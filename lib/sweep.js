// Schleich-insamlingen: alla annonser med Schleich (och serienamn som bara är
// Schleich) på hela Tradera – aktiva och avslutade, oavsett säljare – till
// databasen. Sökningen ger högst 2 400 träffar (10 sidor à 240), så den delas
// upp i prisintervall tills varje del ryms. Avslutade Köp nu-annonser kollas i
// annonsdetaljen (såld eller inte), eftersom sökningen inte säger det.
import { dbPut, dbUnresolved } from "./db.js";
import { RUN_HEADERS } from "./marketdata.js";
import { nicheOf } from "./niches.js";
import { ITEM_TYPES } from "./seller.js";
import { seriesOf } from "./series.js";
import { callAppsScript } from "./storage.js";
import { searchAdvanced, traderaGet } from "./tradera.js";

export const SWEEP_QUERIES = ["schleich", "bayala", "eldrador"];
export const PER_PAGE = 240;
export const CAP = 2400;
const PRICE_MAX = 1_000_000;
// Startintervall (kr); ett intervall med fler än CAP träffar delas på mitten.
const BANDS = [[0, 49], [50, 99], [100, 199], [200, 399], [400, 799], [800, PRICE_MAX]];
export const RESOLVE_MAX = 600; // annonsdetaljer per körning (Traderas gräns: 10 000 per dygn)

const pick = (o, k) => o?.[k] ?? o?.[k[0].toUpperCase() + k.slice(1)];
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

function typeOf(raw) {
  const t = pick(raw, "itemType");
  if (ITEM_TYPES[t]) return ITEM_TYPES[t];
  if (/auction|auktion/i.test(String(t))) return "auktion";
  if (/shop/i.test(String(t))) return "butik";
  return "köp nu";
}

// En sökträff → en rad i databasen. Status: Aktiv, Såld/Osåld för auktioner;
// för avslutade Köp nu skickas ingen status (den sätts när detaljen kollats).
export function sweepRow(raw, ended, now = Date.now()) {
  const title = String(pick(raw, "shortDescription") ?? "").trim();
  const type = typeOf(raw);
  const bids = num(pick(raw, "bidCount"));
  const auction = type === "auktion";
  const price = auction ? (bids ? num(pick(raw, "maxBid")) : num(pick(raw, "nextBid"))) : num(pick(raw, "buyItNowPrice")) || num(pick(raw, "maxBid")) || num(pick(raw, "nextBid"));
  const status = !ended ? "Aktiv" : auction ? (bids ? "Såld" : "Osåld") : null;
  const stamp = new Date(now).toISOString();
  const id = pick(raw, "id");
  return {
    id: String(id),
    seller: pick(raw, "sellerAlias") ?? null,
    seller_id: pick(raw, "sellerId") != null ? String(pick(raw, "sellerId")) : null,
    title,
    type,
    status,
    price: price || null,
    bids,
    end_at: pick(raw, "endDate") ?? null,
    url: pick(raw, "itemUrl") || `https://www.tradera.com/item/${id}`,
    category_id: num(pick(raw, "categoryId")) || null,
    niche: nicheOf(title),
    series: seriesOf(title),
    raw: JSON.stringify(raw).slice(0, 4000),
    source: "sök",
    first_seen: stamp,
    last_seen: stamp,
    ...(status === "Såld" ? { sold_seen: stamp } : {}),
  };
}

// Alla träffar för ett sökord och en status, uppdelat i prisintervall.
export async function fetchAll(words, ended, { search = searchAdvanced, stats = { calls: 0, split: 0 } } = {}) {
  const page = (lo, hi, pageNumber) => {
    stats.calls++;
    return search({ searchWords: words, itemsPerPage: PER_PAGE, pageNumber, priceMinimum: lo, priceMaximum: hi, ...(ended ? { itemStatus: "Ended" } : {}) });
  };
  const band = async (lo, hi) => {
    const first = await page(lo, hi, 1);
    const total = Number(pick(first, "totalNumberOfItems")) || 0;
    if (total > CAP && hi > lo) {
      stats.split++;
      const mid = Math.floor((lo + hi) / 2);
      return [...(await band(lo, mid)), ...(await band(mid + 1, hi))];
    }
    const pages = Math.min(Math.ceil(total / PER_PAGE), CAP / PER_PAGE);
    const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => page(lo, hi, i + 2).catch(() => null)));
    return [first, ...rest].flatMap((d) => pick(d, "items") ?? []);
  };
  const out = [];
  for (const [lo, hi] of BANDS) out.push(...(await band(lo, hi)));
  return out;
}

