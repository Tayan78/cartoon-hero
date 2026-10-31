// Konkurrentanalys: alla annonser för en säljare på Tradera (aktiva och
// avslutade), grupperade på modellnummer. Visar vad säljaren säljer, vad det
// går för, hur stor andel som säljs och hur snabbt.
// Såld = status.gotWinner (gäller både auktion och Köp nu). Saknas statusen
// räknas auktioner med bud, eller Köp nu där antalet kvar minskat, som sålda.
import { ANY_NICHE } from "./niches.js";
import { traderaGet } from "./tradera.js";

const DAY = 24 * 60 * 60 * 1000;
const DETAIL_MAX = 400;
const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Modellnummer ur rubriken: 4–6 siffror som inte är ett årtal.
export function modelNumber(title) {
  return (String(title ?? "").match(/\b\d{4,6}\b/g) ?? []).find((n) => !/^(19|20)\d\d$/.test(n)) ?? "";
}

// Modellnummer ur annonstexten, när rubriken saknar det. Bara femsiffriga nummer
// (Schleichs format). Ett ensamt nummer gäller; finns flera gäller det som står
// intill "Schleich", "art.nr", "nr" eller "modell" – annars är det osäkert.
export function numberFromText(text) {
  const t = String(text ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  const found = [...new Set((t.match(/\b\d{5}\b/g) ?? []).filter(Boolean))];
  if (found.length === 1) return { number: found[0], ambiguous: false };
  if (!found.length) return { number: "", ambiguous: false };
  const near = found.filter((n) => new RegExp(`(schleich|art\\.?\\s*nr|artikel|nr\\.?|nummer|modell)[^\\d]{0,15}${n}\\b`, "i").test(t));
  return near.length === 1 ? { number: near[0], ambiguous: false } : { number: "", ambiguous: true };
}

// Billigaste fraktsättet (kr), eller null om inget anges.
function shippingCost(options) {
  const costs = (Array.isArray(options) ? options : []).map((o) => Number(pick(o, "cost"))).filter((c) => Number.isFinite(c) && c >= 0);
  return costs.length ? Math.min(...costs) : null;
}

// Kategoriattribut som text, t.ex. "Gott skick".
export function conditionText(values) {
  const terms = pick(values, "termAttributeValues");
  return (Array.isArray(terms) ? terms : [])
    .flatMap((t) => pick(t, "values") ?? [])
    .filter((v) => typeof v === "string")
    .join(", ");
}

export const ITEM_TYPES = { 1: "auktion", 3: "köp nu", 4: "butik", 5: "butik" };

export function toSellerItem(item, now = Date.now()) {
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const status = pick(item, "status");
  const end = pick(item, "endDate") ?? "";
  const start = pick(item, "startDate") ?? "";
  const type = ITEM_TYPES[pick(item, "itemType")] ?? String(pick(item, "itemType") ?? "");
  const bids = num(pick(item, "totalBids"));
  const startQty = num(pick(item, "startQuantity"));
  const leftQty = Number(pick(item, "remainingQuantity"));
  const ended = pick(status, "ended") === true || (Date.parse(end) || Infinity) < now;
  const hasStatus = status && typeof pick(status, "gotWinner") === "boolean";
  const sold = hasStatus
    ? pick(status, "gotWinner") === true
    : type === "auktion"
      ? ended && bids > 0
      : startQty > 0 && Number.isFinite(leftQty) && leftQty < startQty;
  const buyNow = num(pick(item, "buyItNowPrice"));
  const price = type === "auktion" && bids > 0 ? num(pick(item, "maxBid")) || buyNow : buyNow || num(pick(item, "maxBid")) || num(pick(item, "openingBid"));
  const days = Date.parse(start) && Date.parse(end) ? Math.max(0, Math.round((Math.min(Date.parse(end), now) - Date.parse(start)) / DAY)) : null;
  const id = pick(item, "id");
  const fromTitle = modelNumber(title);
  const description = pick(item, "longDescription");
  const fromText = fromTitle ? null : numberFromText(description);
  return {
    id,
    title,
    number: fromTitle || fromText?.number || "",
    number_source: fromTitle ? "rubrik" : fromText?.number ? "text" : "",
    number_ambiguous: Boolean(fromText?.ambiguous),
    has_description: typeof description === "string" && description.length > 0,
    url: pick(item, "itemLink") || (id ? `https://www.tradera.com/item/${id}` : ""),
    type,
    start,
    end,
    ended,
    sold,
    price,
    bids,
    days,
    restarts: num(pick(item, "restarts")),
    has_status: Boolean(hasStatus),
    shipping: shippingCost(pick(item, "shippingOptions")),
    condition: conditionText(pick(item, "attributeValues")),
    text: String(description ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 500),
    category_id: num(pick(item, "categoryId")) || null,
    // Traderas svar (utan den långa beskrivningen) sparas i databasen, så att nya
    // tolkningar (nischer, serier, attribut) kan göras i efterhand utan ny hämtning.
    raw: rawJson(item),
  };
}

const RAW_MAX = 4000;
// Köparnas uppgifter (personuppgifter) sparas aldrig.
export const BUYER_FIELDS = ["maxBidder", "buyerList", "acceptedBuyerId", "MaxBidder", "BuyerList", "AcceptedBuyerId"];
function rawJson(item) {
  const { longDescription, LongDescription, ...rest } = item ?? {};
  for (const f of BUYER_FIELDS) delete rest[f];
  const json = JSON.stringify(rest);
  return json.length > RAW_MAX ? json.slice(0, RAW_MAX) : json;
}

// Sammanställning: översikt, de vanligaste priserna och en rad per modellnummer.
export function sellerReport(items, now = Date.now()) {
  const ended = items.filter((i) => i.ended);
  const sold = items.filter((i) => i.sold);
  const active = items.filter((i) => !i.ended);
  const byNumber = new Map();
  for (const i of items) {
    const key = i.number || "";
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key).push(i);
  }
  const models = [...byNumber.entries()]
    .filter(([key]) => key)
    .map(([number, list]) => {
      const s = list.filter((i) => i.sold);
      const e = list.filter((i) => i.ended);
      const a = list.filter((i) => !i.ended);
      const soldPrices = s.map((i) => i.price).filter(Boolean);
      return {
        number,
        title: (s[0] ?? list[0]).title,
        listed: list.length,
        sold: s.length,
        ended: e.length,
        sell_through: e.length ? Math.round((100 * s.length) / e.length) : null,
        median_sold: median(soldPrices),
        low: soldPrices.length ? Math.min(...soldPrices) : null,
        high: soldPrices.length ? Math.max(...soldPrices) : null,
        days_to_sell: median(s.map((i) => i.days).filter((d) => d != null)),
        active: a.length,
        active_price: median(a.map((i) => i.price).filter(Boolean)),
      };
    })
    .sort((x, y) => y.sold - x.sold || (y.median_sold ?? 0) - (x.median_sold ?? 0));
  const priceCount = {};
  for (const i of items) if (i.price && i.type !== "auktion") priceCount[i.price] = (priceCount[i.price] ?? 0) + 1;
  const types = {};
  for (const i of items) types[i.type] = (types[i.type] ?? 0) + 1;
  return {
    fetched_at: new Date(now).toISOString(),
    total: items.length,
    active: active.length,
    ended: ended.length,
    sold: sold.length,
    sell_through: ended.length ? Math.round((100 * sold.length) / ended.length) : null,
    median_sold: median(sold.map((i) => i.price).filter(Boolean)),
    days_to_sell: median(sold.map((i) => i.days).filter((d) => d != null)),
    oldest: items.reduce((min, i) => (i.end && (!min || i.end < min) ? i.end : min), ""),
    with_number: items.filter((i) => i.number).length,
    number_from_text: items.filter((i) => i.number_source === "text").length,
    number_ambiguous: items.filter((i) => i.number_ambiguous).length,
    with_description: items.filter((i) => i.has_description).length,
    with_status: items.filter((i) => i.has_status).length,
    types,
    prices: Object.entries(priceCount)
      .map(([price, count]) => ({ price: Number(price), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    models,
    items: [...items].sort((a, b) => String(b.end).localeCompare(String(a.end))).slice(0, 400),
  };
}

// Säljarens id: från aliaset, eller direkt om det redan är känt.
async function resolveSeller(alias, userId, get) {
  const name = String(alias ?? "").trim().replace(/^@/, "");
  if (userId) return { alias: name, userId };
  if (!name) throw new Error("Ange säljarens alias");
  let user;
  try {
    user = await get(`/v4/users/by-alias/${encodeURIComponent(name)}`);
  } catch (err) {
    throw new Error(/404|not found|hittades/i.test(err.message) ? `Hittade ingen säljare med aliaset "${name}"` : err.message);
  }
  const id = pick(user, "id") ?? pick(user, "userId");
  if (!id) throw new Error(`Hittade ingen säljare med aliaset "${name}"`);
  return { alias: pick(user, "alias") ?? name, userId: id };
}

// Alla annonser för en säljare: aktiva och avslutade (Tradera ger ca 8 veckor bakåt).
// Saknar rubriken nummer och listan texten hämtas annonsen en och en (högst
// DETAIL_MAX, 10 åt gången) – utom de i skipDetail (redan hämtade tidigare).
// only: bara annonser vars rubrik eller text matchar (t.ex. SCHLEICH).
export const SCHLEICH = /schleich/i;
// only: bara annonser som matchar (övriga hoppas över). detailFor: hämta bara
// beskrivningen för annonser som matchar (övriga följer med utan).
export async function fetchSellerItems(alias, { get = traderaGet, now = Date.now(), userId = null, skipDetail = new Set(), only = null, detailFor = null } = {}) {
  const seller = await resolveSeller(alias, userId, get);
  const since = new Date(now - 365 * DAY).toISOString();
  const [activeList, endedList] = await Promise.all([
    get(`/v4/items/seller/${seller.userId}?${new URLSearchParams({ filterActive: "1" })}`),
    get(`/v4/items/seller/${seller.userId}?${new URLSearchParams({ filterActive: "2", minEndDate: since })}`),
  ]);
  const seen = new Set();
  const raws = [];
  for (const raw of [...(Array.isArray(activeList) ? activeList : []), ...(Array.isArray(endedList) ? endedList : [])]) {
    const id = pick(raw, "id");
    if (seen.has(id)) continue;
    seen.add(id);
    if (only && !only.test(`${pick(raw, "shortDescription") ?? ""} ${pick(raw, "longDescription") ?? ""}`)) continue;
    raws.push(raw);
  }
  const hasText = (r) => String(pick(r, "longDescription") ?? "").replace(/<[^>]+>/g, "").trim().length > 0;
  const missing = raws
    .filter((r) => !detailFor || detailFor.test(String(pick(r, "shortDescription") ?? "")))
    .filter((r) => !modelNumber(pick(r, "shortDescription")) && !hasText(r) && !skipDetail.has(String(pick(r, "id"))))
    .slice(0, DETAIL_MAX);
  let errors = 0;
  for (let i = 0; i < missing.length; i += 10) {
    await Promise.all(
      missing.slice(i, i + 10).map((r) =>
        get(`/v4/items/${pick(r, "id")}`).then(
          (full) => (r.longDescription = pick(full, "longDescription") ?? ""),
          () => errors++,
        ),
      ),
    );
  }
  return {
    alias: seller.alias,
    user_id: seller.userId,
    items: raws.map((r) => toSellerItem(r, now)).filter((i) => i.title),
    detail: { fetched: missing.length, errors },
  };
}

// Konkurrentvyn: säljarens annonser sammanställda per modellnummer.
export async function fetchSeller(alias, { get = traderaGet, now = Date.now() } = {}) {
  const { items, ...rest } = await fetchSellerItems(alias, { get, now, only: ANY_NICHE });
  return { ...rest, ...sellerReport(items, now) };
}
