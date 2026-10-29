// Underprisade partier per nisch (Schleich-djur eller Smurfar, se lib/niches.js).
// Värdet bygger på verklig försäljning av ENSKILDA figurer (du säljer styckvis):
// sålda annonser i marknadsdatabasen (fliken Marknad, bevakade säljare) – median
// per grupp minus Traderas avgift. Partiets nettovärde = antal × det, och dina
// köpregler (småfigur: grön vid 2×, gul vid 1,3×) ger vad du högst kan betala
// inkl. frakt. Saknas styckdata används vad partier sålts för per figur.
// Antalet figurer läses ur rubriken; partier utan antal visas inte. Sökningen
// ger inte frakten, så varje parti med antal hämtas en gång för fraktsätten.
import { maxBuy, mergeRules } from "./decision.js";
import { computeFees } from "./economics.js";
import { percentile } from "./lego.js";
import { MARKET_HEADERS } from "./marketdata.js";
import { callAppsScript, storageConfigured } from "./storage.js";
import { getNiche, nicheOf } from "./niches.js";
import { searchAdvanced, traderaGet } from "./tradera.js";

const pick = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const PER_PAGE = 240;
const MAX_PAGES = 10;
const DETAIL_MAX = 500; // annonser som hämtas för frakten per sökning
export const DEAL_SHARE = 0.6; // fynd = högst 60 % av medianen per figur

// Partiord i rubriken.
const LOT = /\b\d+\s*(st|stycken|styck|figurer|djur|hästar|föl|delar|smurfar|smurfer)\b|\d+-?pack|paket|samling|\blot\b|blandat|blandade|mängd|låda|kartong|bundle|parti\b/i;

export const MIN_SINGLES = 10;
// Höjs när svarets innehåll ändras, så att appen hämtar om sparade listor.
export const LOTS_VERSION = 3; // färre sålda styckvis i gruppen = använd partipriset

export const isLot = (title, niche = getNiche("djur")) => {
  const t = String(title ?? "");
  return LOT.test(t) && niche.match(t) && !niche.exclude.test(t);
};

// Antal figurer ur rubriken: "10 st", "15 hästar", "paket med 8", "6-pack",
// "12 Schleich", "20 smurfar". Modellnummer (4–6 siffror) och årtal räknas inte.
// Står flera tal används det högsta. null om inget rimligt antal finns.
export function countFigures(title) {
  const t = String(title ?? "").replace(/\b\d{4,6}\b/g, " ");
  const patterns = [
    /\b(\d{1,3})\s*(?:st|stycken|styck|figurer|figur|djur|hästar|föl|hundar|katter|kor|delar|smurfar|smurfer|smurfs)\b/gi,
    /\bpaket med (\d{1,3})\b/gi,
    /\b(\d{1,3})-?pack\b/gi,
    /\b(\d{1,3})\s+(?:schleich|smurf)/gi,
  ];
  const found = patterns.flatMap((re) => [...t.matchAll(re)].map((m) => Number(m[1])));
  const ok = found.filter((n) => n >= 2 && n <= 300);
  return ok.length ? Math.max(...ok) : null;
}

