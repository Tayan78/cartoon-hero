import Anthropic from "@anthropic-ai/sdk";
import { IDENTIFY_SYSTEM_PROMPT, SCAN_SYSTEM_PROMPT, buildScanUserText } from "./prompt.js";
import { extractJson } from "./economics.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const SCAN_EFFORT = process.env.SCAN_EFFORT || "low";
const MAX_CONTINUATIONS = 4;

// Snabbskanningen får bara söka i de två primärkällorna.
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 6,
  allowed_domains: ["tradera.com", "ebay.com", "ebay.co.uk", "ebay.de"],
  user_location: { type: "approximate", country: "SE", timezone: "Europe/Stockholm" },
};

// Om ett säkerhetsfilter avböjer en förfrågan körs den om på en reservmodell
// i samma anrop. Stäng av med DISABLE_FALLBACKS=1 om kontot inte stöder det.
const FALLBACK_PARAMS =
  process.env.DISABLE_FALLBACKS === "1"
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

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
  const run = async (extra) => {
    if (!stream) return getClient().beta.messages.create({ ...params, ...extra });
    const s = getClient().beta.messages.stream({ ...params, ...extra });
    if (onEvent) s.on("streamEvent", onEvent);
    return s.finalMessage();
  };
  try {
    return await run(FALLBACK_PARAMS);
  } catch (err) {
    // Konto/plattform utan stöd för fallbacks: försök igen utan.
    if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && FALLBACK_PARAMS.fallbacks) {
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

// Snabb identifiering utan sökning, för det preliminära svaret.
export async function identify(image) {
  const message = await create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    system: IDENTIFY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [imageBlock(image), { type: "text", text: "Vad är det här?" }] }],
  });
  assertUsable(message);
  return { item: extractJson(textOf(message.content)), usage: message.usage };
}

// Full skanning: identifiering + sålda priser via webbsökning.
// onStatus(text) anropas när modellen börjar en ny sökning.
export async function scan(image, { buyPrice, settings }, onStatus = () => {}) {
  const usages = []; // ett usage-objekt per API-anrop (fler om sökloopen pausar)
  const messages = [
    {
      role: "user",
      content: [imageBlock(image), { type: "text", text: buildScanUserText({ buyPrice, settings }) }],
    },
  ];
  let searches = 0;
  const onEvent = (event) => {
    if (event.type === "content_block_start" && event.content_block?.type === "server_tool_use") {
      searches += 1;
      onStatus(searches === 1 ? "Söker sålda objekt…" : `Söker sålda objekt (${searches})…`);
    }
  };

  let message;
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    message = await create(
      {
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: SCAN_EFFORT },
        system: [{ type: "text", text: SCAN_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [WEB_SEARCH_TOOL],
        messages,
      },
      { stream: true, onEvent },
    );
    usages.push(message.usage);
    if (message.stop_reason !== "pause_turn") break;
    // Serverns sökloop pausade – skicka tillbaka svaret så fortsätter den.
    const last = messages.at(-1);
    if (last.role === "assistant") last.content = [...last.content, ...message.content];
    else messages.push({ role: "assistant", content: message.content });
  }
  assertUsable(message);

  return { raw: extractJson(textOf(message.content)), usages, model: message.model ?? MODEL };
}
