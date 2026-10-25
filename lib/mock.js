import { summarizeLens } from "./lens.js";
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

export async function mockGemini() {
  await sleep(500);
  return {
    model: "gemini-3.8-flash",
    raw: { name: "Rörstrand Mon Amie kaffekopp med fat", brand: "Rörstrand", model: "Mon Amie", article_number: "", confidence: "high", candidates: [], evidence: "Mönstret matchar Mon Amie i flera butiker." },
    queries: ["rörstrand blå blomma kopp"],
    sources: [{ title: "rorstrand.se", url: "https://www.rorstrand.se" }],
    grounded: true,
    tokensIn: 1800,
    tokensOut: 300,
    usd: (1800 * 0.75 + 300 * 3.75) / 1e6 + 0.014,
  };
}

export async function mockIdentify(images, _vision, model) {
  await sleep(700);
  return {
    model,
    usages: [{ input_tokens: 1500 * images.length + 900, output_tokens: 350 }],
    raw: {
      item: { name: "Rörstrand Mon Amie kaffekopp med fat", category: "Porslin", brand: "Rörstrand", model: "Mon Amie", article_number: "", age: "1950–1980-tal", condition: "Gott skick, inga synliga nagg", confidence_id: "high" },
      candidates: [{ name: "Rörstrand Mon Amie kaffekopp med fat", article_number: "" }],
      search_terms: { tradera: "mon amie kopp fat", ebay: "rorstrand mon amie cup saucer" },
      evidence: "Blått blommönster och Rörstrand-stämpel på undersidan; bildsöket träffar Mon Amie.",
    },
  };
}

export async function mockPrice(input, model, onStatus) {
  if (!input.urls?.length) throw new Error("mock: inga sökadresser");
  onStatus("Läser Tradera/eBay (1)…");
  await sleep(800);
  onStatus("Läser Tradera/eBay (2)…");
  await sleep(800);
  // Skriv "inga sålda" i info-fältet för att se kortet utan sålda jämförelser.
  if (input.note?.includes("inga sålda")) {
    return {
      model,
      usages: [{ input_tokens: 9000, output_tokens: 900, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }],
      raw: {
        price_sek: { low: 30, median: 60, high: 90, comparables: 0, confidence: "low", no_tradera_data: true, international: { low: 0, median: 0, high: 0, comparables: 0 } },
        sources: [45, 55, 69, 79, 89, 99, 118, 120].map((price, i) => ({
          title: `Schleich 13695 Pinto Yearling (${i + 1})`, url: `https://www.ebay.de/itm/${i}`, platform: "eBay", price, currency: "SEK", price_sek: price, sold: false, via: "search",
        })),
        for_sale: { low: 45, high: 120, count: 9 },
        market_note: "Vanlig figur, säljs ofta i lotter.",
        best_platform: "Tradera",
      },
    };
  }
  return {
    model,
    usages: [{ input_tokens: 24000, output_tokens: 1400, server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 } }],
    raw: {
      price_sek: { low: 60, median: 95, high: 150, comparables: 14, confidence: "high", no_tradera_data: false, international: { low: 120, median: 180, high: 260, comparables: 9 } },
      sources: [
        { title: "Rörstrand Mon Amie kaffekopp med fat", url: "https://www.tradera.com/item/1/1/ror-mon-amie", platform: "Tradera", price: 95, currency: "SEK", price_sek: 95, sold: true },
        { title: "2 st Mon Amie kaffekoppar", url: "https://www.tradera.com/item/1/2/mon-amie-2st", platform: "Tradera", price: 180, currency: "SEK", price_sek: 180, sold: true },
        { title: "Rorstrand Mon Amie cup & saucer", url: "https://www.ebay.com/itm/123", platform: "eBay", price: 17, currency: "USD", price_sek: 179, sold: true, via: "fetch" },
        { title: "Mon Amie kopp med fat, 4 st", url: "https://www.tradera.com/item/1/3/mon-amie-4st", platform: "Tradera", price: 450, currency: "SEK", price_sek: 450, sold: false, via: "fetch" },
        { title: "Mon Amie kaffekopp", url: "https://www.tradera.com/item/1/4/mon-amie", platform: "Tradera", price: 149, currency: "SEK", price_sek: 149, sold: false, via: "fetch" },
      ],
      for_sale: { low: 149, high: 450, count: 6 },
      market_note: "Säljer stadigt på Tradera, populärt mönster.",
      best_platform: "Tradera",
    },
  };
}

export async function mockGeminiPrice(input, onStatus) {
  const r = await mockPrice(input, "gemini-3.8-flash", onStatus);
  return {
    raw: r.raw,
    model: "gemini-3.8-flash",
    queries: ["site:tradera.com mon amie kopp", "rorstrand mon amie ebay sold"],
    sources: [{ title: "tradera.com", url: "https://www.tradera.com" }],
    grounded: true,
    tokensIn: 6000,
    tokensOut: 900,
    usd: (6000 * 0.75 + 900 * 3.75) / 1e6 + 2 * 0.014,
  };
}

export async function mockVisionRaw() {
  const summary = await mockVision();
  return { summary, raw: [{ webDetection: { bestGuessLabels: [{ label: "rörstrand mon amie", languageCode: "sv" }] } }] };
}