// Ett parti från sökningen. Pris: slutpris (högsta bud) för sålda, annars
// Köp nu, annars nuvarande bud. Frakten fylls i av addShipping.
export function toLot(item, ended, niche = getNiche("djur")) {
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const count = countFigures(title);
  const bids = num(pick(item, "bidCount"));
  const sold = ended && (pick(item, "hasBids") === true || bids > 0) && num(pick(item, "maxBid")) > 0;
  const buyNow = num(pick(item, "buyItNowPrice"));
  const maxBid = num(pick(item, "maxBid"));
  const nextBid = num(pick(item, "nextBid"));
  // Auktion (även auktion med Köp nu-pris) eller ren Köp nu. Typen kommer från
  // Tradera; saknas den räknas bud eller ett utrop under Köp nu-priset som auktion.
  const type = String(pick(item, "itemType") ?? "");
  const pureBuyNow = /purebuyitnow|fixed|^3$/i.test(type);
  const auction = !pureBuyNow && (/auction|auktion|^1$/i.test(type) || bids > 0 || !buyNow || (nextBid > 0 && nextBid < buyNow));
  // Auktion: ledande bud, eller utropet om ingen budat. Köp nu-priset sparas för sig.
  const price = sold ? maxBid : auction ? (bids > 0 ? maxBid || nextBid : nextBid || maxBid) : buyNow || maxBid || nextBid;
  const id = pick(item, "id");
  return withTotal({
    id,
    title,
    url: pick(item, "itemUrl") || (id ? `https://www.tradera.com/item/${id}` : ""),
    thumbnail: pick(item, "thumbnailLink") ?? "",
    end: pick(item, "endDate") ?? "",
    bids,
    ended,
    sold,
    price,
    price_kind: sold ? "såld" : auction ? "bud" : "köp nu",
    buy_now: auction && buyNow ? buyNow : null, // auktion med Köp nu-pris
    count,
    shipping: null, // kr, billigaste fraktsättet; null = okänd
    pickup_only: false,
    group: niche.group(title),
  });
}

// Totalpris (pris + frakt) och kr per figur på totalen.
function withTotal(lot) {
  const total = lot.price ? lot.price + (lot.shipping ?? 0) : 0;
  // Kan bli 0 för ett lågt bud på ett stort parti (2 kr / 42 figurer) – 0 är ett giltigt värde.
  return { ...lot, total, per_figure: lot.count && total ? Math.round(total / lot.count) : null };
}

// Billigaste fraktsättet ur en hämtad annons (GET /v4/items/{id}). Fraktsätt för
// 0 kr är nästan alltid avhämtning eller "annat" utan pris – de räknas inte.
export function shippingOf(item) {
  const costs = (pick(item, "shippingOptions") ?? []).map((o) => Number(pick(o, "cost"))).filter((c) => Number.isFinite(c) && c > 0);
  if (costs.length) return { shipping: Math.min(...costs), pickup_only: false };
  return { shipping: null, pickup_only: pick(item, "acceptsPickup") === true };
}

// Hämtar frakten för partier med antal: aktiva först, sedan de senast sålda.
export async function addShipping(lots, { get = traderaGet, max = DETAIL_MAX } = {}) {
  const wanted = [
    ...lots.filter((l) => !l.ended && l.count),
    ...lots.filter((l) => l.sold && l.count).sort((a, b) => String(b.end).localeCompare(String(a.end))),
  ].slice(0, max);
  const byId = new Map();
  for (let i = 0; i < wanted.length; i += 20) {
    await Promise.all(
      wanted.slice(i, i + 20).map((l) =>
        get(`/v4/items/${l.id}`).then(
          (item) => byId.set(l.id, shippingOf(item)),
          () => {},
        ),
      ),
    );
  }
  return { lots: lots.map((l) => (byId.has(l.id) ? withTotal({ ...l, ...byId.get(l.id) }) : l)), fetched: byId.size };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p25: percentile(s, 0.25), median: percentile(s, 0.5), p75: percentile(s, 0.75) };
};

// Normalpris per figur från sålda partier, per grupp. Bara partier med känd
// frakt när det finns minst 8 sådana (annars alla, utan frakt för de okända).
export function benchmark(lots, niche = getNiche("djur")) {
  const all = lots.filter((l) => l.sold && l.per_figure != null);
  const shipped = all.filter((l) => l.shipping != null);
  const sold = shipped.length >= 8 ? shipped : all;
  const out = { all: stats(sold.map((l) => l.per_figure)) };
  for (const g of niche.groups) out[g] = stats(sold.filter((l) => l.group === g).map((l) => l.per_figure));
  return out;
}

