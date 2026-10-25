import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_RULES, VERDICT, checkExplanation, decide, formatMultiple, maxBuy, mergeRules } from "../lib/decision.js";
import { finalizeResult } from "../lib/economics.js";
import { mergeSettings } from "../lib/settings.js";
import { toPriceRaw } from "../lib/simple.js";

const settings = mergeSettings({});
const horse = JSON.parse(readFileSync(new URL("./fixtures/hast-13695.json", import.meta.url)));
const scanHorse = (buyPrice, s = settings) => finalizeResult(toPriceRaw(horse.gemini, horse.lens), { buyPrice, settings: s, mode: "listings" });
// Ett vanligt föremål (inte småfigur, utpris över 100 kr).
const normal = (net, buy, extra = {}) => decide({ net, buy, listPrice: 1000, brand: "Rörstrand", ...extra });
const small = (net, buy, extra = {}) => decide({ net, buy, listPrice: 1000, brand: "Schleich", ...extra });

// Färg, beslut och text får aldrig peka åt olika håll.
function assertConsistent(d) {
  if (d.known) assert.equal(d.verdict, VERDICT[d.color]);
  assert.ok(checkExplanation(d.summary, d), `motiveringen säger emot beslutet: ${d.summary}`);
  if (d.known && d.color === "red" && !d.small) assert.ok(d.profit <= 0);
  if (d.known && d.color === "green") assert.ok(d.profit > 0);
  if (d.uncertain) assert.notEqual(d.color, "green");
}

test("hästen: servern bestämmer, Geminis poäng och 'bra affär' ignoreras", () => {
  const r = scanHorse(20);
  // Utpris = lägsta eBay 149 kr. Tradera: 149 − 15 − 59 = 75 kr netto före inköp.
  assert.equal(r.economics.list_price, 149);
  assert.equal(r.economics.net_before_buy, 75);
  assert.equal(r.decision.small, true, "Schleich räknas som småfigur");
  assert.equal(r.decision.color, "green"); // 75 / 20 = 3,75×
  assert.equal(r.verdict, "Köp");
  assert.equal(r.decision.profit, 55);
  assert.ok(!("buy_score" in r));
  assert.doesNotMatch(r.reason, /bra affär|köp den/i);
  assert.match(r.reason, /Bulkaffär/);
  assertConsistent(r.decision);
});

test("hästen: olika inköpspriser ger alltid samstämmig färg, beslut och text", () => {
  const expected = { 10: "green", 37: "green", 38: "yellow", 57: "yellow", 58: "red", 75: "red", 200: "red" };
  for (const [buy, color] of Object.entries(expected)) {
    const r = scanHorse(Number(buy));
    assert.equal(r.decision.color, color, `inköp ${buy} kr`);
    assertConsistent(r.decision);
  }
});

test("hästen utan inköpspris: betala inte mer än", () => {
  const r = scanHorse(0);
  assert.equal(r.decision.known, false);
  assert.equal(r.decision.color, "none");
  assert.deepEqual(r.decision.max_buy, { green: 37, yellow: 57 });
  assert.equal(r.verdict, "Betala inte mer än 37 kr");
  assertConsistent(r.decision);
});

test("vanliga föremål: gränsen för minsta vinst (100 kr)", () => {
  assert.equal(normal(300, 200).color, "green"); // vinst 100, stort köp
  assert.equal(normal(299, 200).color, "yellow"); // vinst 99
  assert.equal(normal(200, 100).color, "green"); // vinst 100, 2,0×
  assert.equal(normal(199, 99).color, "green"); // vinst 100, 2,01×
  assert.equal(normal(198, 99).color, "yellow"); // vinst 99
});

test("vanliga föremål: gränsen för multipel (2,0×) och stort köp (200 kr)", () => {
  assert.equal(normal(398, 199).color, "green"); // 2,0×
  assert.equal(normal(397, 199).color, "yellow"); // 1,99×, inköp under 200
  assert.equal(normal(397, 200).color, "green"); // 1,985×, men inköp 200
  assert.equal(normal(310, 200).color, "green"); // 1,55×, inköp 200, vinst 110
});

test("vanliga föremål: vinst 0 är röd, 1 kr är gul", () => {
  assert.equal(normal(100, 100).color, "red");
  assert.equal(normal(101, 100).color, "yellow");
  assert.equal(normal(50, 100).color, "red");
  assert.equal(normal(0, 10).color, "red");
});

test("småfigurer: gränserna 2,0× och 1,3×, ingen 100-kronorsgräns", () => {
  assert.equal(small(20, 10).color, "green"); // 2,0×, vinst bara 10 kr
  assert.equal(small(199, 100).color, "yellow"); // 1,99×
  assert.equal(small(130, 100).color, "yellow"); // 1,3×
  assert.equal(small(129, 100).color, "red"); // 1,29×
  assert.match(small(20, 10).summary, /hela lotten/);
});

