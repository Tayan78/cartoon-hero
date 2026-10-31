// Räknar anrop till externa tjänster (Tradera, Gemini, SerpApi …) för översikten
// i appen. Räknarna samlas i minnet och skrivs till databasen (via workern) några
// sekunder efter det första anropet – ett skrivanrop i stället för ett per anrop.
import { waitUntil } from "@vercel/functions";

const FLUSH_MS = 3000;
let pending = {};
let scheduled = false;

// Bara på Vercel (inte i tester eller lokalt).
const enabled = () => Boolean(process.env.VERCEL && process.env.APP_TOKEN);

export function countUsage(api, n = 1) {
  if (!enabled()) return;
  pending[api] = (pending[api] ?? 0) + n;
  if (scheduled) return;
  scheduled = true;
  try {
    waitUntil(new Promise((resolve) => setTimeout(resolve, FLUSH_MS)).then(flushUsage));
  } catch {
    scheduled = false;
  }
}

export async function flushUsage() {
  scheduled = false;
  const counts = pending;
  pending = {};
  if (!Object.keys(counts).length) return;
  const url = process.env.DATA_URL || "https://loppis-bevakning.loppis.workers.dev";
  await fetch(`${url}/data/usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-token": process.env.APP_TOKEN },
    body: JSON.stringify({ counts }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

// Traderas anrop per metod (gränsen är 10 000 per dygn och metod).
export function traderaApi(path) {
  if (path.startsWith("/v4/search")) return "tradera_search";
  if (path.startsWith("/v4/items/seller")) return "tradera_seller";
  if (path.startsWith("/v4/items")) return "tradera_item";
  if (path.startsWith("/v4/users")) return "tradera_user";
  if (path.startsWith("/v4/orders")) return "tradera_orders";
  return "tradera_other";
}