// Verklig försäljning av enskilda figurer från fliken Marknad, per grupp: pris
// (median och spann), netto efter Traderas avgift och säljgrad (sålda / avslutade).
// Partier och tillbehör räknas inte.
export function singleStats(rows, niche = getNiche("djur"), platform = { fee_percent: 10, fee_fixed: 0 }) {
  const singles = rows.filter((r) => {
    const title = String(r.Rubrik ?? "");
    // Både nischen i Sheet och rubriken/texten måste stämma – en smurf räknas
    // aldrig in i Schleich-djur (och tvärtom), även om kolumnen Nisch skulle vara fel.
    const inNiche = (!r.Nisch || r.Nisch === niche.id) && niche.match(`${title} ${r.Text ?? ""}`);
    return inNiche && !LOT.test(title) && !niche.exclude.test(title);
  });
  const out = {};
  for (const g of [...niche.groups, "all"]) {
    const mine = g === "all" ? singles : singles.filter((r) => niche.group(String(r.Rubrik ?? "")) === g);
    const sold = mine.filter((r) => r.Status === "Såld" && Number(r.Pris) > 0).map((r) => Number(r.Pris));
    const unsold = mine.filter((r) => r.Status === "Osåld").length;
    const s = stats(sold);
    out[g] = { ...s, net: s.median != null ? s.median - computeFees(s.median, platform) : null, sell_through: sold.length + unsold ? Math.round((100 * sold.length) / (sold.length + unsold)) : null };
  }
  return out;
}

// Aktiva partier med antal och vad de är värda för dig.
//  - Med styckdata (minst MIN_SINGLES sålda i gruppen): nettovärde = antal × netto
//    per figur; köpreglerna (småfigur) ger "betala högst" inkl. frakt (grön/gul).
//  - Annars: värde = antal × vad partier sålts för per figur, fynd = högst DEAL_SHARE.
// Auktioner får budtak = betala högst minus frakten (kräver känd frakt).
export function rankDeals(lots, bench, { singles = null, rules = mergeRules() } = {}) {
  return lots
    .filter((l) => !l.ended && l.per_figure != null)
    .map((l) => {
      const single = singles?.[l.group]?.n >= MIN_SINGLES ? singles[l.group] : singles?.all?.n >= MIN_SINGLES ? singles.all : null;
      if (single) {
        const value = l.count * single.net;
        const limits = maxBuy(value, true, rules);
        const color = l.total <= limits.green ? "green" : l.total <= limits.yellow ? "yellow" : "red";
        const maxBid = l.shipping != null ? Math.max(0, limits.green - l.shipping) : null;
        // Auktion med Köp nu-pris: är Köp nu (inkl. frakt) under gränsen kan du köpa direkt.
        const buyNowTotal = l.buy_now && l.shipping != null ? l.buy_now + l.shipping : null;
        const buyNowOk = buyNowTotal != null && buyNowTotal <= limits.green;
        return {
          ...l,
          basis: "styckvis",
          buy_now_total: buyNowTotal,
          buy_now_ok: buyNowOk,
          buy_now_multiple: buyNowTotal ? Math.round((10 * value) / buyNowTotal) / 10 : null,
          value,
          per_figure_value: single.net,
          pay_max: limits.green,
          pay_max_yellow: limits.yellow,
          multiple: l.total ? Math.round((10 * value) / l.total) / 10 : null,
          color,
          share: value ? Math.round((100 * l.total) / value) / 100 : null,
          max_bid: maxBid,
          under_max: l.price_kind === "bud" && maxBid != null && l.price <= maxBid,
          deal: (l.price_kind === "köp nu" && l.shipping != null && color === "green") || buyNowOk,
        };
      }
      const ref = bench[l.group]?.n >= 8 ? bench[l.group] : bench.all;
      const share = ref.median ? Math.round((100 * l.per_figure) / ref.median) / 100 : null;
      // Värde = antal × normalpris per figur (inkl. frakt). Budtak för auktioner:
      // högsta bud som fortfarande är ett fynd (DEAL_SHARE av värdet), minus frakten.
      const value = ref.median && l.count ? l.count * ref.median : null;
      const maxBid = value && l.shipping != null ? Math.max(0, Math.floor(value * DEAL_SHARE - l.shipping)) : null;
      // Fynd = Köp nu med känd frakt. Ett bud är inte slutpriset, och bara
      // avhämtning eller okänd frakt ser billigare ut än det är.
      const buyNowTotal = l.buy_now && l.shipping != null ? l.buy_now + l.shipping : null;
      const buyNowOk = buyNowTotal != null && value != null && buyNowTotal <= value * DEAL_SHARE;
      return {
        ...l,
        basis: "partier",
        buy_now_total: buyNowTotal,
        buy_now_ok: buyNowOk,
        ref_median: ref.median,
        share,
        value,
        max_bid: maxBid,
        under_max: l.price_kind === "bud" && maxBid != null && l.price <= maxBid,
        deal: (share != null && share <= DEAL_SHARE && l.shipping != null && l.price_kind === "köp nu") || buyNowOk,
      };
    })
    .sort((a, b) => (a.share ?? 9) - (b.share ?? 9));
}

