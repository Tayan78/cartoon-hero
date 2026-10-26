// POST /api/listings – appens annonsläge mot Sheet/Drive (via Apps Script):
// Uppladdning i tre steg, så att varje anrop ryms (upp till 8 bilder per annons):
//   { action: "submit", id, note, settings }   skapar annonsen (status Laddar upp)
//   { action: "image", id, image: dataURL }    en bild i taget, första = huvudbild
//   { action: "commit", id }                   lägger annonsen i kön (status Väntar)
//   { action: "list" }                         alla annonser med status och resultat
//   { action: "update", id, fields }           spara ändringar / godkänn
//   { action: "approve", items: [{ id, confirmed }] }  godkänn flera på en gång
//   { action: "requeue", id, confirmed }       berika om med det modellnummer du valt
//   { action: "delete", id }                   ta bort annonsen och dess bilder
//   { action: "export", include_exported }     CSV till ProLister av godkända Tradera-annonser;
//       sparas i Drive (Loppisskannern/Export) och annonserna markeras Exporterad
// Själva berikningen sker i kön (Apps Script → /api/listing-process), så appen
// kan stängas efter uppladdningen.
import { checkAuth, json, parseDataUrl } from "../lib/http.js";
import { researchListing } from "../lib/listing.js";
import { mockDefect, mockLens, mockListingText, mockSimple, mockTradera } from "../lib/mock.js";
import { buildProListerCsv } from "../lib/prolister.js";
import { mergeSettings } from "../lib/settings.js";
import { callAppsScript, storageConfigured } from "../lib/storage.js";
import { findOnTradera } from "../lib/tradera.js";

const MAX_IMAGE_BYTES = 1024 * 1024;
const STATUSES = ["Klar", "Godkänd"];
const CHANNELS = ["Tradera", "Vinted"];

export async function POST(request) {
  const denied = checkAuth(request);
  if (denied) return denied;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Ogiltig förfrågan" }, 400);
  }
  if (body.action === "export") {
    const res = await exportProLister(Boolean(body.include_exported), mergeSettings(body.settings), new URL(request.url).origin);
    return json(res, res.ok ? 200 : 502);
  }
  const id = String(body.id ?? "").replace(/[^\w-]/g, "").slice(0, 40);
  if (!["list", "approve"].includes(body.action) && !id) return json({ ok: false, error: "id saknas" }, 400);

  let action;
  let payload;
  switch (body.action) {
    case "submit":
      action = "addListing";
      payload = {
        id,
        note: String(body.note ?? "").trim().slice(0, 300),
        settings: body.settings ?? {},
        // Kön i Apps Script anropar den här adressen för att berika annonsen.
        process_url: new URL("/api/listing-process", request.url).href,
      };
      break;
    case "image":
      if (!parseDataUrl(body.image) || body.image.length * 0.75 > MAX_IMAGE_BYTES) {
        return json({ ok: false, error: "Bilden saknas eller är för stor (max 1 MB)" }, 400);
      }
      action = "addListingImage";
      payload = { id, image: body.image };
      break;
    case "commit":
      action = "commitListing";
      payload = { id };
      break;
    case "list":
      action = "listListings";
      payload = {};
      break;
    case "update": {
      const f = body.fields ?? {};
      const fields = {};
      if (typeof f.title === "string") fields.title = f.title.replace(/\s+/g, " ").trim().slice(0, 80);
      if (typeof f.description === "string") fields.description = f.description.slice(0, 7000);
      if (Number.isFinite(Number(f.price)) && Number(f.price) >= 0 && f.price !== "") fields.price = Math.round(Number(f.price));
      if (CHANNELS.includes(f.channel)) fields.channel = f.channel;
      if (STATUSES.includes(f.status)) fields.status = f.status;
      if (typeof f.confirmed === "string") fields.confirmed = f.confirmed.trim().slice(0, 20);
      action = "updateListing";
      payload = { id, fields };
      break;
    }
    case "approve": {
      // Godkänn flera på en gång: [{ id, confirmed }]
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200).map((it) => ({
        id: String(it?.id ?? "").replace(/[^\w-]/g, "").slice(0, 40),
        confirmed: String(it?.confirmed ?? "").trim().slice(0, 20),
      })).filter((it) => it.id);
      if (!items.length) return json({ ok: false, error: "Inga annonser att godkänna" }, 400);
      action = "approveListings";
      payload = { items };
      break;
    }
    case "requeue":
      action = "requeueListing";
      payload = { id, confirmed: String(body.confirmed ?? "").trim().slice(0, 20) };
      break;
    case "delete":
      action = "deleteListing";
      payload = { id };
      break;
    default:
      return json({ ok: false, error: "Okänd action" }, 400);
  }

  const res = await store(action, payload);
  return json(res, res.ok ? 200 : 502);
}

