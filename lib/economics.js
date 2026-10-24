// Efterbehandling av modellens svar: räkna om ekonomin exakt, tillämpa
// ärlighetsregler för osäkra priser och räkna fram kostnaden för skanningen.
import { MODELS, WEB_SEARCH_USD } from "./models.js";

const PLATFORMS = ["Tradera", "Vinted", "Blocket", "Annan"];
const LEVELS = ["low", "medium", "high"];

const int = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const level = (v) => (LEVELS.includes(v) ? v : "low");
const lowerLevel = (v) => LEVELS[Math.max(0, LEVELS.indexOf(level(v)) - 1)];

export function verdictFor(score) {
  if (score >= 70) return "Köp";
  if (score >= 40) return "Kanske";
  return "Låt bli";
}

export function computeFees(price, platform) {
  if (price <= 0) return 0;
  return Math.round((price * platform.fee_percent) / 100 + platform.fee_fixed);
}

// Tar modellens rå-JSON och returnerar ett komplett, konsekvent resultat.
export function finalizeResult(raw, { buyPrice, settings }) {
  const r = raw && typeof raw === "object" ? raw : {};
  const item = r.item ?? {};
  const p = r.price_sek ?? {};
  const intl = p.international ?? {};

  const sources = (Array.isArray(r.sources) ? r.sources : [])
    .filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url))
    .slice(0, 12)
    .map((s) => ({
      title: str(s.title),
      url: s.url,
      platform: /ebay/i.test(s.platform ?? s.url) ? "eBay" : /tradera/i.test(s.platform ?? s.url) ? "Tradera" : str(s.platform),
      price: int(s.price),
      currency: str(s.currency) || "SEK",
      price_sek: int(s.price_sek || (s.currency === "SEK" || !s.currency ? s.price : 0)),
      sold: s.sold !== false,
      via: s.via === "fetch" ? "fetch" : "search",
    }));

  const soldTradera = sources.filter((s) => s.sold && s.platform === "Tradera").length;
  const soldAny = sources.filter((s) => s.sold).length;

  const price = {
    low: int(p.low),
    median: int(p.median),
    high: int(p.high),
    comparables: Math.max(0, int(p.comparables)),
    confidence: level(p.confidence),
    no_tradera_data: Boolean(p.no_tradera_data) || soldTradera === 0,
    international: {
      low: int(intl.low),
      median: int(intl.median),
      high: int(intl.high),
      comparables: Math.max(0, int(intl.comparables)),
    },
  };
  // Annonser som är till salu nu: visas, men påverkar aldrig medianen.
  const fs = r.for_sale ?? {};
  const askPrices = sources.filter((s) => !s.sold && s.price_sek > 0).map((s) => s.price_sek);
  const forSale = {
    low: int(fs.low) || (askPrices.length ? Math.min(...askPrices) : 0),
    high: int(fs.high) || (askPrices.length ? Math.max(...askPrices) : 0),
    count: Math.max(0, int(fs.count)) || askPrices.length,
  };

  // Håll intervallet sorterat även om modellen slarvar.
  [price.low, price.median, price.high] = [price.low, price.median, price.high].sort((a, b) => a - b);

  const flags = [];
  let score = Math.min(100, Math.max(0, int(r.buy_score)));

  const noComparables = price.comparables === 0 || soldAny === 0;
  if (noComparables) {
    price.confidence = "low";
    score = Math.min(score, 25);
    flags.push("Inga sålda jämförelser hittades – priset är en uppskattning.");
  } else if (price.no_tradera_data) {
    // Modellen ska redan ha sänkt säkerheten; servern garanterar att den inte är "high".
    if (price.confidence === "high") price.confidence = lowerLevel(price.confidence);
    score = Math.max(0, score - 10);
    flags.push("Inga Tradera-träffar – priset bygger enbart på internationell data.");
  }
  if (price.confidence === "low" && !noComparables) score = Math.min(score, 55);

  const bestPlatform = PLATFORMS.includes(r.best_platform) ? r.best_platform : "Tradera";
  const platform = settings.platforms[bestPlatform];
  const buy = Math.max(0, int(buyPrice));
  const fees = computeFees(price.median, platform);
  const shipping = price.median > 0 ? Math.round(platform.shipping) : 0;
  const net = price.median - fees - shipping - buy;

  if (net <= 0) {
    score = Math.min(score, 30);
    if (price.median > 0) flags.push("Ingen marginal efter avgifter och frakt.");
  }

  return {
    item: {
      name: str(item.name) || [item.brand, item.model].map(str).filter(Boolean).join(" ") || str(item.category) || "Okänt föremål",
      category: str(item.category),
      brand: str(item.brand),
      model: str(item.model),
      article_number: str(item.article_number),
      age: str(item.age),
      condition: str(item.condition),
      confidence_id: level(item.confidence_id),
    },
    price_sek: price,
    for_sale: forSale,
    candidates: (Array.isArray(r.candidates) ? r.candidates : []).slice(0, 3).map((c) => ({
      name: str(c?.name),
      article_number: str(c?.article_number),
    })),
    sources,
    economics: { buy_price: buy, sale_price: price.median, fees, shipping, net_profit: net },
    buy_score: score,
    verdict: verdictFor(score),
    reason: str(r.reason),
    evidence: str(r.evidence),
    best_platform: bestPlatform,
    flags,
  };
}

// Summerar token och webbsökningar över ett eller flera API-svar.
export function addUsage(total, usage) {
  if (!usage) return total;
  total.input_tokens += usage.input_tokens ?? 0;
  total.output_tokens += usage.output_tokens ?? 0;
  total.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
  total.cache_write_tokens += usage.cache_creation_input_tokens ?? 0;
  total.web_searches += usage.server_tool_use?.web_search_requests ?? 0;
  total.web_fetches += usage.server_tool_use?.web_fetch_requests ?? 0;
  return total;
}

export const emptyUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  web_searches: 0,
  web_fetches: 0,
});

export function costUsd(model, usage) {
  const price = MODELS[model] ?? MODELS["claude-opus-5-5"];
  const tokens =
    (usage.input_tokens * price.input +
      usage.cache_write_tokens * price.input * 1.25 +
      usage.cache_read_tokens * price.cache_read +
      usage.output_tokens * price.output) /
    1e6;
  return tokens + usage.web_searches * WEB_SEARCH_USD;
}

// Hittar första kompletta JSON-objektet i modellens text.
export function extractJson(text) {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("Inget JSON i svaret");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
  }
  throw new Error("Ofullständigt JSON i svaret");
}
