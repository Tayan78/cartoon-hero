import { test } from "node:test";
import assert from "node:assert/strict";
import { ads } from "../worker/src/ads.js";
import { exportAds, importStep, processAd, sheetRowToAd } from "../lib/ads.js";
import { mergeSettings } from "../lib/settings.js";
import { fakeD1 } from "./helpers/fake-d1.js";

function fakeR2() {
  const objects = new Map();
  return {
    objects,
    head: async (k) => (objects.has(k) ? { size: objects.get(k).byteLength } : null),
    put: async (k, b) => objects.set(k, b),
    delete: async (keys) => [].concat(keys).forEach((k) => objects.delete(k)),
  };
}
const jpg = (n = 10) => `data:image/jpeg;base64,${Buffer.alloc(n, 1).toString("base64")}`;
const env = (o = {}) => ({ DB: fakeD1(), IMAGES: fakeR2(), IMAGE_BASE: "https://pub-x.r2.dev", ...o });

test("Annonser i databasen: skapa, bilder till R2, kö, ta, resultat, godkänn, exportera, ta bort", async () => {
  const e = env();
  await ads(e, { op: "create", id: "G1", note: "saknar svans", settings: { lens: false } });
  const img = await ads(e, { op: "image", id: "G1", image: jpg() });
  await ads(e, { op: "image", id: "G1", image: jpg() });
  assert.equal(img.image_url, "https://pub-x.r2.dev/ads/G1/1.jpg");
  assert.deepEqual([...e.IMAGES.objects.keys()], ["ads/G1/1.jpg", "ads/G1/2.jpg"]);
  await ads(e, { op: "commit", id: "G1" });
  const { job } = await ads(e, { op: "claim", id: "G1" });
  assert.deepEqual([job.note, job.images, job.settings], ["saknar svans", ["https://pub-x.r2.dev/ads/G1/1.jpg", "https://pub-x.r2.dev/ads/G1/2.jpg"], { lens: false }]);
  assert.equal((await ads(e, { op: "claim", id: "G1" })).job, null, "tas bara en gång");
  await ads(e, { op: "result", id: "G1", result: { ok: true, listing: { title: "Schleich Tinker sto 13773", description: "Fin", price: 89, channel: "Tradera", article: { number: "13773" }, item: { brand: "Schleich" }, list_basis: "sålt median", cost: { sek: 0.4 } } } });
  let [l] = (await ads(e, { op: "list" })).listings;
  assert.deepEqual([l.status, l.title, l.price, l.listing.price, l.image_urls.length], ["Klar", "Schleich Tinker sto 13773", 89, 89, 2]);
  await ads(e, { op: "approve", items: [{ id: "G1", confirmed: "13773" }] });
  [l] = (await ads(e, { op: "list" })).listings;
  assert.deepEqual([l.status, l.confirmed, l.in_inventory], ["Godkänd", "13773", true]);
  assert.deepEqual(await ads(e, { op: "summary" }), { ready: 0, approved: 1, exported: 0, total: 1 });
  await ads(e, { op: "exported", ids: ["G1"] });
  assert.equal((await ads(e, { op: "list" })).listings[0].status, "Exporterad");
  const st = await ads(e, { op: "storage" });
  assert.deepEqual([st.r2.objects, st.r2.bytes, st.puts_today], [2, 20, 2]);
  await ads(e, { op: "delete", id: "G1" });
  assert.equal(e.IMAGES.objects.size, 0);
  assert.deepEqual((await ads(e, { op: "storage" })).r2, { bytes: 0, objects: 0 });
});

test("Spärrar: max bilder per dygn och total lagring – inget laddas upp över gränsen", async () => {
  const e = env({ R2_DAILY_PUTS: "2", R2_MAX_BYTES: "1000" });
  await ads(e, { op: "create", id: "G2" });
  await ads(e, { op: "image", id: "G2", image: jpg() });
  await ads(e, { op: "image", id: "G2", image: jpg() });
  await assert.rejects(() => ads(e, { op: "image", id: "G2", image: jpg() }), /Dygnets gräns/);
  const big = env({ R2_MAX_BYTES: "15" });
  await ads(big, { op: "create", id: "G3" });
  await ads(big, { op: "image", id: "G3", image: jpg(10) });
  await assert.rejects(() => ads(big, { op: "image", id: "G3", image: jpg(10) }), /nästan full/);
  assert.equal(big.IMAGES.objects.size, 1);
});

