import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateNumbers, channelFor, checkListingText, formatYears, marketPrice, minPriceFor, researchListing, schleichTitle } from "../lib/listing.js";
import { mockDefect, mockLens, mockListingText, mockSimple, mockTradera } from "../lib/mock.js";
import { DEFAULT_CLOSING } from "../lib/settings.js";

const CLOSING = "Samfraktar gärna. Titta på mina andra annonser!";
import { findOnTradera } from "../lib/tradera.js";

test("annonstext: egen samling och rökfritt/djurfritt hem bort, din avslutning exakt sist", () => {
  const r = checkListingText({
    title: "Schleich 13279 Tinker sto häst 2003!",
    description: `Fin häst. Den kommer från min egen samling och är välvårdad.\n\nSkick: Gott.\n\nKommer från ett rökfritt och djurfritt hem!\n${CLOSING}\nTack för titten.`,
    closing: CLOSING,
  });
  assert.equal(r.title, "Schleich 13279 Tinker sto häst 2003");
  assert.doesNotMatch(r.description, /samling|rökfri|djurfri/i);
  assert.match(r.description, /Fin häst\./);
  assert.match(r.description, /Tack för titten\./);
  assert.ok(r.description.endsWith(`\n\n${CLOSING}`));
  assert.equal(r.description.split(CLOSING).length, 2, "avslutningen finns exakt en gång");
  assert.equal(r.fixes.length, 2);
  for (const phrase of ["ur vår samling", "från min samling", "Privat samling.", "mina egna samlingar"]) {
    assert.doesNotMatch(checkListingText({ title: "x", description: `Häst ${phrase}` }).description, /samling/i, phrase);
  }
  // "samlingen" i andra sammanhang är okej.
  assert.match(checkListingText({ title: "x", description: "Passar i samlingen." }).description, /samlingen/);
});

test("annonstext: avslutningen läggs till, rubriken kortas vid ordgräns", () => {
  const r = checkListingText({ title: "Ett ".repeat(30) + "slut", description: "", closing: CLOSING });
  assert.ok(r.title.length <= 80);
  assert.doesNotMatch(r.title, /\s$/);
  assert.equal(r.description, CLOSING);
  assert.equal(checkListingText({ title: "x", description: "Text." }).description, "Text.");
});

test("Schleich: rubrik = märke + ras + djurtyp + nummer + (årtal)", () => {
  assert.equal(schleichTitle({ name: "Tinker sto", number: "13279", years: "2003-2008" }), "Schleich Tinker sto 13279 (2003-08)");
  assert.equal(schleichTitle({ name: "Schleich Siberian Husky hund (16372)", number: "16372", years: "2008-2013" }), "Schleich Siberian Husky hund 16372 (2008-13)");
  assert.equal(schleichTitle({ name: "Knabstrupper föl", number: "13910", years: "" }), "Schleich Knabstrupper föl 13910");
  assert.equal(formatYears("2003"), "2003");
  assert.equal(formatYears("1998–2004"), "1998-2004");
  assert.equal(formatYears("2003-08"), "2003-08");
  assert.equal(formatYears("ca 2010"), "");
  assert.equal(formatYears("2010-2004"), "");
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
  defect: mockDefect,
};

test("berikning Schleich: fast mall med lekt skick, brist från anteckningen och din avslutning", async () => {
  const l = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }], note: "saknar svans" }, deps);
  assert.equal(l.article.number, "13695");
  assert.equal(l.article.verified, true);
  assert.equal(l.confirmed, "");
  assert.ok(l.candidates.some((c) => c.number === "13695"));
  assert.equal(l.channel, "Tradera");
  assert.ok(l.price > 0);
  assert.equal(l.title, "Schleich Pinto ettåring häst 13695 (2010-14)");
  assert.equal(l.description, `Schleich Pinto ettåring häst 13695 (2010-14) i lekt men bra skick enligt bild. Saknar svans.\n\n${DEFAULT_CLOSING}`);
  assert.doesNotMatch(l.description, /rökfri|djurfri|swish/i);
  assert.ok(l.cost.usd > 0);

  const custom = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }], settings: { listing: { closing: CLOSING } } }, deps);
  assert.equal(custom.description, `Schleich Pinto ettåring häst 13695 (2010-14) i lekt men bra skick enligt bild.\n\n${CLOSING}`);
});

test("berikning övrigt: AI:n skriver enligt prompten, servern rensar och avslutar", async () => {
  const porslin = async (input) => {
    const g = await mockSimple(input, () => {});
    g.raw = { ...g.raw, item: { ...g.raw.item, name: "Rörstrand Mon Amie kopp", brand: "Rörstrand", category: "Porslin" } };
    return g;
  };
  const l = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }] }, { ...deps, gemini: porslin });
  assert.doesNotMatch(l.description, /samling|rökfri|djurfri/i);
  assert.ok(l.description.endsWith(DEFAULT_CLOSING));
  assert.ok(l.fixes.length >= 2);
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

