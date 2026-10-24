// Färdiga sökadresser till sålda/avslutade objekt. Sidor med fetch: true läser
// modellen direkt med web_fetch (Tradera blockerar hämtning, så den söks i stället).
// Alla visas som länkar på resultatkortet. Web fetch får bara hämta adresser
// som står i samtalet, därför byggs de här.

const enc = encodeURIComponent;

export function marketUrls({ tradera, ebay }) {
  const urls = [];
  if (tradera) {
    urls.push({ label: "Tradera – avslutade objekt", url: `https://www.tradera.com/search?q=${enc(tradera)}&itemStatus=Ended`, fetch: false });
  }
  if (ebay) {
    urls.push({
      label: "eBay – sålda objekt",
      url: `https://www.ebay.com/sch/i.html?_nkw=${enc(ebay)}&LH_Sold=1&LH_Complete=1`,
      fetch: true,
    });
  }
  if (tradera) urls.push({ label: "Tradera – till salu nu", url: `https://www.tradera.com/search?q=${enc(tradera)}`, fetch: false });
  return urls;
}

// Sökord för steg 2: artikelnumret först när det är belagt, annars modellens sökord.
// Belagt = läst på föremålet, eller står i bildsökets träffar. Ett nummer modellen
// "kommer ihåg" kan vara fel och ger då priser för fel föremål.
export function searchTerms(identification, visionHints = "") {
  const item = identification?.item ?? {};
  const terms = identification?.search_terms ?? {};
  const brand = (item.brand ?? "").replace(/\(.*?\)/g, "").trim();
  const article = verifiedArticle(item, visionHints);
  const exact = article ? [brand, article].filter(Boolean).join(" ") : "";
  return {
    tradera: exact || (terms.tradera ?? "").trim() || [brand, item.model].filter(Boolean).join(" "),
    ebay: exact || (terms.ebay ?? "").trim() || [brand, item.model].filter(Boolean).join(" "),
  };
}

export function verifiedArticle(item, visionHints = "") {
  const article = (item?.article_number ?? "").trim();
  if (!article) return "";
  if (item.article_number_source === "föremålet") return article;
  return visionHints.toUpperCase().includes(article.toUpperCase()) ? article : "";
}

// Ett obelagt nummer visas inte som fakta och tas bort ur sökorden.
export function dropUnverifiedArticle(identification, visionHints = "") {
  const item = identification?.item;
  const article = (item?.article_number ?? "").trim();
  if (!article || verifiedArticle(item, visionHints)) return;
  item.article_number = "";
  const terms = identification.search_terms ?? {};
  for (const key of Object.keys(terms)) {
    terms[key] = String(terms[key] ?? "").split(article).join(" ").replace(/\s+/g, " ").trim();
  }
}
