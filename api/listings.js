// POST /api/listings – appens annonsläge mot Sheet/Drive (via Apps Script):
//   { action: "submit", id, note, images: [dataURL, …] (1–3, första = huvudbild), settings }
//       laddar upp bilderna till Drive och lägger annonsen i kön (status Väntar)
//   { action: "list" }                         alla annonser med status och resultat
//   { action: "update", id, fields }           spara ändringar / godkänn
//   { action: "requeue", id, confirmed }       berika om med det modellnummer du valt
//   { action: "delete", id }                   ta bort annonsen och dess bilder
// Själva berikningen sker i kön (Apps Script → /api/listing-process), så appen
// kan stängas efter uppladdningen.
import { checkAuth, json, parseDataUrl } from "../lib/http.js";
import { researchListing } from "../lib/listing.js";
import { mockLens, mockListingText, mockSimple, mockTradera } from "../lib/mock.js";
import { callAppsScript, storageConfigured } from "../lib/storage.js";
import { findOnTradera } from "../lib/tradera.js";

const MAX_IMAGES = 3;
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
  const id = String(body.id ?? "").replace(/[^\w-]/g, "").slice(0, 40);
  if (body.action !== "list" && !id) return json({ ok: false, error: "id saknas" }, 400);

  let action;
  let payload;
  switch (body.action) {
    case "submit": {
      const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES);
      if (!images.length || images.some((d) => !parseDataUrl(d) || d.length * 0.75 > MAX_IMAGE_BYTES)) {
        return json({ ok: false, error: "1–3 bilder (jpeg, max 1 MB) krävs" }, 400);
      }
      action = "addListing";
      payload = {
        id,
        note: String(body.note ?? "").trim().slice(0, 300),
        images,
        settings: body.settings ?? {},
        // Kön i Apps Script anropar den här adressen för att berika annonsen.
        process_url: new URL("/api/listing-process", request.url).href,
      };
      break;
    }
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

  if (process.env.MOCK === "1" && !storageConfigured()) return json(await mockStore(action, payload));
  const res = await callAppsScript(action, payload).catch((err) => ({ ok: false, error: err.message }));
  return json(res, res.ok ? 200 : 502);
}

// Testläge utan Sheet: annonserna ligger i minnet och berikas direkt.
const memory = new Map();
async function mockStore(action, p) {
  const enrich = async (row) => {
    row.status = "Bearbetas";
    const listing = await researchListing(
      { images: [{ mediaType: "image/jpeg", data: "" }], note: row.note, confirmed: row.confirmed },
      { lens: (img, fx) => mockLens(fx), gemini: (input) => mockSimple(input, () => {}), tradera: (input) => findOnTradera({ ...input, lens: null }, mockTradera), write: mockListingText },
    );
    Object.assign(row, { status: "Klar", listing, title: listing.title, description: listing.description, price: listing.price, channel: listing.channel });
  };
  if (action === "addListing") {
    const row = { id: p.id, created: new Date().toISOString(), status: "Väntar", note: p.note, confirmed: "", images: p.images, image_urls: p.images };
    memory.set(p.id, row);
    setTimeout(() => enrich(row), 1500);
    return { ok: true, image_urls: p.images };
  }
  if (action === "listListings") {
    return { ok: true, listings: [...memory.values()].reverse().map(({ images, ...row }) => row) };
  }
  const row = memory.get(p.id);
  if (!row) return { ok: false, error: "Annonsen finns inte" };
  if (action === "updateListing") Object.assign(row, p.fields);
  if (action === "requeueListing") {
    Object.assign(row, { status: "Väntar", confirmed: p.confirmed });
    setTimeout(() => enrich(row), 1500);
  }
  if (action === "deleteListing") memory.delete(p.id);
  return { ok: true };
}