// Enkelt läge i testläge: Schleich-hästen från testerna, annonser på flera sajter.
export async function mockSimple({ note }, onStatus) {
  await sleep(600);
  onStatus("Söker på Google…");
  await sleep(800);
  const none = note?.includes("inga annonser");
  const raw = {
    item: { name: "Schleich Pinto Yearling", category: "Leksaker / samlarfigurer", brand: "Schleich", model: "Pinto Jährling", article_number: "13695", article_number_source: "google", age: "ca 2010", condition: "Gott skick", confidence_id: "high" },
    candidates: [{ name: "Schleich Pinto föl", article_number: "13803" }],
    evidence: "Bildsöket och flera annonser visar samma figur med nummer 13695.",
    price_sek: { low: 45, median: 79, high: 150, confidence: "medium" },
    listings: none
      ? []
      : [
          { title: "Schleich 13695 Pinto Jährling", url: "https://www.tradera.com/item/1/1/schleich-13695", platform: "Tradera", price: 79, currency: "SEK", price_sek: 79 },
          { title: "Schleich häst pinto 13695", url: "https://www.tradera.com/item/1/2/schleich-pinto", platform: "Tradera", price: 99, currency: "SEK", price_sek: 99 },
          { title: "Schleich 13695 Pinto Yearling", url: "https://www.ebay.de/itm/13695", platform: "eBay", price: 6.5, currency: "EUR", price_sek: 75 },
          { title: "Schleich pintohäst", url: "https://www.blocket.se/annons/1", platform: "Blocket", price: 45, currency: "SEK", price_sek: 45 },
          { title: "Schleich häst 13695", url: "https://www.vinted.se/items/1", platform: "Vinted", price: 60, currency: "SEK", price_sek: 60 },
          { title: "Schleich Pinto Jährling OVP", url: "https://www.ebay.de/itm/13695b", platform: "eBay", price: 13, currency: "EUR", price_sek: 150 },
        ],
    market_note: "Lättsåld, utgången modell som samlare söker.",
    best_platform: "Tradera",
  };
  return {
    raw,
    model: "gemini-3.8-flash",
    queries: ["Schleich pinto föl figur", "Schleich 13695 tradera"],
    sources: [{ title: "tradera.com", url: "https://www.tradera.com" }],
    supported: ['"article_number": "13695"'],
    grounded: true,
    attempts: 1,
    tokensIn: 4200,
    tokensOut: 1100,
    usd: (4200 * 0.75 + 1100 * 3.75) / 1e6 + 2 * 0.014,
    response: { candidates: [{ content: { parts: [{ text: JSON.stringify(raw) }] }, groundingMetadata: { webSearchQueries: ["Schleich pinto föl figur", "Schleich 13695 tradera"] } }] },
  };
}

// Google Lens i testläge: svar i SerpApis format (visual_matches med price).
export async function mockLens(fx) {
  await sleep(500);
  const raw = {
    search_metadata: { status: "Success" },
    visual_matches: [
      { position: 1, title: "Schleich 13695 Pinto Jährling", link: "https://www.ebay.de/itm/2041", source: "eBay", price: { value: "6,50 €*", extracted_value: 6.5, currency: "€" }, in_stock: true },
      { position: 2, title: "Schleich Horse Club 13695 Pinto ettåring", link: "https://www.tradera.com/item/340/6611/schleich-13695", source: "Tradera", price: { value: "79 kr", extracted_value: 79, currency: "kr" } },
      { position: 3, title: "Schleich 13695 Pinto Yearling", link: "https://www.lekia.se/schleich-13695", source: "Lekia", price: { value: "129 kr", extracted_value: 129, currency: "kr" }, in_stock: false },
      { position: 4, title: "Schleich pinto häst", link: "https://www.blocket.se/annons/123", source: "Blocket", price: { value: "50 kr", extracted_value: 50, currency: "kr" } },
      { position: 5, title: "Schleich Pinto Foal 13803", link: "https://www.schleich-s.com/13803", source: "schleich-s.com" },
    ],
  };
  return { raw, summary: summarizeLens(raw, fx) };
}

export async function mockSentence(prompt) {
  await sleep(300);
  const color = /Beslut[^\n]*\((grön|gul|röd)\)/.exec(prompt)?.[1];
  const text = {
    grön: "Utgången modell som samlare söker, så den bör gå att sälja nära utpriset.",
    gul: "Går att sälja, men marginalen är tunn – pruta om du kan.",
    röd: "Avgifter och frakt äter upp marginalen vid det här inköpspriset.",
  }[color] ?? "Använd maxpriset som gräns när du prutar.";
  return { text, model: "gemini-3.8-flash", tokensIn: 300, tokensOut: 40, usd: (300 * 0.75 + 40 * 3.75) / 1e6 };
}

// Traderas sökning i testläge: två aktiva annonser för hästen.
export async function mockTradera({ query, article }) {
  await sleep(300);
  const listings = [
    { title: "Schleich 13695 Pinto ettåring", url: "https://www.tradera.com/item/340211/700000001/schleich-13695", platform: "Tradera", price: 129, currency: "SEK", price_sek: 129, sold: false, via: "tradera", price_type: "köp nu", bids: 0, thumbnail: "" },
    { title: "Schleich häst 13695 pinto", url: "https://www.tradera.com/item/340211/700000002/schleich-hast", platform: "Tradera", price: 89, currency: "SEK", price_sek: 89, sold: false, via: "tradera", price_type: "bud", bids: 2, thumbnail: "" },
  ];
  return { query, listings, total: 2, matched_number: Boolean(article) };
}
