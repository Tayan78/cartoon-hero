// GET /api/ping – kontrollerar lösenordet och visar vad som är konfigurerat.
import { MODEL } from "../lib/claude.js";
import { checkAuth, json } from "../lib/http.js";
import { storageConfigured } from "../lib/storage.js";

export async function GET(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  return json({
    ok: true,
    model: MODEL,
    api_key: Boolean(process.env.ANTHROPIC_API_KEY) || process.env.MOCK === "1",
    storage: storageConfigured(),
    mock: process.env.MOCK === "1",
  });
}
