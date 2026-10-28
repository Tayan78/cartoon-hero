// Marknadsdata för Schleich: hitta konkurrenter och samla in deras annonser
// till en egen databas i Google Sheet (flikarna "Säljare" och "Marknad").
// Tradera ger bara ca 8 veckor bakåt per säljare, så historiken byggs upp
// genom att samla in varje natt – en rad per annons, som uppdateras.
import { fetchSellerItems, modelNumber } from "./seller.js";
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

// En annons → en rad i fliken Marknad.
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

// Samlar in en säljare: hämtar annonserna (texten bara för nya annonser) och
// skriver dem till Sheet. store kan bytas i test.
export async function collectSeller({ alias, user_id }, { store = callAppsScript, fetchItems = fetchSellerItems, now = Date.now() } = {}) {
  const known = user_id ? await store("marketKnown", { seller_id: String(user_id) }) : { ok: true, ids: [] };
  if (!known.ok) throw new Error(known.error || "Kunde inte läsa Marknad");
  const result = await fetchItems(alias, { userId: user_id || null, skipDetail: new Set((known.ids ?? []).map(String)), now });
  const rows = result.items.map((i) => marketRow(i, result));
  const saved = await store("marketUpsert", { seller_id: String(result.user_id), alias: result.alias, rows, collected_at: new Date(now).toISOString() });
  if (!saved.ok) throw new Error(saved.error || "Kunde inte spara i Marknad");
  return { alias: result.alias, user_id: result.user_id, items: rows.length, added: saved.added ?? 0, updated: saved.updated ?? 0, detail: result.detail };
}
