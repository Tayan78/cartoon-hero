// Export till Tradera ProLister: en CSV-fil (UTF-8) med en rad per annons och
// kolumnnamn enligt ProListers importguide, så att de mappas automatiskt.
// Kategori, frakt, attribut och budgivare lämnas tomma – de massredigeras i ProLister.
export const PROLISTER_COLUMNS = ["Rubrik", "Beskrivning", "Bilder", "Köp nu-pris", "Annonstyp", "Skick", "Referens"];

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 7000;
const REFERENCE_MAX = 60;
// Samma förbjudna formuleringar som annonstexten kontrolleras mot.
const FORBIDDEN = /\b(min|mitt|mina|vår|vårt|våra|egen|egna|privat|privata)\s+(egen\s+|egna\s+)?samling(ar|en)?\b|rökfri|djurfri/i;

// RFC 4180: fält med komma, citattecken eller radbrytning omges av citattecken.
function cell(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Kontrollerar en annons innan den får följa med i filen. Returnerar felet, eller "".
export function listingProblem(l) {
  const title = String(l.title ?? "").trim();
  const description = String(l.description ?? "").trim();
  const price = Number(l.price);
  if (!title) return "rubrik saknas";
  if (title.length > TITLE_MAX) return "rubriken är längre än 80 tecken";
  if (!description) return "beskrivning saknas";
  if (description.length > DESCRIPTION_MAX) return "beskrivningen är längre än 7000 tecken";
  if (!Number.isInteger(price) || price <= 0) return "pris saknas";
  if (!(l.image_urls ?? []).length) return "bilder saknas";
  if (FORBIDDEN.test(`${title}\n${description}`)) return "texten innehåller en förbjuden formulering";
  return "";
}

// listings: annonser från fliken Annonser (title, description, price, image_urls, id).
// Returnerar CSV-texten och vilka som följde med respektive hoppades över.
export function buildProListerCsv(listings) {
  const included = [];
  const skipped = [];
  for (const l of listings) {
    const problem = listingProblem(l);
    if (problem) skipped.push({ id: l.id, title: l.title ?? "", reason: problem });
    else included.push(l);
  }
  const rows = included.map((l) => [
    String(l.title).trim(),
    String(l.description).trim().replace(/\r\n?/g, "\n"),
    l.image_urls.join(","),
    Number(l.price),
    "FixedPrice",
    "Used",
    String(l.id).slice(0, REFERENCE_MAX),
  ]);
  // BOM så att Excel och ProLister läser å, ä och ö rätt (som "CSV UTF-8" från Excel).
  const csv = "﻿" + [PROLISTER_COLUMNS, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  return { csv, included: included.map((l) => l.id), skipped };
}
