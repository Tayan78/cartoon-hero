import Anthropic from "@anthropic-ai/sdk";
import { IDENTIFY_SYSTEM_PROMPT, PRICE_SYSTEM_PROMPT, buildIdentifyText, buildPriceText } from "./prompt.js";
import { extractJson } from "./economics.js";
import { MODELS } from "./models.js";

const ID_EFFORT = process.env.ID_EFFORT || "low";
const SEARCH_EFFORT = process.env.SEARCH_EFFORT || "low";
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES) || 4;
const MAX_CONTINUATIONS = 4;

// Prissökningen får bara söka i och läsa sidor från de två primärkällorna.
const DOMAINS = ["tradera.com", "ebay.com", "ebay.co.uk", "ebay.de"];
const MAX_FETCHES = Number(process.env.MAX_FETCHES) || 4;

function priceTools(model, withFetch) {
  return [
    withFetch && {
      type: MODELS[model].webFetch,
      name: "web_fetch",
      max_uses: MAX_FETCHES,
      allowed_domains: DOMAINS,
      max_content_tokens: 12000,
    },
    {
      type: MODELS[model].webSearch,
      name: "web_search",
      max_uses: MAX_SEARCHES,
      allowed_domains: DOMAINS,
      user_location: { type: "approximate", country: "SE", timezone: "Europe/Stockholm" },
    },
  ].filter(Boolean);
}

// Om ett säkerhetsfilter avböjer en förfrågan körs den om på en reservmodell
// i samma anrop (Opus/Sonnet). Stäng av med DISABLE_FALLBACKS=1.
function fallbackParams(model) {
  if (process.env.DISABLE_FALLBACKS === "1" || !MODELS[model].fallbacks) return {};
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

let client;
const getClient = () => (client ??= new Anthropic());

function imageBlock(image) {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
}

const textOf = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

async function create(params, { stream, onEvent } = {}) {
  const fallback = fallbackParams(params.model);
  const run = async (extra) => {
    if (!stream) return getClient().beta.messages.create({ ...params, ...extra });
    const s = getClient().beta.messages.stream({ ...params, ...extra });
    if (onEvent) s.on("streamEvent", onEvent);
    return s.finalMessage();
  };
  try {
    return await run(fallback);
  } catch (err) {
    // Konto/plattform utan stöd för fallbacks: försök igen utan.
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && fallback.fallbacks) {
      return run({});
    }
    throw err;
  }
}

function assertUsable(message) {
  if (message.stop_reason === "refusal") {
    throw new Error("Modellen avböjde att svara på den här bilden.");
  }
}

// Steg 1: identifiering från bilderna (+ bildsökets ledtrådar). Ingen webbsökning.
export async function identify(images, vision, model) {
  const message = await create({
    model,
    max_tokens: 4000,
    output_config: { effort: ID_EFFORT },
    system: IDENTIFY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [...images.map(imageBlock), { type: "text", text: buildIdentifyText({ imageCount: images.length, vision }) }],
      },
    ],
  });
  assertUsable(message);
  return { raw: extractJson(textOf(message.content)), usages: [message.usage], model: message.model ?? model };
}

// Steg 2: sålda priser via färdiga söksidor (web_fetch) och webbsökning,
// utifrån identifieringen (bara text).
// onStatus(text) anropas när modellen börjar en ny sökning.
export async function priceSearch({ identification, vision, urls, buyPrice, settings }, model, onStatus = () => {}) {
  const usages = []; // ett usage-objekt per API-anrop (fler om sökloopen pausar)
  const messages = [
    { role: "user", content: buildPriceText({ identification, vision, urls, buyPrice, settings }) },
  ];
  let calls = 0;
  const onEvent = (event) => {
    if (event.type === "content_block_start" && event.content_block?.type === "server_tool_use") {
      calls += 1;
      const what = event.content_block.name === "web_fetch" ? "Läser Tradera/eBay" : "Söker sålda objekt";
      onStatus(`${what} (${calls})…`);
    }
  };

  let message;
  let withFetch = true;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const params = {
      model,
      max_tokens: 16000,
      output_config: { effort: SEARCH_EFFORT },
      system: PRICE_SYSTEM_PROMPT,
      tools: priceTools(model, withFetch),
      messages,
    };
    try {
      message = await create(params, { stream: true, onEvent });
    } catch (err) {
      // Stöds inte sidhämtning för modellen/kontot: kör vidare med bara webbsökning.
      if (!(i === 0 && withFetch && err instanceof Anthropic.BadRequestError && /fetch/i.test(err.message))) throw err;
      console.warn("web_fetch avvisades, kör utan:", err.message);
      withFetch = false;
      message = await create({ ...params, tools: priceTools(model, false) }, { stream: true, onEvent });
    }
    usages.push(message.usage);
    if (message.stop_reason !== "pause_turn") break;
    // Serverns sökloop pausade – skicka tillbaka svaret så fortsätter den.
    const last = messages.at(-1);
    if (last.role === "assistant") last.content = [...last.content, ...message.content];
    else messages.push({ role: "assistant", content: message.content });
  }
  assertUsable(message);

  return { raw: extractJson(textOf(message.content)), usages, model: message.model ?? model };
}
