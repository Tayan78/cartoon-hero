import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROLISTER_COLUMNS, SCHLEICH_DEFAULTS, buildProListerCsv, exportImageUrl, listingProblem, toHtmlText } from "../lib/prolister.js";

const ORIGIN = "https://loppis.vercel.app";
// Din ProLister-export (rubrikraden och en rad med dina standardvärden, anonymiserad).
const reference = readFileSync(new URL("./fixtures/prolister-export.csv", import.meta.url), "utf8");

const ok = (o = {}) => ({
  id: "G1729860000000",
  title: "Schleich Tinker sto 13279 (2003-08)",
  description: 'Schleich Tinker sto 13279 (2003-08) i lekt men bra skick enligt bild. "Saknar svans"; lite slitage.\n\nSamfraktar gärna.',
  price: 129,
  image_urls: ["https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345", "https://lh3.googleusercontent.com/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765"],
  ...o,
});

// CSV-läsare med semikolon och citattecken (som ProListers export).
function parse(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") row.push(field), (field = "");
    else if (c === "\r") continue;
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else field += c;
  }
  return rows;
}
const asObjects = (csv) => {
  const [head, ...rows] = parse(csv.replace(/^﻿/, ""));
  return rows.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
};

test("exporten har exakt samma rubrikrad och format som ProListers egen export", () => {
  const { csv } = buildProListerCsv([ok()], { origin: ORIGIN });
  assert.ok(csv.startsWith("﻿"));
  // Samma kolumner i samma ordning – utom attributes, som heter skick (mappas rätt vid import).
  const theirs = reference.split(/\r?\n/)[0].replace('"attributes"', '"skick"');
  assert.equal(csv.split("\r\n")[0], theirs, "samma 31 kolumner i samma ordning, inom citattecken");
  assert.deepEqual(parse(reference.slice(1))[0].map((k) => (k === "attributes" ? "skick" : k)), PROLISTER_COLUMNS);
});

test("Schleich får samma värden som dina publicerade annonser, inklusive frakt", () => {
  const ours = asObjects(buildProListerCsv([ok()], { origin: ORIGIN }).csv)[0];
  const yours = asObjects(reference)[0];
  // Allt som ProLister själv sätter (id, listId, latestObjectId, latestUploadDate) lämnas tomt;
  // annonsens eget innehåll kommer från appen; resten ska vara identiskt med din export.
  const own = ["id", "listId", "latestObjectId", "latestUploadDate", "imageUrls", "header", "description", "buyNowPrice", "reference", "uploadOrder", "skick"];
  for (const key of PROLISTER_COLUMNS.filter((k) => !own.includes(k))) {
    assert.equal(ours[key], yours[key], key);
  }
  assert.equal(ours.shipping, SCHLEICH_DEFAULTS.shipping);
  assert.equal(ours.category, "1000532 : Miniatyrer & leksaksfigurer");
  assert.equal(ours.skick, "Gott skick");
  assert.equal(yours.attributes, "121:Gott skick", "samma skick som i din export, i importens format");
  assert.deepEqual([ours.id, ours.listId, ours.latestObjectId], ["", "", ""]);
  assert.equal(ours.header, "Schleich Tinker sto 13279 (2003-08)");
  assert.equal(ours.description, 'Schleich Tinker sto 13279 (2003-08) i lekt men bra skick enligt bild. "Saknar svans"; lite slitage.<br><br>Samfraktar gärna.');
  assert.equal(ours.imageUrls, `${ORIGIN}/bild/1AbCdEfGhIjKlMnOpQrStUvWxYz012345.jpg,${ORIGIN}/bild/1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765.jpg`);
  assert.deepEqual([ours.buyNowPrice, ours.reference, ours.uploadOrder, ours.itemType], ["129", "G1729860000000", "1", "FixedPrice"]);
});

test("egna värden från inställningarna; övriga föremål får tom kategori och frakt", () => {
  const schleich = { category: "1000532", condition: "Bra skick", shipping: "0.5:2:101:39" };
  const [a, b] = asObjects(
    buildProListerCsv([ok(), ok({ id: "G2", title: "Rörstrand Mon Amie kopp" })], { origin: ORIGIN, schleich }).csv,
  );
  assert.deepEqual([a.category, a.skick, a.shipping], ["1000532", "Bra skick", "0.5:2:101:39"]);
  assert.deepEqual([b.category, b.skick, b.shipping], ["", "", ""]);
  assert.equal(b.uploadOrder, "2");
});

test("äldre inställning '121:Gott skick' blir 'Gott skick'", async () => {
  const { mergeSettings } = await import("../lib/settings.js");
  assert.equal(mergeSettings({ listing: { schleich_attributes: "121:Mycket gott skick" } }).listing.schleich_condition, "Mycket gott skick");
  assert.equal(mergeSettings({}).listing.schleich_condition, "Gott skick");
});

test("bildadresser och HTML-text", () => {
  assert.equal(exportImageUrl("https://lh3.googleusercontent.com/d/1AbC_dEf-123456789012345", ORIGIN), `${ORIGIN}/bild/1AbC_dEf-123456789012345.jpg`);
  assert.equal(exportImageUrl("https://example.com/a.jpg", ORIGIN), "https://example.com/a.jpg");
  assert.equal(toHtmlText("Rad 1\r\nRad 2 <b>"), "Rad 1<br>Rad 2 &lt;b&gt;");
});

test("obligatoriska fält och förbjudna formuleringar kontrolleras", () => {
  assert.equal(listingProblem(ok()), "");
  assert.equal(listingProblem(ok({ title: "" })), "rubrik saknas");
  assert.equal(listingProblem(ok({ title: "x".repeat(81) })), "rubriken är längre än 80 tecken");
  assert.equal(listingProblem(ok({ description: " " })), "beskrivning saknas");
  assert.equal(listingProblem(ok({ price: 0 })), "pris saknas");
  assert.equal(listingProblem(ok({ price: "" })), "pris saknas");
  assert.equal(listingProblem(ok({ image_urls: [] })), "bilder saknas");
  assert.equal(listingProblem(ok({ description: "Från min egen samling." })), "texten innehåller en förbjuden formulering");
  assert.equal(listingProblem(ok({ description: "Kommer från rökfritt hem." })), "texten innehåller en förbjuden formulering");
  const { included, skipped } = buildProListerCsv([ok(), ok({ id: "G3", price: 0 })], { origin: ORIGIN });
  assert.deepEqual(included, ["G1729860000000"]);
  assert.deepEqual(skipped, [{ id: "G3", title: ok().title, reason: "pris saknas" }]);
});

test("bildproxyn: bara giltiga Drive-id, bara bilder", async () => {
  const { GET } = await import("../api/image.js");
  const realFetch = globalThis.fetch;
  try {
    assert.equal((await GET(new Request("http://x/api/image?file=../../etc.jpg"))).status, 400);
    globalThis.fetch = async (url) => {
      assert.match(url, /drive\.google\.com\/uc\?export=download&id=1AbCdEfGhIjKlMnOpQrStUv$/);
      return new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg" } });
    };
    const res = await GET(new Request("http://x/api/image?file=1AbCdEfGhIjKlMnOpQrStUv.jpg"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    globalThis.fetch = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
    assert.equal((await GET(new Request("http://x/api/image?file=1AbCdEfGhIjKlMnOpQrStUv.jpg"))).status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});
