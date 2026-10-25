// Köpbeslutet räknas fram av servern med fasta regler – AI:n får aldrig sätta
// det, bara förklara det i efterhand (se explainPrompt/checkExplanation).
//
//   Vinst    = netto efter avgifter och frakt − inköpspris
//   Multipel = netto efter avgifter och frakt / inköpspris
//
// Vanliga föremål: grön om vinst ≥ min_profit OCH (multipel ≥ min_multiple ELLER
// inköp ≥ big_buy), gul om vinst > 0, annars röd.
// Småfigurer (bulkaffär): grön om multipel ≥ small_green, gul om ≥ small_yellow.
// Osäkert pris: högst gul.
// Utan inköpspris räknas i stället "Betala inte mer än" bakvägen fram.

export const DEFAULT_RULES = {
  min_profit: 100,
  min_multiple: 2,
  big_buy: 200,
  small_green: 2,
  small_yellow: 1.3,
  small_price: 100,
  small_brands: ["Schleich"],
};

export const VERDICT = { green: "Köp", yellow: "Tveksamt", red: "Låt bli" };

const EPS = 1e-9;
const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;
// Multipeln avrundas nedåt till en decimal, så att t.ex. 1,98× aldrig visas som "2,0×" på ett gult kort.
export const formatMultiple = (m) => `${(Math.floor(m * 10 + EPS) / 10).toFixed(1).replace(".", ",")}×`;

export function isSmallFigure({ brand, listPrice }, rules = DEFAULT_RULES) {
  const b = String(brand ?? "").toLowerCase();
  const byBrand = rules.small_brands.some((name) => name && b.includes(name.toLowerCase()));
  return byBrand || (listPrice > 0 && listPrice < rules.small_price);
}

function colorFor({ profit, multiple, buy, small }, rules) {
  if (small) {
    if (multiple >= rules.small_green - EPS) return "green";
    if (multiple >= rules.small_yellow - EPS) return "yellow";
    return "red";
  }
  if (profit <= 0) return "red";
  if (profit >= rules.min_profit && (multiple >= rules.min_multiple - EPS || buy >= rules.big_buy)) return "green";
  return "yellow";
}

// Högsta inköpspris (hela kronor) som fortfarande ger grön respektive gul.
export function maxBuy(net, small, rules = DEFAULT_RULES) {
  if (net <= 0) return { green: 0, yellow: 0 };
  if (small) {
    return {
      green: Math.floor(net / rules.small_green + EPS),
      yellow: Math.floor(net / rules.small_yellow + EPS),
    };
  }
  const byProfit = net - rules.min_profit;
  let green = 0;
  if (byProfit >= rules.big_buy) green = byProfit; // stort köp: multipeln behövs inte
  else if (byProfit > 0) green = Math.floor(Math.min(byProfit, net / rules.min_multiple) + EPS);
  return { green: Math.max(0, green), yellow: Math.max(0, Math.ceil(net) - 1) };
}

// net: utpris − avgift − frakt (före inköp). buy: 0 = inköpspris inte angivet.
export function decide({ net, buy, listPrice, brand, uncertain = false, rules = DEFAULT_RULES }) {
  const small = isSmallFigure({ brand, listPrice }, rules);
  const limits = maxBuy(net, small, rules);
  const known = buy > 0;
  const base = { known, small, uncertain, net, max_buy: limits };

  if (!known) {
    // Inget pris att bedöma: visa vad man högst kan betala.
    const color = limits.yellow > 0 ? "none" : "red";
    const verdict =
      color === "red" ? VERDICT.red : limits.green > 0 ? `Betala inte mer än ${kr(limits.green)}` : `Ingen grön affär – max ${kr(limits.yellow)}`;
    return {
      ...base,
      color,
      verdict,
      pay_max: limits.green || limits.yellow,
      profit: null,
      multiple: null,
      capped: false,
      summary: summarize({ ...base, color, profit: null, multiple: null }),
    };
  }

  const profit = Math.round(net - buy);
  const multiple = net / buy;
  let color = colorFor({ profit, multiple, buy, small }, rules);
  const capped = uncertain && color === "green";
  if (capped) color = "yellow";
  const d = { ...base, color, verdict: VERDICT[color], pay_max: limits.green || limits.yellow, profit, multiple, capped };
  return { ...d, summary: summarize(d) };
}

