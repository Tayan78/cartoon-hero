// Traderas REST-API (v4): aktiva annonser för det identifierade föremålet.
// Sökningen kräver bara appens nycklar (X-App-Id/X-App-Key), ingen inloggning,
// och är gratis inom 10 000 anrop per dygn.
const BASE_URL = process.env.TRADERA_BASE_URL || "https://api.tradera.com";

export const traderaConfigured = () => Boolean(process.env.TRADERA_APP_ID && process.env.TRADERA_APP_KEY);

// Svaret är JSON i camelCase, men tål även PascalCase (som SOAP-versionen).
const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

async function call(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "X-App-Id": String(process.env.TRADERA_APP_ID),
      "X-App-Key": process.env.TRADERA_APP_KEY,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = data?.title || data?.message || data?.error || text.slice(0, 120) || `Tradera svarade ${res.status}`;
    throw new Error(res.status === 401 || res.status === 403 ? `Fel Tradera-nycklar (${res.status})` : msg);
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
    const has = (l, w) => l.title.toUpperCase().includes(w.toUpperCase());
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
