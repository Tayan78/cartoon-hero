// Lego i bulk: kilopris från sålda partier på Tradera.
// Traderas avancerade sökning med itemStatus "Ended" ger avslutade annonser
// (ca 4 månader bakåt). Bara auktioner med bud räknas som sålda – slutpriset är
// högsta budet. Köp nu-annonser utan bud kan ha sålts eller löpt ut, och räknas
// därför inte. Vikten läses ur rubriken.
import { computeFees } from "./economics.js";
import { decide, mergeRules } from "./decision.js";
import { parseWeightKg, searchAdvanced } from "./tradera.js";

export const LEGO_QUERIES = ["lego kg", "lego kilo", "legobitar"];
const PER_PAGE = 240;
const MAX_PAGES = 10;
const DAY = 24 * 60 * 60 * 1000;

const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

// Partier som inte är vanlig blandad Lego tas bort, med skäl.
const EXCLUDE = [
  ["Duplo", /duplo/i],
  ["inte Lego", /mega ?bloks?|kompatib|lego-?liknande|liknande lego|lepin|cobi|\bej lego|\binte lego|\bnot lego|playmobil|brio/i],
  ["bara figurer", /(endast|bara|enbart|only)\s+(mini)?fig/i],
  ["oöppnat/nytt", /oöppna|obruten|förseglad|sealed|\bnew\b|ny i (kartong|förpackning)|nytt i kartong/i],
];
// Rubriker som lovar figurer eller populära teman säljs dyrare per kilo.
const FIGS = /minifig|figur|gubb|star ?wars|ninjago|harry potter|marvel|super ?hero|batman|jurassic|lord of the rings|sagan om ringen|pirat|castle|riddare/i;

export function classifyLot(title) {
  const t = String(title ?? "");
  const hit = EXCLUDE.find(([, re]) => re.test(t));
  return { exclude: hit ? hit[0] : null, figs: FIGS.test(t) };
}

// Ett avslutat parti → det vi behöver, eller null om det inte är Lego.
export function toLot(item) {
  const title = String(pick(item, "shortDescription") ?? "").trim();
  if (!title || !/lego/i.test(title)) return null;
  const bids = num(pick(item, "bidCount"));
  const sold = (pick(item, "hasBids") === true || bids > 0) && num(pick(item, "maxBid")) > 0;
  const kg = parseWeightKg(title);
  const price = sold ? num(pick(item, "maxBid")) : num(pick(item, "buyItNowPrice")) || num(pick(item, "maxBid"));
  const id = pick(item, "id");
  const { exclude, figs } = classifyLot(title);
  return {
    id,
    title,
    url: pick(item, "itemUrl") || (id ? `https://www.tradera.com/item/${id}` : ""),
    end: pick(item, "endDate") ?? "",
    bids,
    sold,
    price,
    kg,
    kr_per_kg: sold && kg ? Math.round(price / kg) : null,
    figs,
    exclude: exclude ?? (kg ? null : "vikt saknas"),
  };
}

// Percentil med linjär interpolation, avrundad till hela kronor.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

export function stats(lots) {
  const xs = lots.map((l) => l.kr_per_kg).sort((a, b) => a - b);
  return { n: xs.length, p25: percentile(xs, 0.25), median: percentile(xs, 0.5), p75: percentile(xs, 0.75) };
}

export const SIZES = [
  ["1–3 kg", 0, 3],
  ["3–10 kg", 3, 10],
  ["10 kg+", 10, Infinity],
];
export const sizeOf = (kg) => SIZES.find(([, min, max]) => kg >= min && kg < max)?.[0] ?? SIZES[0][0];

// Median och spann per grupp: alla, utan/med figurer, storlek – för 30 och 90 dagar.
export function legoStats(lots, now = Date.now()) {
  const sold = lots.filter((l) => l.sold && !l.exclude && l.kr_per_kg);
  const within = (days) => sold.filter((l) => now - Date.parse(l.end) <= days * DAY);
  const period = (list) => ({
    all: stats(list),
    plain: stats(list.filter((l) => !l.figs)),
    figs: stats(list.filter((l) => l.figs)),
    sizes: Object.fromEntries(SIZES.map(([name]) => [name, stats(list.filter((l) => !l.figs && sizeOf(l.kg) === name))])),
  });
  return { d30: period(within(30)), d90: period(within(90)), all: period(sold) };
}

// Hämtar alla avslutade partier för sökorden (alla sidor), utan dubbletter.
export async function fetchLegoLots({ queries = LEGO_QUERIES, search = searchAdvanced } = {}) {
  const pages = [];
  const page = (query, pageNumber) =>
    search({ searchWords: query, itemStatus: "Ended", itemsPerPage: PER_PAGE, pageNumber }).then(
      (data) => {
        const items = pick(data, "items");
        pages.push({ query, page: pageNumber, items: Array.isArray(items) ? items.length : 0 });
        return data;
      },
      (err) => {
        pages.push({ query, page: pageNumber, error: err.message });
        return null;
      },
    );
  const results = await Promise.all(
    queries.map(async (query) => {
      const first = await page(query, 1);
      const total = Math.min(num(pick(first, "totalNumberOfPages")), MAX_PAGES);
      const rest = await Promise.all(Array.from({ length: Math.max(0, total - 1) }, (_, i) => page(query, i + 2)));
      return [first, ...rest];
    }),
  );
  const byId = new Map();
  for (const data of results.flat()) {
    for (const item of pick(data, "items") ?? []) {
      const lot = toLot(item);
      if (lot && !byId.has(lot.id)) byId.set(lot.id, lot);
    }
  }
  return { lots: [...byId.values()], pages };
}

// Sammanställning till appen: statistik, antal per skäl och de sålda partierna.
export function legoReport(lots, now = Date.now()) {
  const excluded = {};
  for (const l of lots) if (l.exclude) excluded[l.exclude] = (excluded[l.exclude] ?? 0) + 1;
  const used = lots.filter((l) => l.sold && !l.exclude).sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  return {
    fetched_at: new Date(now).toISOString(),
    total: lots.length,
    sold: lots.filter((l) => l.sold).length,
    unsold: lots.filter((l) => !l.sold).length,
    used: used.length,
    excluded,
    oldest: lots.reduce((min, l) => (l.end && (!min || l.end < min) ? l.end : min), ""),
    stats: legoStats(lots, now),
    lots: used.slice(0, 300).map(({ exclude, ...l }) => l),
  };
}

// Räknaren: kilopris för partier utan figurer (det du får för resten när
// figurerna är sålda separat) → netto efter Traderas avgift → samma köpregler
// som i Skanna. Köparen betalar frakten, så den dras inte av.
export function legoCalc({ weight, price, kr_per_kg, settings }) {
  const kg = Number(weight);
  if (!(kg > 0) || !(kr_per_kg > 0)) return null;
  const sale = Math.round(kg * kr_per_kg);
  const fees = computeFees(sale, settings?.platforms?.Tradera ?? { fee_percent: 10, fee_fixed: 0 });
  const net = sale - fees;
  const decision = decide({ net, buy: Math.max(0, Math.round(Number(price) || 0)), listPrice: sale, brand: "Lego", rules: mergeRules(settings?.decision) });
  return { kg, kr_per_kg, sale, fees, net, decision };
}
