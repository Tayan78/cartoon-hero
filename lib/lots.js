// Underprisade Schleich-partier, steg 1: kr per figur.
// Avslutade partier med bud ger vad partier normalt säljs för per figur (median
// och spann). Aktiva partier jämförs mot det – långt under medianen = fynd.
// Antalet figurer läses ur rubriken; partier utan antal visas inte.
import { percentile } from "./lego.js";
import { searchAdvanced } from "./tradera.js";

const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const PER_PAGE = 240;
const MAX_PAGES = 10;
export const DEAL_SHARE = 0.6; // fynd = högst 60 % av medianen per figur

// Partiord i rubriken.
const LOT = /\b\d+\s*(st|stycken|styck|figurer|djur|hästar|föl|delar)\b|\d+-?pack|paket|samling|\blot\b|blandat|blandade|mängd|låda|kartong|bundle|parti\b/i;
// Inte vanliga partier: bara tillbehör, kort/böcker/tidningar, eller andra märken.
const NOT_FIGURES = /\b(kort|tidning|tidningar|bok|böcker|klistermärken|stickers)\b|bara tillbehör|endast tillbehör|playmobil|lego\b|papo|collecta|bullyland|mojo/i;
const HORSES = /häst|föl|hingst|\bsto\b|ponny|valack/i;

export const isLot = (title) => LOT.test(String(title ?? "")) && !NOT_FIGURES.test(String(title ?? ""));

// Antal figurer ur rubriken: "10 st", "15 hästar", "paket med 8", "6-pack", "12 Schleich".
// Modellnummer (4–6 siffror) och årtal räknas inte. null om inget rimligt antal finns.
export function countFigures(title) {
  const t = String(title ?? "").replace(/\b\d{4,6}\b/g, " ");
  const patterns = [
    /\b(\d{1,3})\s*(?:st|stycken|styck|figurer|figur|djur|hästar|föl|hundar|katter|kor|delar)\b/gi,
    /\bpaket med (\d{1,3})\b/gi,
    /\b(\d{1,3})-?pack\b/gi,
    /\b(\d{1,3})\s+schleich/gi,
  ];
  const found = patterns.flatMap((re) => [...t.matchAll(re)].map((m) => Number(m[1])));
  const ok = found.filter((n) => n >= 2 && n <= 200);
  return ok.length ? Math.max(...ok) : null;
}

export const groupOf = (title) => (HORSES.test(String(title ?? "")) ? "hästar" : "blandat");

// Ett parti från sökningen. Pris: slutpris (högsta bud) för sålda, annars
// Köp nu, annars nuvarande bud.
export function toLot(item, ended) {
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const count = countFigures(title);
  const bids = num(pick(item, "bidCount"));
  const sold = ended && (pick(item, "hasBids") === true || bids > 0) && num(pick(item, "maxBid")) > 0;
  const buyNow = num(pick(item, "buyItNowPrice"));
  const bid = num(pick(item, "maxBid")) || num(pick(item, "nextBid"));
  const price = sold ? num(pick(item, "maxBid")) : buyNow || bid;
  const id = pick(item, "id");
  return {
    id,
    title,
    url: pick(item, "itemUrl") || (id ? `https://www.tradera.com/item/${id}` : ""),
    thumbnail: pick(item, "thumbnailLink") ?? "",
    end: pick(item, "endDate") ?? "",
    bids,
    ended,
    sold,
    price,
    price_kind: sold ? "såld" : buyNow ? "köp nu" : "bud",
    count,
    per_figure: count && price ? Math.round(price / count) : null,
    group: groupOf(title),
  };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p25: percentile(s, 0.25), median: percentile(s, 0.5), p75: percentile(s, 0.75) };
};

// Normalpris per figur från sålda partier: alla, hästar och blandat.
export function benchmark(lots) {
  const sold = lots.filter((l) => l.sold && l.per_figure);
  return {
    all: stats(sold.map((l) => l.per_figure)),
    hästar: stats(sold.filter((l) => l.group === "hästar").map((l) => l.per_figure)),
    blandat: stats(sold.filter((l) => l.group === "blandat").map((l) => l.per_figure)),
  };
}

// Aktiva partier med antal, jämförda mot medianen för sin grupp (eller alla
// partier om gruppen har färre än 8 sålda). share = andel av medianen.
export function rankDeals(lots, bench) {
  return lots
    .filter((l) => !l.ended && l.per_figure)
    .map((l) => {
      const ref = bench[l.group]?.n >= 8 ? bench[l.group] : bench.all;
      const share = ref.median ? Math.round((100 * l.per_figure) / ref.median) / 100 : null;
      return { ...l, ref_median: ref.median, share, deal: share != null && share <= DEAL_SHARE };
    })
    .sort((a, b) => (a.share ?? 9) - (b.share ?? 9));
}

// Hämtar alla aktiva och avslutade "schleich"-annonser och plockar ut partierna.
export async function findLots({ query = "schleich", search = searchAdvanced, now = Date.now() } = {}) {
  const run = async (status) => {
    const body = (pageNumber) => ({ searchWords: query, itemsPerPage: PER_PAGE, pageNumber, ...(status ? { itemStatus: status } : {}) });
    const first = await search(body(1));
    const pages = Math.min(Number(pick(first, "totalNumberOfPages")) || 1, MAX_PAGES);
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => search(body(i + 2)).catch(() => null)));
    return [first, ...rest].flatMap((d) => pick(d, "items") ?? []);
  };
  const [active, ended] = await Promise.all([run(null), run("Ended")]);
  const seen = new Set();
  const lots = [];
  // Avslutade först: finns samma annons i båda listorna gäller den avslutade.
  for (const [items, isEnded] of [[ended, true], [active, false]]) {
    for (const item of items) {
      const id = pick(item, "id");
      if (seen.has(id)) continue;
      seen.add(id);
      if (isLot(pick(item, "shortDescription"))) lots.push(toLot(item, isEnded));
    }
  }
  const bench = benchmark(lots);
  const deals = rankDeals(lots, bench);
  const activeLots = lots.filter((l) => !l.ended);
  return {
    fetched_at: new Date(now).toISOString(),
    scanned: seen.size,
    lots: lots.length,
    active_lots: activeLots.length,
    without_count: activeLots.filter((l) => !l.count).length,
    sold_lots: lots.filter((l) => l.sold && l.per_figure).length,
    benchmark: bench,
    deals: deals.slice(0, 150),
    examples: lots.filter((l) => l.sold && l.per_figure).sort((a, b) => String(b.end).localeCompare(String(a.end))).slice(0, 30),
  };
}
