// Google Lens via SerpApi: bilden laddas upp till SerpApis Image API (image_id,
// giltigt 10 min, max 500 KB), sedan söker Google Lens på den som i Sverige.
// Träffarna är riktiga sidor med titel, länk och ibland pris – de används som
// grund för modellnummer och som annonser med priser.
import { countUsage } from "./usage.js";
import { recurringNumbers } from "./vision.js";

const UPLOAD_URL = "https://serpapi.com/image";
const SEARCH_URL = "https://serpapi.com/search.json";
// 0 är giltigt (gratisplanen); bara ett tomt/ogiltigt värde ger standardpriset.
const lensUsd = Number(process.env.SERPAPI_USD_PER_SEARCH);
export const LENS_USD = process.env.SERPAPI_USD_PER_SEARCH && Number.isFinite(lensUsd) ? lensUsd : 0.015;
const MAX_BYTES = 500 * 1024;

export const lensConfigured = () => Boolean(process.env.SERPAPI_API_KEY);

async function uploadImage(image) {
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > MAX_BYTES) throw new Error(`Bilden är ${Math.round(bytes.length / 1024)} kB, Google Lens tar max 500 kB`);
  const form = new FormData();
  form.append("api_key", process.env.SERPAPI_API_KEY);
  form.append("image", new Blob([bytes], { type: image.mediaType }), `bild.${image.mediaType.split("/")[1] || "jpg"}`);
  const res = await fetch(UPLOAD_URL, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.image_id) throw new Error(data.error || `SerpApi-uppladdning svarade ${res.status}`);
  return data.image_id;
}

// Söker Google Lens på huvudbilden. Returnerar råsvaret och en sammanfattning.
export async function lensSearch(image, fx) {
  const imageId = await uploadImage(image);
  const params = new URLSearchParams({
    engine: "google_lens",
    image_id: imageId,
    hl: "sv",
    country: "se",
    api_key: process.env.SERPAPI_API_KEY,
  });
  countUsage("serpapi");
  const res = await fetch(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(45000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Google Lens svarade ${res.status}`);
  return { raw: data, summary: summarizeLens(data, fx) };
}

const PLATFORMS = [
  [/tradera\./i, "Tradera"],
  [/ebay\./i, "eBay"],
  [/blocket\./i, "Blocket"],
  [/vinted\./i, "Vinted"],
  [/facebook\./i, "Facebook"],
  [/sellpy\./i, "Sellpy"],
];
export function platformFor(link) {
  let host = "";
  try {
    host = new URL(link).hostname;
  } catch {}
  return PLATFORMS.find(([re]) => re.test(host))?.[1] ?? "Butik";
}

// "$", "€", "£", "kr", "SEK" … → SEK med inställningarnas växelkurser.
// Lens skickar ofta bara texten ("119 kr*") utan valutafält: läs då valutan ur texten.
// Sökningen görs med country=se, så "kr" tolkas som svenska kronor.
function currencyOf(price) {
  const cur = String(price?.currency ?? "").trim().toUpperCase();
  if (cur) return cur;
  const text = String(price?.value ?? "");
  if (/US\$|\$/.test(text)) return "$";
  if (/€|EUR/i.test(text)) return "€";
  if (/£|GBP/i.test(text)) return "£";
  if (/\bkr\b|SEK|:-/i.test(text)) return "KR";
  return "";
}

export function toSek(price, fx) {
  const value = Number(price?.extracted_value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const cur = currencyOf(price);
  if (cur === "KR" || cur === "SEK" || cur === ":-") return Math.round(value);
  if (cur === "$" || cur === "USD" || cur === "US$") return Math.round(value * fx.USD);
  if (cur === "€" || cur === "EUR") return Math.round(value * fx.EUR);
  if (cur === "£" || cur === "GBP") return Math.round(value * fx.GBP);
  return 0; // okänd valuta (t.ex. NOK, DKK) – hellre inget pris än fel pris
}

export function summarizeLens(data, fx) {
  const seen = new Set();
  const matches = [];
  for (const [kind, list] of [["exakt", data.exact_matches], ["liknande", data.visual_matches], ["produkt", data.products]]) {
    for (const m of list ?? []) {
      if (!m?.link || seen.has(m.link)) continue;
      seen.add(m.link);
      matches.push({
        kind,
        title: String(m.title ?? "").trim(),
        link: m.link,
        source: m.source ?? "",
        platform: platformFor(m.link),
        price_sek: toSek(m.price, fx),
        price_text: m.price?.value ?? "",
        in_stock: m.in_stock,
        thumbnail: m.thumbnail ?? "",
      });
    }
  }
  return {
    matches,
    numbers: recurringNumbers(matches.map((m) => m.title)),
    priced: matches.filter((m) => m.price_sek > 0),
  };
}

// Butikspriser är nypris – ett tak, inte vad en begagnad säljs för.
const isResale = (m) => m.platform !== "Butik";

// Nypris i butik som referens på kortet (ingår inte i annonserna).
export function lensRetail(summary) {
  const shops = (summary?.priced ?? []).filter((m) => !isResale(m));
  if (!shops.length) return null;
  const prices = shops.map((m) => m.price_sek);
  return {
    low: Math.min(...prices),
    high: Math.max(...prices),
    count: shops.length,
    shops: shops.slice(0, 6).map((m) => ({ title: m.title, url: m.link, source: m.source, price_sek: m.price_sek })),
  };
}

// Kort text till Gemini: de främsta träffarnas titlar, källor och priser.
export function lensText(summary) {
  if (!summary?.matches.length) return "Google Lens: inga träffar.";
  const lines = ["Träffar från Google Lens på bilden (riktiga sidor, de första är mest lika):"];
  if (summary.numbers.length) {
    lines.push(`- Artikel-/modellnummer i titlarna: ${summary.numbers.map((n) => `${n.number} (${n.pages} träffar)`).join(", ")}`);
  }
  for (const m of summary.matches.slice(0, 20)) {
    lines.push(`- ${m.title || "(ingen titel)"} – ${m.source || m.platform}${m.price_text ? ` – ${m.price_text}` : ""}`);
  }
  return lines.join("\n");
}

// Lens-träffar med pris från begagnatsajter blir annonser för prispanelen.
export function lensListings(summary) {
  return (summary?.priced ?? []).filter(isResale).slice(0, 15).map((m) => ({
    title: m.title,
    url: m.link,
    platform: m.platform,
    price: m.price_sek,
    currency: "SEK",
    price_sek: m.price_sek,
    sold: false,
    via: "lens",
  }));
}

// Kontoinformation från SerpApi (räknas inte som sökning): kvar, per månad och använda.
export async function lensAccount() {
  const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(process.env.SERPAPI_API_KEY)}`, {
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `SerpApi svarade ${res.status}`);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    left: n(data.plan_searches_left ?? data.total_searches_left),
    per_month: n(data.searches_per_month),
    used: n(data.this_month_usage),
    plan: String(data.plan_name ?? ""),
  };
}

// Kontroll för "Testa anslutning".
export async function checkLens() {
  const { left } = await lensAccount();
  return left !== null ? `ok (${left} sökningar kvar)` : "ok";
}
