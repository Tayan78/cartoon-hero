// Gemini med Google-sökning: hittar exakt modell/artikelnummer på samma sätt
// som Google Lens/AI-översikten. Används som ledtråd till identifieringen.
import { extractJson } from "./economics.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// USD per miljon token och per sökning. Kontrollera mot Googles prislista;
// sökningarna är gratis upp till en månadskvot men räknas här alltid som betalda.
const PRICE = {
  input: Number(process.env.GEMINI_INPUT_USD) || 0.75,
  output: Number(process.env.GEMINI_OUTPUT_USD) || 3.75,
  search: Number(process.env.GEMINI_SEARCH_USD) || 14 / 1000,
};

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

const PROMPT = `Du hjälper en svensk reseller att identifiera ett begagnat föremål från bilder. Använd Google-sökning för att hitta EXAKT vilken produkt det är: tillverkare, modell/serie/mönster och artikel-/modellnummer (t.ex. Schleich 13695). Jämför med produktbilder i det du hittar. Ange bara ett artikelnummer som du har hittat i sökresultaten.

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

// images: [{ mediaType, data }]
export async function geminiIdentify(images) {
  const res = await fetch(`${ENDPOINT}/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [...images.map((img) => ({ inline_data: { mime_type: img.mediaType, data: img.data } })), { text: PROMPT }],
        },
      ],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini svarade ${res.status}`);

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
  const usd = (tokensIn * PRICE.input + tokensOut * PRICE.output) / 1e6 + queries.length * PRICE.search;

  let raw;
  try {
    raw = extractJson(text);
  } catch {
    raw = { name: text.slice(0, 200), article_number: "", candidates: [], evidence: "" };
  }
  return { raw, queries, sources, grounded: queries.length > 0, tokensIn, tokensOut, usd };
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

// Gratis kontroll av nyckel och modellnamn. Finns inte modellen listas de
// Flash-modeller som nyckeln har tillgång till, så att GEMINI_MODEL kan rättas.
export async function checkGemini() {
  const headers = { "x-goog-api-key": process.env.GEMINI_API_KEY };
  const res = await fetch(`${ENDPOINT}/${GEMINI_MODEL}`, { headers, signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data.displayName || GEMINI_MODEL;
  let message = data.error?.message || `Gemini svarade ${res.status}`;
  if (res.status === 404) {
    const list = await fetch(`${ENDPOINT}?pageSize=200`, { headers }).then((r) => r.json()).catch(() => ({}));
    const flash = (list.models ?? []).map((m) => m.name?.replace("models/", "")).filter((n) => /flash/.test(n ?? ""));
    if (flash.length) message += ` Tillgängliga Flash-modeller: ${flash.slice(0, 8).join(", ")}`;
  }
  throw new Error(message);
}
