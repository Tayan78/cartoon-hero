// GET /api/ping – kontrollerar lösenordet och visar vad som är konfigurerat.
// Med ?check=1 testas också varje nyckel på riktigt, och Googles/Anthropics
// felmeddelanden visas så att felet syns direkt.
import { checkClaude } from "../lib/claude.js";
import { GEMINI_MODEL, checkGemini, geminiConfigured } from "../lib/gemini.js";
import { checkAuth, json } from "../lib/http.js";
import { DEFAULT_ID_MODEL, DEFAULT_SEARCH_MODEL, MODELS } from "../lib/models.js";
import { callAppsScript, storageConfigured } from "../lib/storage.js";
import { checkVision, visionConfigured } from "../lib/vision.js";
import { checkLens, lensConfigured } from "../lib/lens.js";
import { checkTradera, traderaConfigured } from "../lib/tradera.js";

async function run(configured, fn) {
  if (!configured) return { ok: false, detail: "inte konfigurerat" };
  try {
    return { ok: true, detail: await fn() };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function checkSheet() {
  // Okänd action efter godkänd hemlighet betyder att kopplingen fungerar.
  const res = await callAppsScript("ping", {});
  if (res.ok || res.error === "Okänd action") return "ok";
  throw new Error(res.error || "okänt fel");
}

export async function GET(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const mock = process.env.MOCK === "1";
  const body = {
    ok: true,
    api_key: Boolean(process.env.ANTHROPIC_API_KEY) || mock,
    vision: visionConfigured() || mock,
    gemini: geminiConfigured() || mock,
    lens: lensConfigured() || mock,
    tradera: traderaConfigured() || mock,
    gemini_model: GEMINI_MODEL,
    storage: storageConfigured(),
    mock,
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, m.label])),
    defaults: { identify: DEFAULT_ID_MODEL, search: DEFAULT_SEARCH_MODEL },
  };

  if (new URL(request.url).searchParams.get("check") === "1" && !mock) {
    const [claude, gemini, vision, sheet, lens, tradera] = await Promise.all([
      run(Boolean(process.env.ANTHROPIC_API_KEY), () => checkClaude(DEFAULT_ID_MODEL)),
      run(geminiConfigured(), checkGemini),
      run(visionConfigured(), checkVision),
      run(storageConfigured(), checkSheet),
      run(lensConfigured(), checkLens),
      run(traderaConfigured(), checkTradera),
    ]);
    body.checks = { claude, gemini, vision, sheet, lens, tradera };
  }
  return json(body);
}
