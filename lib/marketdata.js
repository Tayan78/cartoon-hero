// Marknadsdata för Schleich: hitta konkurrenter och samla in deras annonser
// till en egen databas i Google Sheet (flikarna "Säljare" och "Marknad").
// Tradera ger bara ca 8 veckor bakåt per säljare, så historiken byggs upp
// genom att samla in varje natt – en rad per annons, som uppdateras.
import { SCHLEICH, fetchSellerItems, modelNumber } from "./seller.js";
import { callAppsScript } from "./storage.js";
import { searchAdvanced } from "./tradera.js";

const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const PER_PAGE = 240;
const MAX_PAGES = 10;

// Söker aktiva och avslutade annonser och grupperar dem per säljare. Säljare med
// minst minListings annonser föreslås som konkurrenter.
export async function discoverSellers({ query = "schleich", search = searchAdvanced, minListings = 15 } = {}) {
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
    if (!sellerId || seen.has(id)) continue;
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
  return { query, scanned: seen.size, sellers_found: sellers.size, sellers: list.slice(0, 60) };
}

// ---------- Databasen i Google Sheet ----------
// Apps Script har bara generella funktioner (sheetRead/sheetUpsert/scheduleNightly);
// all logik ligger här.
export const SELLER_HEADERS = [
  "Säljar-ID", "Alias", "Bevakad", "Schleich-annonser", "Aktiva", "Avslutade", "Med nummer %", "Betyg",
  "Tillagd", "Senast insamlad", "Annonser i databasen", "Sålda i databasen", "Fel",
];
export const MARKET_HEADERS = [
  "Annons-ID", "Säljare", "Säljar-ID", "Rubrik", "Modellnummer", "Nummerkälla", "Typ", "Status", "Pris",
  "Första pris", "Lägsta pris", "Prisändringar", "Bud", "Frakt", "Skick", "Start", "Slut", "Dagar",
  "Omstarter", "Länk", "Först sedd", "Senast sedd", "Såld upptäckt", "Text",
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
const toSeller = (o) => ({
  id: String(o["Säljar-ID"]),
  alias: o.Alias,
  watched: o.Bevakad === "Ja",
  total: o["Schleich-annonser"],
  active: o.Aktiva,
  ended: o.Avslutade,
  number_share: o["Med nummer %"],
  rating: o.Betyg,
  collected: iso(o["Senast insamlad"]),
  in_db: Number(o["Annonser i databasen"]) || 0,
  sold_in_db: Number(o["Sålda i databasen"]) || 0,
  error: o.Fel || "",
});

export async function listSellers({ store = callAppsScript } = {}) {
  return (await sheetCall(store, "sheetRead", SELLERS)).rows.map(toSeller).filter((s) => s.id);
}

// Bevaka (eller sluta bevaka). Nattkörningen är på när minst en säljare bevakas.
export async function watchSeller(seller, watch, { store = callAppsScript, url, now = Date.now() } = {}) {
  const existing = (await listSellers({ store })).find((s) => s.id === String(seller.id));
  const row = { "Säljar-ID": String(seller.id), Alias: seller.alias, Bevakad: watch ? "Ja" : "Nej" };
  if (!existing) {
    Object.assign(row, {
      "Schleich-annonser": seller.total ?? "",
      Aktiva: seller.active ?? "",
      Avslutade: seller.ended ?? "",
      "Med nummer %": seller.number_share ?? "",
      Betyg: seller.rating ?? "",
      Tillagd: new Date(now).toISOString(),
      "Annonser i databasen": 0,
      "Sålda i databasen": 0,
    });
  }
  await sheetCall(store, "sheetUpsert", { ...SELLERS, key: "Säljar-ID", rows: [row] });
  const anyWatched = (await listSellers({ store })).some((s) => s.watched);
  await sheetCall(store, "scheduleNightly", { url, enabled: anyWatched });
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

// Samlar in en säljare: hämtar Schleich-annonserna (texten bara för nya),
// uppdaterar Marknad och tar bort säljarens rader som inte är Schleich.
export async function collectSeller({ alias, user_id }, { store = callAppsScript, fetchItems = fetchSellerItems, now = Date.now() } = {}) {
  if (!user_id) throw new Error("Säljarens id saknas");
  const stamp = new Date(now).toISOString();
  const existing = (await sheetCall(store, "sheetRead", { ...MARKET, filter: { column: "Säljar-ID", equals: String(user_id) } })).rows;
  const byId = new Map(existing.map((r) => [String(r["Annons-ID"]), r]));
  const skip = new Set(existing.filter((r) => r.Text || r.Modellnummer).map((r) => String(r["Annons-ID"])));
  const result = await fetchItems(alias, { userId: user_id, skipDetail: skip, now, only: SCHLEICH });
  const rows = result.items.map((i) => mergeMarketRow(byId.get(String(i.id)), marketRow(i, result), stamp));
  const fresh = new Set(rows.map((r) => r["Annons-ID"]));
  const remove = existing
    .filter((r) => !fresh.has(String(r["Annons-ID"])) && !SCHLEICH.test(`${r.Rubrik ?? ""} ${r.Text ?? ""}`))
    .map((r) => String(r["Annons-ID"]));
  const saved = await sheetCall(store, "sheetUpsert", { ...MARKET, key: "Annons-ID", rows, remove });

  // Säljarens siffror: allt i databasen för säljaren efter uppdateringen.
  const status = new Map(existing.map((r) => [String(r["Annons-ID"]), r.Status]));
  for (const r of rows) status.set(r["Annons-ID"], r.Status);
  for (const id of remove) status.delete(id);
  await sheetCall(store, "sheetUpsert", {
    ...SELLERS,
    key: "Säljar-ID",
    rows: [{ "Säljar-ID": String(result.user_id), Alias: result.alias, "Senast insamlad": stamp, Fel: "", "Annonser i databasen": status.size, "Sålda i databasen": [...status.values()].filter((s) => s === "Såld").length }],
  });
  return { alias: result.alias, user_id: result.user_id, items: rows.length, added: saved.added ?? 0, updated: saved.updated ?? 0, removed: saved.removed ?? 0, detail: result.detail };
}

// ---------- Insamling i bakgrunden ----------
// En körning samlar in säljare en i taget (Sheet skriver en åt gången). Varje
// steg kör så många säljare som hinns på ca 50 s; sedan startar servern nästa
// steg själv. Status sparas i fliken Körningar, så att appen kan visa hur det går
// och man inte behöver vänta.
export const RUN_HEADERS = ["Namn", "Startad", "Senast", "Status", "Klara", "Kvar", "Säljare"];
const RUNS = { sheet: "Körningar", headers: RUN_HEADERS };
const RUN = "marknad";
const STALE_MS = 3 * 60 * 1000; // inget livstecken på 3 min = körningen har stannat

const setRun = (store, fields) => sheetCall(store, "sheetUpsert", { ...RUNS, key: "Namn", rows: [{ Namn: RUN, ...fields }] });

export async function runStatus({ store = callAppsScript, now = Date.now() } = {}) {
  const r = (await sheetCall(store, "sheetRead", { ...RUNS, filter: { column: "Namn", equals: RUN } })).rows[0];
  if (!r) return { running: false, status: "" };
  const last = Date.parse(iso(r.Senast)) || 0;
  return {
    running: r.Status === "Pågår" && now - last < STALE_MS,
    status: r.Status === "Pågår" && now - last >= STALE_MS ? "Avbruten" : r.Status,
    started: iso(r.Startad),
    last: iso(r.Senast),
    done: Number(r.Klara) || 0,
    left: Number(r.Kvar) || 0,
  };
}

// Startar en körning (alla bevakade, eller bara only = [säljar-id]) om ingen pågår.
export async function startRun(only = null, { store = callAppsScript, now = Date.now() } = {}) {
  const status = await runStatus({ store, now });
  if (status.running) return { started: false, status };
  const stamp = new Date(now).toISOString();
  await setRun(store, { Startad: stamp, Senast: stamp, Status: "Pågår", Klara: 0, Kvar: "", Säljare: (only ?? []).join(",") });
  return { started: true, state: { done: [], only } };
}

// Ett steg: den som väntat längst först, så länge tiden räcker. Livstecken efter
// varje säljare; fel sparas på säljaren. more = det finns säljare kvar.
export async function runStep(state, { store = callAppsScript, collect = collectSeller, budgetMs = 50_000, clock = Date.now } = {}) {
  const started = clock();
  const done = new Set(state?.done ?? []);
  const only = state?.only ? new Set(state.only.map(String)) : null;
  const queue = (await listSellers({ store }))
    .filter((s) => (only ? only.has(s.id) : s.watched) && !done.has(s.id))
    .sort((a, b) => a.collected.localeCompare(b.collected));
  let ran = 0;
  for (const s of queue) {
    if (ran && clock() - started > budgetMs) break;
    done.add(s.id);
    ran++;
    try {
      await collect({ alias: s.alias, user_id: s.id }, { store });
    } catch (err) {
      await store("sheetUpsert", { ...SELLERS, key: "Säljar-ID", rows: [{ "Säljar-ID": s.id, Fel: err.message }] }).catch(() => {});
    }
    await setRun(store, { Senast: new Date(clock()).toISOString(), Klara: done.size, Kvar: queue.length - ran }).catch(() => {});
  }
  const more = ran < queue.length;
  if (!more) await setRun(store, { Status: "Klar", Senast: new Date(clock()).toISOString(), Kvar: 0 }).catch(() => {});
  return { ran, more, state: { done: [...done], only: state?.only ?? null } };
}
