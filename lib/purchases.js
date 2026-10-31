// Inköp: dina köpta partier, loppisfynd och gammalt lager. Ett inköp kan fyllas
// i från en Tradera-länk (pris, frakt, köparskydd, antal, bild) och sparas i
// databasen; annonserna kopplas till inköpet när de fotas.
import { dbConfigured } from "./db.js";
import { buyerFee, countFigures } from "./lots.js";
import { traderaGet } from "./tradera.js";

// Ditt eget Tradera-konto – fast, behöver aldrig ändras.
export const OWN_ALIAS = "Joulupukkin";

const pick = (o, k) => o?.[k] ?? o?.[k[0].toUpperCase() + k.slice(1)];
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

// Annons-id ur en Tradera-länk (…/item/<kategori>/<id>/… eller …/item/<id>) eller ett rent nummer.
export function traderaItemId(link) {
  const s = String(link ?? "").trim();
  return s.match(/tradera\.com\/item\/(?:\d+\/)?(\d{6,})/i)?.[1] ?? s.match(/^\d{6,}$/)?.[0] ?? null;
}

// Tradera-annonsen → förslag på inköp (du kan ändra allt innan du sparar).
export function purchaseFromItem(item, link = "") {
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const auction = /auction|^1$/i.test(String(pick(item, "itemType") ?? "")) || num(pick(item, "totalBids")) > 0;
  const price = auction ? num(pick(item, "maxBid")) || num(pick(item, "buyItNowPrice")) : num(pick(item, "buyItNowPrice")) || num(pick(item, "maxBid"));
  const costs = (pick(item, "shippingOptions") ?? []).map((o) => Number(pick(o, "cost"))).filter((c) => Number.isFinite(c) && c > 0);
  const shipping = costs.length ? Math.min(...costs) : 0;
  const fees = price ? buyerFee(price) : 0;
  const end = pick(item, "endDate");
  return {
    source: "tradera",
    url: link || pick(item, "itemLink") || "",
    tradera_id: String(pick(item, "id") ?? ""),
    title,
    price,
    shipping,
    fees,
    total_cost: price + shipping + fees,
    item_count: countFigures(title) ?? null,
    thumbnail: pick(item, "thumbnailLink") ?? (pick(item, "imageLinks") ?? [])[0] ?? null,
    bought_at: end ? String(end).slice(0, 10) : new Date().toISOString().slice(0, 10),
  };
}

export async function lookupPurchase(link, { get = traderaGet } = {}) {
  const id = traderaItemId(link);
  if (!id) throw new Error("Hittar inget annons-id i länken");
  return purchaseFromItem(await get(`/v4/items/${id}`), String(link ?? "").startsWith("http") ? link : "");
}

// Workerns /data/purchases (lista, spara, koppla annons, eget konto).
export async function purchasesCall(body, { fetchImpl = fetch } = {}) {
  if (!dbConfigured()) throw new Error("APP_TOKEN saknas på servern");
  const url = process.env.DATA_URL || "https://loppis-bevakning.loppis.workers.dev";
  const res = await fetchImpl(`${url}/data/purchases`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-token": process.env.APP_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Databasen: ${data.error || res.status}`);
  return data;
}
