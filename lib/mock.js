// Testläge (MOCK=1): fejkade svar så att appen kan provas utan API-nyckel.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mockIdentify() {
  await sleep(600);
  return {
    item: { name: "Rörstrand Mon Amie kaffekopp med fat", category: "Porslin", brand: "Rörstrand", model: "Mon Amie", condition: "Gott skick", confidence_id: "high" },
    usage: { input_tokens: 1700, output_tokens: 120 },
  };
}

export async function mockScan(_image, _opts, onStatus) {
  await sleep(800);
  onStatus("Söker sålda objekt…");
  await sleep(800);
  onStatus("Söker sålda objekt (2)…");
  await sleep(800);
  return {
    model: "mock",
    usages: [{ input_tokens: 24000, output_tokens: 1400, server_tool_use: { web_search_requests: 2 } }],
    raw: {
      item: { name: "Rörstrand Mon Amie kaffekopp med fat", category: "Porslin", brand: "Rörstrand", model: "Mon Amie", article_number: "", age: "1950–1980-tal", condition: "Gott skick, inga synliga nagg", confidence_id: "high" },
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
