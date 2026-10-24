// Gemini med Google-sökning: hittar exakt modell/artikelnummer på samma sätt
// som Google Lens/AI-översikten. Används som ledtråd till identifieringen.
import { extractJson } from "./economics.js";

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
  throw new Error(errors.join(" | "));
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
async function ask(images, prompt, models) {
  const { model, data } = await generateWithFallback(
    {
      contents: [
        {
          role: "user",
          parts: [...images.map((img) => ({ inline_data: { mime_type: img.mediaType, data: img.data } })), { text: prompt }],
        },
      ],
      tools: [{ google_search: {} }],
    },
    45000,
    models,
  );

  const candidate = data.candidates?.[0] ?? {};
  const text = (candidate.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const grounding = candidate.groundingMetadata ?? {};
  const queries = grounding.webSearchQueries ?? [];
  const sources = (grounding.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w) => w?.uri)
    .slice(0, 6)
    .map((w) => ({ title: w.title ?? "", url: w.uri }));

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
  return { raw, model, queries, sources, grounded, tokensIn, tokensOut, usd };
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
