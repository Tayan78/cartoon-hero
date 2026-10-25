// Google Lens via SerpApi: bilden laddas upp till SerpApis Image API (image_id,
// giltigt 10 min, max 500 KB), sedan söker Google Lens på den som i Sverige.
// Träffarna är riktiga sidor med titel, länk och ibland pris – de används som
// grund för modellnummer och som annonser med priser.
import { recurringNumbers } from "./vision.js";

const UPLOAD_URL = "https://serpapi.com/image";
const SEARCH_URL = "https://serpapi.com/search.json";
export const LENS_USD = Number(process.env.SERPAPI_USD_PER_SEARCH) || 0.015;
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
export function toSek(price, fx) {
  const value = Number(price?.extracted_value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const cur = String(price?.currency ?? "").trim().toUpperCase();
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

// Lens-träffar med pris blir annonser (källor) för prispanelen.
export function lensListings(summary) {
  return (summary?.priced ?? []).slice(0, 15).map((m) => ({
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

// Kontroll för "Testa anslutning": kontoinformation räknas inte som sökning.
export async function checkLens() {
  const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(process.env.SERPAPI_API_KEY)}`, {
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `SerpApi svarade ${res.status}`);
  const left = data.plan_searches_left ?? data.total_searches_left;
  return left !== undefined ? `ok (${left} sökningar kvar)` : "ok";
}
