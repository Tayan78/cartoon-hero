// Traderas REST-API (v4): aktiva annonser för det identifierade föremålet.
// Sökningen kräver bara appens nycklar (X-App-Id/X-App-Key), ingen inloggning,
// och är gratis inom 10 000 anrop per dygn.
import { countUsage, traderaApi } from "./usage.js";

const BASE_URL = process.env.TRADERA_BASE_URL || "https://api.tradera.com";

export const traderaConfigured = () => Boolean(process.env.TRADERA_APP_ID && process.env.TRADERA_APP_KEY);

// Svaret är JSON i camelCase, men tål även PascalCase (som SOAP-versionen).
const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

// GET utan body, POST med JSON-body (t.ex. avancerad sökning).
async function call(path, body) {
  countUsage(traderaApi(path));
  const res = await fetch(`${BASE_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "X-App-Id": String(process.env.TRADERA_APP_ID),
      "X-App-Key": process.env.TRADERA_APP_KEY,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.title || data?.message || (typeof data?.error === "string" ? data.error : "") || text.slice(0, 120) || "fel";
    throw new Error(res.status === 401 || res.status === 403 ? `Fel Tradera-nycklar (${res.status})` : `Tradera ${res.status}: ${msg}`);
  }
  if (!data) throw new Error("Oväntat svar från Tradera");
  return data;
}

// En annons från sökresultatet → samma format som övriga annonser på kortet.
// Pris: Köp nu om det finns, annars nästa bud (det man måste lägga för att vinna nu).
export function toListing(item) {
  const id = pick(item, "id");
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const buyNow = num(pick(item, "buyItNowPrice"));
  const nextBid = num(pick(item, "nextBid")) || num(pick(item, "maxBid"));
  const price = buyNow || nextBid;
  const url = pick(item, "itemUrl") || (id ? `https://www.tradera.com/item/${id}` : "");
  if (!title || !price || !/^https?:\/\//.test(url) || pick(item, "isEnded") === true) return null;
  return {
    title,
    url,
    platform: "Tradera",
    price,
    currency: "SEK",
    price_sek: price,
    sold: false,
    via: "tradera",
    price_type: buyNow ? "köp nu" : "bud",
    bids: num(pick(item, "bidCount")),
    thumbnail: pick(item, "thumbnailLink") ?? "",
  };
}

// Ett enskilt objekt (GET /v4/items/{id}). Pågående → annons till salu.
// Avslutat med bud → såld för högsta budet. Avslutat utan bud → hoppas över.
export function toItemListing(item, link, now = Date.now()) {
  const end = Date.parse(pick(item, "endDate") ?? "");
  const ended = Number.isFinite(end) && end < now;
  if (!ended) {
    const listing = toListing({ ...item, itemUrl: link });
    return listing && { ...listing, bids: num(pick(item, "totalBids")) };
  }
  const bids = num(pick(item, "totalBids"));
  const price = num(pick(item, "maxBid"));
  const title = String(pick(item, "shortDescription") ?? "").trim();
  if (!bids || !price || !title) return null;
  return { title, url: link, platform: "Tradera", price, currency: "SEK", price_sek: price, sold: true, via: "tradera", price_type: "såld", bids };
}

// Tradera-länkar bland Google Lens-träffarna: samma föremål enligt bilden, men
// utan pris. Lotter och andra modellnummer sorteras bort.
const LOT = /paket|stycken|\d+\s*st\b|\blot\b|samling|bundle|mängd/i;
export function lensTraderaIds(matches, article = "", max = 5) {
  const ids = [];
  for (const m of matches ?? []) {
    if (m.platform !== "Tradera" || LOT.test(m.title)) continue;
    const numbers = (m.title.match(/\b\d{4,6}\b/g) ?? []).filter((n) => !/^(19|20)\d\d$/.test(n));
    if (article && numbers.length && !numbers.includes(article)) continue;
    const id = /\/item\/(?:\d+\/)?(\d{6,})/.exec(m.link)?.[1];
    if (id && !ids.some((x) => x.id === id)) ids.push({ id, link: m.link });
    if (ids.length >= max) break;
  }
  return ids;
}

// Hämtar pris och status för Lens-träffarnas Tradera-annonser (parallellt).
export async function traderaItems(ids) {
  const results = await Promise.all(
    ids.map(({ id, link }) =>
      call(`/v4/items/${id}`).then(
        (item) => ({ id, listing: toItemListing(item, link) }),
        (err) => ({ id, error: err.message }),
      ),
    ),
  );
  return {
    listings: results.map((r) => r.listing).filter(Boolean),
    tried: results.map((r) => ({ item: r.id, found: r.listing ? (r.listing.sold ? "såld" : "till salu") : r.error ?? "avslutad/utan pris" })),
  };
}

export function parseSearch(data) {
  const items = pick(data, "items") ?? [];
  return (Array.isArray(items) ? items : []).map(toListing).filter(Boolean);
}

// Söker aktiva annonser, en sökning i taget tills något hittas: först märke +
// nummer, sedan namnet (säljare skriver sällan ut numret). Annonser som nämner
// numret, eller annars modellens namnord, behålls – så att andra modeller i
// samma serie inte styr priset.
export async function traderaSearch({ queries, article = "", words = [] }) {
  const tried = [];
  for (const query of queries.filter(Boolean)) {
    const data = await call(`/v4/search?${new URLSearchParams({ query })}`);
    const all = parseSearch(data);
    tried.push({ query, found: all.length, keys: Object.keys(data ?? {}).slice(0, 8) });
    if (!all.length) continue;
    // Utan mellanslag, så att "Tinkersto" hittar "Tinker sto".
    const flat = (s) => s.toUpperCase().replace(/[\s-]+/g, "");
    const has = (l, w) => flat(l.title).includes(flat(w));
    const withNumber = article ? all.filter((l) => has(l, article)) : [];
    const withWords = words.length ? all.filter((l) => words.every((w) => has(l, w))) : all;
    const listings = (withNumber.length ? withNumber : withWords).slice(0, 12);
    if (!listings.length) continue;
    return { query, listings, total: num(pick(data, "totalNumberOfItems")) || all.length, matched_number: withNumber.length > 0, tried };
  }
  return { query: tried.map((t) => t.query).join(" / "), listings: [], total: 0, matched_number: false, tried };
}

// Sökord: märke + bekräftat nummer, sedan namnet utan nummer och parenteser.
// Namnord = ord i namnet som inte är märket och är minst 5 tecken (t.ex. "Knabstrupper").
export function traderaQuery({ item, article }) {
  const brand = String(item?.brand ?? "").replace(/\(.*?\)/g, "").trim();
  const name = String(item?.name ?? "").replace(/\(.*?\)/g, "").replace(/\b\d{3,}\b/g, "").replace(/\s+/g, " ").trim();
  const words = name.split(" ").filter((w) => w.length >= 5 && w.toLowerCase() !== brand.toLowerCase()).slice(0, 2);
  const queries = [...new Set([article?.verified ? `${brand} ${article.number}`.trim() : "", name].filter(Boolean))];
  return { queries, article: article?.verified ? article.number : "", words };
}

// Hela Tradera-steget: sökning på nummer/namn, plus pris för Lens-träffarnas
// Tradera-annonser (samma föremål enligt bilden). search/lookup kan bytas i testläge.
const urlKey = (url) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "");
export async function findOnTradera({ item, article, lens }, search = traderaSearch, lookup = traderaItems) {
  const q = traderaQuery({ item, article });
  const result = await search(q);
  const known = new Set(result.listings.map((l) => urlKey(l.url)));
  const ids = lens ? lensTraderaIds(lens.matches, q.article).filter((x) => !known.has(urlKey(x.link))) : [];
  if (ids.length) {
    const extra = await lookup(ids);
    result.listings = mergeListings(result.listings, extra.listings);
    result.tried = [...(result.tried ?? []), ...extra.tried];
  }
  return { ...result, queries: q.queries };
}

// Traderas annonser först (de väger tyngst), sedan övriga utan dubbletter.
export function mergeListings(tradera, others) {
  const key = (l) => l.url.replace(/[?#].*$/, "");
  const seen = new Set(tradera.map(key));
  return [...tradera, ...others.filter((l) => !seen.has(key(l)))];
}

// Kontroll för "Testa anslutning": en vanlig sökning.
export async function checkTradera() {
  const data = await call(`/v4/search?${new URLSearchParams({ query: "schleich" })}`);
  return `ok (${parseSearch(data).length} annonser i testsökningen)`;
}

// Avancerad sökning (POST /v4/search/advanced). Fältnamn i camelCase som i SOAP:
// searchWords, itemStatus ("Ended" ger avslutade), itemsPerPage (max 240), pageNumber.
export const searchAdvanced = (body) => call("/v4/search/advanced", body);
// Övriga läsanrop (t.ex. säljare och deras annonser).
export const traderaGet = (path) => call(path);

// ---------- test: sålda Lego-partier (kilopris) ----------
// Vikt ur rubrik eller text: "5 kg", "2,3 kilo", "800 g", "1.5kg". Rimliga partier
// (0,1–200 kg) räknas, annars null.
export function parseWeightKg(text) {
  const t = String(text ?? "").replace(/<[^>]+>/g, " ");
  const kg = /(\d+(?:[.,]\d+)?)\s*(?:kg|kilo(?:gram)?)\b/i.exec(t);
  const g = kg ? null : /(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram)\b/i.exec(t);
  const value = kg ? Number(kg[1].replace(",", ".")) : g ? Number(g[1].replace(",", ".")) / 1000 : NaN;
  return value >= 0.1 && value <= 200 ? Math.round(value * 1000) / 1000 : null;
}

// Ett avslutat parti: slutpris (högsta bud, annars köp nu-pris), bud, vikt och kr/kg.
export function endedLot(item) {
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const bids = num(pick(item, "bidCount")) || num(pick(item, "totalBids"));
  const hasBids = pick(item, "hasBids") === true || bids > 0;
  const price = hasBids ? num(pick(item, "maxBid")) : num(pick(item, "buyItNowPrice"));
  const kg = parseWeightKg(title) ?? parseWeightKg(pick(item, "longDescription"));
  return {
    id: pick(item, "id"),
    title,
    ended: pick(item, "isEnded"),
    end: pick(item, "endDate") ?? "",
    type: pick(item, "itemType") ?? "",
    bids,
    sold: hasBids,
    price,
    kg,
    kr_per_kg: kg && price ? Math.round(price / kg) : null,
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Sammanfattar ett sökresultat: hur många som är avslutade, har bud och vikt.
export function summarizeLots(data) {
  const items = pick(data, "items");
  const list = Array.isArray(items) ? items : [];
  const lots = list.map(endedLot);
  const priced = lots.filter((l) => l.sold && l.kr_per_kg);
  return {
    total: num(pick(data, "totalNumberOfItems")),
    count: list.length,
    ended: lots.filter((l) => l.ended === true).length,
    sold: lots.filter((l) => l.sold).length,
    with_kg: lots.filter((l) => l.kg).length,
    median_kr_per_kg: median(priced.map((l) => l.kr_per_kg)),
    priced: priced.length,
    fields: Object.keys(list[0] ?? {}),
    lots,
  };
}

// Provar avancerad sökning med ItemStatus "Ended". Fältnamnen i v4 är inte
// dokumenterade, så några varianter provas; en utan ItemStatus som jämförelse.
export async function probeEndedSearch(query = "lego kg") {
  const variants = [
    ["searchWords + itemStatus", { searchWords: query, itemStatus: "Ended", itemsPerPage: 100 }],
    ["query + itemStatus", { query, itemStatus: "Ended", itemsPerPage: 100 }],
    ["request-omslag", { request: { searchWords: query, itemStatus: "Ended", itemsPerPage: 100 } }],
    ["jämförelse: aktiva", { searchWords: query, itemsPerPage: 100 }],
  ];
  const results = await Promise.all(
    variants.map(([name, body]) =>
      call("/v4/search/advanced", body).then(
        (data) => ({ name, ...summarizeLots(data), errors: pick(data, "errors") ?? null }),
        (err) => ({ name, error: err.message }),
      ),
    ),
  );
  const best = results.filter((r) => !r.error && r.name !== "jämförelse: aktiva").sort((a, b) => b.ended - a.ended)[0];
  return {
    query,
    variants: results.map(({ lots, ...r }) => r),
    best: best?.name ?? null,
    sample: (best?.lots ?? []).filter((l) => l.ended === true).slice(0, 15),
  };
}
