// Export till Tradera ProLister: en CSV-fil i samma format som ProListers egen
// export – UTF-8 med BOM, semikolon mellan kolumnerna, radbrytningar i texten
// som <br> – och kolumnnamn från ProListers importguide, så att de mappas
// automatiskt. Bilderna länkas som vanliga .jpg-adresser via /bild/<id>.jpg.
export const PROLISTER_COLUMNS = [
  "Header",
  "Description",
  "ImageUrls",
  "BuyNowPrice",
  "ItemType",
  "Condition",
  "Category",
  "Attributes",
  "quantity",
  "Reference",
];

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 7000;
const REFERENCE_MAX = 60;
// Samma förbjudna formuleringar som annonstexten kontrolleras mot.
const FORBIDDEN = /\b(min|mitt|mina|vår|vårt|våra|egen|egna|privat|privata)\s+(egen\s+|egna\s+)?samling(ar|en)?\b|rökfri|djurfri/i;

// Fält med semikolon, citattecken eller radbrytning omges av citattecken.
function cell(value) {
  const s = String(value ?? "");
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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

// listings: annonser från fliken Annonser. defaults: kategori och attribut för
// Schleich (från inställningarna). origin: appens adress, för bildlänkarna.
export function buildProListerCsv(listings, { origin = "", schleichCategory = "", schleichAttributes = "" } = {}) {
  const included = [];
  const skipped = [];
  for (const l of listings) {
    const problem = listingProblem(l);
    if (problem) skipped.push({ id: l.id, title: l.title ?? "", reason: problem });
    else included.push(l);
  }
  const rows = included.map((l) => {
    const schleich = isSchleich(l);
    return [
      String(l.title).trim(),
      toHtmlText(l.description),
      l.image_urls.map((u) => exportImageUrl(u, origin)).join(","),
      Number(l.price),
      "FixedPrice",
      "Used",
      schleich ? schleichCategory : "",
      schleich ? schleichAttributes : "",
      1,
      String(l.id).slice(0, REFERENCE_MAX),
    ];
  });
  // BOM så att å, ä och ö läses rätt (som ProListers egen export).
  const csv = "﻿" + [PROLISTER_COLUMNS, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
  return { csv, included: included.map((l) => l.id), skipped };
}