function store(action, payload) {
  if (process.env.MOCK === "1" && !storageConfigured()) return mockStore(action, payload);
  return callAppsScript(action, payload).catch((err) => ({ ok: false, error: err.message }));
}

// Godkända Tradera-annonser → CSV för ProLister. Redan exporterade följer bara
// med om du ber om det, så att inget läggs upp två gånger.
async function exportProLister(includeExported, settings, origin) {
  const list = await store("listListings", {});
  if (!list.ok) return list;
  const wanted = (list.listings ?? []).filter(
    (l) => (l.status === "Godkänd" || (includeExported && l.status === "Exporterad")) && (l.channel || "Tradera") === "Tradera",
  );
  if (!wanted.length) return { ok: false, error: "Inga godkända Tradera-annonser att exportera." };
  const { csv, included, skipped } = buildProListerCsv(wanted, {
    origin,
    schleich: {
      category: settings.listing.schleich_category,
      condition: settings.listing.schleich_condition,
      shipping: settings.listing.schleich_shipping,
    },
  });
  if (!included.length) return { ok: false, error: "Ingen annons klarade kontrollen.", skipped };
  const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" }).replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
  const name = `prolister-${stamp}.csv`;
  const saved = await store("saveExport", { name, csv, ids: included });
  if (!saved.ok) return saved;
  return { ok: true, name, csv, url: saved.url ?? "", count: included.length, skipped };
}

// Testläge utan Sheet: annonserna ligger i minnet och berikas direkt.
const memory = new Map();
async function mockStore(action, p) {
  const enrich = async (row) => {
    row.status = "Bearbetas";
    const listing = await researchListing(
      { images: [{ mediaType: "image/jpeg", data: "" }], note: row.note, confirmed: row.confirmed },
      { lens: (img, fx) => mockLens(fx), gemini: (input) => mockSimple(input, () => {}), tradera: (input) => findOnTradera({ ...input, lens: null }, mockTradera), write: mockListingText, defect: mockDefect },
    );
    Object.assign(row, { status: "Klar", listing, title: listing.title, description: listing.description, price: listing.price, channel: listing.channel });
  };
  if (action === "addListing") {
    memory.set(p.id, { id: p.id, created: new Date().toISOString(), status: "Laddar upp", note: p.note, confirmed: "", image_urls: [] });
    return { ok: true };
  }
  if (action === "listListings") {
    return { ok: true, listings: [...memory.values()].reverse() };
  }
  if (action === "approveListings") {
    for (const it of p.items) if (memory.has(it.id)) Object.assign(memory.get(it.id), { status: "Godkänd", confirmed: it.confirmed });
    return { ok: true, count: p.items.length };
  }
  if (action === "saveExport") {
    for (const id of p.ids) if (memory.has(id)) memory.get(id).status = "Exporterad";
    return { ok: true, url: "" };
  }
  const row = memory.get(p.id);
  if (!row) return { ok: false, error: "Annonsen finns inte" };
  if (action === "addListingImage") row.image_urls.push(p.image);
  if (action === "commitListing") {
    row.status = "Väntar";
    setTimeout(() => enrich(row), 1500);
  }
  if (action === "updateListing") Object.assign(row, p.fields);
  if (action === "requeueListing") {
    Object.assign(row, { status: "Väntar", confirmed: p.confirmed });
    setTimeout(() => enrich(row), 1500);
  }
  if (action === "deleteListing") memory.delete(p.id);
  return { ok: true };
}
