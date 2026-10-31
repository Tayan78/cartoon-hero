// En modell i databasen (t.ex. 13773): vad den sålt för senaste månaderna, hur
// stor del som säljs, hur snabbt och vad som ligger ute just nu. Används när en
// fotad annons prissätts. Bara annonser med en enda figur räknas (paketpriser
// säger inget om en enskild modell). Auktioner som inte nådde reservpriset är osålda.
import { countFigures } from "../../lib/lots.js";

const LOT = /\b(parti|paket|samling|lot|bundle|mix)\b/i;
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return Math.round(sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo));
};

export function summarizeModel(rows, { now = Date.now() } = {}) {
  const single = rows.filter((r) => (r.n_products ?? 0) <= 1 && !countFigures(r.title) && !LOT.test(r.title ?? "") && r.price > 0);
  const sold = single.filter((r) => r.status === "Såld" && r.reserve_met !== 0);
  const unsold = single.filter((r) => r.status === "Osåld" || (r.status === "Såld" && r.reserve_met === 0));
  const active = single.filter((r) => r.status === "Aktiv" && (!r.end_at || Date.parse(r.end_at) > now));
  const prices = sold.map((r) => r.price).sort((a, b) => a - b);
  const days = sold
    .map((r) => (Date.parse(r.end_at) - Date.parse(r.start_at || r.first_seen)) / 86400000)
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const asks = active.map((r) => r.price).sort((a, b) => a - b);
  const ended = sold.length + unsold.length;
  return {
    sold: sold.length,
    unsold: unsold.length,
    median: quantile(prices, 0.5),
    p25: quantile(prices, 0.25),
    p75: quantile(prices, 0.75),
    sell_through: ended ? Math.round((100 * sold.length) / ended) : null,
    days_to_sell: days.length ? Math.round(quantile(days, 0.5)) : null,
    active: active.length,
    active_low: asks[0] ?? null,
    asks_below_median: prices.length ? asks.filter((p) => p < quantile(prices, 0.5)).length : 0,
    recent: sold
      .sort((a, b) => String(b.end_at).localeCompare(String(a.end_at)))
      .slice(0, 5)
      .map((r) => ({ title: r.title, price: r.price, end_at: r.end_at, url: r.url, type: r.type })),
  };
}

export async function modelStats(db, { number, days = 120, now = Date.now() } = {}) {
  const n = String(number ?? "").trim();
  if (!/^\d{4,6}$/.test(n)) throw new Error("Modellnummer saknas");
  const since = new Date(now - Math.min(Math.max(Number(days) || 120, 7), 365) * 86400000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT l.id, l.title, l.status, l.type, l.price, l.start_at, l.first_seen, l.end_at, l.reserve_met, l.url,
         (SELECT COUNT(*) FROM listing_products x WHERE x.listing_id = l.id) AS n_products
       FROM listings l
       WHERE (l.model_number = ?1 OR l.id IN (SELECT listing_id FROM listing_products WHERE product_key = ?2))
         AND (l.status = 'Aktiv' OR l.end_at >= ?3)
       LIMIT 1000`,
    )
    .bind(n, `SCHLEICH-${n}`, since)
    .all();
  return { number: n, days: Number(days) || 120, ...summarizeModel(results, { now }) };
}
