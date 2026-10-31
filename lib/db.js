// Databasen (Cloudflare D1) nås via bevakningens worker: /data/listings,
// /data/sellers och /data/status, skyddade med samma APP_TOKEN som appen.
// Under övergången skrivs marknadsdatan både hit och till Google Sheet.

import { productLinks } from "./products.js";

export const DATA_URL = process.env.DATA_URL || "https://loppis-bevakning.loppis.workers.dev";
export const DB_CHUNK = 200; // rader per anrop (workern tar högst 500)
export const dbConfigured = () => Boolean(process.env.APP_TOKEN);

const LISTING_KEYS = {
  "Annons-ID": "id", Säljare: "seller", "Säljar-ID": "seller_id", Rubrik: "title", Modellnummer: "model_number",
  Nummerkälla: "number_source", Typ: "type", Status: "status", Pris: "price", "Första pris": "first_price",
  "Lägsta pris": "lowest_price", Prisändringar: "price_changes", Bud: "bids", Frakt: "shipping", Skick: "condition",
  Start: "start_at", Slut: "end_at", Dagar: "days", Omstarter: "restarts", Länk: "url", "Först sedd": "first_seen",
  "Senast sedd": "last_seen", "Såld upptäckt": "sold_seen", Text: "text", Nisch: "niche",
  Kategori: "category_id", Rådata: "raw", Källa: "source",
};
const SELLER_KEYS = {
  "Säljar-ID": "id", Alias: "alias", Bevakad: "watched", Nischer: "niches", "Schleich-annonser": "listings_found",
  Aktiva: "active", Avslutade: "ended", "Med nummer %": "number_share", Betyg: "rating", Tillagd: "added_at",
  "Senast insamlad": "collected_at", "Annonser i databasen": "in_db", "Sålda i databasen": "sold_in_db", Fel: "error",
};
const NUMBERS = new Set([
  "price", "first_price", "lowest_price", "price_changes", "bids", "shipping", "days", "restarts",
  "listings_found", "active", "ended", "number_share", "rating", "in_db", "sold_in_db", "category_id",
]);
const DATES = new Set(["start_at", "end_at", "first_seen", "last_seen", "sold_seen", "added_at", "collected_at"]);

// Ett värde från arket → databasens format. Tomt tal = null (skriver inte över),
// tom text skickas som "" bara där den betyder något (t.ex. Fel = inget fel).
function value(col, v) {
  if (v === undefined) return undefined;
  if (col === "watched") return v === "Ja" || v === true || v === 1 ? 1 : 0;
  if (NUMBERS.has(col)) {
    const n = Number(v);
    return v === "" || v === null || !Number.isFinite(n) ? null : n;
  }
  if (DATES.has(col)) {
    if (v instanceof Date) return v.toISOString();
    return v ? String(v) : null;
  }
  if (col === "id" || col === "seller_id") return v === "" || v == null ? null : String(v);
  return v == null ? null : String(v);
}

function convert(row, keys) {
  const out = {};
  for (const [sheetKey, col] of Object.entries(keys)) {
    const v = value(col, row[sheetKey]);
    if (v !== undefined) out[col] = v;
  }
  return out;
}
export const toDbListing = (row) => convert(row, LISTING_KEYS);
export const toDbSeller = (row) => convert(row, SELLER_KEYS);

async function dataCall(path, body, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${DATA_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-app-token": process.env.APP_TOKEN ?? "" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Databasen: ${data.error || res.status}`);
  return data;
}

// Skriver rader (i arkets format) till databasen, i delar om DB_CHUNK.
export async function dbWrite(table, rows, deps = {}) {
  if (!dbConfigured() || !rows.length) return { written: 0 };
  // Annonser får sina produktkopplingar (modellnummer i rubrik eller text).
  const convertRow = table === "sellers" ? toDbSeller : (r) => ({ ...toDbListing(r), products: productLinks({ title: r.Rubrik, text: r.Text }) });
  const all = rows.map(convertRow).filter((r) => r.id);
  for (let i = 0; i < all.length; i += DB_CHUNK) await dataCall(`/data/${table}`, { rows: all.slice(i, i + DB_CHUNK) }, deps);
  return { written: all.length };
}

// Rader som redan har databasens fält (t.ex. från Schleich-sökningen).
export async function dbPut(table, rows, deps = {}) {
  if (!dbConfigured() || !rows.length) return { written: 0 };
  const all = rows.filter((r) => r.id);
  for (let i = 0; i < all.length; i += DB_CHUNK) await dataCall(`/data/${table}`, { rows: all.slice(i, i + DB_CHUNK) }, deps);
  return { written: all.length };
}

export const dbStatus = (deps = {}) => dataCall("/data/status", null, deps);
export const dbDashboard = (deps = {}) => dataCall("/data/dashboard", null, deps);
export const dbCompetitors = (opts = {}, deps = {}) => dataCall("/data/competitors", opts, deps);
export const dbModel = (number, deps = {}) => dataCall("/data/model", { number }, deps);
export const dbWeek = (opts = {}, deps = {}) => dataCall("/data/week", opts, deps);
export const dbProducts = (opts = {}, deps = {}) => dataCall("/data/products", opts, deps);
export const dbTexts = (opts = {}, deps = {}) => dataCall("/data/texts", opts, deps);
export const dbMarket = (opts = {}, deps = {}) => dataCall("/data/market", opts, deps);
export const dbNeedsDetail = (limit, deps = {}) => dataCall("/data/needs-detail", { limit }, deps).then((d) => d.ids);

// Körningshistorik (översikten): start ger ett id, sedan klar/fel med samma id.
// Fel här får aldrig stoppa själva körningen.
export async function dbRun(body, deps = {}) {
  if (!dbConfigured()) return null;
  return dataCall("/data/run", body, deps).then((d) => d.id ?? null).catch(() => null);
}
export const dbUnresolved = (limit, deps = {}) => dataCall("/data/unresolved", { limit }, deps).then((d) => d.ids);

// Annonser från databasen i arkets format (det som styckpriserna räknas på).
const FROM_DB = { id: "Annons-ID", seller_id: "Säljar-ID", title: "Rubrik", model_number: "Modellnummer", status: "Status", price: "Pris", niche: "Nisch", text: "Text" };
export async function dbMarketRows(statuses, deps = {}) {
  const { rows } = await dataCall("/data/query", { statuses }, deps);
  return rows.map((r) => Object.fromEntries(Object.entries(FROM_DB).map(([col, key]) => [key, r[col] ?? ""])));
}