test("småfigur: Schleich (även i längre märkesnamn) eller utpris under 100 kr", () => {
  assert.equal(decide({ net: 60, buy: 10, listPrice: 500, brand: "Schleich (Tyskland)" }).small, true);
  assert.equal(decide({ net: 30, buy: 10, listPrice: 99, brand: "" }).small, true);
  assert.equal(decide({ net: 30, buy: 10, listPrice: 100, brand: "" }).small, false);
  const rules = mergeRules({ small_brands: "Papo, Bullyland" });
  assert.equal(decide({ net: 60, buy: 10, listPrice: 500, brand: "Papo", rules }).small, true);
  assert.equal(decide({ net: 60, buy: 10, listPrice: 500, brand: "Schleich", rules }).small, false);
});

test("osäkert pris: högst gul, rött förblir rött", () => {
  const capped = normal(500, 100, { uncertain: true });
  assert.equal(capped.color, "yellow");
  assert.equal(capped.verdict, "Tveksamt");
  assert.equal(capped.capped, true);
  assert.match(capped.summary, /osäkert/);
  assert.equal(normal(50, 100, { uncertain: true }).color, "red");
  assert.equal(small(130, 100, { uncertain: true }).capped, false);
});

test("hästen utan Tradera/eBay-annonser: osäkert pris", () => {
  const onlyBlocket = finalizeResult(toPriceRaw(horse.gemini, horse.lens.filter((l) => l.platform === "Blocket")), {
    buyPrice: 10, settings, mode: "listings",
  });
  assert.equal(onlyBlocket.decision.uncertain, true);
  assert.notEqual(onlyBlocket.decision.color, "green");
});

test("maxpriset bakvägen stämmer med beslutet på båda sidor om gränsen", () => {
  for (const net of [0, 50, 99, 100, 150, 199, 200, 250, 299, 300, 301, 450, 1000, 2500]) {
    for (const [isSmall, fn] of [[false, normal], [true, small]]) {
      const { green, yellow } = maxBuy(net, isSmall);
      if (green > 0) {
        assert.equal(fn(net, green).color, "green", `net ${net} small ${isSmall} köp ${green}`);
        assert.notEqual(fn(net, green + 1).color, "green", `net ${net} small ${isSmall} köp ${green + 1}`);
      }
      if (yellow > 0) {
        assert.notEqual(fn(net, yellow).color, "red", `net ${net} small ${isSmall} köp ${yellow}`);
        assert.equal(fn(net, yellow + 1).color, "red", `net ${net} small ${isSmall} köp ${yellow + 1}`);
      }
    }
  }
});

test("alla kombinationer: färg, beslut och motivering hänger ihop", () => {
  for (let net = -50; net <= 1200; net += 37) {
    for (const buy of [0, 1, 5, 20, 49, 50, 99, 100, 150, 199, 200, 201, 400, 900]) {
      for (const uncertain of [false, true]) {
        assertConsistent(normal(net, buy, { uncertain }));
        assertConsistent(small(net, buy, { uncertain }));
      }
    }
  }
});

test("AI-motivering som säger emot beslutet underkänns", () => {
  const red = normal(50, 100);
  const green = normal(500, 100);
  assert.equal(checkExplanation("Bra affär, köp den direkt.", red), null);
  assert.equal(checkExplanation("Låt bli, marginalen är för liten.", green), null);
  assert.equal(checkExplanation("Ger 25 % i marginal.", green), null);
  assert.equal(checkExplanation("Eftertraktad modell som säljer snabbt nära utpriset.", green), "Eftertraktad modell som säljer snabbt nära utpriset.");
});

test("multipeln avrundas nedåt så att gult aldrig visas som 2,0×", () => {
  assert.equal(formatMultiple(1.98), "1,9×");
  assert.equal(formatMultiple(2), "2,0×");
  assert.equal(formatMultiple(3.75), "3,7×");
});

test("köpreglerna kan ändras i inställningarna och saneras", () => {
  const s = mergeSettings({ decision: { min_profit: "150", min_multiple: -1, small_brands: ["Schleich", " Papo "] } });
  assert.equal(s.decision.min_profit, 150);
  assert.equal(s.decision.min_multiple, DEFAULT_RULES.min_multiple);
  assert.deepEqual(s.decision.small_brands, ["Schleich", "Papo"]);
  assert.equal(normal(240, 100, { rules: s.decision }).color, "yellow"); // vinst 140 < 150
});
