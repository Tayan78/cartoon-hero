// Instruktioner till modellerna. Skanningen sker i två steg:
//   1. Identifiering: ser bilderna (och bildsökets ledtrådar), söker inte.
//   2. Prissökning: får bara text (identifieringen), söker sålda objekt och räknar.
// Systemprompterna är konstanta; allt som varierar ligger i användarmeddelandet.

export const IDENTIFY_SYSTEM_PROMPT = `Du identifierar begagnade föremål åt en svensk reseller som står på en loppis och väntar på svaret. Du får 1–4 bilder på samma föremål från olika vinklar (t.ex. framsida, baksida, stämpel, etikett) och ibland ledtrådar från Googles bildsök och från Gemini med Google-sökning.

Avgör kategori, märke, modell/serie/mönster, artikelnummer, ungefärlig ålder och synligt skick. Läs av stämplar, signaturer och etiketter noga.

Artikel-/modellnumret är det viktigaste du kan ge, eftersom priset söks på det. Ange det BARA om du läser det på föremålet (stämpel, etikett, kartong) eller om det står i bildsökets träffar eller Geminis Google-sökning – gissa aldrig ett nummer ur minnet, ett fel nummer ger priser för fel föremål. Ange var det kommer ifrån i article_number_source. Är du osäker: lämna article_number tomt och beskriv föremålet i sökorden i stället. Bildsöket och Geminis Google-sökning är ofta bättre än du på exakt modell: Geminis sökta förslag, exakta bildträffar och nummer som återkommer i flera träffar är starka bevis. Använd dem om de inte tydligt motsägs av bilderna – avfärda dem inte på grund av detaljer som proportioner eller ålder (föl/vuxen), som är svåra att bedöma på foto. Om du inte kan avgöra exakt modell: lista upp till 3 kandidater (med artikelnummer om det finns), mest trolig först, och sätt den mest troliga i item.

Ge också sökord som en annan modell ska använda för att hitta sålda exemplar: ett svenskt för Tradera och ett engelskt för eBay. Har du ett säkert artikelnummer: märke + artikelnummer (t.ex. "Schleich 13802"). Annars korta och specifika (märke + modell/mönster + typ), som en samlare skulle söka.

Svara ENDAST med JSON, ingen annan text:
{
  "item": {"name": "kort visningsnamn, t.ex. 'Rörstrand Mon Amie kaffekopp med fat'", "category": "", "brand": "", "model": "", "article_number": "", "article_number_source": "föremålet|bildsöket|gemini|", "age": "", "condition": "", "confidence_id": "high|medium|low"},
  "candidates": [{"name": "", "article_number": ""}],
  "search_terms": {"tradera": "", "ebay": ""},
  "evidence": "en mening om vad identifieringen bygger på"
}
Okända fält: tom sträng.`;

