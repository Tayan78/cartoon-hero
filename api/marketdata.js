// POST /api/marketdata – marknadsdatabasen (Sheet-flikarna "Säljare" och "Marknad").
// Logiken ligger i lib/marketdata.js; Apps Script läser och skriver bara flikar.
//   Från appen (x-app-token):
//     { action: "discover" }                föreslå konkurrenter (många Schleich-annonser)
//     { action: "sellers" }                 bevakade säljare och deras siffror
//     { action: "watch", seller, watch }    bevaka eller sluta bevaka (seller: { id?, alias })
//     { action: "collect_all", only? }     starta insamling i bakgrunden (alla, eller only = [id])
//     { action: "status" }                  pågående insamling + säljarna
//     { action: "singles", niches }         styckförsäljning per nisch (till bevakningen i Cloudflare)
//     { action: "lots_check", link }        varför saknas ett parti? filter + vilka sökningar som hittar det
//     { action: "lots", niche }             partier (djur/smurfar): kr per figur inkl. frakt och fynd (lib/lots.js)
//     { action: "db_status" }               databasen (Cloudflare D1): antal annonser, sålda, säljare
//     { action: "db_copy", offset }         kopiera Säljare + Marknad från arket till databasen
//     { action: "sweep" }                   all Schleich på Tradera till databasen (i bakgrunden)
//     { action: "sweep_status" }            hur den senaste Schleich-insamlingen gick
//     { action: "dashboard" }               översikten: körningar, anrop per dygn, databasen
//     { action: "competitors" }             förslag på konkurrenter från databasen (mest sålt Schleich)
//     { action: "products" }                produkter: täckning och mest sålda modeller
//     { action: "market", days }            marknadsanalys för Schleich (7/30/90 dagar eller "all")
//     { action: "products_relink" }         koppla annonser utan produkt + uppdatera kategorierna
//   Från Apps Script-timern (x-script-secret): { action: "nightly" }
//   Från servern själv (x-script-secret):     { action: "continue", state } – nästa steg,
//                                             { action: "sweep_bg" } – Schleich-insamlingen efter säljarna,
//                                             { action: "details_bg", state } – annonsdetaljer i steg efter sökningen
// Insamlingen körs med waitUntil: svaret kommer direkt och arbetet fortsätter.
import { timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { checkAuth, json } from "../lib/http.js";
import { dbCompetitors, dbConfigured, dbDashboard, dbMarket, dbProducts, dbStatus } from "../lib/db.js";
import { relinkProducts, syncCategories } from "../lib/productsync.js";
import { collectSeller, copyToDb, discoverSellers, listSellers, runStatus, runStep, startRun, watchSeller } from "../lib/marketdata.js";
import { checkLot, findLots, singlesForNiches } from "../lib/lots.js";
import { runSweep, sweepStatus } from "../lib/sweep.js";
import { detailStep } from "../lib/detail.js";
import { mergeSettings } from "../lib/settings.js";
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

// Kör ett steg och startar nästa steg som ett nytt anrop (varje anrop får ca 2 min).
async function chain(state, origin) {
  const out = await runStep(state);
  // Alla säljare klara → hela Schleich-insamlingen, som ett eget anrop (egen tid).
  if (!out.more) {
    if (!state?.only) await selfCall(origin, { action: "sweep_bg" });
    return;
  }
  await selfCall(origin, { action: "continue", state: out.state });
}

// Schleich-sökningen, sedan annonsdetaljerna (i egna anrop, så att tiden räcker).
const sweepThenDetails = (origin) =>
  runSweep()
    .catch(() => {})
    .then(() => selfCall(origin, { action: "details_bg", state: {} }));

// Startar nästa steg som ett nytt anrop till servern själv.
const selfCall = (origin, body) =>
  fetch(`${origin}/api/marketdata`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-script-secret": process.env.APPS_SCRIPT_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});

export async function POST(request) {
  const fromScript = scriptAllowed(request);
  if (!fromScript) {
    const denied = checkAuth(request);
    if (denied) return denied;
  }
  const body = await request.json().catch(() => ({}));
  if (fromScript && !["nightly", "continue", "sweep_bg", "details_bg"].includes(body.action)) return json({ ok: false, error: "Inte tillåtet" }, 403);
  const origin = new URL(request.url).origin;
  if (!traderaConfigured()) return json({ ok: false, error: "Tradera är inte konfigurerat" }, 400);
  if (!["discover", "lots", "lots_check", "db_status", "dashboard", "competitors", "products", "products_relink", "market"].includes(body.action) && !storageConfigured()) return json({ ok: false, error: "Google Sheet är inte konfigurerat" }, 400);

  try {
    switch (body.action) {
      case "discover": {
        const [found, sellers] = await Promise.all([discoverSellers({ niche: body.niche }), storageConfigured() ? listSellers().catch(() => []) : []]);
        const ids = new Set(sellers.filter((s) => s.watched).map((s) => s.id));
        return json({ ok: true, ...found, sellers: found.sellers.map((s) => ({ ...s, watched: ids.has(String(s.id)) })) });
      }
      case "singles": {
        // Till bevakningen (Cloudflare): styckförsäljning per nisch och köpreglerna.
        const ids = Array.isArray(body.niches) && body.niches.length ? body.niches.map(String) : ["djur"];
        return json({ ok: true, ...(await singlesForNiches(ids, { settings: mergeSettings(body.settings) })) });
      }
      case "lots_check":
        return json({ ok: true, ...(await checkLot(body.link)) });
      case "lots":
        return json({ ok: true, ...(await findLots({ niche: body.niche, settings: mergeSettings(body.settings) })) });
      case "db_status":
        if (!dbConfigured()) return json({ ok: false, error: "APP_TOKEN saknas på servern" }, 400);
        return json({ ok: true, db: await dbStatus() });
      case "dashboard":
        if (!dbConfigured()) return json({ ok: false, error: "APP_TOKEN saknas på servern" }, 400);
        return json({ ok: true, ...(await dbDashboard()) });
      case "competitors":
        if (!dbConfigured()) return json({ ok: false, error: "APP_TOKEN saknas på servern" }, 400);
        return json({ ok: true, ...(await dbCompetitors({ limit: body.limit, min: body.min })) });
      case "market":
        if (!dbConfigured()) return json({ ok: false, error: "APP_TOKEN saknas på servern" }, 400);
        return json({ ok: true, ...(await dbMarket({ days: body.days === "all" ? null : body.days })) });
      case "products":
        if (!dbConfigured()) return json({ ok: false, error: "APP_TOKEN saknas på servern" }, 400);
        return json({ ok: true, ...(await dbProducts({ limit: body.limit })) });
      case "products_relink": {
        const [linked, categories] = await Promise.all([relinkProducts(), syncCategories().catch((err) => ({ error: err.message }))]);
        return json({ ok: true, ...linked, categories });
      }
      case "db_copy":
        return json({ ok: true, ...(await copyToDb({ offset: Number(body.offset) || 0 })) });
      case "sweep": {
        const st = await sweepStatus();
        if (st?.running) return json({ ok: true, started: false, sweep: st });
        waitUntil(sweepThenDetails(origin));
        return json({ ok: true, started: true });
      }
      case "sweep_bg":
        if (!fromScript) return json({ ok: false, error: "Inte tillåtet" }, 403);
        waitUntil(sweepThenDetails(origin));
        return json({ ok: true });
      case "details_bg":
        if (!fromScript) return json({ ok: false, error: "Inte tillåtet" }, 403);
        waitUntil(detailStep(body.state ?? {}, { next: (state) => selfCall(origin, { action: "details_bg", state }) }).catch(() => {}));
        return json({ ok: true });
      case "sweep_status":
        return json({ ok: true, sweep: await sweepStatus() });
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
      case "collect_all":
      case "nightly": {
        if (body.action === "nightly" && !fromScript) return json({ ok: false, error: "Inte tillåtet" }, 403);
        const only = Array.isArray(body.only) && body.only.length ? body.only.map(String) : null;
        const run = await startRun(only);
        if (run.started) waitUntil(chain(run.state, origin).catch(() => {}));
        // more: false – Apps Script-timern behöver inte vänta, servern fortsätter själv.
        return json({ ok: true, started: run.started, running: !run.started, run: run.status ?? null, more: false });
      }
      case "continue":
        if (!fromScript) return json({ ok: false, error: "Inte tillåtet" }, 403);
        waitUntil(chain(body.state, origin).catch(() => {}));
        return json({ ok: true });
      case "status": {
        const [run, sellers] = await Promise.all([runStatus(), listSellers()]);
        return json({ ok: true, run, sellers });
      }
      default:
        return json({ ok: false, error: "Okänd action" }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: err.message }, 502);
  }
}
