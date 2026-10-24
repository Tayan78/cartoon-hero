// Testläge (MOCK=1): fejkade svar så att appen kan provas utan API-nycklar.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mockVision() {
  await sleep(400);
  return {
    best_guesses: ["rörstrand mon amie"],
    entities: [{ description: "Rörstrand", score: 0.9 }, { description: "Mon Amie", score: 0.8 }],
    pages: [{ title: "Rörstrand Mon Amie kopp | Tradera", url: "https://www.tradera.com/item/1/9/mon-amie", exact: true }],
  };
}

export async function mockIdentify(images, _vision, model) {
  await sleep(700);
  return {
    model,
    usages: [{ input_tokens: 1500 * images.length + 900, output_tokens: 350 }],
    raw: {
      item: { name: "Rörstrand Mon Amie kaffekopp med fat", category: "Porslin", brand: "Rörstrand", model: "Mon Amie", article_number: "", age: "1950–1980-tal", condition: "Gott skick, inga synliga nagg", confidence_id: "high" },
      search_terms: { tradera: "mon amie kopp fat", ebay: "rorstrand mon amie cup saucer" },
      evidence: "Blått blommönster och Rörstrand-stämpel på undersidan; bildsöket träffar Mon Amie.",
    },
  };
}

export async function mockPrice(_input, model, onStatus) {
  onStatus("Söker sålda objekt…");
  await sleep(800);
  onStatus("Söker sålda objekt (2)…");
  await sleep(800);
  return {
    model,
    usages: [{ input_tokens: 24000, output_tokens: 1400, server_tool_use: { web_search_requests: 2 } }],
    raw: {
      price_sek: { low: 60, median: 95, high: 150, comparables: 14, confidence: "high", no_tradera_data: false, international: { low: 120, median: 180, high: 260, comparables: 9 } },
      sources: [
        { title: "Rörstrand Mon Amie kaffekopp med fat", url: "https://www.tradera.com/item/1/1/ror-mon-amie", platform: "Tradera", price: 95, currency: "SEK", price_sek: 95, sold: true },
        { title: "2 st Mon Amie kaffekoppar", url: "https://www.tradera.com/item/1/2/mon-amie-2st", platform: "Tradera", price: 180, currency: "SEK", price_sek: 180, sold: true },
        { title: "Rorstrand Mon Amie cup & saucer", url: "https://www.ebay.com/itm/123", platform: "eBay", price: 17, currency: "USD", price_sek: 179, sold: true },
      ],
      economics: { buy_price: 10, fees: 10, shipping: 59, net_profit: 16 },
      buy_score: 62,
      verdict: "Kanske",
      reason: "Säljer stadigt på Tradera, men frakten äter det mesta av marginalen för en enskild kopp – köp om det finns flera.",
      best_platform: "Tradera",
    },
  };
}