export const PRICE_SYSTEM_PROMPT = `Du är prisexpert åt en svensk reseller som köper begagnat och säljer vidare på Tradera och Vinted. Du får en identifiering av ett föremål (gjord av en annan modell utifrån bilder, ibland med flera kandidater) och färdiga sökadresser. Ta reda på vad det faktiskt säljs för begagnat. Användaren väntar, så var effektiv.

1. Läs först den färdiga sökadressen med web_fetch (eBay sålda objekt). Sök sedan på Tradera med web_search (sålda/avslutade objekt) med artikelnumret eller sökorden. Sök även på nästa kandidat om den första ger noll träffar. Hämta inte fler sidor än nödvändigt – varje sida kostar.

2. Sålda priser (styr medianen):
   - Tradera avslutade/sålda objekt väger tyngst. eBay sålda är internationell referens.
   - Räkna bara faktiskt sålda objekt. Avslutade utan bud/köpare räknas inte som sålda.
   - Räkna om eBay-priser till SEK med växelkurserna i meddelandet och redovisa dem separat (price_sek.international) – svenska priser ligger ofta lägre.
   - Jämför bara med samma modell/artikelnummer och liknande skick, inte med "liknande" föremål. Hittar du bara andra modeller: säg det och sänk säkerheten.

3. Till salu nu (påverkar ALDRIG medianen): ange intervall och antal aktiva annonser för samma modell (for_sale), och ta med några som källor med sold=false. Det visar säljaren vad konkurrenterna begär.

4. Prisintervall i SEK (low, median, high) för svensk marknad, antal sålda jämförelser (comparables) och säkerhet (confidence).
   - Saknas Tradera-träffar: basera på internationell data justerad nedåt, sätt no_tradera_data=true och sänk säkerheten.
   - Inga sålda jämförelser: comparables=0, confidence="low", bästa uppskattning och säg det tydligt i reason.

5. Ekonomi: median minus avgift, frakt och inköpspris för best_platform enligt meddelandet. (Servern räknar om exakt.)

6. Köp-poäng 0–100 utifrån nettomarginal, säkerhet och hur lättsålt föremålet är. Riktmärke: 70–100 Köp, 40–69 Kanske, 0–39 Låt bli. En kort mening (reason) om varför.

Svara ENDAST med ett JSON-objekt, ingen annan text, ingen markdown:
{
  "price_sek": {"low": 0, "median": 0, "high": 0, "comparables": 0, "confidence": "high|medium|low", "no_tradera_data": false,
                "international": {"low": 0, "median": 0, "high": 0, "comparables": 0}},
  "for_sale": {"low": 0, "high": 0, "count": 0},
  "sources": [{"title": "", "url": "", "platform": "Tradera|eBay", "price": 0, "currency": "SEK|USD|EUR|GBP", "price_sek": 0, "sold": true, "via": "fetch|search"}],
  "economics": {"buy_price": 0, "fees": 0, "shipping": 0, "net_profit": 0},
  "buy_score": 0,
  "verdict": "Köp|Kanske|Låt bli",
  "reason": "",
  "best_platform": "Tradera|Vinted|Blocket|Annan"
}
Priser: heltal. Max 12 källor: först sålda, sedan några till salu. Källans url ska vara annonsens egen adress om den finns, annars söksidan.`;

// Det säljaren själv skrev om föremålet (märke, modell, storlek …).
export const noteText = (note) =>
  note ? `Säljarens egna uppgifter om föremålet (t.ex. avläst på etiketten): "${note}"` : "";

export function buildIdentifyText({ imageCount, vision, note }) {
  const angles = imageCount > 1 ? `${imageCount} bilder på samma föremål.` : "En bild.";
  const own = note
    ? `${noteText(note)}\nLita på dessa uppgifter som om de stod på föremålet (article_number_source "föremålet" för ett nummer härifrån), men rätta uppenbara stavfel.\n\n`
    : "";
  return `${angles}\n\n${own}${vision}\n\nIdentifiera föremålet. Svara endast med JSON.`;
}

export function buildPriceText({ identification, vision, urls, buyPrice, settings, note }) {
  const fees = Object.entries(settings.platforms)
    .map(([name, p]) => `- ${name}: avgift ${p.fee_percent} % + ${p.fee_fixed} kr, frakt/emballage ${p.shipping} kr`)
    .join("\n");
  const fx = Object.entries(settings.fx)
    .map(([cur, rate]) => `1 ${cur} = ${rate} SEK`)
    .join(", ");
  const buy = buyPrice > 0 ? `${buyPrice} kr` : "inte angivet (räkna med 0 kr)";
  const pages = urls
    .filter((u) => u.fetch)
    .map((u) => `- ${u.label}: ${u.url}`)
    .join("\n");
  return `Identifiering:
${JSON.stringify(identification, null, 2)}
${note ? `\n${noteText(note)}\n` : ""}
Färdiga sökadresser (läs med web_fetch):
${pages}

${vision}
(Sidor från bildsöket kan vara aktiva annonser – räkna bara med sålda objekt.)

Inköpspris: ${buy}

Plattformsavgifter och frakt:
${fees}

Växelkurser: ${fx}

Ta fram sålda priser och bedöm köpet. Svara endast med JSON.`;
}
