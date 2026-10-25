import { test } from "node:test";
import assert from "node:assert/strict";
import { PROLISTER_COLUMNS, buildProListerCsv, listingProblem } from "../lib/prolister.js";

const ok = (o = {}) => ({
  id: "G1729860000000",
  title: "Schleich Tinker sto 13279 (2003-08)",
  description: 'Schleich Tinker sto 13279 (2003-08) i lekt men bra skick enligt bild. "Saknar svans".\n\nSamfraktar gärna.',
  price: 129,
  image_urls: ["https://lh3.googleusercontent.com/d/a", "https://lh3.googleusercontent.com/d/b"],
  ...o,
});

// Enkel CSV-läsare (RFC 4180) för att kontrollera filen.
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
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\r") continue;
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else field += c;
  }
  return rows;
}

test("ProLister-CSV: kolumnnamn enligt guiden, BOM och en rad per annons", () => {
  const { csv, included, skipped } = buildProListerCsv([ok(), ok({ id: "G2", title: "Schleich Pinto föl 13803", price: 79, image_urls: ["https://x/1"] })]);
  assert.ok(csv.startsWith("﻿"));
  const rows = parse(csv.slice(1));
  assert.deepEqual(rows[0], PROLISTER_COLUMNS);
  assert.deepEqual(rows[0], ["Rubrik", "Beskrivning", "Bilder", "Köp nu-pris", "Annonstyp", "Skick", "Referens"]);
  assert.equal(rows.length, 3);
  const [title, description, images, price, type, condition, reference] = rows[1];
  assert.equal(title, "Schleich Tinker sto 13279 (2003-08)");
  assert.equal(description, ok().description, "radbrytningar, komman och citattecken bevaras");
  assert.equal(images, "https://lh3.googleusercontent.com/d/a,https://lh3.googleusercontent.com/d/b", "bilderna kommaseparerade i en cell");
  assert.deepEqual([price, type, condition, reference], ["129", "FixedPrice", "Used", "G1729860000000"]);
  assert.deepEqual(included, ["G1729860000000", "G2"]);
  assert.deepEqual(skipped, []);
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

  const { csv, included, skipped } = buildProListerCsv([ok(), ok({ id: "G3", price: 0 })]);
  assert.deepEqual(included, ["G1729860000000"]);
  assert.deepEqual(skipped, [{ id: "G3", title: ok().title, reason: "pris saknas" }]);
  assert.equal(parse(csv.slice(1)).length, 2);
});