test("AI-steget: tar annonsen, max 3 bilder, sparar resultat eller fel", async () => {
  const e = env();
  const call = (b) => ads(e, b);
  await call({ op: "create", id: "G4" });
  for (let i = 0; i < 4; i++) await call({ op: "image", id: "G4", image: jpg() });
  await call({ op: "commit", id: "G4" });
  const seen = [];
  const r = await processAd("G4", { call, image: async (u) => (seen.push(u), { mediaType: "image/jpeg", data: "" }), research: async () => ({ title: "T", description: "D", price: 59, channel: "Tradera", item: {} }) });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 3);
  assert.equal((await processAd("G4", { call })).skipped, true);
  await call({ op: "requeue", id: "G4", confirmed: "13773" });
  await processAd("G4", { call, image: async () => ({}), research: async () => { throw new Error("Gemini nere"); } });
  const [l] = (await call({ op: "list" })).listings;
  assert.deepEqual([l.status, l.error, l.confirmed], ["Fel", "Gemini nere", "13773"]);
});

test("Export: bara godkända Tradera-annonser, bildlänkar direkt till R2, markeras Exporterad", async () => {
  const e = env();
  const call = (b) => ads(e, b);
  await call({ op: "create", id: "G5" });
  await call({ op: "image", id: "G5", image: jpg() });
  await call({ op: "commit", id: "G5" });
  await call({ op: "claim", id: "G5" });
  await call({ op: "result", id: "G5", result: { ok: true, listing: { title: "Schleich Tinker sto 13773", description: "Schleich Tinker sto 13773 i lekt men bra skick.", price: 89, channel: "Tradera", item: { brand: "Schleich" } } } });
  assert.equal((await exportAds(false, mergeSettings(), "https://app", { call })).ok, false, "inget godkänt än");
  await call({ op: "approve", items: [{ id: "G5" }] });
  const out = await exportAds(false, mergeSettings(), "https://app", { call, now: new Date("2026-11-01T10:00:00Z") });
  assert.equal(out.count, 1);
  assert.match(out.csv, /https:\/\/pub-x\.r2\.dev\/ads\/G5\/1\.jpg/);
  assert.equal((await call({ op: "list" })).listings[0].status, "Exporterad");
});

test("Kopiering från Google Sheet: annonserna och bilderna, avbrutna blir Fel, körs inte dubbelt", async () => {
  const e = env();
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (fetched.push(String(url)), new Response(Buffer.alloc(5, 2), { headers: { "content-type": "image/jpeg" } }));
  try {
    const rows = [
      { "Annons-ID": "G10", Skapad: "2026-10-20T10:00:00Z", Status: "Exporterad", Rubrik: "Schleich föl", Beskrivning: "Fin", Pris: 49, Kanal: "Tradera", "Bild-ID": "a1,a2", JSON: '{"price":49}', "I lager": "Ja" },
      { "Annons-ID": "G11", Status: "Bearbetas", "Bild-ID": "b1" },
    ];
    const store = async (action) => (action === "sheetRead" ? { ok: true, rows } : { ok: false });
    const runs = [];
    const out = await importStep({}, { store, call: (b) => ads(e, b), run: async (b) => (runs.push(b), b.name ? 1 : 1) });
    assert.equal(out.more, false);
    const list = (await ads(e, { op: "list" })).listings;
    const g10 = list.find((l) => l.id === "G10");
    assert.deepEqual([g10.status, g10.price, g10.in_inventory, g10.source, g10.image_urls], ["Exporterad", 49, true, "ark", ["https://pub-x.r2.dev/ads/G10/1.jpg", "https://pub-x.r2.dev/ads/G10/2.jpg"]]);
    assert.equal(list.find((l) => l.id === "G11").status, "Fel");
    assert.equal(fetched.length, 3);
    assert.match(fetched[0], /drive\.google\.com\/uc\?export=download&id=a1/);
    assert.equal(runs.at(-1).status, "Klar");
    // Igen: inget kopieras två gånger.
    await importStep({}, { store, call: (b) => ads(e, b), run: async () => 1 });
    assert.equal(fetched.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sheetRowToAd({ "Annons-ID": 7, Status: "" }).status, "Klar");
});
