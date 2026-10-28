// POST /api/marketdata – marknadsdatabasen (Sheet-flikarna "Säljare" och "Marknad").
// Logiken ligger i lib/marketdata.js; Apps Script läser och skriver bara flikar.
//   Från appen (x-app-token):
//     { action: "discover" }                föreslå konkurrenter (många Schleich-annonser)
//     { action: "sellers" }                 bevakade säljare och deras siffror
//     { action: "watch", seller, watch }    bevaka eller sluta bevaka (seller: { id?, alias })
//     { action: "collect", alias, user_id } samla in en säljare nu
//   Från Apps Script-timern (x-script-secret): { action: "nightly", state }
import { timingSafeEqual } from "node:crypto";
import { checkAuth, json } from "../lib/http.js";
import { collectSeller, discoverSellers, listSellers, runNightly, watchSeller } from "../lib/marketdata.js";
import { storageConfigured } from "../lib/storage.js";
import { traderaConfigured, traderaGet } from "../lib/tradera.js";

function scriptAllowed(request) {
  const expected = process.env.APPS_SCRIPT_SECRET;
  const given = request.headers.get("x-script-secret");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Säljarens id från aliaset (när det skrivits in för hand).
async function resolve(seller) {
  if (seller.id) return seller;
  const alias = String(seller.alias ?? "").trim().replace(/^@/, "");
  if (!alias) throw new Error("Säljare saknas");
  const user = await traderaGet(`/v4/users/by-alias/${encodeURIComponent(alias)}`).catch(() => null);
  const id = user?.id ?? user?.userId;
  if (!id) throw new Error(`Hittade ingen säljare med aliaset "${alias}"`);
  return { ...seller, id: String(id), alias: user.alias ?? alias };
}

export async function POST(request) {
  const fromScript = scriptAllowed(request);
  if (!fromScript) {
    const denied = checkAuth(request);
    if (denied) return denied;
  }
  const body = await request.json().catch(() => ({}));
  if (fromScript && body.action !== "nightly") return json({ ok: false, error: "Inte tillåtet" }, 403);
  if (!traderaConfigured()) return json({ ok: false, error: "Tradera är inte konfigurerat" }, 400);
  if (body.action !== "discover" && !storageConfigured()) return json({ ok: false, error: "Google Sheet är inte konfigurerat" }, 400);

  try {
    switch (body.action) {
      case "discover": {
        const [found, sellers] = await Promise.all([discoverSellers(), storageConfigured() ? listSellers().catch(() => []) : []]);
        const ids = new Set(sellers.filter((s) => s.watched).map((s) => s.id));
        return json({ ok: true, ...found, sellers: found.sellers.map((s) => ({ ...s, watched: ids.has(String(s.id)) })) });
      }
      case "sellers":
        return json({ ok: true, sellers: await listSellers() });
      case "watch": {
        const seller = await resolve({ ...(body.seller ?? {}) });
        const saved = await watchSeller(seller, body.watch !== false, { url: new URL(request.url).origin + "/api/marketdata" });
        return json({ ok: true, seller: saved });
      }
      case "collect": {
        const seller = await resolve({ id: body.user_id, alias: body.alias });
        return json({ ok: true, ...(await collectSeller({ alias: seller.alias, user_id: seller.id })) });
      }
      case "nightly":
        if (!fromScript) return json({ ok: false, error: "Inte tillåtet" }, 403);
        return json({ ok: true, ...(await runNightly(body.state)) });
      default:
        return json({ ok: false, error: "Okänd action" }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
}
