// Marknadsdata för Schleich: hitta konkurrenter och samla in deras annonser till
// databasen (Cloudflare D1). Tradera ger bara en tid bakåt per säljare, så
// historiken byggs upp genom att samla in varje natt – en rad per annons.
// Google Sheet används inte längre av insamlingen (bara Apps Script-timern och
// den gamla flytten copyToDb läser arket).
import { dbLatestRun, dbPut, dbRun, dbSellerList, dbWrite } from "./db.js";
import { ANY_NICHE, getNiche, nicheOf } from "./niches.js";
import { fetchSellerItems, modelNumber } from "./seller.js";
import { productKey, productLinks } from "./products.js";
import { seriesOf } from "./series.js";
import { callAppsScript, storageConfigured } from "./storage.js";
import { searchAdvanced } from "./tradera.js";

const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const PER_PAGE = 240;
const MAX_PAGES = 10;

// Söker aktiva och avslutade annonser och grupperar dem per säljare. Säljare med
// minst minListings annonser föreslås som konkurrenter.
export async function discoverSellers({ niche: nicheId = "djur", search = searchAdvanced, minListings = 15 } = {}) {
  const niche = getNiche(nicheId);
  const query = niche.query;
  const run = async (status) => {
    const body = (pageNumber) => ({ searchWords: query, itemsPerPage: PER_PAGE, pageNumber, ...(status ? { itemStatus: status } : {}) });
    const first = await search(body(1));
    const pages = Math.min(Number(pick(first, "totalNumberOfPages")) || 1, MAX_PAGES);
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => search(body(i + 2)).catch(() => null)));
    return [first, ...rest].flatMap((d) => pick(d, "items") ?? []).map((item) => ({ item, ended: status === "Ended" }));
  };
  const all = [...(await run(null)), ...(await run("Ended"))];
  const seen = new Set();
  const sellers = new Map();
  for (const { item, ended } of all) {
    const id = pick(item, "id");
    const sellerId = pick(item, "sellerId");
    if (!sellerId || seen.has(id) || !niche.match(String(pick(item, "shortDescription") ?? ""))) continue;
    seen.add(id);
    const s = sellers.get(sellerId) ?? { id: sellerId, alias: pick(item, "sellerAlias") ?? "", total: 0, active: 0, ended: 0, with_bids: 0, with_number: 0, rating: null };
    s.total++;
    if (ended) s.ended++;
    else s.active++;
    if (pick(item, "hasBids") === true) s.with_bids++;
    if (modelNumber(pick(item, "shortDescription"))) s.with_number++;
    const dsr = Number(pick(item, "sellerDsrAverage"));
    if (Number.isFinite(dsr) && dsr > 0) s.rating = dsr;
    sellers.set(sellerId, s);
  }
  const list = [...sellers.values()]
    .filter((s) => s.total >= minListings)
    .map((s) => ({ ...s, number_share: Math.round((100 * s.with_number) / s.total) }))
    .sort((a, b) => b.total - a.total);
  return { niche: niche.id, label: niche.label, query, scanned: seen.size, sellers_found: sellers.size, sellers: list.slice(0, 60).map((s) => ({ ...s, niche: niche.id })) };
}

// ---------- Databasen i Google Sheet ----------
// Apps Script har bara generella funktioner (sheetRead/sheetUpsert/scheduleNightly);
// all logik ligger här.
export const SELLER_HEADERS = [
  "Säljar-ID", "Alias", "Bevakad", "Schleich-annonser", "Aktiva", "Avslutade", "Med nummer %", "Betyg",
  "Tillagd", "Senast insamlad", "Annonser i databasen", "Sålda i databasen", "Fel", "Nischer",
];
export const MARKET_HEADERS = [
  "Annons-ID", "Säljare", "Säljar-ID", "Rubrik", "Modellnummer", "Nummerkälla", "Typ", "Status", "Pris",
  "Första pris", "Lägsta pris", "Prisändringar", "Bud", "Frakt", "Skick", "Start", "Slut", "Dagar",
  "Omstarter", "Länk", "Först sedd", "Senast sedd", "Såld upptäckt", "Text", "Nisch",
];
const SELLERS = { sheet: "Säljare", headers: SELLER_HEADERS };
const MARKET = { sheet: "Marknad", headers: MARKET_HEADERS };

