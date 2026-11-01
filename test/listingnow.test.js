import { test } from "node:test";
import assert from "node:assert/strict";
import { processListingNow } from "../lib/listingnow.js";
import { fakeAppsScript } from "./helpers/apps-script.js";

async function queued(gs, id) {
  await gs.store("addListing", { id, note: "saknar svans", settings: { lens: false } });
  gs.run(`(function(){ var sh = listingSheet(); var row = rowById(sh, ${JSON.stringify(id)}); setCells(sh, row, { 'Bild-ID': 'f1,f2,f3,f4', 'Status': 'Väntar' }); })()`);
}

test("Direkt bearbetning mot riktiga Code.gs: tar annonsen, max 3 bilder, sparar resultatet som Klar", async () => {
  const gs = fakeAppsScript();
  await queued(gs, "G1");
  const fetched = [];
  let input;
  const research = async (i) => ((input = i), { title: "Schleich Tinker sto 13773", description: "Fin", price: 89, channel: "Tradera", article: { number: "13773" }, item: { name: "Tinker", brand: "Schleich", category: "Figurer" }, list_basis: "sålt median", cost: { sek: 0.4 } });
  const r = await processListingNow("G1", { store: gs.store, research, image: async (f) => (fetched.push(f), { mediaType: "image/jpeg", data: f }) });
  assert.equal(r.ok, true);
  assert.deepEqual(fetched, ["f1", "f2", "f3"]);
  assert.deepEqual([input.note, input.settings], ["saknar svans", { lens: false }]);
  const [row] = gs.table("Annonser");
  assert.deepEqual([row.Status, row.Rubrik, row.Pris, row.Modellnummer, row.Prisgrund], ["Klar", "Schleich Tinker sto 13773", 89, "13773", "sålt median"]);
  assert.equal(JSON.parse(row.JSON).price, 89);
  // Redan klar: tas inte igen (ingen dubbel AI-kostnad).
  assert.equal((await processListingNow("G1", { store: gs.store, research, image: async () => ({}) })).skipped, true);
});

test("Direkt bearbetning: fel blir status Fel, och äldre Apps Script utan claimListing hoppas över", async () => {
  const gs = fakeAppsScript();
  await queued(gs, "G2");
  const r = await processListingNow("G2", { store: gs.store, research: async () => { throw new Error("Gemini nere"); }, image: async () => ({ mediaType: "image/jpeg", data: "" }) });
  assert.equal(r.result.ok, false);
  const [row] = gs.table("Annonser");
  assert.deepEqual([row.Status, row.Fel], ["Fel", "Gemini nere"]);
  const old = async () => ({ ok: false, error: "Okänd action" });
  assert.equal((await processListingNow("G3", { store: old })).skipped, true);
});
