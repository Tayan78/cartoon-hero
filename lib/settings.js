// Standardinställningar. Allt här kan skrivas över från appens inställningssida
// (sparas i telefonen och skickas med varje skanning), så inget är hårdkodat.
// Kontrollera avgifterna mot plattformarnas aktuella villkor – de ändras ibland.
import { DEFAULT_RULES, mergeRules } from "./decision.js";
import { DEFAULT_ID_MODEL, DEFAULT_SEARCH_MODEL, valid } from "./models.js";

export const DEFAULT_CLOSING =
  "Samfraktar gärna om du köper flera eller vinner flera auktioner. Packas väl i bubbelkuvert eller spårbart brevlådepaket. Titta gärna på mina andra annonser!";

export const DEFAULT_SETTINGS = {
  platforms: {
    Tradera: { fee_percent: 10, fee_fixed: 0, shipping: 59 },
    Vinted: { fee_percent: 0, fee_fixed: 0, shipping: 0 },
    Blocket: { fee_percent: 0, fee_fixed: 0, shipping: 59 },
    Annan: { fee_percent: 0, fee_fixed: 0, shipping: 59 },
  },
  // Växelkurser till SEK för eBay-priser
  fx: { USD: 10.5, EUR: 11.5, GBP: 13.5 },
  // Modell per steg och om Googles bildsök ska användas
  models: { identify: DEFAULT_ID_MODEL, search: DEFAULT_SEARCH_MODEL },
  vision: true,
  gemini: true,
  // Google Lens via SerpApi (ersätter Cloud Vision i enkelt läge när den finns)
  lens: true,
  // Traderas egna sökning (aktiva annonser) i enkelt läge
  tradera: true,
  // "simple": Vision + Gemini (annonser till salu i Sverige). "advanced": hela kedjan med Claude.
  mode: "simple",
  // Annonsläget: din fasta avslutning sist i varje annons.
  listing: { closing: DEFAULT_CLOSING },
  // Köpreglerna (trösklar för grön/gul/röd), se lib/decision.js.
  decision: DEFAULT_RULES,
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Slår ihop klientens inställningar med standardvärdena och sanerar siffrorna.
export function mergeSettings(input) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!input || typeof input !== "object") return out;
  for (const [name, def] of Object.entries(out.platforms)) {
    const p = input.platforms?.[name] ?? {};
    out.platforms[name] = {
      fee_percent: num(p.fee_percent, def.fee_percent),
      fee_fixed: num(p.fee_fixed, def.fee_fixed),
      shipping: num(p.shipping, def.shipping),
    };
  }
  for (const [cur, def] of Object.entries(out.fx)) {
    out.fx[cur] = num(input.fx?.[cur], def);
  }
  out.models.identify = valid(input.models?.identify) ?? out.models.identify;
  // Prissökningen kan också köras av Gemini med Google-sökning.
  out.models.search = input.models?.search === "gemini" ? "gemini" : valid(input.models?.search) ?? out.models.search;
  if (typeof input.vision === "boolean") out.vision = input.vision;
  if (typeof input.gemini === "boolean") out.gemini = input.gemini;
  if (input.mode === "simple" || input.mode === "advanced") out.mode = input.mode;
  if (typeof input.lens === "boolean") out.lens = input.lens;
  if (typeof input.tradera === "boolean") out.tradera = input.tradera;
  out.decision = mergeRules(input.decision);
  if (typeof input.listing?.closing === "string") out.listing.closing = input.listing.closing.trim().slice(0, 1000);
  return out;
}