// En sökning är text ("schleich st") eller { words, category } (inom en kategori).
const searchBody = (q) => (typeof q === "string" ? { searchWords: q } : { searchWords: q.words, categoryId: q.category });
const queryLabel = (q) => (typeof q === "string" ? q : `${q.words} i kategori ${q.category}`);

// Kontroll av en enskild annons (länk eller id): vad filtren säger och vilka
// partisökningar som hittar den – för att förstå varför ett parti saknas.
export async function checkLot(link, { search = searchAdvanced, get = traderaGet } = {}) {
  const id = /\/item\/(?:\d+\/)?(\d{6,})/.exec(String(link))?.[1] ?? /^\d{6,}$/.exec(String(link).trim())?.[0];
  if (!id) throw new Error("Klistra in en Tradera-länk eller ett annons-id");
  const item = await get(`/v4/items/${id}`);
  const title = String(pick(item, "shortDescription") ?? "").trim();
  const nicheId = nicheOf(title);
  const niche = getNiche(nicheId ?? "djur");
  const reasons = [];
  if (!nicheId) reasons.push("rubriken nämner varken Schleich eller smurf");
  if (!/\b\d+\s*(st|stycken|styck|figurer|djur|hästar|föl|delar|smurfar|smurfer)\b|\d+-?pack|paket|samling|\blot\b|blandat|blandade|mängd|låda|kartong|bundle|parti\b/i.test(title)) reasons.push("inget partiord i rubriken");
  if (niche.exclude.test(title)) reasons.push(`sorteras bort: "${niche.exclude.exec(title)[0]}"`);
  const count = countFigures(title);
  if (!count) reasons.push("antalet figurer går inte att läsa ur rubriken");
  const ended = pick(pick(item, "status"), "ended") === true || Date.parse(pick(item, "endDate") ?? "") < Date.now();
  // Alla sökningar parallellt; inom en sökning sida för sida tills annonsen hittas.
  const found = await Promise.all(
    (niche.lotQueries ?? [niche.query]).map(async (q) => {
      let hit = null;
      let pages = 1;
      for (let page = 1; page <= pages && page <= MAX_PAGES && !hit; page++) {
        const data = await search({ ...searchBody(q), itemsPerPage: PER_PAGE, pageNumber: page, ...(ended ? { itemStatus: "Ended" } : {}) }).catch(() => null);
        pages = Number(pick(data, "totalNumberOfPages")) || 1;
        if ((pick(data, "items") ?? []).some((x) => String(pick(x, "id")) === id)) hit = page;
      }
      return { query: queryLabel(q), page: hit, pages };
    }),
  );
  return { id, title, niche: nicheId, count, ended, is_lot: reasons.length === 0, reasons, shipping: shippingOf(item), found };
}

