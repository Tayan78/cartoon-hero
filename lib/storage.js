// Loggning till Google Drive + Sheets via en Apps Script-webbapp
// (se apps-script/Code.gs). Saknas konfigurationen hoppas loggningen över.

export const storageConfigured = () => Boolean(process.env.APPS_SCRIPT_URL && process.env.APPS_SCRIPT_SECRET);

export async function callAppsScript(action, payload) {
  if (!storageConfigured()) return { ok: false, skipped: true, error: "Apps Script är inte konfigurerat" };
  const res = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    // text/plain undviker CORS-preflight och är det Apps Script hanterar enklast.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret: process.env.APPS_SCRIPT_SECRET, action, ...payload }),
    redirect: "follow",
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Apps Script svarar med en HTML-sida vid fel (t.ex. saknad behörighet eller
    // gammal driftsättning); visa sidans titel/text så att orsaken syns.
    const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1];
    const body = text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const detail = [title, body.slice(0, 200)].filter(Boolean).join(" – ");
    return { ok: false, error: `Oväntat svar från Apps Script (${res.status})${detail ? `: ${detail}` : ""}` };
  }
}