// Fast, regelstyrd motivering – används alltid som grund och som reserv om AI-texten underkänns.
export function summarize(d) {
  const parts = [];
  if (!d.known) {
    if (d.color === "red") parts.push("Ingen marginal kvar efter avgifter och frakt, även om du får den gratis.");
    else if (d.max_buy.green > 0) parts.push(`Grön affär upp till ${kr(d.max_buy.green)}, vinst kvar upp till ${kr(d.max_buy.yellow)}.`);
    else parts.push(`Ingen grön affär möjlig – vinst bara om du betalar högst ${kr(d.max_buy.yellow)}.`);
    if (d.uncertain) parts.push("Priset är osäkert, så pruta gärna lägre.");
  } else {
    const m = formatMultiple(d.multiple);
    if (d.small) {
      parts.push(`Multipel ${m} på inköpet (${d.profit >= 0 ? "vinst" : "förlust"} ${kr(Math.abs(d.profit))}).`);
    } else if (d.profit <= 0) {
      parts.push(`Förlust ${kr(-d.profit)} efter avgifter och frakt.`);
    } else {
      parts.push(`Vinst ${kr(d.profit)} (${m}) efter avgifter och frakt.`);
    }
    if (d.capped) parts.push("Hade varit grön, men priset är osäkert.");
  }
  if (d.small) parts.push("Bulkaffär: räkna på hela lotten, inte styck.");
  return parts.join(" ");
}

// Prompt för AI-motiveringen: beslutet och siffrorna är givna och får inte ändras.
export function explainPrompt(d, { name, listPrice, marketNote }) {
  const facts = [
    `Föremål: ${name}`,
    `Beslut (färdigt, får inte ändras): ${d.known ? `${d.verdict} (${d.color === "green" ? "grön" : d.color === "yellow" ? "gul" : "röd"})` : d.verdict}`,
    `Utpris: ${kr(listPrice)}`,
    d.known ? `Vinst: ${kr(d.profit)}, multipel ${formatMultiple(d.multiple)}` : "Inköpspris: inte angivet",
    d.small ? "Småfigur – bulkaffär, räkna på hela lotten." : "",
    d.uncertain ? "Priset är osäkert (få eller inga annonser på Tradera/eBay)." : "",
    marketNote ? `Om efterfrågan: ${marketNote}` : "",
  ].filter(Boolean);
  return `Skriv EN kort mening på svenska (max 25 ord) till en reseller som förklarar beslutet nedan. Beslutet och siffrorna är redan bestämda – upprepa dem inte med andra värden, motsäg dem inte och ge inget eget köpråd. Inga procentsatser. Svara bara med meningen.

${facts.join("\n")}`;
}

// Underkänner AI-texter som pekar åt ett annat håll än beslutet.
const CONTRA = {
  green: /låt bli|avstå|inte värt|olönsam|förlust|dålig affär|köp inte/i,
  yellow: /klart köp|självklart köp|riktigt bra affär|låt bli|köp inte/i,
  red: /bra affär|fynd|köp den|värt att köpa|lönsam|klart köp|god marginal/i,
  none: /låt bli|köp den|klart köp/i,
};
export function checkExplanation(text, d) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 300) return null;
  if (/\d+\s*%/.test(t)) return null;
  if (CONTRA[d.color]?.test(t)) return null;
  return t;
}

export function mergeRules(input) {
  const out = structuredClone(DEFAULT_RULES);
  if (!input || typeof input !== "object") return out;
  for (const key of ["min_profit", "min_multiple", "big_buy", "small_green", "small_yellow", "small_price"]) {
    const n = Number(input[key]);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  const brands = Array.isArray(input.small_brands) ? input.small_brands : typeof input.small_brands === "string" ? input.small_brands.split(",") : null;
  if (brands) out.small_brands = brands.map((b) => String(b).trim()).filter(Boolean).slice(0, 20);
  return out;
}
