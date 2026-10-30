// Bevakningens logik (utan Cloudflare-beroenden, så att den kan testas i Node):
// vilka nya annonser som är kandidater, värdering med samma kod som Fynd
// (lib/lots.js) och notisen till ntfy.
import { mergeRules } from "../../lib/decision.js";
import { addShipping, countFigures, isLot, rankDeals, toLot } from "../../lib/lots.js";
import { getNiche } from "../../lib/niches.js";

// Nischer som bevakas. Fler läggs till här (se lib/niches.js), t.ex. "smurfar".
export const WATCH_NICHES = ["djur"];
// Kategorin Miniatyrer & leksaksfigurer, där Schleich och smurfar ligger.
export const CATEGORY = 1000532;
export const PAGE_SIZE = 50;

const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];

// Sökningen: nyaste först. Traderas sorteringsnamn är inte dokumenterade i v4, så
// bevakningen provar dessa i ordning och använder den första som Tradera godtar.
// Köp nu-annonser ligger ute i 30 dagar, så senast slutdatum ≈ nyast.
export const ORDER_CANDIDATES = ["StartDateDescending", "EndDateDescending"];
export const searchBody = (orderBy) => ({ categoryId: CATEGORY, itemsPerPage: PAGE_SIZE, pageNumber: 1, ...(orderBy ? { orderBy } : {}) });

// Är sidan sorterad med nyaste först? Traderas annons-id är löpnummer, så nyare
// annonser har högre id: minst 80 % av grannparen ska vara fallande.
export function pageOrder(items) {
  const ids = (items ?? []).map((it) => Number(pick(it, "id"))).filter(Number.isFinite);
  const pairs = ids.slice(1).map((id, i) => ids[i] > id);
  return { newest_id: ids.length ? Math.max(...ids) : null, sorted_desc: pairs.length >= 5 && pairs.filter(Boolean).length / pairs.length >= 0.8 };
}

// Första sorteringen som Tradera både godtar och faktiskt sorterar efter.
// Godtas namnet men sidan inte är sorterad (Tradera ignorerar det) provas nästa.
export async function pickOrderBy(search) {
  let accepted = null;
  for (const orderBy of ORDER_CANDIDATES) {
    const data = await search(searchBody(orderBy)).catch(() => null);
    const errors = pick(data, "errors");
    if (!data || (Array.isArray(errors) && errors.length)) continue;
    if (pageOrder(pick(data, "items")).sorted_desc) return orderBy;
    accepted ??= orderBy;
  }
  return accepted;
}

// Nya annonser som är partier i en bevakad nisch, har antal och går att köpa direkt
// (Köp nu, eller auktion med Köp nu-pris).
export function candidates(items, seen, niches = WATCH_NICHES) {
  const out = [];
  for (const item of items ?? []) {
    const id = String(pick(item, "id"));
    if (seen.has(id)) continue;
    const title = String(pick(item, "shortDescription") ?? "");
    for (const nicheId of niches) {
      const niche = getNiche(nicheId);
      if (!isLot(title, niche) || !countFigures(title)) continue;
      const lot = toLot(item, false, niche);
      if (lot.price_kind === "köp nu" || lot.buy_now) out.push({ lot, niche: nicheId });
      break;
    }
  }
  return out;
}

// Hämtar frakten och värderar. Returnerar partierna som är gröna enligt köpreglerna:
// Köp nu-pris (+ köparskydd + frakt) inom "betala högst".
export async function evaluate(cands, { getItem, singles, rules }) {
  const deals = [];
  const merged = mergeRules(rules);
  for (const { lot, niche } of cands) {
    const nicheSingles = singles?.[niche];
    if (!nicheSingles) continue; // utan marknadsdata går det inte att värdera
    const { lots } = await addShipping([lot], { get: getItem, max: 1 });
    const [ranked] = rankDeals(lots, { all: { n: 0, median: null } }, { singles: nicheSingles, rules: merged });
    if (ranked?.deal && ranked.basis === "styckvis") deals.push({ ...ranked, niche });
  }
  return deals;
}

const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;

// Notisen till ntfy (JSON-format, så att å/ä/ö fungerar).
// Påhittat grönt parti för /test?annons=1 – samma notis som en riktig träff ger.
export const EXAMPLE_DEAL = {
  count: 24,
  price_kind: "köp nu",
  price: 349,
  total: 438,
  multiple: 2.4,
  title: "TEST – 24 st Schleich djur, hästar och blandat",
  value: 1050,
  pay_max: 525,
  url: "https://www.tradera.com/search?q=schleich%20paket",
};

export function notification(deal, topic) {
  const viaAuction = deal.price_kind === "bud";
  const price = viaAuction ? deal.buy_now : deal.price;
  const total = viaAuction ? deal.buy_now_total : deal.total;
  const multiple = viaAuction ? deal.buy_now_multiple : deal.multiple;
  return {
    topic,
    title: `💎 ${deal.count} st – Köp nu ${kr(price)} (${String(multiple).replace(".", ",")}×)`,
    message:
      `${deal.title}\n` +
      `Totalt ${kr(total)} inkl. köparskydd och frakt · värt ca ${kr(deal.value)} netto styckvis · betala högst ${kr(deal.pay_max)}`,
    click: deal.url,
    ...(deal.thumbnail ? { attach: deal.thumbnail } : {}),
    priority: 5,
    tags: ["moneybag"],
  };
}
