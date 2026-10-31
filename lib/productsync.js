// Efterhandskoppling av annonser till produkter och synk av Traderas kategorier.
// Körs efter Schleich-insamlingen varje natt (och kan startas från appen).
import { dbConfigured, dbPut, dbTexts } from "./db.js";
import { productLinks } from "./products.js";
import { traderaConfigured, traderaGet } from "./tradera.js";

// Går igenom Schleich-annonser utan produkt (i id-ordning) och kopplar dem som
// har modellnummer. Annonser utan nummer hoppas över (AI-steget tar dem senare).
export async function relinkProducts({ texts = dbTexts, put = dbPut, page = 1000, maxPages = 50 } = {}) {
  if (texts === dbTexts && !dbConfigured()) return { scanned: 0, linked: 0 };
  let after = "";
  let scanned = 0;
  let linked = 0;
  for (let i = 0; i < maxPages; i++) {
    const { rows, next } = await texts({ after, limit: page, unlinked: true });
    scanned += rows.length;
    const links = rows.map((r) => ({ id: r.id, products: productLinks({ title: r.title, text: r.text }) })).filter((r) => r.products.length);
    if (links.length) await put("links", links);
    linked += links.length;
    if (!next || rows.length < page) break;
    after = next;
  }
  return { scanned, linked };
}

const pick = (o, k) => o?.[k] ?? o?.[k[0].toUpperCase() + k.slice(1)];

// Traderas kategoriträd → platta rader med sökväg ("Leksaker > Figurer > …").
export function flattenCategories(tree) {
  const out = [];
  const walk = (nodes, parent, path) => {
    for (const c of Array.isArray(nodes) ? nodes : []) {
      const id = Number(pick(c, "id"));
      const name = String(pick(c, "name") ?? "").trim();
      if (!id || !name) continue;
      const full = path ? `${path} > ${name}` : name;
      out.push({ id, name, parent_id: parent, path: full });
      // Barnen heter olika i olika versioner av API:et (SOAP: Category).
      walk(pick(c, "childCategories") ?? pick(c, "children") ?? pick(c, "subCategories") ?? pick(c, "categories") ?? pick(c, "category"), id, full);
    }
  };
  walk(Array.isArray(tree) ? tree : pick(tree, "categories") ?? pick(tree, "items") ?? [], null, "");
  return out;
}

export async function syncCategories({ get = traderaGet, put = dbPut } = {}) {
  if (get === traderaGet && (!traderaConfigured() || !dbConfigured())) return { categories: 0 };
  const rows = flattenCategories(await get("/v4/categories"));
  await put("categories", rows);
  return { categories: rows.length };
}
