import { test } from "node:test";
import assert from "node:assert/strict";
import { PROLISTER_COLUMNS, buildProListerCsv, exportImageUrl, listingProblem, toHtmlText } from "../lib/prolister.js";

const ORIGIN = "https://loppis.vercel.app";
const ok = (o = {}) => ({
  id: "G1729860000000",
  title: "Schleich Tinker sto 13279 (2003-08)",
  description: 'Schleich Tinker sto 13279 (2003-08) i lekt men bra skick enligt bild. "Saknar svans"; lite slitage.\n\nSamfraktar gärna.',
  price: 129,
  image_urls: ["https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345", "https://lh3.googleusercontent.com/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765"],
  ...o,
});
const defaults = { origin: ORIGIN, schleichCategory: "1000532", schleichAttributes: "121:Gott skick" };

// Enkel CSV-läsare med semikolon (som ProListers egen export).
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

test("ProLister-CSV: samma format som ProListers egen export (BOM, semikolon, <br>)", () => {
  const { csv, included, skipped } = buildProListerCsv([ok(), ok({ id: "G2", title: "Rörstrand Mon Amie kopp", price: 79, image_urls: ["https://lh3.googleusercontent.com/d/1QqQqQqQqQqQqQqQqQqQqQq"] })], defaults);
  assert.ok(csv.startsWith("﻿"));
  const rows = parse(csv.slice(1));
  assert.deepEqual(rows[0], PROLISTER_COLUMNS);
  assert.equal(rows.length, 3);
  const r = Object.fromEntries(PROLISTER_COLUMNS.map((k, i) => [k, rows[1][i]]));
  assert.equal(r.Header, "Schleich Tinker sto 13279 (2003-08)");
  assert.equal(r.Description, 'Schleich Tinker sto 13279 (2003-08) i lekt men bra skick enligt bild. "Saknar svans"; lite slitage.<br><br>Samfraktar gärna.');
  assert.equal(
    r.ImageUrls,
    `${ORIGIN}/bild/1AbCdEfGhIjKlMnOpQrStUvWxYz012345.jpg,${ORIGIN}/bild/1ZyXwVuTsRqPoNmLkJiHgFeDcBa98765.jpg`,
    "bilderna som .jpg-adresser, kommaseparerade, huvudbilden först",
  );
  assert.deepEqual([r.BuyNowPrice, r.ItemType, r.Condition, r.quantity, r.Reference], ["129", "FixedPrice", "Used", "1", "G1729860000000"]);
  assert.deepEqual([r.Category, r.Attributes], ["1000532", "121:Gott skick"], "Schleich får din kategori och ditt attribut");
  const other = Object.fromEntries(PROLISTER_COLUMNS.map((k, i) => [k, rows[2][i]]));
  assert.deepEqual([other.Category, other.Attributes], ["", ""], "övrigt sätts i ProLister");
  assert.deepEqual(included, ["G1729860000000", "G2"]);
  assert.deepEqual(skipped, []);
});

test("bildadresser och HTML-text", () => {
  assert.equal(exportImageUrl("https://lh3.googleusercontent.com/d/1AbC_dEf-123456789012345", ORIGIN), `${ORIGIN}/bild/1AbC_dEf-123456789012345.jpg`);
  assert.equal(exportImageUrl("https://example.com/a.jpg", ORIGIN), "https://example.com/a.jpg");
  assert.equal(toHtmlText("Rad 1\r\nRad 2 <b>"), "Rad 1<br>Rad 2 &lt;b&gt;");
});

test("ProLister-CSV: obligatoriska fält och förbjudna formuleringar kontrolleras", () => {
  assert.equal(listingProblem(ok()), "");
  assert.equal(listingProblem(ok({ title: "" })), "rubrik saknas");
  assert.equal(listingProblem(ok({ title: "x".repeat(81) })), "rubriken är längre än 80 tecken");
  assert.equal(listingProblem(ok({ description: " " })), "beskrivning saknas");
  assert.equal(listingProblem(ok({ price: 0 })), "pris saknas");
  assert.equal(listingProblem(ok({ price: "" })), "pris saknas");
  assert.equal(listingProblem(ok({ image_urls: [] })), "bilder saknas");
  assert.equal(listingProblem(ok({ description: "Från min egen samling." })), "texten innehåller en förbjuden formulering");
  assert.equal(listingProblem(ok({ description: "Kommer från rökfritt hem." })), "texten innehåller en förbjuden formulering");

  const { csv, included, skipped } = buildProListerCsv([ok(), ok({ id: "G3", price: 0 })], defaults);
  assert.deepEqual(included, ["G1729860000000"]);
  assert.deepEqual(skipped, [{ id: "G3", title: ok().title, reason: "pris saknas" }]);
  assert.equal(parse(csv.slice(1)).length, 2);
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
