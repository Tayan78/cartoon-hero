// Konkurrentanalys: alla annonser för en säljare på Tradera (aktiva och
// avslutade), grupperade på modellnummer. Visar vad säljaren säljer, vad det
// går för, hur stor andel som säljs och hur snabbt.
// Såld = status.gotWinner (gäller både auktion och Köp nu). Saknas statusen
// räknas auktioner med bud, eller Köp nu där antalet kvar minskat, som sålda.
import { traderaGet } from "./tradera.js";

const DAY = 24 * 60 * 60 * 1000;
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
  return {
    id,
    title,
    number: modelNumber(title),
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
  };
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

// Hämtar säljaren via alias och alla annonser: aktiva och avslutade senaste året.
export async function fetchSeller(alias, { get = traderaGet, now = Date.now() } = {}) {
  const name = String(alias ?? "").trim().replace(/^@/, "");
  if (!name) throw new Error("Ange säljarens alias");
  let user;
  try {
    user = await get(`/v4/users/by-alias/${encodeURIComponent(name)}`);
  } catch (err) {
    throw new Error(/404|not found|hittades/i.test(err.message) ? `Hittade ingen säljare med aliaset "${name}"` : err.message);
  }
  const userId = pick(user, "id") ?? pick(user, "userId");
  if (!userId) throw new Error(`Hittade ingen säljare med aliaset "${name}"`);
  const since = new Date(now - 365 * DAY).toISOString();
  const [activeList, endedList] = await Promise.all([
    get(`/v4/items/seller/${userId}?${new URLSearchParams({ filterActive: "1" })}`),
    get(`/v4/items/seller/${userId}?${new URLSearchParams({ filterActive: "2", minEndDate: since })}`),
  ]);
  const seen = new Set();
  const items = [];
  for (const raw of [...(Array.isArray(activeList) ? activeList : []), ...(Array.isArray(endedList) ? endedList : [])]) {
    const item = toSellerItem(raw, now);
    if (item.title && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return { alias: pick(user, "alias") ?? name, user_id: userId, ...sellerReport(items, now) };
}