async function sheetCall(store, action, payload) {
  const res = await store(action, payload);
  if (!res?.ok) {
    const msg = res?.error || "Google Sheet svarade inte";
    throw new Error(/okänd action/i.test(msg) ? "Apps Script behöver uppdateras (ny version av Code.gs)" : msg);
  }
  return res;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ? String(v) : "");

// Säljarna ligger i databasen. Första gången (bara i arket) kopieras de dit.
const NONE = /(?!)/; // matchar inget: säljarinsamlingen hämtar inga beskrivningar
const fromDb = (r) => ({
  id: String(r.id),
  alias: r.alias,
  watched: Number(r.watched) === 1,
  own: Number(r.own) === 1,
  total: r.listings_found ?? "",
  active: r.active ?? "",
  ended: r.ended ?? "",
  number_share: r.number_share ?? "",
  rating: r.rating ?? "",
  collected: r.collected_at ?? "",
  in_db: Number(r.in_db) || 0,
  sold_in_db: Number(r.sold_in_db) || 0,
  error: r.error || "",
  niches: String(r.niches || "").split(",").filter(Boolean),
});

export async function listSellers({ list = dbSellerList, store = callAppsScript, importRows = dbWrite } = {}) {
  let rows = await list({});
  if (!rows.some((r) => Number(r.watched) === 1) && (store !== callAppsScript || storageConfigured())) {
    const sheet = await sheetCall(store, "sheetRead", SELLERS).then((r) => r.rows.filter((x) => x["Säljar-ID"]), () => []);
    if (sheet.length) {
      await importRows("sellers", sheet);
      rows = await list({});
    }
  }
  return rows.map(fromDb).filter((s) => s.id);
}

// Bevaka (eller sluta bevaka). Nattkörningen (Apps Script-timern) är på när minst en säljare bevakas.
export async function watchSeller(seller, watch, { list = dbSellerList, put = dbPut, store = callAppsScript, url, now = Date.now() } = {}) {
  const existing = (await listSellers({ list, store })).find((s) => s.id === String(seller.id));
  const row = { id: String(seller.id), alias: seller.alias, watched: watch ? 1 : 0 };
  if (seller.niche) row.niches = [...new Set([...(existing?.niches ?? []), seller.niche])].join(",");
  if (!existing) {
    Object.assign(row, {
      listings_found: seller.total ?? null,
      active: seller.active ?? null,
      ended: seller.ended ?? null,
      number_share: seller.number_share ?? null,
      rating: seller.rating ?? null,
      added_at: new Date(now).toISOString(),
    });
  }
  await put("sellers", [row]);
  const anyWatched = (await listSellers({ list, store })).some((s) => s.watched);
  if (store !== callAppsScript || storageConfigured()) await sheetCall(store, "scheduleNightly", { url, enabled: anyWatched }).catch(() => {});
  return { id: String(seller.id), alias: seller.alias };
}

// En annons → en rad i fliken Marknad (internt format).
export function marketRow(item, seller) {
  return {
    id: String(item.id),
    seller: seller.alias,
    seller_id: String(seller.user_id),
    title: item.title,
    number: item.number,
    number_source: item.number_source,
    type: item.type,
    status: item.sold ? "Såld" : item.ended ? "Osåld" : "Aktiv",
    price: item.price || "",
    bids: item.bids,
    shipping: item.shipping ?? "",
    condition: item.condition,
    start: item.start,
    end: item.end,
    days: item.days ?? "",
    restarts: item.restarts,
    url: item.url,
    text: item.text,
    category_id: item.category_id ?? null,
    raw: item.raw ?? null,
    source: "säljare",
  };
}

