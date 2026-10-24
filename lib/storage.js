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
    return { ok: false, error: `Oväntat svar från Apps Script (${res.status})` };
  }
}