// Avslutade Köp nu-annonser med okänt utfall: annonsdetaljen säger om de sålts.
export async function resolveEnded({ get = traderaGet, unresolved = dbUnresolved, put = dbPut, max = RESOLVE_MAX, now = Date.now() } = {}) {
  const ids = await unresolved(max);
  const rows = [];
  let errors = 0;
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map((id) =>
        get(`/v4/items/${id}`).then(
          (item) => {
            const status = pick(item, "status");
            const won = pick(status, "gotWinner");
            if (typeof won !== "boolean") return;
            const stamp = new Date(now).toISOString();
            rows.push({ id: String(id), status: won ? "Såld" : "Osåld", last_seen: stamp, ...(won ? { sold_seen: stamp } : {}) });
          },
          () => errors++,
        ),
      ),
    );
  }
  await put("listings", rows);
  return { checked: ids.length, resolved: rows.length, sold: rows.filter((r) => r.status === "Såld").length, errors };
}

// Hela insamlingen: sökorden × aktiva/avslutade → databasen, sedan utfallen.
export async function sweep({ search = searchAdvanced, put = dbPut, resolve = resolveEnded, now = Date.now(), queries = SWEEP_QUERIES } = {}) {
  const stats = { calls: 0, split: 0 };
  const rows = new Map();
  for (const ended of [true, false]) {
    for (const q of queries) {
      for (const raw of await fetchAll(q, ended, { search, stats })) {
        const row = sweepRow(raw, ended, now);
        if (row.id && row.title && !rows.has(row.id)) rows.set(row.id, row);
      }
    }
  }
  const list = [...rows.values()];
  await put("listings", list);
  const resolved = await resolve({ now });
  return {
    listings: list.length,
    active: list.filter((r) => r.status === "Aktiv").length,
    ended: list.filter((r) => r.status !== "Aktiv").length,
    searches: stats.calls,
    split: stats.split,
    resolved,
  };
}

// ---------- Körning med status ----------
// Status sparas i fliken Körningar (raden "schleich"), så att appen kan visa den.
const RUNS = { sheet: "Körningar", headers: RUN_HEADERS, key: "Namn" };
const STALE_MS = 10 * 60 * 1000;
const record = (store, fields) => store("sheetUpsert", { ...RUNS, rows: [{ Namn: "schleich", ...fields }] }).catch(() => {});

export async function sweepStatus({ store = callAppsScript, now = Date.now() } = {}) {
  const res = await store("sheetRead", { ...RUNS, filter: { column: "Namn", equals: "schleich" } }).catch(() => null);
  const r = res?.rows?.[0];
  if (!r) return null;
  const iso = (v) => (v instanceof Date ? v.toISOString() : v ? String(v) : "");
  const running = r.Status === "Pågår" && now - (Date.parse(iso(r.Senast)) || 0) < STALE_MS;
  return { status: r.Status === "Pågår" && !running ? "Avbruten" : r.Status, running, started: iso(r.Startad), last: iso(r.Senast), listings: Number(r.Klara) || 0, summary: r.Säljare || "" };
}

export async function runSweep({ store = callAppsScript, run = sweep, clock = Date.now } = {}) {
  const started = new Date(clock()).toISOString();
  await record(store, { Startad: started, Senast: started, Status: "Pågår", Klara: "", Kvar: "", Säljare: "" });
  try {
    const out = await run();
    const r = out.resolved ?? {};
    await record(store, {
      Senast: new Date(clock()).toISOString(),
      Status: "Klar",
      Klara: out.listings,
      Kvar: r.checked ?? "",
      Säljare: `${out.active} aktiva, ${out.ended} avslutade · ${out.searches} sökningar · ${r.resolved ?? 0} Köp nu-utfall kollade (${r.sold ?? 0} sålda)`,
    });
    return out;
  } catch (err) {
    await record(store, { Senast: new Date(clock()).toISOString(), Status: `Fel: ${err.message}`.slice(0, 200) });
    throw err;
  }
}
