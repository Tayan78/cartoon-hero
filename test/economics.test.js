import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, extractJson, finalizeResult, verdictFor } from "../lib/economics.js";
import { mergeSettings } from "../lib/settings.js";

const settings = mergeSettings({});
const sold = (platform, price) => ({
  title: "x",
  url: `https://www.${platform.toLowerCase()}.com/item/1`,
  platform,
  price,
  currency: "SEK",
  price_sek: price,
  sold: true,
});

test("räknar om ekonomin från medianpris och plattformens avgifter", () => {
  const r = finalizeResult(
    {
      item: { name: "Kopp" },
      price_sek: { low: 100, median: 200, high: 300, comparables: 5, confidence: "high" },
      sources: [sold("Tradera", 200)],
      economics: { net_profit: 9999 },
      buy_score: 80,
      best_platform: "Tradera",
    },
    { buyPrice: 20, settings },
  );
  // 200 − 10 % (20) − frakt 59 − inköp 20
  assert.deepEqual(r.economics, { buy_price: 20, sale_price: 200, fees: 20, shipping: 59, net_profit: 101 });
  assert.equal(r.buy_score, 80);
  assert.equal(r.verdict, "Köp");
  assert.deepEqual(r.flags, []);
});

test("inga sålda jämförelser → låg säkerhet och lågt tak på poängen", () => {
  const r = finalizeResult(
    { price_sek: { median: 500, comparables: 0, confidence: "high" }, sources: [], buy_score: 90 },
    { buyPrice: 0, settings },
  );
  assert.equal(r.price_sek.confidence, "low");
  assert.ok(r.buy_score <= 25);
  assert.equal(r.verdict, "Låt bli");
  assert.match(r.flags[0], /Inga sålda jämförelser/);
});

test("bara eBay-träffar → flaggas, säkerheten sänks och poängen dras ner", () => {
  const r = finalizeResult(
    {
      price_sek: { low: 300, median: 400, high: 500, comparables: 6, confidence: "high" },
      sources: [sold("eBay", 450)],
      buy_score: 75,
    },
    { buyPrice: 0, settings },
  );
  assert.equal(r.price_sek.no_tradera_data, true);
  assert.equal(r.price_sek.confidence, "medium");
  assert.equal(r.buy_score, 65);
  assert.equal(r.verdict, "Kanske");
  assert.match(r.flags.join(" "), /internationell data/);
});

test("negativ marginal begränsar poängen", () => {
  const r = finalizeResult(
    {
      price_sek: { low: 50, median: 80, high: 100, comparables: 4, confidence: "high" },
      sources: [sold("Tradera", 80)],
      buy_score: 85,
    },
    { buyPrice: 100, settings },
  );
  assert.ok(r.economics.net_profit < 0);
  assert.ok(r.buy_score <= 30);
});

test("inställningar från appen slås ihop och saneras", () => {
  const s = mergeSettings({ platforms: { Tradera: { fee_percent: "12", shipping: -5 } }, fx: { USD: "11" } });
  assert.equal(s.platforms.Tradera.fee_percent, 12);
  assert.equal(s.platforms.Tradera.shipping, 59);
  assert.equal(s.fx.USD, 11);
  assert.equal(s.platforms.Vinted.fee_percent, 0);
});

test("hittar JSON även med text eller kodstaket runt", () => {
  assert.deepEqual(extractJson('Här:\n```json\n{"a": {"b": "}"}}\n```'), { a: { b: "}" } });
  assert.throws(() => extractJson("inget här"));
});

test("kostnad per skanning", () => {
  const usd = costUsd("claude-opus-5-5", {
    input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 3,
  });
  assert.equal(Number(usd.toFixed(4)), 4 + 2 + 0.03);
});

test("verdict-gränser", () => {
  assert.equal(verdictFor(70), "Köp");
  assert.equal(verdictFor(69), "Kanske");
  assert.equal(verdictFor(39), "Låt bli");
});
