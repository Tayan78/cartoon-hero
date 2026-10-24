// GET /api/ping – kontrollerar lösenordet och visar vad som är konfigurerat.
import { checkAuth, json } from "../lib/http.js";
import { DEFAULT_ID_MODEL, DEFAULT_SEARCH_MODEL, MODELS } from "../lib/models.js";
import { storageConfigured } from "../lib/storage.js";
import { GEMINI_MODEL, geminiConfigured } from "../lib/gemini.js";
import { visionConfigured } from "../lib/vision.js";

export async function GET(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const mock = process.env.MOCK === "1";
  return json({
    ok: true,
    api_key: Boolean(process.env.ANTHROPIC_API_KEY) || mock,
    vision: visionConfigured() || mock,
    gemini: geminiConfigured() || mock,
    gemini_model: GEMINI_MODEL,
    storage: storageConfigured(),
    mock,
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, m.label])),
    defaults: { identify: DEFAULT_ID_MODEL, search: DEFAULT_SEARCH_MODEL },
  });
}
