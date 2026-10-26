// POST /api/home { since } – siffrorna på startsidan:
//   lens:     sökningar kvar hos SerpApi (live från deras konto-API)
//   usage:    appens egen kostnadsräkning sedan din senaste avläsning av
//             Google Cloud (summa av "Kostnad SEK" i Skanningar och Annonser)
//   listings: antal annonser exporterade till ProLister, och hur många som väntar på dig
// Google har inget API som visar saldot för en API-nyckel, därför avläsning + räkning.
import { checkAuth, json } from "../lib/http.js";
import { lensAccount, lensConfigured } from "../lib/lens.js";
import { callAppsScript, storageConfigured } from "../lib/storage.js";

const MOCK = process.env.MOCK === "1";

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  const since = Number.isFinite(Date.parse(body.since)) ? new Date(body.since).toISOString() : "";

  const [lens, summary] = await Promise.all([
    MOCK && !lensConfigured()
      ? { left: 202, per_month: 250, used: 48, plan: "Free" }
      : lensConfigured()
        ? lensAccount().catch((err) => ({ error: err.message }))
        : null,
    MOCK && !storageConfigured()
      ? { ok: true, sek_since: 1.84, exported: 23, ready: 2, approved: 1 }
      : storageConfigured()
        ? callAppsScript("summary", { since }).catch((err) => ({ ok: false, error: err.message }))
        : null,
  ]);
  return json({
    ok: true,
    lens,
    usage: summary?.ok ? { sek_since: summary.sek_since ?? 0 } : summary ? { error: summary.error } : null,
    listings: summary?.ok ? { exported: summary.exported ?? 0, ready: summary.ready ?? 0, approved: summary.approved ?? 0 } : null,
  });
}
