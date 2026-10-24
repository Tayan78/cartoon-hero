// Modeller som får användas, med pris (USD per miljon token) och vad de stöder.
// Identifiering och prissökning kan använda olika modeller; välj i appens
// inställningar eller med ID_MODEL / SEARCH_MODEL i Vercel.

export const MODELS = {
  "claude-opus-5-5": {
    label: "Opus 5.5 (bäst, dyrast)",
    input: 4,
    output: 20,
    cache_read: 0.2,
    webSearch: "web_search_20260209",
    fallbacks: true,
  },
  "claude-sonnet-5-5": {
    label: "Sonnet 5.5 (mellan)",
    input: 2,
    output: 10,
    cache_read: 0.2,
    webSearch: "web_search_20260209",
    fallbacks: true,
  },
  "claude-haiku-5-5": {
    label: "Haiku 5.5 (billigast)",
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    // Haiku har inte den nyare sökvarianten med dynamisk filtrering.
    webSearch: "web_search_20250305",
    // Haiku saknar automatisk reservmodell vid avböjda svar.
    fallbacks: false,
  },
};

export const DEFAULT_ID_MODEL = valid(process.env.ID_MODEL) ?? "claude-opus-5-5";
export const DEFAULT_SEARCH_MODEL = valid(process.env.SEARCH_MODEL) ?? "claude-haiku-5-5";

export function valid(model) {
  return typeof model === "string" && Object.hasOwn(MODELS, model) ? model : undefined;
}

export const WEB_SEARCH_USD = 10 / 1000; // Claude web search: 10 USD per 1000 sökningar
export const VISION_USD_PER_IMAGE = 3.5 / 1000; // Vision Web Detection efter 1000 gratis/månad
