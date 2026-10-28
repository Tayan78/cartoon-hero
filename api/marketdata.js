// POST /api/marketdata – marknadsdatabasen (Sheet-flikarna "Säljare" och "Marknad").
//   Från appen (x-app-token):
//     { action: "discover" }              föreslå konkurrenter (många Schleich-annonser)
//     { action: "sellers" }               bevakade säljare och deras siffror
//     { action: "watch", seller, watch }  bevaka eller sluta bevaka en säljare
//     { action: "collect", alias, user_id } samla in en säljare nu
//   Från Apps Script-timern (x-script-secret): { action: "collect", alias, user_id }
import { timingSafeEqual } from "node:crypto";
import { checkAuth, json } from "../lib/http.js";
import { collectSeller, discoverSellers } from "../lib/marketdata.js";
import { callAppsScript, storageConfigured } from "../lib/storage.js";
import { traderaConfigured, traderaGet } from "../lib/tradera.js";

function scriptAllowed(request) {
  const expected = process.env.APPS_SCRIPT_SECRET;
  const given = request.headers.get("x-script-secret");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request) {
  const fromScript = scriptAllowed(request);
  if (!fromScript) {
    const denied = checkAuth(request);
    if (denied) return denied;
  }
  const body = await request.json().catch(() => ({}));
  if (fromScript && body.action !== "collect") return json({ ok: false, error: "Inte tillåtet" }, 403);
  if (!traderaConfigured()) return json({ ok: false, error: "Tradera är inte konfigurerat" }, 400);
  if (body.action !== "discover" && !storageConfigured()) return json({ ok: false, error: "Google Sheet är inte konfigurerat" }, 400);

  try {
    switch (body.action) {
      case "discover": {
        const [found, watched] = await Promise.all([discoverSellers(), storageConfigured() ? callAppsScript("marketSellers", {}) : { sellers: [] }]);
        const ids = new Set((watched.sellers ?? []).filter((s) => s.watched).map((s) => String(s.id)));
        return json({ ok: true, ...found, sellers: found.sellers.map((s) => ({ ...s, watched: ids.has(String(s.id)) })) });
      }
      case "sellers": {
        const res = await callAppsScript("marketSellers", {});
        if (!res.ok) throw new Error(res.error || "Kunde inte läsa Säljare");
        return json(res);
      }
      case "watch": {
        const s = { ...(body.seller ?? {}) };
        // Bara alias (inskrivet för hand): slå upp säljarens id hos Tradera.
        if (!s.id && s.alias) {
          const user = await traderaGet(`/v4/users/by-alias/${encodeURIComponent(String(s.alias).trim().replace(/^@/, ""))}`).catch(() => null);
          s.id = user?.id ?? user?.userId;
          if (!s.id) return json({ ok: false, error: `Hittade ingen säljare med aliaset "${s.alias}"` }, 400);
          s.alias = user.alias ?? s.alias;
        }
        if (!s.id || !s.alias) return json({ ok: false, error: "Säljare saknas" }, 400);
        const res = await callAppsScript("marketWatch", { seller: s, watch: body.watch !== false, process_url: new URL(request.url).origin + "/api/marketdata" });
        if (!res.ok) throw new Error(res.error || "Kunde inte spara säljaren");
        return json({ ...res, seller: { id: String(s.id), alias: s.alias } });
      }
      case "collect": {
        if (!body.alias && !body.user_id) return json({ ok: false, error: "Säljare saknas" }, 400);
        return json({ ok: true, ...(await collectSeller({ alias: body.alias, user_id: body.user_id })) });
      }
      default:
        return json({ ok: false, error: "Okänd action" }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
}