// Ny data för en annons + raden som redan finns → fälten som ska skrivas. Första
// pris, lägsta pris och antal prisändringar (bara Köp nu) följer med över tid.
// Tomt nummer, skick eller text skriver inte över det som redan finns.
export function mergeMarketRow(old, x, now) {
  const row = {
    "Annons-ID": x.id, Säljare: x.seller, "Säljar-ID": x.seller_id, Rubrik: x.title, Typ: x.type, Status: x.status,
    Pris: x.price, Bud: x.bids, Frakt: x.shipping, Start: x.start, Slut: x.end, Dagar: x.days, Omstarter: x.restarts,
    Länk: x.url, "Senast sedd": now,
  };
  if (x.number) Object.assign(row, { Modellnummer: x.number, Nummerkälla: x.number_source });
  if (x.condition) row.Skick = x.condition;
  if (x.text) row.Text = x.text;
  // Bara till databasen (arket har inte kolumnerna och hoppar över dem).
  if (x.category_id) row.Kategori = x.category_id;
  if (x.raw) row.Rådata = x.raw;
  if (x.source) row.Källa = x.source;
  const niche = nicheOf(`${x.title} ${x.text || old?.Text || ""}`);
  if (niche) row.Nisch = niche;
  if (!old) {
    Object.assign(row, { "Första pris": x.price, "Lägsta pris": x.price, Prisändringar: 0, "Först sedd": now });
  } else if (x.type !== "auktion") {
    const prev = Number(old.Pris) || 0;
    if (x.price && prev && Number(x.price) !== prev) row.Prisändringar = (Number(old.Prisändringar) || 0) + 1;
    const low = Number(old["Lägsta pris"]) || 0;
    if (x.price && (!low || Number(x.price) < low)) row["Lägsta pris"] = x.price;
  }
  if (x.status === "Såld" && old?.Status !== "Såld") row["Såld upptäckt"] = now;
  return row;
}

// En annons från säljarens lista → en rad i databasen. Första och lägsta pris,
// prisändringar och prishistorik räknar databasen fram själv.
export function sellerDbRow(item, seller, stamp) {
  const status = item.sold ? "Såld" : item.ended ? "Osåld" : "Aktiv";
  return {
    id: String(item.id),
    seller: seller.alias,
    seller_id: String(seller.user_id),
    title: item.title,
    ...(item.number ? { model_number: item.number, number_source: item.number_source || null } : {}),
    type: item.type || null,
    status,
    price: item.price || null,
    bids: item.bids ?? null,
    shipping: item.shipping ?? null,
    condition: item.condition || null,
    start_at: item.start || null,
    end_at: item.end || null,
    days: item.days ?? null,
    restarts: item.restarts ?? null,
    url: item.url || null,
    text: item.text || null,
    category_id: item.category_id ?? null,
    raw: item.raw ?? null,
    source: "säljare",
    niche: nicheOf(`${item.title} ${item.text ?? ""}`),
    series: seriesOf(item.title),
    first_seen: stamp,
    last_seen: stamp,
    ...(status === "Såld" ? { sold_seen: stamp } : {}),
    products: products(item),
  };
}

// Produktkopplingen: rubrik/text, annars numret säljarens svar redan gav.
function products(item) {
  const links = productLinks({ title: item.title, text: item.text });
  if (links.length || !item.number || !ANY_NICHE.test(`${item.title} ${item.text ?? ""}`)) return links;
  return [{ key: productKey(item.number), model_number: item.number, method: item.number_source || "text", confidence: 0.8 }];
}

// Samlar in en säljare: bara listan (2 anrop), inga beskrivningar – de hämtas
// av annonsdetaljerna, en gång per annons. Schleich och Smurfar sparas; för ditt
// eget konto allt.
export async function collectSeller({ alias, user_id, own = false }, { put = dbPut, fetchItems = fetchSellerItems, now = Date.now() } = {}) {
  if (!user_id) throw new Error("Säljarens id saknas");
  const stamp = new Date(now).toISOString();
  const result = await fetchItems(alias, { userId: user_id, now, detailFor: NONE });
  const items = own ? result.items : result.items.filter((i) => ANY_NICHE.test(`${i.title ?? ""} ${i.text ?? ""}`));
  const seller = { alias: result.alias, user_id: result.user_id };
  let dbError = null;
  try {
    await put("listings", items.map((i) => sellerDbRow(i, seller, stamp)));
  } catch (err) {
    dbError = err.message;
  }
  await put("sellers", [{ id: String(result.user_id), alias: result.alias, collected_at: stamp, error: dbError ?? "" }]).catch(() => {});
  return { alias: result.alias, user_id: result.user_id, items: items.length, all_items: result.items.length, db_error: dbError };
}

// ---------- Insamling i bakgrunden ----------
// Status och förlopp ligger i databasen (runs). Varje steg kör säljare fyra åt
// gången så länge tiden räcker (ca 50 s); sedan startar servern nästa steg själv.
export const RUN_HEADERS = ["Namn", "Startad", "Senast", "Status", "Klara", "Kvar", "Säljare"];
const RUN = "marknad";
const STALE_MS = 3 * 60 * 1000; // inget livstecken på 3 min = körningen har stannat
const PARALLEL = 4;

