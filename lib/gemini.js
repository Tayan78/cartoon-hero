// Gemini med Google-sökning: hittar exakt modell/artikelnummer på samma sätt
// som Google Lens/AI-översikten. Används som ledtråd till identifieringen.
import { extractJson } from "./economics.js";
import { PRICE_SYSTEM_PROMPT, buildPriceText } from "./prompt.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Reservmodeller om huvudmodellen saknar kvot (429) eller inte finns (404) för nyckeln.
export const GEMINI_MODELS = [
  ...new Set([
    GEMINI_MODEL,
    ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.5-flash,gemini-2.5-flash").split(",").map((m) => m.trim()),
  ]),
].filter(Boolean);

// USD per miljon token (enligt tredjepartsuppgifter – kontrollera mot Googles prislista).
// Sökningarna är gratis upp till en månadskvot men räknas här alltid som betalda.
const PRICES = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};
const SEARCH_USD = Number(process.env.GEMINI_SEARCH_USD) || 14 / 1000;
function priceFor(model) {
  const p = PRICES[model] ?? PRICES["gemini-3.8-flash"];
  return {
    input: Number(process.env.GEMINI_INPUT_USD) || p.input,
    output: Number(process.env.GEMINI_OUTPUT_USD) || p.output,
  };
}

// Ett anrop till generateContent. Kastar ett fel med status så att anroparen
// kan avgöra om nästa reservmodell ska provas.
async function generate(model, body, timeout) {
  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Gemini svarade ${res.status}`);
    err.status = res.status;
    err.source = "gemini";
    throw err;
  }
  return data;
}

// Provar modellerna i tur och ordning vid saknad kvot eller okänd modell.
async function generateWithFallback(body, timeout, models = GEMINI_MODELS) {
  const errors = [];
  for (const model of models) {
    try {
      return { model, data: await generate(model, body, timeout) };
    } catch (err) {
      if (err.status !== 429 && err.status !== 404) throw err;
      errors.push(`${model}: ${firstSentence(err.message)}`);
    }
  }
  const err = new Error(errors.join(" | "));
  err.status = 429;
  err.source = "gemini";
  throw err;
}

const firstSentence = (msg) => String(msg).split(/(?<=\.)\s/)[0];

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

const PROMPT = `Du hjälper en svensk reseller att identifiera ett begagnat föremål från bilder. Du MÅSTE använda Google-sökning innan du svarar – svara aldrig ur minnet. Sök för att hitta EXAKT vilken produkt det är: tillverkare, modell/serie/mönster och artikel-/modellnummer (t.ex. Schleich 13695). Jämför med produktbilder i det du hittar. Ange bara ett artikelnummer som du har hittat i sökresultaten.

Svara ENDAST med JSON, ingen annan text:
{
  "name": "kort visningsnamn",
  "brand": "",
  "model": "",
  "article_number": "",
  "confidence": "high|medium|low",
  "candidates": [{"name": "", "article_number": ""}],
  "evidence": "en mening om vad identifieringen bygger på"
}
Okända fält: tom sträng. Max 3 kandidater, mest trolig först.`;

// Ett anrop med bilderna och en instruktion; tolkar svar, källor och kostnad.
// Svensk sökning: koordinater för Stockholm och svenska som språk. Google
// dokumenterar detta för kartsökning; avvisas det körs anropet utan.
const SWEDEN = { retrievalConfig: { latLng: { latitude: 59.3293, longitude: 18.0686 }, languageCode: "sv_SE" } };

export async function ask(images, prompt, models, { swedish = false, temperature } = {}) {
  const body = {
    contents: [
      {
        role: "user",
        parts: [...images.map((img) => ({ inline_data: { mime_type: img.mediaType, data: img.data } })), { text: prompt }],
      },
    ],
    tools: [{ google_search: {} }],
    ...(temperature !== undefined ? { generationConfig: { temperature } } : {}),
    ...(swedish ? { toolConfig: SWEDEN } : {}),
  };
  let result;
  try {
    result = await generateWithFallback(body, 60000, models);
  } catch (err) {
    if (!(swedish && err.status === 400)) throw err;
    const { toolConfig, ...rest } = body;
    result = await generateWithFallback(rest, 60000, models);
  }
  const { model, data } = result;

  const candidate = data.candidates?.[0] ?? {};
  const text = (candidate.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const grounding = candidate.groundingMetadata ?? {};
  const queries = grounding.webSearchQueries ?? [];
  const sources = (grounding.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w) => w?.uri)
    .slice(0, 6)
    .map((w) => ({ title: w.title ?? "", url: w.uri }));
  // Textbitar i svaret som Google kopplat till minst en källa.
  const supported = (grounding.groundingSupports ?? [])
    .filter((g) => (g.groundingChunkIndices ?? []).length > 0)
    .map((g) => g.segment?.text ?? "");

  const u = data.usageMetadata ?? {};
  const tokensIn = u.promptTokenCount ?? 0;
  const tokensOut = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const price = priceFor(model);
  const usd = (tokensIn * price.input + tokensOut * price.output) / 1e6 + queries.length * SEARCH_USD;

  let raw;
  try {
    raw = extractJson(text);
  } catch {
    raw = { name: text.slice(0, 200), article_number: "", candidates: [], evidence: "" };
  }
  // Sökningen kan synas som sökfrågor, källor eller en sökruta i svaret.
  const grounded = queries.length > 0 || sources.length > 0 || Boolean(grounding.searchEntryPoint);
  return { raw, model, queries, sources, supported, grounded, tokensIn, tokensOut, usd, response: data };
}

// Andra försöket när Gemini svarade ur minnet utan att söka: be uttryckligen om
// en sökning på förslaget, så att numret blir belagt (eller rättat).
function withNote(prompt, note) {
  return note ? `Säljaren uppger om föremålet: "${note}". Ta med det i dina Google-sökningar.\n\n${prompt}` : prompt;
}

function verifyPrompt(first) {
  const guess = [first.brand, first.name, first.article_number].filter(Boolean).join(" ");
  return `Du svarade utan att söka. Gör nu Google-sökningar innan du svarar, t.ex. "${guess}" och "${[first.brand, first.model].filter(Boolean).join(" ")} artikelnummer", och jämför produktbilderna du hittar med bilden. Rätta förslaget om sökningen visar en annan modell.

${PROMPT}`;
}

// images: [{ mediaType, data }]
export async function geminiIdentify(images, note = "") {
  const first = await ask(images, withNote(PROMPT, note));
  if (first.grounded) return first;
  // Samma modell som svarade första gången, så att kvot- och prisläget är känt.
  const second = await ask(images, withNote(verifyPrompt(first.raw), note), [first.model]).catch(() => null);
  const total = (key) => first[key] + (second?.[key] ?? 0);
  const chosen = second?.grounded ? second : first;
  return { ...chosen, tokensIn: total("tokensIn"), tokensOut: total("tokensOut"), usd: total("usd"), attempts: second ? 2 : 1 };
}

// Kort text till identifieringen. Ett nummer räknas som belagt bara om Gemini
// faktiskt sökte (grounded); annars kan det vara en gissning.
export function geminiText(result) {
  if (!result) return "";
  const r = result.raw ?? {};
  const lines = [
    `Gemini med Google-sökning${result.grounded ? "" : " (sökte inte – behandla som gissning)"}:`,
    `- Förslag: ${[r.name, r.article_number && `artikelnummer ${r.article_number}`].filter(Boolean).join(", ")} (säkerhet ${r.confidence || "okänd"})`,
  ];
  const others = (r.candidates ?? []).filter((c) => c?.name && c.name !== r.name);
  if (others.length) lines.push(`- Andra kandidater: ${others.map((c) => [c.name, c.article_number].filter(Boolean).join(" ")).join("; ")}`);
  if (r.evidence) lines.push(`- Underlag: ${r.evidence}`);
  if (result.queries.length) lines.push(`- Googlesökningar: ${result.queries.join("; ")}`);
  if (result.sources.length) lines.push(`- Källor: ${result.sources.map((s) => s.title || s.url).join("; ")}`);
  return lines.join("\n");
}

// Artikelnummer som Gemini hittade via sökning – räknas som belagt.
export function geminiArticle(result) {
  return result?.grounded ? String(result.raw?.article_number ?? "").trim() : "";
}

// En kort text utan bilder och utan Google-sökning (motiveringen till köpbeslutet).
export async function geminiSentence(prompt) {
  const { model, data } = await generateWithFallback(
    { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } },
    20000,
  );
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  const u = data.usageMetadata ?? {};
  const tokensIn = u.promptTokenCount ?? 0;
  const tokensOut = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const price = priceFor(model);
  return { text, model, tokensIn, tokensOut, usd: (tokensIn * price.input + tokensOut * price.output) / 1e6 };
}

// Kontroll för "Testa anslutning": ett minimalt anrop med Google-sökning
// påslagen per modell, så att både nyckel, modellnamn och kvot syns.
// Kostar bara några token (modellen behöver inte söka för att svara).
export async function checkGemini() {
  const results = await Promise.all(
    GEMINI_MODELS.map((model) =>
      generate(
        model,
        { contents: [{ role: "user", parts: [{ text: "Svara bara med ordet ok." }] }], tools: [{ google_search: {} }] },
        15000,
      ).then(
        () => `✓ ${model}`,
        (err) => `✗ ${model} (${firstSentence(err.message)})`,
      ),
    ),
  );
  const line = results.join(", ");
  if (results.some((r) => r.startsWith("✓"))) return line;
  throw new Error(line);
}

// Prissökning med Gemini och Google-sökning (alternativ till Claude i inställningarna).
// Samma instruktioner och JSON-svar som Claudes prissteg, men Google i stället för
// web_search/web_fetch. Google-sökningen kan inte låsas till vissa sajter, så
// prompten styr den mot Tradera och eBay.
const GEMINI_PRICE_PREFACE = `Du har Google-sökning (inte web_fetch). Sök på Google efter sålda/avslutade objekt, t.ex. "site:tradera.com <sökord>" och "<sökord> ebay sold", och efter annonser till salu nu på Tradera och eBay. Använd bara träffar från tradera.com och ebay. Källornas url ska vara annonsernas egna adresser som du sett i sökresultaten – hitta aldrig på adresser. Där instruktionerna nedan nämner web_fetch: använd Google-sökning i stället.

`;

export async function geminiPriceSearch(input, onStatus = () => {}) {
  onStatus("Söker priser med Google…");
  const prompt = `${GEMINI_PRICE_PREFACE}${PRICE_SYSTEM_PROMPT}\n\n${buildPriceText(input)}`;
  const first = await ask([], prompt);
  let chosen = first;
  let extra = null;
  if (!first.grounded) {
    onStatus("Söker priser med Google (2)…");
    extra = await ask([], `Du svarade utan att söka. Gör nu Google-sökningar på Tradera och eBay innan du svarar.\n\n${prompt}`, [first.model]).catch(() => null);
    if (extra?.grounded) chosen = extra;
  }
  const total = (key) => first[key] + (extra?.[key] ?? 0);
  // Bara annonser från Tradera och eBay räknas som källor.
  const raw = chosen.raw ?? {};
  if (Array.isArray(raw.sources)) {
    raw.sources = raw.sources.filter((src) => /^https?:\/\/([a-z0-9-]+\.)*(tradera\.com|ebay\.[a-z.]+)\//i.test(src?.url ?? ""));
  }
  return {
    ...chosen,
    raw,
    tokensIn: total("tokensIn"),
    tokensOut: total("tokensOut"),
    usd: total("usd"),
    queries: [...first.queries, ...(extra?.queries ?? [])],
  };
}
