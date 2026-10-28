// POST /api/seller { alias } – konkurrentanalys: säljarens annonser på Tradera
// (aktiva och avslutade senaste året) per modellnummer. Se lib/seller.js.
import { checkAuth, json } from "../lib/http.js";
import { fetchSeller } from "../lib/seller.js";
import { traderaConfigured } from "../lib/tradera.js";

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (!traderaConfigured()) return json({ error: "Tradera är inte konfigurerat" }, 400);
  try {
    return json({ ok: true, ...(await fetchSeller(body.alias)) });
  } catch (err) {
    return json({ error: err.message }, /Ange|Hittade ingen/.test(err.message) ? 400 : 502);
  }
}