test("bilder: Gemini tittar först bara på huvudbilden, upp till 3 om modellen är oklar", async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ mediaType: "image/jpeg", data: String(i) }));
  const calls = [];
  const gemini = (unclear) => async (input) => {
    calls.push(input.images.map((img) => img.data));
    const g = await mockSimple(input, () => {});
    if (unclear && calls.length === 1) g.raw = { ...g.raw, item: { ...g.raw.item, article_number: "", confidence_id: "low" } };
    return g;
  };
  let written = [];
  const write = (imgs, prompt) => ((written = imgs.map((img) => img.data)), mockListingText(imgs, prompt));
  let lensImage;
  const lens = (img, fx) => ((lensImage = img.data), mockLens(fx));

  await researchListing({ images: eight }, { ...deps, lens, gemini: gemini(false), write });
  assert.deepEqual(calls, [["0"]], "tydlig modell: bara huvudbilden");
  assert.equal(lensImage, "0", "Lens bara på huvudbilden");
  // Annonstexten (utom Schleich, som har fast mall) ser högst 3 bilder.
  const porslin = async (input) => {
    const g = await mockSimple(input, () => {});
    g.raw = { ...g.raw, item: { ...g.raw.item, brand: "Rörstrand", name: "Kopp" } };
    return g;
  };
  await researchListing({ images: eight }, { ...deps, gemini: porslin, write });
  assert.deepEqual(written, ["0", "1", "2"], "annonstexten ser högst 3 bilder");

  calls.length = 0;
  const l = await researchListing({ images: eight }, { ...deps, lens, gemini: gemini(true), write });
  assert.deepEqual(calls, [["0"], ["0", "1", "2"]], "oklar modell: upp till 3 bilder");
  assert.match(l.flags.join(" "), /3 bilder användes/);
});

test("lägsta pris: föl/ponny 49 kr, häst 69 kr, övriga djur ingen gräns", () => {
  assert.deepEqual(minPriceFor("Schleich Haflinger föl 13814"), { min: 49, kind: "föl/ponny" });
  assert.deepEqual(minPriceFor("Schleich Shetlandsponny hingst 13756"), { min: 49, kind: "föl/ponny" });
  assert.deepEqual(minPriceFor("Schleich Tinker sto 13279 (2003-08)"), { min: 69, kind: "häst" });
  assert.deepEqual(minPriceFor("Schleich Pinto ettåring häst 13695"), { min: 69, kind: "häst" });
  assert.equal(minPriceFor("Schleich Fjällrävsunge 14639"), null);
  assert.equal(minPriceFor("Schleich Storkpar 14000"), null); // "sto" bara som eget ord
});

test("berikning: billig marknad höjs till lägsta pris och flaggas", async () => {
  const cheap = async () => ({
    listings: [{ title: "Schleich Pinto 13695", url: "https://www.tradera.com/item/1", platform: "Tradera", price: 25, currency: "SEK", price_sek: 25, sold: false, via: "tradera" }],
    total: 1,
    queries: [],
  });
  const l = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }] }, { ...deps, lens: async () => null, tradera: cheap });
  assert.equal(l.price, 69);
  assert.equal(l.list_basis, "lägsta pris för häst");
  assert.ok(l.flags.some((f) => /lägsta pris för häst: 69 kr/.test(f)));
});

test("pris ur databasen: sålt median, mättad modell → billigaste till salu (aldrig under kvartil 25), för få sålda → inget", () => {
  assert.equal(marketPrice({ sold: 2, median: 90 }), null);
  assert.equal(marketPrice(null), null);
  const normal = marketPrice({ sold: 8, median: 89, p25: 69, sell_through: 70, asks_below_median: 3, active_low: 59 });
  assert.equal(normal.price, 89);
  assert.match(normal.basis, /sålt median, 8 st/);
  assert.equal(marketPrice({ sold: 8, median: 89, p25: 69, sell_through: 30, asks_below_median: 3, active_low: 75 }).price, 75);
  assert.equal(marketPrice({ sold: 8, median: 89, p25: 69, sell_through: 30, asks_below_median: 3, active_low: 49 }).price, 69);
});

test("berikning med databasen: bekräftat nummer slås upp och priset sätts från sålda", async () => {
  const asked = [];
  const market = async (n) => (asked.push(n), { number: n, sold: 6, median: 119, p25: 99, p75: 139, sell_through: 75, asks_below_median: 0, active: 2, active_low: 129, recent: [] });
  const l = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }], confirmed: "13803" }, { ...deps, market });
  assert.deepEqual(asked, ["13803"]);
  assert.equal(l.price, 119);
  assert.match(l.list_basis, /sålt median, 6 st/);
  assert.equal(l.market.median, 119);
  // Databasen nere: annonsen blir ändå klar, med Tradera-priset.
  const down = await researchListing({ images: [{ mediaType: "image/jpeg", data: "" }], confirmed: "13803" }, { ...deps, market: async () => { throw new Error("nere"); } });
  assert.ok(down.price > 0);
  assert.ok(down.flags.some((f) => /Databasen kunde inte läsas/.test(f)));
});
