// POST /api/lego
//   { action: "stats" }  – kilopris för Lego i bulk från sålda Tradera-partier
//   { action: "calc", weight, price, kr_per_kg, settings } – köpbeslut för ett parti
import { checkAuth, json } from "../lib/http.js";
import { fetchLegoLots, legoCalc, legoReport } from "../lib/lego.js";
import { mergeSettings } from "../lib/settings.js";
import { traderaConfigured } from "../lib/tradera.js";

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));

  if (body.action === "calc") {
    const result = legoCalc({ ...body, settings: mergeSettings(body.settings) });
    return result ? json({ ok: true, ...result }) : json({ error: "Ange vikt" }, 400);
  }

  if (!traderaConfigured()) return json({ error: "Tradera är inte konfigurerat" }, 400);
  try {
    const { lots, pages } = await fetchLegoLots();
    if (!lots.length && pages.every((p) => p.error)) return json({ error: pages[0]?.error ?? "Tradera svarade inte" }, 502);
    return json({ ok: true, ...legoReport(lots), pages });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}