// Hämtar aktiva och avslutade annonser för nischen, plockar ut partierna och
// hämtar frakten för dem med antal.
export async function findLots({ niche: nicheId = "djur", search = searchAdvanced, get = traderaGet, store = callAppsScript, settings = null, now = Date.now() } = {}) {
  const niche = getNiche(nicheId);
  const rules = mergeRules(settings?.decision);
  const platform = settings?.platforms?.Tradera ?? { fee_percent: 10, fee_fixed: 0 };
  // Sålda och osålda annonser i marknadsdatabasen (styckförsäljning).
  const marketRows = (async () => {
    if (store === callAppsScript && !storageConfigured()) return null;
    const read = (status) => store("sheetRead", { sheet: "Marknad", headers: MARKET_HEADERS, filter: { column: "Status", equals: status } });
    const [sold, unsold] = await Promise.all([read("Såld"), read("Osåld")]);
    return sold?.ok && unsold?.ok ? [...sold.rows, ...unsold.rows] : null;
  })().catch(() => null);
  const truncated = [];
  const runQuery = async (query, status) => {
    const body = (pageNumber) => ({ ...searchBody(query), itemsPerPage: PER_PAGE, pageNumber, ...(status ? { itemStatus: status } : {}) });
    const first = await search(body(1)).catch(() => null);
    const total = Number(pick(first, "totalNumberOfPages")) || 1;
    if (total > MAX_PAGES) truncated.push(`${queryLabel(query)}${status ? " (avslutade)" : ""}`);
    const pages = Math.min(total, MAX_PAGES);
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => search(body(i + 2)).catch(() => null)));
    return [first, ...rest].flatMap((d) => pick(d, "items") ?? []);
  };
  // Alla partisökningar för både aktiva och avslutade annonser, utan dubbletter.
  const run = async (status) => (await Promise.all((niche.lotQueries ?? [niche.query]).map((q) => runQuery(q, status)))).flat();
  const [active, ended] = await Promise.all([run(null), run("Ended")]);
  const seen = new Set();
  let lots = [];
  // Avslutade först: finns samma annons i båda listorna gäller den avslutade.
  for (const [items, isEnded] of [[ended, true], [active, false]]) {
    for (const item of items) {
      const id = pick(item, "id");
      if (seen.has(id)) continue;
      seen.add(id);
      if (isLot(pick(item, "shortDescription"), niche)) lots.push(toLot(item, isEnded, niche));
    }
  }
  const shipped = await addShipping(lots, { get });
  lots = shipped.lots;
  const bench = benchmark(lots, niche);
  const rows = await marketRows;
  const singles = rows ? singleStats(rows, niche, platform) : null;
  const deals = rankDeals(lots, bench, { singles, rules });
  const activeLots = lots.filter((l) => !l.ended);
  return {
    version: LOTS_VERSION,
    niche: niche.id,
    label: niche.label,
    groups: niche.groups,
    fetched_at: new Date(now).toISOString(),
    scanned: seen.size,
    lots: lots.length,
    active_lots: activeLots.length,
    without_count: activeLots.filter((l) => !l.count).length,
    sold_lots: lots.filter((l) => l.sold && l.per_figure != null).length,
    shipping_fetched: shipped.fetched,
    queries: (niche.lotQueries ?? [niche.query]).map(queryLabel),
    truncated,
    benchmark: bench,
    singles,
    rules: { small_green: rules.small_green, small_yellow: rules.small_yellow },
    fee_percent: platform.fee_percent,
    // Alla aktiva auktioner (de har egen lista) + de 150 billigaste övriga.
    deals: [...deals.filter((l) => l.price_kind === "bud"), ...deals.filter((l) => l.price_kind !== "bud").slice(0, 150)].sort((a, b) => (a.share ?? 9) - (b.share ?? 9)),
  };
}
