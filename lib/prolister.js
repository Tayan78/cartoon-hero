// Export till Tradera ProLister: en CSV-fil som ser exakt ut som ProListers
// egen export – samma 31 kolumner i samma ordning, UTF-8 med BOM, semikolon,
// alla fält inom citattecken och radbrytningar i texten som <br>. Schleich får
// samma värden som dina publicerade annonser (kategori, skick, frakt …), så att
// inget behöver ändras efter importen. Bilderna länkas som /bild/<id>.jpg.
// Undantag: skicket. ProListers egen kolumn "attributes" ("121:Gott skick")
// mappas inte vid import, men kolumnen "skick" med "Gott skick" gör det (testat).
export const PROLISTER_COLUMNS = [
  "id", "listId", "imageUrls", "header", "description", "startingBid", "buyNowPrice", "reservationPrice",
  "isHighlighted", "rankUp", "reference", "uploadOrder", "latestObjectId", "restarts", "acceptedBidders",
  "durationDays", "itemType", "endtime", "category", "latestUploadDate", "campaignCode", "skick",
  "shippingCondition", "shipping", "shippingTakeaway", "shippingAlternativeFirst", "shippingCostFirst",
  "shippingAlternativeSecond", "shippingCostSecond", "quantity", "vat",
  // Egen kolumn sist: mappen annonsen hamnar i i ProLister, t.ex. "2026-10-25 Schleich".
  "Mapp",
];

// En mapp per import: datum först (sorteras i tidsordning) + Schleich eller Övrigt.
export const folderFor = (listing, date) => `${date} ${isSchleich(listing) ? "Schleich" : "Övrigt"}`;

// Dagens datum i svensk tid, ÅÅÅÅ-MM-DD.
export const todayInSweden = (now = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });

// Värden som alla dina publicerade annonser har (från din ProLister-export).
// id, listId, latestObjectId och latestUploadDate sätter ProLister själv.
const BASE = {
  startingBid: "null",
  reservationPrice: "null",
  isHighlighted: "false",
  rankUp: "false",
  restarts: "0",
  acceptedBidders: "0",
  durationDays: "30",
  itemType: "FixedPrice",
  endtime: "20:0",
  campaignCode: "",
  shippingCondition: "",
  shippingTakeaway: "FALSE",
  shippingAlternativeFirst: "null",
  shippingCostFirst: "null",
  shippingAlternativeSecond: "null",
  shippingCostSecond: "null",
  quantity: "1",
  vat: "0",
};

// Standard för Schleich, från din export (ändras under ⚙︎ → Annonser).
export const SCHLEICH_DEFAULTS = {
  category: "1000532 : Miniatyrer & leksaksfigurer",
  condition: "Gott skick",
  shipping: "0.5:2:101:49,0.5:19:100:49,0.5:12:22:59,0.5:12:33:59,0.5:7:1:49,0.5:19:101:49",
};

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 7000;
const REFERENCE_MAX = 60;
// Samma förbjudna formuleringar som annonstexten kontrolleras mot.
const FORBIDDEN = /\b(min|mitt|mina|vår|vårt|våra|egen|egna|privat|privata)\s+(egen\s+|egna\s+)?samling(ar|en)?\b|rökfri|djurfri/i;

// Som ProListers export: varje fält inom citattecken.
const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

// ProLister visar texten som HTML: radbrytningar blir <br>.
export const toHtmlText = (text) =>
  String(text ?? "")
    .trim()
    .replace(/\r\n?/g, "\n")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

// Drive-länk (lh3.googleusercontent.com/d/<id>) → https://<appen>/bild/<id>.jpg
export function exportImageUrl(url, origin) {
  const id = /googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(url)?.[1];
  return id && origin ? `${origin}/bild/${id}.jpg` : url;
}

const isSchleich = (l) => /schleich/i.test([l.title, l.listing?.item?.brand].filter(Boolean).join(" "));

// Kontrollerar en annons innan den får följa med i filen. Returnerar felet, eller "".
export function listingProblem(l) {
  const title = String(l.title ?? "").trim();
  const description = String(l.description ?? "").trim();
  const price = Number(l.price);
  if (!title) return "rubrik saknas";
  if (title.length > TITLE_MAX) return "rubriken är längre än 80 tecken";
  if (!description) return "beskrivning saknas";
  if (toHtmlText(description).length > DESCRIPTION_MAX) return "beskrivningen är längre än 7000 tecken";
  if (!Number.isInteger(price) || price <= 0) return "pris saknas";
  if (!(l.image_urls ?? []).length) return "bilder saknas";
  if (FORBIDDEN.test(`${title}\n${description}`)) return "texten innehåller en förbjuden formulering";
  return "";
}

// listings: annonser från fliken Annonser. origin: appens adress (för bildlänkarna).
// schleich: kategori, skick och frakt för Schleich (övrigt sätts i ProLister).
export function buildProListerCsv(listings, { origin = "", schleich = SCHLEICH_DEFAULTS, date = todayInSweden() } = {}) {
  const included = [];
  const skipped = [];
  for (const l of listings) {
    const problem = listingProblem(l);
    if (problem) skipped.push({ id: l.id, title: l.title ?? "", reason: problem });
    else included.push(l);
  }
  const rows = included.map((l, i) => {
    const row = {
      ...BASE,
      imageUrls: l.image_urls.map((u) => exportImageUrl(u, origin)).join(","),
      header: String(l.title).trim(),
      description: toHtmlText(l.description),
      buyNowPrice: String(Number(l.price)),
      reference: String(l.id).slice(0, REFERENCE_MAX),
      uploadOrder: String(i + 1),
      Mapp: folderFor(l, date),
      ...(isSchleich(l) ? { category: schleich.category, skick: schleich.condition, shipping: schleich.shipping } : {}),
    };
    return PROLISTER_COLUMNS.map((k) => row[k] ?? "");
  });
  // BOM så att å, ä och ö läses rätt (som ProListers egen export).
  const csv = "﻿" + [PROLISTER_COLUMNS, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
  return { csv, included: included.map((l) => l.id), skipped };
}
