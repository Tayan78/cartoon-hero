// Färdiga sökadresser till sålda/avslutade objekt. Modellen läser dem direkt med
// web_fetch i stället för att hoppas att webbsökningen hittar sålda annonser.
// Web fetch får bara hämta adresser som står i samtalet, därför byggs de här.

const enc = encodeURIComponent;

export function marketUrls({ tradera, ebay }) {
  const urls = [];
  if (tradera) {
    urls.push({ label: "Tradera – avslutade objekt", url: `https://www.tradera.com/search?q=${enc(tradera)}&itemStatus=Ended` });
  }
  if (ebay) {
    urls.push({
      label: "eBay – sålda objekt",
      url: `https://www.ebay.com/sch/i.html?_nkw=${enc(ebay)}&LH_Sold=1&LH_Complete=1`,
    });
  }
  if (tradera) urls.push({ label: "Tradera – till salu nu", url: `https://www.tradera.com/search?q=${enc(tradera)}` });
  return urls;
}

// Sökord för steg 2: artikelnumret först när det finns, annars modellens sökord.
export function searchTerms(identification) {
  const item = identification?.item ?? {};
  const terms = identification?.search_terms ?? {};
  const brand = (item.brand ?? "").replace(/\(.*?\)/g, "").trim();
  const article = (item.article_number ?? "").trim();
  const exact = article ? [brand, article].filter(Boolean).join(" ") : "";
  return {
    tradera: exact || (terms.tradera ?? "").trim() || [brand, item.model].filter(Boolean).join(" "),
    ebay: exact || (terms.ebay ?? "").trim() || [brand, item.model].filter(Boolean).join(" "),
  };
}