export async function runStatus({ latest = dbLatestRun, now = Date.now() } = {}) {
  const r = await latest(RUN).catch(() => null);
  if (!r) return { running: false, status: "" };
  const last = Date.parse(r.updated_at || r.started_at) || 0;
  const stale = r.status === "Pågår" && now - last >= STALE_MS;
  const m = /(\d+) klara, (\d+) kvar/.exec(r.summary ?? "");
  return {
    running: r.status === "Pågår" && !stale,
    status: stale ? "Avbruten" : r.status,
    started: r.started_at,
    last: r.updated_at || r.started_at,
    done: m ? Number(m[1]) : 0,
    left: m ? Number(m[2]) : 0,
    summary: r.summary ?? "",
  };
}

// Startar en körning (alla bevakade + ditt konto, eller bara only = [säljar-id]) om ingen pågår.
export async function startRun(only = null, { latest = dbLatestRun, run = dbRun, now = Date.now() } = {}) {
  const status = await runStatus({ latest, now });
  if (status.running) return { started: false, status };
  const runId = await run({ name: RUN, started_at: new Date(now).toISOString(), summary: only ? `${only.length} säljare (för hand)` : "alla bevakade" });
  return { started: true, state: { done: [], only, run_id: runId, failed: 0 } };
}

// Ett steg: den som väntat längst först, fyra åt gången. Fel sparas på säljaren.
export async function runStep(state, { list = dbSellerList, put = dbPut, collect = collectSeller, run = dbRun, budgetMs = 50_000, clock = Date.now } = {}) {
  const started = clock();
  const done = new Set(state?.done ?? []);
  const only = state?.only ? new Set(state.only.map(String)) : null;
  const queue = (await listSellers({ list }))
    .filter((s) => (only ? only.has(s.id) : s.watched || s.own) && !done.has(s.id))
    .sort((a, b) => String(a.collected).localeCompare(String(b.collected)));
  let ran = 0;
  let failed = Number(state?.failed) || 0;
  while (ran < queue.length && (ran === 0 || clock() - started <= budgetMs)) {
    const batch = queue.slice(ran, ran + PARALLEL);
    ran += batch.length;
    await Promise.all(
      batch.map(async (s) => {
        done.add(s.id);
        try {
          await collect({ alias: s.alias, user_id: s.id, own: s.own }, { put });
        } catch (err) {
          failed++;
          await put("sellers", [{ id: s.id, error: String(err.message).slice(0, 300) }]).catch(() => {});
        }
      }),
    );
    if (state?.run_id) await run({ id: state.run_id, progress: true, summary: `${done.size} klara, ${queue.length - ran} kvar` });
  }
  const more = ran < queue.length;
  if (!more && state?.run_id) {
    await run({ id: state.run_id, finished_at: new Date(clock()).toISOString(), status: failed ? `Klar, ${failed} fel` : "Klar", summary: `${done.size} säljare insamlade${failed ? `, ${failed} med fel` : ""}` });
  }
  return { ran, more, state: { done: [...done], only: state?.only ?? null, run_id: state?.run_id ?? null, failed } };
}

// ---------- Flytt till databasen ----------
// Kopierar Säljare och Marknad från arket till databasen, limit annonser per anrop
// (appen anropar igen med next tills allt är kopierat). Raderna skrivs med upsert,
// så det går att köra om utan dubbletter.
export async function copyToDb({ offset = 0, limit = 5000, store = callAppsScript, db = dbWrite } = {}) {
  const [sellers, market] = await Promise.all([
    offset === 0 ? sheetCall(store, "sheetRead", SELLERS) : null,
    sheetCall(store, "sheetRead", MARKET),
  ]);
  if (sellers) await db("sellers", sellers.rows.filter((r) => r["Säljar-ID"]));
  const rows = market.rows.filter((r) => r["Annons-ID"]);
  const part = rows.slice(offset, offset + limit);
  await db("listings", part);
  const next = offset + part.length;
  return { total: rows.length, copied: next, sellers: sellers?.rows.length ?? null, done: next >= rows.length, next };
}
