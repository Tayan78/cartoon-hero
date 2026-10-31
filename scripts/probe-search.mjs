// Provar Traderas sökfilter (körs i GitHub Actions, där nycklarna finns).
// Skriver bara ut antal och fältnamn – aldrig nycklar eller annonsdata i övrigt.
import { searchAdvanced } from "../lib/tradera.js";

const pick = (o, k) => o?.[k] ?? o?.[k[0].toUpperCase() + k.slice(1)];
const total = (d) => ({ items: pick(d, "totalNumberOfItems"), pages: pick(d, "totalNumberOfPages") });
const run = async (label, body) => {
  try {
    const d = await searchAdvanced({ itemsPerPage: 1, pageNumber: 1, ...body });
    console.log(label.padEnd(48), JSON.stringify(total(d)));
    return d;
  } catch (err) {
    console.log(label.padEnd(48), "FEL", err.message);
    return null;
  }
};

const ended = { searchWords: "schleich", itemStatus: "Ended" };
const base = await run("schleich avslutade", ended);
await run("schleich aktiva", { searchWords: "schleich" });
for (const [k1, k2] of [["priceMinimum", "priceMaximum"], ["PriceMinimum", "PriceMaximum"], ["minPrice", "maxPrice"]]) {
  await run(`avslutade ${k1}/${k2} 0–50`, { ...ended, [k1]: 0, [k2]: 50 });
  await run(`avslutade ${k1}/${k2} 51–100000`, { ...ended, [k1]: 51, [k2]: 100000 });
}
await run("avslutade, bara i rubriken (searchInDescription false)", { ...ended, searchInDescription: false });
await run("avslutade, även i beskrivning (true)", { ...ended, searchInDescription: true });
for (const w of ["bayala", "eldrador", "schleich riddare", "schleich snobben", "schleich harry potter", "schleich star wars"]) {
  await run(`avslutade: ${w}`, { searchWords: w, itemStatus: "Ended" });
}
for (const o of ["EndDateAscending", "EndDateDescending"]) {
  const d = await searchAdvanced({ ...ended, itemsPerPage: 1, pageNumber: 1, orderBy: o }).catch(() => null);
  console.log(`äldsta/nyaste slutdatum (${o})`.padEnd(48), pick(pick(d, "items")?.[0], "endDate") ?? "–");
}
const first = pick(base, "items")?.[0];
console.log("fält i sökträffen:", first ? Object.keys(first).join(", ") : "–");
try {
  const res = await fetch("https://api.tradera.com/v4/search/category-count", {
    method: "POST",
    headers: { "X-App-Id": String(process.env.TRADERA_APP_ID), "X-App-Key": process.env.TRADERA_APP_KEY, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ searchWords: "schleich" }),
  });
  const c = await res.json().catch(() => null);
  console.log("category-count status", res.status);
  console.log("kategorier (svarets fält):", Object.keys(c ?? {}).join(", "));
  console.log(JSON.stringify(c).slice(0, 1500));
} catch (err) {
  console.log("category-count FEL", err.message);
}
