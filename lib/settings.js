// Standardinställningar. Allt här kan skrivas över från appens inställningssida
// (sparas i telefonen och skickas med varje skanning), så inget är hårdkodat.
// Kontrollera avgifterna mot plattformarnas aktuella villkor – de ändras ibland.
import { DEFAULT_ID_MODEL, DEFAULT_SEARCH_MODEL, valid } from "./models.js";

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
  out.models.search = valid(input.models?.search) ?? out.models.search;
  if (typeof input.vision === "boolean") out.vision = input.vision;
  return out;
}
