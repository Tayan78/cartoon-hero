import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_LINE, candidateNumbers, channelFor, checkListingText, researchListing } from "../lib/listing.js";
import { mockLens, mockListingText, mockSimple, mockTradera } from "../lib/mock.js";
import { findOnTradera } from "../lib/tradera.js";

test("annonstext: förbjuden formulering bort, bakgrundsraden exakt sist", () => {
  const r = checkListingText({
    title: "Schleich 13279 Tinker sto häst 2003!",
    description: "Fin häst. Den kommer från min egen samling och är välvårdad.\n\nSkick: Gott.\n\nKommer från ett rökfritt och djurfritt hem!\nTack för titten.",
  });
  assert.equal(r.title, "Schleich 13279 Tinker sto häst 2003");
  assert.doesNotMatch(r.description, /samling/i);
  assert.match(r.description, /Fin häst\./);
  assert.ok(r.description.endsWith(`\n\n${BACKGROUND_LINE}`));
  assert.equal(r.description.split(BACKGROUND_LINE).length, 2, "raden finns exakt en gång");
  assert.ok(r.fixes.length >= 1);
  for (const phrase of ["ur vår samling", "från min samling", "Privat samling.", "mina egna samlingar"]) {
    assert.doesNotMatch(checkListingText({ title: "x", description: `Häst ${phrase}` }).description, /samling/i, phrase);
  }
  // "samlingen" i andra sammanhang är okej.
  assert.match(checkListingText({ title: "x", description: "Passar i samlingen." }).description, /samlingen/);
});

test("annonstext: saknad bakgrundsrad läggs till, rubriken kortas vid ordgräns", () => {
  const r = checkListingText({ title: "Ett ".repeat(30) + "slut", description: "" });
  assert.ok(r.title.length <= 80);
  assert.doesNotMatch(r.title, /\s$/);
  assert.equal(r.description, BACKGROUND_LINE);
});

test("kanal: Tradera som standard, Vinted för kläder, skor och väskor", () => {
  assert.equal(channelFor({ category: "Leksaksfigurer", name: "Schleich Tinkersto" }), "Tradera");
  assert.equal(channelFor({ category: "Porslin", name: "Rörstrand Mon Amie kopp" }), "Tradera");
  assert.equal(channelFor({ category: "Kläder / Damkläder", name: "Filippa K kofta" }), "Vinted");
  assert.equal(channelFor({ category: "", name: "Dr. Martens kängor 38" }), "Vinted");
  assert.equal(channelFor({ category: "Accessoarer", name: "Michael Kors handväska" }), "Vinted");
});

test("kandidater: förslaget först, inga dubbletter, Lens-nummer med antal träffar", () => {
  const c = candidateNumbers({
    article: { number: "13279", source: "Google Lens", verified: true },
    candidates: [{ name: "Tinkersto", article_number: "13279" }, { name: "Tinkerhingst", article_number: "13831" }],
    lensNumbers: [{ number: "13279", pages: 3 }, { number: "13831", pages: 2 }, { number: "13617", pages: 2 }],
  });
  assert.deepEqual(c.map((x) => x.number), ["13279", "13831", "13617"]);
  assert.equal(c[2].source, "Google Lens (2 träffar)");
});

const deps = {
  lens: (img, fx) => mockLens(fx),
  gemini: (input) => mockSimple(input, () => {}),
  tradera: (input) => findOnTradera({ ...input, lens: null }, mockTradera),
  write: mockListingText,
};

test("berikning: identifiering, pris från Tradera, kanal och kontrollerad text", async () => {
  const l = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }], note: "saknar svans" }, deps);
  assert.equal(l.article.number, "13695");
  assert.equal(l.article.verified, true);
  assert.equal(l.confirmed, "");
  assert.ok(l.candidates.some((c) => c.number === "13695"));
  assert.equal(l.channel, "Tradera");
  assert.ok(l.price > 0);
  assert.match(l.title, /13695/);
  assert.doesNotMatch(l.description, /samling/i);
  assert.ok(l.description.endsWith(BACKGROUND_LINE));
  assert.ok(l.cost.usd > 0);
});

test("berikning med valt modellnummer: numret räknas som bekräftat av dig", async () => {
  const l = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }], confirmed: "13803" }, deps);
  assert.equal(l.confirmed, "13803");
  assert.deepEqual([l.article.number, l.article.source, l.article.verified], ["13803", "din info", true]);
});

test("kön: /api/listing-process kräver hemligheten och svarar med annonsen", async () => {
  process.env.MOCK = "1";
  process.env.APPS_SCRIPT_SECRET = "hemligt";
  const { POST } = await import("../api/listing-process.js");
  const call = (secret, body) =>
    POST(new Request("http://x/api/listing-process", { method: "POST", headers: { "x-script-secret": secret }, body: JSON.stringify(body) }));
  assert.equal((await call("fel", { images: ["AAAA"] })).status, 401);
  assert.equal((await call("hemligt", { images: [] })).status, 400);
  const res = await call("hemligt", { id: "G1", images: ["AAAA"], note: "" });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.id, "G1");
  assert.ok(data.listing.title);
});
