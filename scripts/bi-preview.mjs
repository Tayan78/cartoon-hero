// Förhandsvisning av BI: läser Schleich-annonserna ur D1 (bara läsning) och
// skriver ut en sammanställning (aggregat, inga enskilda annonser) som JSON.
// Körs i GitHub Actions: CLOUDFLARE_API_TOKEN/ACCOUNT_ID, wrangler i worker/.
import { execFileSync } from "node:child_process";
import { isLot } from "../lib/lots.js";
import { NICHES } from "../lib/niches.js";
import { SERIES } from "../lib/series.js";

const sql = `SELECT title, status, price, type, bids, niche, series, end_at, seller
  FROM listings WHERE niche IS NOT NULL OR series IS NOT NULL OR source = 'sök'`;
const out = execFileSync("npx", ["--yes", "wrangler@4.150.0", "d1", "execute", "loppis", "--remote", "--json", "--command", sql], { cwd: "worker", maxBuffer: 256 * 1024 * 1024 }).toString();
const rows = JSON.parse(out)[0].results;

const pct = (xs, p) => {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p;
  return Math.round(s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i)));
};
const LABEL = Object.fromEntries(SERIES.map((s) => [s.id, s.label]));
const ANIMAL_SERIES = new Set(SERIES.filter((s) => s.animal).map((s) => s.id));
const horse = (t) => /häst|föl|hingst|\bsto\b|ponny|valack/i.test(t);
function segment(r) {
  const lot = isLot(r.title, NICHES.djur) || isLot(r.title, NICHES.smurfar);
  if (lot) return "Partier";
  const first = (r.series ?? "").split(",").filter((s) => !ANIMAL_SERIES.has(s))[0];
  if (first) return LABEL[first] ?? first;
  if (r.niche === "smurfar") return "Smurfar";
  if (r.niche === "djur") return horse(r.title) ? "Hästar" : "Övriga djur";
  return "Övrigt";
}
const stats = (list) => {
  const sold = list.filter((r) => r.status === "Såld");
  const unsold = list.filter((r) => r.status === "Osåld").length;
  const prices = sold.map((r) => r.price);
  return {
    listings: list.length, active: list.filter((r) => r.status === "Aktiv").length, sold: sold.length, unsold,
    sell_through: sold.length + unsold ? Math.round((100 * sold.length) / (sold.length + unsold)) : null,
    p25: pct(prices, 0.25), median: pct(prices, 0.5), p75: pct(prices, 0.75),
  };
};
const group = (list, key) => {
  const m = new Map();
  for (const r of list) {
    const k = key(r);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

for (const r of rows) r.segment = segment(r);
const ended = rows.filter((r) => r.status === "Såld" || r.status === "Osåld");
const singlesAnimals = rows.filter((r) => r.segment === "Hästar" || r.segment === "Övriga djur");
const month = (r) => (r.end_at ? r.end_at.slice(0, 7) : null);

// Månader med försäljning (sedan nov 2023) – djur styckvis.
const monthly = [...group(singlesAnimals.filter((r) => r.status === "Såld"), month)].map(([m, l]) => ({ month: m, sold: l.length, median: pct(l.map((r) => r.price), 0.5) })).sort((a, b) => a.month.localeCompare(b.month));
// Senaste 3 hela månaderna (för utbud i månader).
const months = [...new Set(rows.map(month).filter(Boolean))].sort();
const last3 = months.filter((m) => m < new Date().toISOString().slice(0, 7)).slice(-3);
const segments = [...group(rows, (r) => r.segment)].map(([name, l]) => {
  const st = stats(l);
  const soldRecent = l.filter((r) => r.status === "Såld" && last3.includes(month(r))).length / Math.max(1, last3.length);
  return { name, ...st, sold_per_month: Math.round(soldRecent), months_of_supply: soldRecent ? Math.round((10 * st.active) / soldRecent) / 10 : null };
}).sort((a, b) => b.sold - a.sold);

const format = [...group(singlesAnimals, (r) => (r.type === "auktion" ? "Auktion" : r.type === "köp nu" || r.type === "butik" ? "Köp nu" : null))].map(([name, l]) => ({ name, ...stats(l) }));
const BANDS = [[1, 29], [30, 49], [50, 69], [70, 99], [100, 149], [150, 249], [250, 1e9]];
const bands = BANDS.map(([lo, hi]) => {
  const l = singlesAnimals.filter((r) => r.type !== "auktion" && r.price >= lo && r.price <= hi);
  return { band: hi > 1e8 ? `${lo}+` : `${lo}–${hi}`, ...stats(l) };
});
const models = [...group(singlesAnimals, (r) => (r.title.match(/\b([12478]\d{4})\b/) ?? [])[1] ?? null)].map(([model, l]) => {
  const titles = {};
  for (const r of l) titles[r.title] = (titles[r.title] ?? 0) + 1;
  return { model, name: Object.entries(titles).sort((a, b) => b[1] - a[1])[0][0].slice(0, 60), ...stats(l) };
}).filter((m) => m.sold >= 3).sort((a, b) => b.sold - a.sold).slice(0, 15);
const season = Array.from({ length: 12 }, (_, i) => {
  const mm = String(i + 1).padStart(2, "0");
  const l = singlesAnimals.filter((r) => r.status === "Såld" && month(r)?.slice(5) === mm);
  return { month: mm, sold: l.length };
});
const sellers = [...group(rows.filter((r) => r.status === "Såld"), (r) => r.seller || null)].map(([seller, l]) => ({ seller, sold: l.length })).sort((a, b) => b.sold - a.sold);
const totalSold = rows.filter((r) => r.status === "Såld").length;
const auctionsSold = singlesAnimals.filter((r) => r.type === "auktion" && r.status === "Såld");

console.log("BI_JSON_START");
console.log(JSON.stringify({
  generated: new Date().toISOString(),
  totals: { listings: rows.length, ...stats(rows), unknown_outcome: rows.filter((r) => r.status == null).length, first_month: months[0], last3 },
  segments, monthly, format, bands, models, season,
  bids: { median: pct(auctionsSold.map((r) => r.bids), 0.5), p75: pct(auctionsSold.map((r) => r.bids), 0.75), one_bid_share: auctionsSold.length ? Math.round((100 * auctionsSold.filter((r) => r.bids === 1).length) / auctionsSold.length) : null },
  sellers: { total: sellers.length, top: sellers.slice(0, 10).map((s) => ({ ...s, share: Math.round((1000 * s.sold) / totalSold) / 10 })), top10_share: Math.round((100 * sellers.slice(0, 10).reduce((a, s) => a + s.sold, 0)) / totalSold) },
}));
console.log("BI_JSON_END");
