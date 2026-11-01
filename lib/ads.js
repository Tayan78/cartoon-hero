// Dina annonser i databasen (Cloudflare D1) och bilderna i R2 – i stället för
// fliken Annonser och Drive. Workern sköter lagringen (/data/ads); här finns
// AI-bearbetningen, exporten och kopieringen från Google Sheet.
//
// AI:n startar direkt när en annons läggs i kön, i ett eget anrop per annons
// (parallellt). Fastnar något tar nästa visning av listan upp det igen.
import { dbConfigured, dbRun } from "./db.js";
import { researchListing } from "./listing.js";
import { buildProListerCsv } from "./prolister.js";
import { callAppsScript } from "./storage.js";

const DATA_URL = () => process.env.DATA_URL || "https://loppis-bevakning.loppis.workers.dev";
export const AI_IMAGES = 3;

export async function adsCall(body, { fetchImpl = fetch } = {}) {
  if (!dbConfigured()) throw new Error("APP_TOKEN saknas på servern");
  const res = await fetchImpl(`${DATA_URL()}/data/ads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-token": process.env.APP_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Databasen svarade ${res.status}`);
  return data;
}

// En bild (publik länk i R2) som base64 till AI:n.
export async function imageBase64(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Bilden kunde inte hämtas (${res.status})`);
  return { mediaType: "image/jpeg", data: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

// Tar annonsen ur kön, kör AI:n och sparar resultatet.
export async function processAd(id, { call = adsCall, research = researchListing, image = imageBase64 } = {}) {
  const { job } = await call({ op: "claim", id });
  if (!job) return { skipped: true };
  let result;
  try {
    const images = await Promise.all(job.images.slice(0, AI_IMAGES).map((u) => image(u)));
    if (!images.length) throw new Error("Inga bilder");
    const listing = await research({
      images,
      note: String(job.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      confirmed: String(job.confirmed ?? "").trim().slice(0, 20),
      settings: job.settings,
    });
    result = { ok: true, listing };
  } catch (err) {
    result = { ok: false, error: err.source === "gemini" ? `Gemini: ${err.message}` : err.message || "Något gick fel" };
  }
  await call({ op: "result", id, result });
  return result;
}

// CSV till ProLister av godkända Tradera-annonser. Bildlänkarna går direkt till R2
// (kopierade annonser utan R2-bilder får appens /bild/-länk till Drive som förut).
export async function exportAds(includeExported, settings, origin, { call = adsCall, now = new Date() } = {}) {
  const { listings } = await call({ op: "list", limit: 2000 });
  const wanted = listings.filter((l) => (l.status === "Godkänd" || (includeExported && l.status === "Exporterad")) && (l.channel || "Tradera") === "Tradera");
  if (!wanted.length) return { ok: false, error: "Inga godkända Tradera-annonser att exportera." };
  const { csv, included, skipped } = buildProListerCsv(wanted, {
    origin,
    schleich: { category: settings.listing.schleich_category, condition: settings.listing.schleich_condition, shipping: settings.listing.schleich_shipping },
  });
  if (!included.length) return { ok: false, error: "Ingen annons klarade kontrollen.", skipped };
  const stamp = now.toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" }).replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
  await call({ op: "exported", ids: included });
  return { ok: true, name: `prolister-${stamp}.csv`, csv, url: "", count: included.length, skipped };
}

// ---------- Kopiering från Google Sheet ----------
// Läser fliken Annonser (bara läsning – arket och Drive lämnas orörda), lägger in
// varje annons i databasen och kopierar bilderna från Drive till R2.
const LISTING_HEADERS = [
  "Skapad", "Annons-ID", "Status", "Huvudbild", "Bilder", "Anteckning", "Rubrik", "Beskrivning", "Pris", "Kanal",
  "Modellnummer", "Bekräftat", "Namn", "Märke", "Kategori", "Prisgrund", "Kostnad SEK", "Fel", "Uppdaterad",
  "I lager", "Bild-ID", "Inställningar", "JSON",
];
const iso = (v) => (v ? (Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null) : null);
const parse = (v) => {
  try {
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
};

export function sheetRowToAd(r) {
  return {
    id: String(r["Annons-ID"]),
    created_at: iso(r.Skapad),
    updated_at: iso(r.Uppdaterad) ?? iso(r.Skapad),
    status: r.Status === "Laddar upp" || r.Status === "Bearbetas" ? "Fel" : r.Status || "Klar",
    note: r.Anteckning ?? "",
    settings: parse(r.Inställningar) ?? {},
    title: r.Rubrik ?? "",
    description: r.Beskrivning ?? "",
    price: Number(r.Pris) || null,
    channel: r.Kanal || null,
    model_number: r.Modellnummer ? String(r.Modellnummer) : null,
    confirmed: r.Bekräftat ? String(r.Bekräftat) : null,
    name: r.Namn || null,
    brand: r.Märke || null,
    category: r.Kategori || null,
    price_basis: r.Prisgrund || null,
    cost_sek: Number(r["Kostnad SEK"]) || null,
    error: r.Status === "Laddar upp" || r.Status === "Bearbetas" ? "Avbruten i Google – skicka om" : r.Fel || null,
    result: parse(r.JSON),
    in_inventory: r["I lager"] === "Ja",
    file_ids: String(r["Bild-ID"] ?? "").split(",").filter(Boolean),
  };
}

// Ett steg: så många annonser som hinns (~45 s). state = { offset, run_id, done, images, errors }.
export async function importStep(state = {}, { store = callAppsScript, call = adsCall, run = dbRun, budgetMs = 45_000, clock = Date.now } = {}) {
  const started = clock();
  const res = await store("sheetRead", { sheet: "Annonser", headers: LISTING_HEADERS });
  if (!res?.ok) throw new Error(res?.error || "Google Sheet svarade inte");
  const rows = res.rows.filter((r) => r["Annons-ID"]);
  let { offset = 0, done = 0, images = 0, errors = 0 } = state;
  const runId = state.run_id ?? (await run({ name: "kopiering", started_at: new Date(clock()).toISOString(), summary: `0 av ${rows.length} annonser` }));
  while (offset < rows.length && clock() - started < budgetMs) {
    const ad = sheetRowToAd(rows[offset]);
    const { file_ids, ...data } = ad;
    try {
      await call({ op: "import", ad: data });
      for (let i = 0; i < file_ids.length; i++) {
        try {
          const r = await call({ op: "import_image", id: ad.id, n: i + 1, url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(file_ids[i])}` });
          if (!r.skipped) images++;
        } catch (err) {
          errors++;
          if (/gräns|full/i.test(err.message)) throw err; // spärr nådd: stoppa
        }
      }
      done++;
    } catch (err) {
      if (/gräns|full/i.test(err.message)) {
        if (runId) await run({ id: runId, finished_at: new Date(clock()).toISOString(), status: `Stoppad: ${err.message}`.slice(0, 200), summary: `${done} av ${rows.length} annonser, ${images} bilder` });
        return { more: false, stopped: err.message, state: { offset, run_id: runId, done, images, errors } };
      }
      errors++;
    }
    offset++;
  }
  const more = offset < rows.length;
  if (runId) {
    await run(
      more
        ? { id: runId, progress: true, summary: `${offset} av ${rows.length} annonser, ${images} bilder${errors ? `, ${errors} fel` : ""}` }
        : { id: runId, finished_at: new Date(clock()).toISOString(), status: errors ? `Klar, ${errors} fel` : "Klar", summary: `${rows.length} annonser, ${images} bilder kopierade` },
    );
  }
  return { more, total: rows.length, state: { offset, run_id: runId, done, images, errors } };
}
