// Loppisskannern – fas 1: fota (1–4 vinklar) → (inköpspris) → skanna → resultatkort.

import { allGroups, allScans, askPersistent, deleteGroup, deleteScan, filterScans, getGroup, getScan, putGroup, putScan, thumbnail, updateScan } from "./history.js";

// Samma standardvärden som lib/settings.js på servern.
const DEFAULT_SETTINGS = {
  platforms: {
    Tradera: { fee_percent: 10, fee_fixed: 0, shipping: 59 },
    Vinted: { fee_percent: 0, fee_fixed: 0, shipping: 0 },
    Blocket: { fee_percent: 0, fee_fixed: 0, shipping: 59 },
    Annan: { fee_percent: 0, fee_fixed: 0, shipping: 59 },
  },
  fx: { USD: 10.5, EUR: 11.5, GBP: 13.5 },
  listing: {
    closing: "Samfraktar gärna om du köper flera eller vinner flera auktioner. Packas väl i bubbelkuvert eller spårbart brevlådepaket. Titta gärna på mina andra annonser!",
    schleich_category: "1000532 : Miniatyrer & leksaksfigurer",
    schleich_condition: "Gott skick",
    schleich_shipping: "0.5:2:101:49,0.5:19:100:49,0.5:12:22:59,0.5:12:33:59,0.5:7:1:49,0.5:19:101:49",
  },
  decision: { min_profit: 100, min_multiple: 2, big_buy: 200, small_green: 2, small_yellow: 1.3, small_price: 100, small_brands: ["Schleich"] },
};
const RULE_FIELDS = [
  ["min_profit", "Minsta vinst för grön (kr)"],
  ["min_multiple", "Minsta multipel för grön"],
  ["big_buy", "Stort köp: inköp från (kr), multipel krävs inte"],
  ["small_green", "Småfigur: grön från multipel"],
  ["small_yellow", "Småfigur: gul från multipel"],
  ["small_price", "Småfigur: utpris under (kr)"],
];
// Tomt värde = serverns standard (ID_MODEL / SEARCH_MODEL i Vercel).
const MODEL_OPTIONS = [
  ["", "Standard (servern)"],
  ["claude-opus-5-5", "Opus 5.5 – bäst, dyrast"],
  ["claude-sonnet-5-5", "Sonnet 5.5 – mellan"],
  ["claude-haiku-5-5", "Haiku 5.5 – billigast"],
];
const MAX_PHOTOS = 4;
const MAX_SIDE = 1500;
const JPEG_QUALITY = 0.82;
const MAX_BYTES = 480 * 1024;

const $ = (id) => document.getElementById(id);
const kr = (n) => `${Math.round(n).toLocaleString("sv-SE")} kr`;

// ---------- lagring i telefonen ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
const getToken = () => store.get("token", "");
const getSettings = () => {
  const s = store.get("settings", null);
  return {
    platforms: { ...structuredClone(DEFAULT_SETTINGS.platforms), ...(s?.platforms ?? {}) },
    fx: { ...DEFAULT_SETTINGS.fx, ...(s?.fx ?? {}) },
    models: { identify: s?.models?.identify ?? "", search: s?.models?.search ?? "" },
    vision: s?.vision ?? true,
    gemini: s?.gemini ?? true,
    mode: s?.mode ?? "simple",
    lens: s?.lens ?? true,
    tradera: s?.tradera ?? true,
    decision: { ...DEFAULT_SETTINGS.decision, ...(s?.decision ?? {}) },
    listing: { ...DEFAULT_SETTINGS.listing, ...(s?.listing ?? {}) },
    // Startsidans budget: saldo och förbrukat enligt Google Cloud, och när du läste av.
    budget: { google_limit: 50, google_spent: 0, google_spent_at: "", ...(s?.budget ?? {}) },
  };
};

// ---------- vyer ----------
const views = ["home", "scan", "result", "history", "capture", "groups", "review", "settings", "lego", "seller", "market", "lots", "ops"];
const TITLES = {
  home: "Loppisskannern",
  scan: "Skanna",
  result: "Resultat",
  history: "Historik",
  capture: "Fota annonser",
  groups: "Annonser",
  review: "Granska annons",
  settings: "Inställningar",
  lego: "Lego i bulk",
  seller: "Konkurrent",
  market: "Marknadsdata",
  lots: "Fynd",
  ops: "Drift",
};
let currentView = "home";
// Flikraden: vilken flik som lyser för varje vy.
const TAB_ROOTS = ["home", "scan", "capture", "groups", "history"];
const TAB_OF = { result: null, review: "groups", settings: null };
function markTab(name) {
  const tab = name === "result" ? (historyIndex >= 0 ? "history" : "scan") : name in TAB_OF ? TAB_OF[name] : name;
  for (const b of document.querySelectorAll("#tabbar .tab")) b.classList.toggle("on", b.dataset.tab === tab);
}
function show(name) {
  if (name !== "capture") stopCamera();
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  currentView = name;
  $("top-title").textContent = TITLES[name] ?? "Loppisskannern";
  // Tillbaka-pilen behövs bara under en flik (resultat, granskning, inställningar …).
  $("btn-back").hidden = TAB_ROOTS.includes(name) && !(name === "capture" && captureFrom === "groups");
  markTab(name);
  $("btn-settings").hidden = name === "settings";
  window.scrollTo(0, 0);
}

// ---------- bilder ----------
let photos = []; // dataURL:er efter komprimering, första = huvudbild

// Bilder från telefonens bildbibliotek är 12–24 megapixel. De avkodas direkt i
// mindre storlek, så att minnet räcker även för 8 bilder i rad (annars kraschar
// Safari). Stöds det inte används <img> som förut.
async function decodeSmall(file) {
  // Små bilder (under ~1 MB) behöver inte krympas vid avkodningen.
  if ("createImageBitmap" in window && file.size > 1024 * 1024) {
    try {
      // Bredd 1500 räcker för både liggande och stående bilder; toJpeg krymper resten.
      const bitmap = await createImageBitmap(file, { resizeWidth: MAX_SIDE, resizeQuality: "high", imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Kunde inte läsa bilden"));
      i.src = url;
    });
    // iOS roterar enligt EXIF när bilden ritas, så naturalWidth/Height stämmer.
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => img.removeAttribute("src") };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function compress(file) {
  const { source, width, height, release } = await decodeSmall(file);
  try {
    return toJpeg(source, width, height);
  } finally {
    release();
  }
}

// Bild eller videobild → JPEG. Google Lens (SerpApi) tar max 500 kB: krymp
// kvalitet och storlek bara om bilden inte ryms (oftast räcker första försöket).
function toJpeg(source, width, height) {
  const canvas = document.createElement("canvas");
  let dataUrl = "";
  try {
    for (const [side, quality] of [[MAX_SIDE, JPEG_QUALITY], [MAX_SIDE, 0.7], [1200, 0.7], [1000, 0.65]]) {
      const scale = Math.min(1, side / Math.max(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length * 0.75 <= MAX_BYTES) break;
    }
  } finally {
    // Safari har ett tak för bildminne; en bortglömd canvas räknas tills den städas bort.
    canvas.width = 0;
    canvas.height = 0;
  }
  return dataUrl;
}

// Låter telefonen andas mellan tunga bilder (uppdaterar skärmen och städar minne).
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

async function addPhoto(file, replaceMain) {
  $("btn-scan").disabled = true;
  $("scan-hint").textContent = "Förbereder bild…";
  let error = "";
  try {
    const url = await compress(file);
    if (replaceMain && photos.length) photos[0] = url;
    else photos.push(url);
  } catch (err) {
    error = err.message;
  }
  renderPhotos();
  // Visa felet efter renderPhotos, som annars skriver över det.
  if (error) $("scan-hint").textContent = `⚠️ ${error}`;
}

function renderPhotos() {
  const has = photos.length > 0;
  $("preview").hidden = !has;
  if (has) $("preview").src = photos[0];
  else $("preview").removeAttribute("src");
  $("camera-label").classList.toggle("has-photo", has);
  if (has) $("camera-text").textContent = "Tryck för att fota om huvudbilden";
  else $("camera-text").innerHTML = "📷<br>Fota föremål";

  $("angles").hidden = !has;
  $("angle-list").replaceChildren(
    ...photos.slice(1).map((url, i) => {
      const wrap = Object.assign(document.createElement("div"), { className: "angle" });
      const img = Object.assign(document.createElement("img"), { src: url, alt: `Vinkel ${i + 2}` });
      const del = Object.assign(document.createElement("button"), { type: "button", textContent: "×", ariaLabel: "Ta bort" });
      del.addEventListener("click", () => {
        photos.splice(i + 1, 1);
        renderPhotos();
      });
      wrap.append(img, del);
      return wrap;
    }),
  );
  $("add-angle").hidden = photos.length >= MAX_PHOTOS;
  $("pick-gallery").hidden = photos.length >= MAX_PHOTOS;
  $("pick-gallery-text").textContent = has ? "🖼 Lägg till från bilder" : "🖼 Välj från bilder";
  $("add-angle-text").textContent = `+ Vinkel (${photos.length}/${MAX_PHOTOS})`;

  $("btn-scan").disabled = !has;
  const kb = photos.reduce((sum, p) => sum + p.length * 0.75, 0) / 1024;
  $("scan-hint").textContent = has ? `${photos.length} ${photos.length === 1 ? "bild" : "bilder"} · ${Math.round(kb)} kB` : "";
}

$("photo").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await addPhoto(file, true);
});

$("photo-more").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await addPhoto(file, false);
});

// Bilder som redan finns i telefonen; första blir huvudbild om ingen finns.
$("photo-gallery").addEventListener("change", async (e) => {
  const files = [...(e.target.files ?? [])].slice(0, MAX_PHOTOS - photos.length);
  e.target.value = "";
  for (const file of files) {
    await addPhoto(file, false);
    await nextFrame();
  }
});

function resetScan() {
  leaveHistoryCard();
  photos = [];
  $("buy-price").value = "";
  $("note").value = "";
  renderPhotos();
  show("scan");
}

// ---------- skanning ----------
let current = null; // { scan_id, result, image_url }

function setStatus(text, busy = true) {
  $("status").hidden = !text;
  $("status-text").textContent = text ?? "";
  $("status").querySelector(".spinner").hidden = !busy;
}

function resetCard(image = photos[0]) {
  $("card-img").src = image;
  $("r-name").textContent = "Identifierar…";
  $("r-sub").textContent = "";
  for (const id of ["r-price", "r-verdict-row", "r-article", "r-details", "r-sources-title", "r-debug", "btn-save"]) $(id).hidden = true;
  for (const id of ["r-reason", "r-evidence", "r-cost"]) $(id).textContent = "";
  $("r-flags").replaceChildren();
  $("r-sources").replaceChildren();
  $("r-details").replaceChildren();
  $("btn-save").textContent = "Spara till lager";
  $("btn-save").classList.remove("saved");
  $("btn-save").disabled = false;
}

function renderPrelim(item) {
  $("r-name").textContent = item.name || "Okänt föremål";
  $("r-sub").textContent = [item.brand, item.model, item.category].filter(Boolean).join(" · ");
}

const multiple = (m) => `${(Math.floor(m * 10 + 1e-9) / 10).toFixed(1).replace(".", ",")}×`;
const confText = { high: "hög", medium: "medel", low: "låg" };

// Prispanelen: utpris (lägsta till salu), budgräns (sålt median) och en
// prislinje med annonserna som prickar och det sålda spannet som grönt fält.
function renderPrice(r) {
  const p = r.price_sek;
  const e = r.economics;
  const fs = r.for_sale ?? { low: 0, high: 0, count: 0 };
  const listings = r.mode === "listings";
  const hasSold = !listings && p.comparables > 0 && e.bid_floor > 0;
  const asks = r.sources.filter((s) => !s.sold && s.price_sek > 0).map((s) => s.price_sek);

  $("r-price").hidden = false;
  $("r-list").textContent = e.list_price > 0 ? kr(e.list_price) : "–";
  $("r-floor-label").textContent = listings ? "Mittpris annonser" : hasSold ? "Bud ned till" : "Sålt (median)";
  $("r-floor").textContent = hasSold ? kr(e.bid_floor) : listings && p.median > 0 ? kr(p.median) : "–";
  $("r-floor").className = `floor ${hasSold ? "has" : listings && p.median > 0 ? "" : "none"}`;
  $("r-basis").textContent =
    e.list_basis === "lägsta Tradera/eBay"
      ? "Lägsta pris på Tradera/eBay just nu. Bud under det kan accepteras."
      : listings && e.list_basis === "lägsta till salu"
        ? "Lägsta pris till salu just nu (inga Tradera/eBay-annonser hittades)."
        : e.list_basis === "lägsta till salu"
      ? hasSold
        ? `Lägsta till salu just nu. Säljs oftast för ${kr(p.median)} – bud ned dit är rimliga.`
        : "Lägsta till salu just nu. Bud under det kan accepteras."
      : e.list_basis === "sålt median"
        ? "Inga annonser till salu just nu – priset bygger på sålda objekt."
        : e.list_price > 0
          ? "Inga annonser eller försäljningar hittades – priset är en uppskattning."
          : "Inget pris hittades.";

  // Skala för prislinjen, med lite luft på båda sidor.
  const values = [...asks, fs.low, fs.high, hasSold ? p.low : 0, hasSold ? p.high : 0, p.median].filter((v) => v > 0);
  const bar = $("r-bar");
  const labels = $("r-bar-labels");
  if (values.length < 2) {
    bar.hidden = true;
    labels.hidden = true;
  } else {
    bar.hidden = false;
    labels.hidden = false;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo) * 0.1 || hi * 0.1 || 1;
    const pos = (v) => `${(((v - lo + pad) / (hi - lo + 2 * pad)) * 100).toFixed(1)}%`;
    const span = (cls, left, width) => {
      const el = Object.assign(document.createElement("span"), { className: cls });
      el.style.left = left;
      if (width) el.style.width = width;
      return el;
    };
    const parts = [span("track", "0")];
    if (hasSold && p.low > 0 && p.high > 0) {
      parts.push(span("sold-range", pos(p.low), `calc(${pos(p.high)} - ${pos(p.low)})`));
    }
    if (fs.low > 0 && fs.high > fs.low) parts.push(span("ask-range", pos(fs.low), `calc(${pos(fs.high)} - ${pos(fs.low)})`));
    if (p.median > 0) parts.push(span(hasSold ? "median" : "estimate", pos(p.median)));
    for (const a of asks) parts.push(span("dot", pos(a)));
    if (e.list_basis.startsWith("lägsta")) parts.push(span("list-dot", pos(e.list_price)));
    bar.replaceChildren(...parts);

    const label = (html) => Object.assign(document.createElement("span"), { innerHTML: html });
    const range = fs.low && fs.high && fs.high !== fs.low ? `${kr(fs.low)}–${kr(fs.high)}` : kr(fs.low || fs.high);
    labels.replaceChildren(
      ...(hasSold
        ? [label(`<span class="sold">sålt ${kr(p.low)}–${kr(p.high)}</span>`), fs.count ? label(`<b>${range}</b> till salu`) : label("")]
        : [
            fs.low ? label(`<b>${kr(fs.low)}</b> lägst`) : label(""),
            p.median > 0 ? label(`<span class="est">${listings ? "mittpris" : "uppskattat"} ${kr(p.median)}</span>`) : label(""),
            fs.high && fs.high !== fs.low ? label(`<b>${kr(fs.high)}</b> högst`) : label(""),
          ]),
    );
  }
  const perSite = {};
  for (const s of r.sources.filter((x) => !x.sold)) perSite[s.platform] = (perSite[s.platform] ?? 0) + 1;
  const where = Object.entries(perSite).map(([k, n]) => `${k} ${n}`).join(" · ");
  $("r-counts").textContent = listings
    ? `${fs.count} annonser till salu${where ? `: ${where}` : ""}`
    : `${fs.count} annonser till salu${where ? ` (${where})` : ""} · ${p.comparables} sålda`;
  $("r-nosold").textContent = listings
    ? "Priset bygger på annonser till salu just nu – inte på sålda priser."
    : "Inga bekräftade försäljningar – priset följer marknaden just nu.";
  $("r-nosold").hidden = hasSold;
  $("r-retail").hidden = !r.retail;
  if (r.retail) {
    const span = r.retail.low === r.retail.high ? kr(r.retail.low) : `${kr(r.retail.low)}–${kr(r.retail.high)}`;
    $("r-retail").textContent = `Nypris i butik: ${span} (${r.retail.count} butiker) – räknas inte som begagnatpris.`;
  }

  renderDecision(r.decision);
}

// Beslutet kommer färdigt från servern (lib/decision.js) – appen visar det bara.
function renderDecision(d) {
  $("r-verdict-row").hidden = false;
  $("r-verdict-row").className = `decision ${d.color}`;
  $("r-verdict").textContent = d.verdict;
  $("r-net").textContent = d.known
    ? `${d.profit > 0 ? "Vinst" : "Förlust"} ${kr(Math.abs(d.profit))} · ${multiple(d.multiple)}`
    : d.max_buy.yellow > 0
      ? `Grön upp till ${kr(d.max_buy.green)} · vinst upp till ${kr(d.max_buy.yellow)}`
      : "Ingen marginal efter avgift och frakt";
  const tags = [];
  if (d.uncertain) tags.push(d.capped ? "Osäkert pris – sänkt från grön" : "Osäkert pris");
  if (d.small) tags.push("Bulkaffär – räkna på hela lotten");
  $("r-tags").replaceChildren(...tags.map((t) => Object.assign(document.createElement("span"), { className: "tag", textContent: t })));
}

function renderResult(data, { track = true } = {}) {
  const r = data.result;
  const p = r.price_sek;
  renderPrelim(r.item);
  if (r.item.condition) $("r-sub").textContent += (r.item.age ? ` · ${r.item.age}` : "") + ` · ${r.item.condition}`;
  if (r.article) {
    $("r-article").hidden = false;
    $("r-article").textContent = `Modellnummer ${r.article.number} · ${r.article.source}${r.article.verified ? "" : " (obekräftat)"}`;
  }

  renderPrice(r);
  $("r-reason").textContent = r.reason;
  $("r-reason").title = r.reason_source === "ai" ? "Motivering av Gemini utifrån beslutet" : "Regelstyrd motivering";
  $("r-evidence").textContent = [r.note && `Din info: ${r.note}`, r.evidence && `Identifiering: ${r.evidence}`]
    .filter(Boolean)
    .join(" · ");

  // "Inga sålda" visas redan i prispanelen.
  $("r-flags").replaceChildren(
    ...r.flags
      .filter((f) => !f.startsWith("Inga sålda jämförelser"))
      .map((f) => Object.assign(document.createElement("li"), { textContent: f })),
  );

  const e = r.economics;
  const rows = [
    ["Jämförelser", `${p.comparables} sålda · säkerhet ${confText[p.confidence]}`],
    ["Identifiering", `säkerhet ${confText[r.item.confidence_id]}`],
  ];
  if (r.gemini?.name) {
    rows.push(["Google (Gemini)", [r.gemini.name, r.gemini.article_number].filter(Boolean).join(" · ")]);
  }
  const others = (r.candidates ?? []).filter((c) => c.name && c.name !== r.item.name);
  if (others.length) {
    rows.push(["Andra kandidater", others.map((c) => [c.name, c.article_number].filter(Boolean).join(" ")).join("; ")]);
  }
  if (p.international.median > 0) {
    rows.push(["Internationellt (eBay)", `${kr(p.international.median)} (${kr(p.international.low)}–${kr(p.international.high)})`]);
  }
  rows.push(
    ["Bästa plattform", r.best_platform],
    ["Utpris", kr(e.list_price)],
    ["Avgift", `−${kr(e.fees)}`],
    ["Frakt", `−${kr(e.shipping)}`],
    ["Netto före inköp", kr(e.net_before_buy ?? e.net_profit + e.buy_price)],
  );
  if (e.buy_price > 0) rows.push(["Inköpspris", `−${kr(e.buy_price)}`], ["Vinst", kr(e.net_profit)]);
  if (r.decision?.known && r.decision.pay_max > 0) rows.push(["Betala inte mer än", kr(r.decision.pay_max)]);
  $("r-details").replaceChildren(
    ...rows.flatMap(([k, v]) => [
      Object.assign(document.createElement("dt"), { textContent: k }),
      Object.assign(document.createElement("dd"), { textContent: v }),
    ]),
  );
  $("r-details").hidden = false;

  $("r-sources-title").hidden = r.sources.length === 0 && !r.search_urls?.length;
  $("r-sources").replaceChildren(
    ...[...r.sources].sort((a, b) => Number(b.sold) - Number(a.sold)).map((s) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: s.url, target: "_blank", rel: "noopener" });
      const title = document.createElement("span");
      title.append(Object.assign(document.createElement("span"), { className: "tag", textContent: s.platform }), s.title || s.url);
      const price = document.createElement("span");
      price.textContent = (s.price_sek ? kr(s.price_sek) : "") + (s.sold ? "" : s.price_type === "bud" ? ` · bud${s.bids ? ` (${s.bids})` : ""}` : " · till salu") + (s.price_type === "såld" ? " · såld" : "");
      a.append(title, price);
      li.append(a);
      return li;
    }),
    // Geminis Google-källor för identifieringen och (om Gemini sökte priset) prissökningen.
    ...[...(r.gemini?.sources ?? []).slice(0, 3), ...(r.price_google_sources ?? []).slice(0, 3)].map((g) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: g.url, target: "_blank", rel: "noopener", className: "search-link" });
      a.append(Object.assign(document.createElement("span"), { textContent: `📎 ${g.title || "Google-källa"}` }));
      li.append(a);
      return li;
    }),
    // Söksidorna, så att du själv kan kontrollera på Tradera/eBay.
    ...(r.search_urls ?? []).map((u) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: u.url, target: "_blank", rel: "noopener", className: "search-link" });
      a.append(Object.assign(document.createElement("span"), { textContent: `🔎 ${u.label}` }));
      li.append(a);
      return li;
    }),
  );

  const secs = (data.duration_ms / 1000).toFixed(1);
  const sek = (n) => `${n.toFixed(2).replace(".", ",")} kr`;
  const short = (m) => {
    if (m === "serpapi-google-lens" || m === "tradera-api") return "";
    const flash = m?.match(/gemini-([\d.]+)-flash/);
    if (flash) return `Flash ${flash[1]}`;
    return (m?.match(/opus|sonnet|haiku/i)?.[0] ?? "").replace(/^./, (c) => c.toUpperCase());
  };
  const parts = data.cost.steps
    .map((st) => `${st.step}${short(st.model) ? ` (${short(st.model)})` : ""} ${sek(st.sek)}`)
    .join(" · ");
  $("r-cost").textContent =
    `Kostnad ${sek(data.cost.sek)} (${parts}) · ${data.cost.web_fetches ?? 0} sidor lästa · ${data.cost.web_searches} sökningar · ${data.images} bild${data.images === 1 ? "" : "er"} · ${secs} s`;
  $("btn-save").hidden = false;
  $("r-debug").hidden = !r.debug;
  $("r-debug").open = false;
  $("r-debug-pre").textContent = r.debug ? JSON.stringify(r.debug, null, 2) : "";
  if (track) trackCost(data.cost.sek);
}

function trackCost(sek) {
  const month = new Date().toISOString().slice(0, 7);
  const c = store.get("costs", {});
  c[month] = { sek: (c[month]?.sek ?? 0) + sek, scans: (c[month]?.scans ?? 0) + 1 };
  store.set("costs", c);
}

async function readNdjson(res, onMessage) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onMessage(JSON.parse(line));
    }
  }
  if (buf.trim()) onMessage(JSON.parse(buf));
}

$("btn-scan").addEventListener("click", async () => {
  if (!photos.length) return;
  if (!getToken()) {
    openSettings("Ange lösenordet först.");
    return;
  }
  leaveHistoryCard();
  resetCard();
  show("result");
  setStatus("Skickar…");
  current = null;
  let gotResult = false;
  const buyPrice = Number($("buy-price").value) || 0;
  const note = $("note").value.trim();
  // Miniatyren till historiken görs medan servern arbetar.
  const thumb = thumbnail(photos[0]).catch(() => "");

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({
        images: photos,
        buyPrice,
        note,
        settings: getSettings(),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Fel ${res.status}`);
    }
    await readNdjson(res, (msg) => {
      if (msg.type === "status") setStatus(msg.text);
      else if (msg.type === "prelim") {
        renderPrelim(msg.item);
        setStatus("Identifierad – söker sålda priser…");
      } else if (msg.type === "result") {
        gotResult = true;
        current = { scan_id: msg.scan_id, result: msg.result, image_url: "" };
        renderResult(msg);
        setStatus("Sparar i Sheet…");
        saveToHistory(msg, { buyPrice, note, thumb });
      } else if (msg.type === "logged") {
        if (current) {
          current.image_url = msg.image_url;
          if (msg.image_url) historyUpdate(current.scan_id, { image_url: msg.image_url });
        }
        setStatus(msg.ok ? "" : `Kunde inte logga i Sheet: ${msg.error ?? "okänt fel"}`, false);
      } else if (msg.type === "error") throw new Error(msg.error);
    });
    if (!gotResult) throw new Error("Svaret avbröts – försök igen.");
  } catch (err) {
    setStatus(gotResult ? `Loggning: ${err.message}` : `⚠️ ${err.message}`, false);
    if (!gotResult) $("r-name").textContent = "Skanningen misslyckades";
  }
});

$("btn-save").addEventListener("click", async () => {
  if (!current) return;
  const btn = $("btn-save");
  btn.disabled = true;
  btn.textContent = "Sparar…";
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify(current),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
    btn.textContent = "✓ Sparad i lager";
    btn.classList.add("saved");
    historyUpdate(current.scan_id, { saved: true });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Spara till lager";
    setStatus(`Kunde inte spara: ${err.message}`, false);
  }
});

$("btn-new").addEventListener("click", resetScan);

// ---------- historik ----------
// Varje skanning sparas i telefonen. Misslyckas lagringen märks det bara i
// historiken – skanningen och Sheet-loggningen påverkas inte.
async function saveToHistory(data, { buyPrice, note, thumb }) {
  try {
    await putScan({ id: data.scan_id, ts: Date.now(), buyPrice, note, thumb: await thumb, image_url: "", saved: false, data });
    askPersistent();
  } catch (err) {
    console.warn("Historiken kunde inte sparas:", err);
  }
}

function historyUpdate(id, fields) {
  updateScan(id, fields).catch((err) => console.warn("Historiken kunde inte uppdateras:", err));
}

const historyFilter = { color: "", saved: "", q: "" };
let historyIds = []; // id:n i den filtrerade listan, i visningsordning
let historyIndex = -1; // >= 0 när ett historikkort visas

const when = (ts) =>
  new Date(ts).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function pillFor(d) {
  const pill = document.createElement("span");
  pill.className = `pill ${d?.color ?? "none"}`;
  pill.textContent = !d ? "–" : d.known || d.color === "red" ? d.verdict : `Max ${kr(d.pay_max)}`;
  return pill;
}

async function renderHistory() {
  let list = [];
  try {
    list = await allScans();
  } catch (err) {
    $("h-list").replaceChildren();
    $("h-empty").hidden = false;
    $("h-empty").textContent = `⚠️ ${err.message}`;
    return;
  }
  const shown = filterScans(list, historyFilter);
  historyIds = shown.map((rec) => rec.id);
  $("h-count").textContent = shown.length === list.length ? `${list.length} skanningar` : `${shown.length} av ${list.length}`;
  $("h-empty").hidden = shown.length > 0;
  $("h-empty").textContent = list.length ? "Inget matchar filtret." : "Inga skanningar ännu. De sparas här i telefonen när du skannar.";
  $("h-list").replaceChildren(
    ...shown.map((rec, i) => {
      const r = rec.data.result;
      const li = document.createElement("li");
      const row = Object.assign(document.createElement("button"), { type: "button", className: "hist-row" });
      const img = Object.assign(document.createElement("img"), { src: rec.thumb || "", alt: "" });
      const info = Object.assign(document.createElement("div"), { className: "info" });
      const number = r.article?.number ? `${r.article.number}${r.article.verified ? "" : "?"}` : "";
      info.append(
        Object.assign(document.createElement("div"), { className: "name", textContent: r.item?.name || "Okänt föremål" }),
        Object.assign(document.createElement("div"), {
          className: "line",
          textContent: [rec.saved ? "✓ lager" : "", number, r.economics?.list_price > 0 ? `Lägg ut för ${kr(r.economics.list_price)}` : ""]
            .filter(Boolean)
            .join(" · "),
        }),
      );
      const side = Object.assign(document.createElement("div"), { className: "side" });
      side.append(pillFor(r.decision), Object.assign(document.createElement("span"), { className: "muted", textContent: when(rec.ts) }));
      row.append(img, info, side);
      row.addEventListener("click", () => openHistoryCard(i));
      li.append(row);
      return li;
    }),
  );
}

function openHistory() {
  leaveHistoryCard();
  show("history");
  renderHistory();
}

// Visar ett sparat kort precis som det såg ut, med bläddring inom filtret.
async function openHistoryCard(index) {
  const id = historyIds[index];
  const rec = id && (await getScan(id).catch(() => null));
  if (!rec) return renderHistory();
  historyIndex = index;
  resetCard(rec.thumb || "");
  renderResult(rec.data, { track: false });
  setStatus("");
  current = { scan_id: rec.id, result: rec.data.result, image_url: rec.image_url ?? "" };
  if (rec.saved) {
    $("btn-save").textContent = "✓ Sparad i lager";
    $("btn-save").classList.add("saved");
    $("btn-save").disabled = true;
  }
  $("r-meta").hidden = false;
  $("r-meta").textContent = [when(rec.ts), rec.buyPrice > 0 ? `inköp ${kr(rec.buyPrice)}` : "inget inköpspris"].join(" · ");
  $("hist-nav").hidden = false;
  $("h-pos").textContent = `${index + 1} av ${historyIds.length}`;
  $("h-prev").disabled = index <= 0;
  $("h-next").disabled = index >= historyIds.length - 1;
  $("btn-delete").hidden = false;
  show("result");
}

function leaveHistoryCard() {
  historyIndex = -1;
  for (const id of ["hist-nav", "r-meta", "btn-delete"]) $(id).hidden = true;
}

function stepHistory(delta) {
  const next = historyIndex + delta;
  if (historyIndex >= 0 && next >= 0 && next < historyIds.length) openHistoryCard(next);
}

$("h-prev").addEventListener("click", () => stepHistory(-1));
$("h-next").addEventListener("click", () => stepHistory(1));

$("h-search").addEventListener("input", (e) => {
  historyFilter.q = e.target.value;
  renderHistory();
});
for (const [group, key] of [["h-colors", "color"], ["h-saved", "saved"]]) {
  $(group).addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    for (const c of $(group).querySelectorAll(".chip")) c.classList.toggle("on", c === chip);
    historyFilter[key] = chip.dataset[key];
    renderHistory();
  });
}

$("btn-delete").addEventListener("click", async () => {
  if (historyIndex < 0 || !confirm("Ta bort skanningen från historiken? (Raden i Sheet finns kvar.)")) return;
  const index = historyIndex;
  await deleteScan(historyIds[index]).catch(() => {});
  historyIds.splice(index, 1);
  if (historyIds.length) openHistoryCard(Math.min(index, historyIds.length - 1));
  else openHistory();
});

// Svep åt sidan på kortet för att bläddra.
let touch = null;
$("card").addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY };
}, { passive: true });
$("card").addEventListener("touchend", (e) => {
  if (!touch || historyIndex < 0) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) stepHistory(dx < 0 ? 1 : -1);
}, { passive: true });

$("btn-copy-debug").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("r-debug-pre").textContent);
    $("btn-copy-debug").textContent = "✓ Kopierat";
  } catch {
    $("btn-copy-debug").textContent = "Markera texten och kopiera";
  }
});

// ---------- annonsläge: fota (max 8 bilder per annons, AI:n tittar på högst 3) ----------
const GROUP_PHOTOS = 8;
let groupPhotos = []; // första = huvudbild
let editingGroup = null; // gruppen som redigeras från listan, annars null (ny annons)
let stream = null;

async function startCamera() {
  const msg = $("c-cam-msg");
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.hidden = false;
    msg.textContent = "Kameran i appen stöds inte här – använd 📷 eller 🖼 nedan.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
    // Vyn kan ha lämnats medan telefonen frågade om lov.
    if ($("view-capture").hidden) return stopCamera();
    $("c-video").srcObject = stream;
    msg.hidden = true;
  } catch (err) {
    stream = null;
    msg.hidden = false;
    msg.textContent = `Kameran gick inte att starta (${err.name === "NotAllowedError" ? "ingen behörighet" : err.message}) – använd 📷 eller 🖼 nedan.`;
  }
}

function stopCamera() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
  $("c-video").srcObject = null;
}

async function renderCapture() {
  const n = groupPhotos.length;
  $("c-photos").replaceChildren(
    ...Array.from({ length: GROUP_PHOTOS }, (_, i) => {
      const slot = Object.assign(document.createElement("div"), { className: "c-slot" });
      if (i < n) {
        const del = Object.assign(document.createElement("button"), { type: "button", textContent: "×", ariaLabel: "Ta bort bild" });
        del.addEventListener("click", () => {
          groupPhotos.splice(i, 1);
          renderCapture();
        });
        slot.append(Object.assign(document.createElement("img"), { src: groupPhotos[i], alt: "" }), del);
        if (i === 0) slot.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "Huvudbild" }));
      } else {
        slot.textContent = i === 0 ? "Huvudbild" : `Bild ${i + 1}`;
      }
      return slot;
    }),
  );
  const full = n >= GROUP_PHOTOS;
  $("c-shutter").disabled = full;
  $("c-next").disabled = n === 0;
  $("c-next").textContent = editingGroup ? "Spara ändringar" : "Nästa annons →";
  $("c-title").textContent = editingGroup ? "Ändra annons" : "Fota annonser";
  const count = (await allGroups().catch(() => [])).length;
  const number = editingGroup ? editingGroup.number : count + 1;
  $("c-count").textContent = `Annons ${number} · ${n}/${GROUP_PHOTOS} bilder`;
  $("c-list").textContent = count ? `Visa lista (${count})` : "Visa lista";
}

function addGroupPhoto(dataUrl) {
  if (groupPhotos.length >= GROUP_PHOTOS) return;
  groupPhotos.push(dataUrl);
  $("c-hint").textContent = "";
  renderCapture();
}

let captureFrom = "home"; // vart tillbaka-pilen leder från fotovyn

async function openCapture(group = null, from = currentView === "groups" ? "groups" : "home") {
  captureFrom = from;
  editingGroup = group;
  groupPhotos = group ? [...group.photos] : [];
  $("c-note").value = group?.note ?? "";
  $("c-hint").textContent = "";
  show("capture");
  renderCapture();
  startCamera();
}

$("c-shutter").addEventListener("click", () => {
  const video = $("c-video");
  if (!stream || !video.videoWidth) return;
  addGroupPhoto(toJpeg(video, video.videoWidth, video.videoHeight));
});

for (const id of ["c-gallery", "c-native"]) {
  $(id).addEventListener("change", async (e) => {
    const files = [...(e.target.files ?? [])].slice(0, GROUP_PHOTOS - groupPhotos.length);
    e.target.value = "";
    $("c-next").disabled = true;
    for (const [i, file] of files.entries()) {
      $("c-hint").textContent = files.length > 1 ? `Förbereder bild ${i + 1} av ${files.length}…` : "Förbereder bild…";
      try {
        addGroupPhoto(await compress(file));
      } catch (err) {
        $("c-hint").textContent = `⚠️ ${err.message}`;
      }
      await nextFrame();
    }
    if ($("c-hint").textContent.startsWith("Förbereder")) $("c-hint").textContent = "";
    renderCapture();
  });
}

// Nästa: bilderna och anteckningen blir en annons, och nästa börjar tomt.
$("c-next").addEventListener("click", async () => {
  if (!groupPhotos.length) return;
  // version ökar vid varje ändring, så att en ändrad annons laddas upp på nytt.
  const group = editingGroup
    ? { ...editingGroup, photos: groupPhotos, note: $("c-note").value.trim(), upload: "ny", version: (editingGroup.version ?? 0) + 1 }
    : { id: `G${Date.now()}`, ts: Date.now(), photos: groupPhotos, note: $("c-note").value.trim(), selected: true, upload: "ny", version: 1 };
  delete group.number;
  try {
    await putGroup(group);
    askPersistent();
  } catch (err) {
    $("c-hint").textContent = `⚠️ Kunde inte spara: ${err.message}`;
    return;
  }
  runUploads();
  if (editingGroup) return openGroups();
  groupPhotos = [];
  $("c-note").value = "";
  const saved = (await allGroups().catch(() => [])).length;
  await renderCapture();
  $("c-hint").textContent = `✓ Annons ${saved} sparad – fota nästa.`;
});

$("c-list").addEventListener("click", () => {
  // Påbörjade bilder sparas inte automatiskt: fråga hellre än att tappa dem.
  if (groupPhotos.length && !editingGroup && !confirm("Bilderna för den här annonsen är inte sparade. Lämna ändå?")) return;
  openGroups();
});

// ---------- annonsläge: lista ----------
async function openGroups() {
  editingGroup = null;
  show("groups");
  renderGroups();
  renderSent();
}

async function renderGroups() {
  let groups = [];
  try {
    groups = await allGroups();
  } catch (err) {
    $("g-empty").hidden = false;
    $("g-empty").textContent = `⚠️ ${err.message}`;
    return;
  }
  const selected = groups.filter((g) => g.selected).length;
  $("g-count").textContent = groups.length ? `${selected} av ${groups.length} markerade` : "";
  $("g-empty").hidden = groups.length > 0;
  $("g-send").disabled = selected === 0;
  $("g-send").textContent = selected ? `Skicka till AI (${selected})` : "Skicka till AI";
  $("g-list").replaceChildren(
    ...groups.map((g, i) => {
      const li = Object.assign(document.createElement("li"), { className: "g-row" });
      const check = Object.assign(document.createElement("input"), { type: "checkbox", checked: g.selected, ariaLabel: "Markera" });
      check.addEventListener("change", async () => {
        await putGroup({ ...g, selected: check.checked });
        renderGroups();
      });
      const open = Object.assign(document.createElement("button"), { type: "button", className: "open" });
      const info = Object.assign(document.createElement("div"), { className: "info" });
      info.append(
        Object.assign(document.createElement("div"), { className: "name", textContent: `Annons ${i + 1} · ${g.photos.length} ${g.photos.length === 1 ? "bild" : "bilder"}` }),
        Object.assign(document.createElement("div"), { className: "line", textContent: [uploadText(g), g.note || "Ingen anteckning"].filter(Boolean).join(" · ") }),
      );
      open.append(Object.assign(document.createElement("img"), { src: g.photos[0], alt: "" }), info);
      open.addEventListener("click", () => openCapture({ ...g, number: i + 1 }));
      const del = Object.assign(document.createElement("button"), { type: "button", className: "del", textContent: "🗑", ariaLabel: "Ta bort annons" });
      del.addEventListener("click", async () => {
        if (!confirm(`Ta bort annons ${i + 1}?`)) return;
        await deleteGroup(g.id).catch(() => {});
        // Redan uppladdade bilder tas bort i Drive också.
        if (g.upload && g.upload !== "ny") listingsApi({ action: "delete", id: g.id }).catch(() => {});
        renderGroups();
      });
      li.append(check, open, del);
      return li;
    }),
  );
}

async function selectAll(selected) {
  const groups = await allGroups().catch(() => []);
  await Promise.all(groups.map((g) => putGroup({ ...g, selected })));
  renderGroups();
}

$("g-all").addEventListener("click", () => selectAll(true));
$("g-none").addEventListener("click", () => selectAll(false));
$("g-capture").addEventListener("click", () => openCapture());
// Uppladdningen sker i bakgrunden medan du fotar: varje annons laddas upp när
// du trycker Nästa. "Skicka till AI" lägger bara de uppladdade annonserna i kön.
// Avbryts något (skärmen släcks, täckningen försvinner) fortsätter det av sig
// självt nästa gång appen är öppen.
async function listingsApi(body) {
  const res = await fetch("/api/listings", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-token": getToken() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNetworkError = (err) => err instanceof TypeError || /load failed|network|failed to fetch/i.test(err?.message ?? "");

// Nätverksfel provas igen några gånger; fel från servern direkt.
async function withRetry(fn, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !isNetworkError(err)) throw err;
      await sleep(1500 * attempt);
    }
  }
}

// Håller skärmen tänd medan något laddas upp (där telefonen stöder det).
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

function uploadText(g) {
  if (g.send) return g.upload === "fel" ? "⏳ skickas när nätet är tillbaka" : "📤 skickas…";
  return { ny: "⏫ väntar på uppladdning", pågår: "⏫ laddar upp…", klar: "☁︎ uppladdad", fel: "⏳ laddas upp när nätet är tillbaka" }[g.upload] ?? "";
}

async function uploadGroup(g) {
  // En bild per anrop, så att även 8 bilder ryms.
  await withRetry(() => listingsApi({ action: "submit", id: g.id, note: g.note, settings: getSettings() }));
  for (const image of g.photos) await withRetry(() => listingsApi({ action: "image", id: g.id, image }));
  // Ändrades annonsen under tiden laddas den upp igen i nästa varv.
  const now = await getGroup(g.id);
  if (now && (now.version ?? 0) === (g.version ?? 0)) await putGroup({ ...now, upload: "klar", uploadError: "" });
}

let uploading = false;
let uploadRetry = null;
async function runUploads() {
  if (uploading || !getToken() || !navigator.onLine) return;
  uploading = true;
  clearTimeout(uploadRetry);
  try {
    for (;;) {
      const groups = await allGroups().catch(() => []);
      // Annonser som ska skickas först, sedan resten i fotoordning.
      const next =
        groups.find((g) => g.send && g.upload !== "fel") ??
        groups.find((g) => g.upload !== "klar" && g.upload !== "fel") ??
        groups.find((g) => g.upload === "fel");
      if (!next || (next.upload === "fel" && !next.retryNow)) break;
      keepAwake(true);
      try {
        if (next.upload !== "klar") {
          await putGroup({ ...next, upload: "pågår", retryNow: false });
          refreshUploads();
          await uploadGroup(next);
        } else {
          await withRetry(() => listingsApi({ action: "commit", id: next.id }));
          await deleteGroup(next.id);
          refreshUploads(true);
        }
      } catch (err) {
        const cur = await getGroup(next.id);
        if (cur) {
          // Misslyckades uppladdningen: nytt försök senare. Gick inte att lägga i kön
          // av annat skäl än nätet (t.ex. raden saknas i Sheet): ladda upp på nytt.
          const upload = cur.upload !== "klar" ? "fel" : isNetworkError(err) ? "klar" : "ny";
          await putGroup({ ...cur, upload, uploadError: err.message, retryNow: false });
        }
        // Nytt försök om en halv minut (eller när appen öppnas / nätet kommer tillbaka).
        uploadRetry = setTimeout(retryFailed, 30000);
        break;
      }
    }
  } finally {
    uploading = false;
    keepAwake(false);
    refreshUploads();
  }
}

async function retryFailed() {
  const groups = await allGroups().catch(() => []);
  await Promise.all(groups.filter((g) => g.upload === "fel").map((g) => putGroup({ ...g, retryNow: true })));
  runUploads();
}

async function refreshUploads(sent = false) {
  const groups = await allGroups().catch(() => []);
  const busy = groups.filter((g) => g.upload !== "klar").length;
  const sending = groups.filter((g) => g.send).length;
  const failed = groups.find((g) => g.uploadError);
  $("c-upload").textContent = busy ? `⏫ ${busy} ${busy === 1 ? "annons laddas" : "annonser laddas"} upp i bakgrunden` : groups.length ? "☁︎ Alla annonser uppladdade" : "";
  if (!$("view-groups").hidden) {
    renderGroups();
    if (sending) $("g-hint").textContent = `📤 Skickar ${sending} till AI… du kan fortsätta fota. Stängs appen fortsätter det nästa gång den öppnas.`;
    else if (failed) $("g-hint").textContent = `⚠️ ${failed.uploadError} – försöker igen automatiskt.`;
    else if (sent) $("g-hint").textContent = "✓ Skickade till AI. AI:n arbetar i bakgrunden – du kan stänga appen.";
    if (sent) renderSent();
  }
}

$("g-send").addEventListener("click", async () => {
  if (!getToken()) return openSettings("Ange lösenordet först.");
  const groups = (await allGroups().catch(() => [])).filter((g) => g.selected);
  if (!groups.length) return;
  await Promise.all(groups.map((g) => putGroup({ ...g, send: true, retryNow: true })));
  await refreshUploads();
  runUploads();
});

// Fortsätt där det slutade när appen öppnas igen eller nätet kommer tillbaka.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") retryFailed();
});
window.addEventListener("online", retryFailed);

// ---------- annonsläge: skickade och granskning ----------
const STATUS_PILL = { "Laddar upp": "wait", Väntar: "wait", Bearbetas: "wait", Klar: "done", Godkänd: "ok", Exporterad: "ok", Fel: "err" };
let sentListings = [];
let sentTimer = null;
// Klara annonser är markerade för "Godkänn markerade" tills du avmarkerar dem.
const approveSkip = new Set();

async function renderSent() {
  clearTimeout(sentTimer);
  try {
    // Annonser som fortfarande laddas upp visas i listan ovanför.
    sentListings = ((await listingsApi({ action: "list" })).listings ?? []).filter((l) => l.status !== "Laddar upp");
  } catch (err) {
    $("g-sent-hint").textContent = `⚠️ Kunde inte hämta skickade annonser: ${err.message}`;
    return;
  }
  const working = sentListings.filter((l) => l.status === "Väntar" || l.status === "Bearbetas").length;
  // Exporterade läggs i en egen hopfälld lista längst ner, så att de inte stör.
  const active = sentListings.filter((l) => l.status !== "Exporterad");
  const done = sentListings.filter((l) => l.status === "Exporterad");
  $("g-sent-hint").textContent = !sentListings.length
    ? "Inga skickade annonser ännu."
    : working
      ? `AI:n arbetar med ${working} ${working === 1 ? "annons" : "annonser"} – du kan stänga appen.`
      : active.length
        ? "Tryck på en annons för att granska den."
        : "Alla annonser är exporterade.";
  $("g-sent").replaceChildren(...active.map(sentRow));
  $("g-exported").hidden = !done.length;
  $("g-exported-count").textContent = done.length;
  $("g-exported-list").replaceChildren(...done.map(sentRow));
  renderApproveBar();
  const approved = sentListings.filter((l) => l.status === "Godkänd" && (l.channel || "Tradera") === "Tradera").length;
  $("g-export").hidden = !approved && !done.length;
  $("g-export-all-label").hidden = !done.length;
  $("g-export").textContent = approved ? `📄 Exportera till ProLister (${approved})` : "📄 Exportera till ProLister";
  // Uppdatera av sig själv medan AI:n arbetar och listan visas.
  if (working && !$("view-groups").hidden) sentTimer = setTimeout(renderSent, 15000);
}

function sentRow(l) {
  const li = Object.assign(document.createElement("li"), { className: "g-row" });
  const open = Object.assign(document.createElement("button"), { type: "button", className: "open" });
  const info = Object.assign(document.createElement("div"), { className: "info" });
  info.append(
    Object.assign(document.createElement("div"), { className: "name", textContent: l.title || l.note || "Annons" }),
    Object.assign(document.createElement("div"), {
      className: "line",
      textContent: [l.price ? kr(l.price) : "", l.channel, l.confirmed ? `nr ${l.confirmed} ✓` : "", l.status === "Fel" ? l.error : ""]
        .filter(Boolean)
        .join(" · ") || (l.note ? `Anteckning: ${l.note}` : ""),
    }),
  );
  open.append(Object.assign(document.createElement("img"), { src: l.image_urls?.[0] ?? "", alt: "" }), info);
  const pill = Object.assign(document.createElement("span"), { className: `pill status ${STATUS_PILL[l.status] ?? "wait"}`, textContent: l.status });
  if (["Klar", "Godkänd", "Exporterad", "Fel"].includes(l.status)) open.addEventListener("click", () => openReview(l.id));
  if (l.status === "Klar") {
    const check = Object.assign(document.createElement("input"), { type: "checkbox", checked: !approveSkip.has(l.id), ariaLabel: "Markera för godkännande" });
    check.addEventListener("change", () => {
      if (check.checked) approveSkip.delete(l.id);
      else approveSkip.add(l.id);
      renderApproveBar();
    });
    li.append(check);
  }
  li.append(open, pill);
  return li;
}

// ---------- godkänn flera på en gång ----------
const readyListings = () => sentListings.filter((l) => l.status === "Klar");
const markedListings = () => readyListings().filter((l) => !approveSkip.has(l.id));

function renderApproveBar() {
  const ready = readyListings().length;
  const marked = markedListings().length;
  $("g-approve-tools").hidden = ready < 2;
  $("g-approve").hidden = ready === 0;
  $("g-approve").disabled = marked === 0;
  $("g-approve").textContent = `✓ Godkänn markerade (${marked})`;
}

$("g-approve-all").addEventListener("click", () => {
  for (const l of readyListings()) approveSkip.delete(l.id);
  renderSent();
});
$("g-approve-none").addEventListener("click", () => {
  for (const l of readyListings()) approveSkip.add(l.id);
  renderSent();
});

// Godkänner med det modellnummer du bekräftat, annars det AI:n valt.
// Rätta de annonser som har fel modell först (öppna dem och tryck på rätt nummer).
$("g-approve").addEventListener("click", async () => {
  const items = markedListings().map((l) => ({ id: l.id, confirmed: l.confirmed || l.listing?.article?.number || "" }));
  if (!items.length) return;
  if (!confirm(`Godkänn ${items.length} ${items.length === 1 ? "annons" : "annonser"}? Modellnumret AI:n valt räknas som bekräftat – öppna och rätta dem som är fel först.`)) return;
  const btn = $("g-approve");
  btn.disabled = true;
  $("g-approve-hint").textContent = `Godkänner ${items.length}…`;
  try {
    try {
      await listingsApi({ action: "approve", items });
    } catch (err) {
      // Äldre Apps Script utan approveListings: en i taget.
      if (!/okänd action/i.test(err.message)) throw err;
      for (const [i, item] of items.entries()) {
        $("g-approve-hint").textContent = `Godkänner ${i + 1} av ${items.length}…`;
        await listingsApi({ action: "update", id: item.id, fields: { status: "Godkänd", confirmed: item.confirmed } });
      }
    }
    $("g-approve-hint").textContent = `✓ ${items.length} godkända och tillagda i Lager.`;
  } catch (err) {
    $("g-approve-hint").textContent = `⚠️ ${err.message} – försök igen.`;
  }
  renderSent();
});

let reviewing = null; // annonsen som granskas
let reviewChannel = "Tradera";
let reviewConfirmed = "";

function openReview(id) {
  const l = sentListings.find((x) => x.id === id);
  if (!l) return;
  reviewing = l;
  const data = l.listing ?? {};
  $("v-status").textContent = l.status;
  $("v-images").replaceChildren(
    ...l.image_urls.map((url, i) => {
      const slot = Object.assign(document.createElement("div"), { className: "c-slot" });
      slot.append(Object.assign(document.createElement("img"), { src: url, alt: "" }));
      if (i === 0) slot.append(Object.assign(document.createElement("span"), { className: "tag", textContent: "Huvudbild" }));
      return slot;
    }),
  );
  $("v-note").textContent = l.note ? `Din anteckning: ${l.note}` : "";
  reviewConfirmed = l.confirmed || "";
  renderCandidates();
  $("v-title").value = l.title || "";
  $("v-desc").value = l.description || "";
  $("v-price").value = l.price || "";
  $("v-title-count").textContent = `${$("v-title").value.length}/80`;
  const fs = data.for_sale;
  $("v-price-basis").textContent = data.price
    ? `Förslag ${kr(data.price)} (${data.list_basis})${fs?.count ? ` · ${fs.count} till salu ${kr(fs.low)}–${kr(fs.high)}` : ""}${data.retail ? ` · nypris ${kr(data.retail.low)}–${kr(data.retail.high)}` : ""}`
    : "";
  reviewChannel = l.channel || data.channel || "Tradera";
  for (const c of $("v-channel").querySelectorAll(".chip")) c.classList.toggle("on", c.dataset.channel === reviewChannel);
  $("v-flags").replaceChildren(
    ...[...(l.status === "Fel" ? [l.error] : []), ...(data.fixes ?? []), ...(data.flags ?? [])].map((f) =>
      Object.assign(document.createElement("li"), { textContent: f }),
    ),
  );
  const sources = data.sources ?? [];
  $("v-sources-title").hidden = !sources.length;
  $("v-sources").replaceChildren(
    ...sources.map((s) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: s.url, target: "_blank", rel: "noopener" });
      const title = document.createElement("span");
      title.append(Object.assign(document.createElement("span"), { className: "tag", textContent: s.platform }), s.title || s.url);
      a.append(title, Object.assign(document.createElement("span"), { textContent: `${kr(s.price_sek)}${s.sold ? " · såld" : ""}` }));
      li.append(a);
      return li;
    }),
  );
  const failed = l.status === "Fel";
  $("v-retry").hidden = !failed;
  $("v-approve").hidden = failed;
  $("v-approve").textContent = l.status === "Godkänd" ? "✓ Godkänd – spara igen" : "Godkänn";
  $("v-hint").textContent = "";
  show("review");
}

// Modellnummer: inget räknas som bekräftat förrän du trycker.
function renderCandidates() {
  const data = reviewing.listing ?? {};
  const used = data.article?.number ?? "";
  const list = [...(data.candidates ?? [])];
  if (reviewConfirmed && !list.some((c) => c.number === reviewConfirmed)) list.unshift({ number: reviewConfirmed, source: "ditt val" });
  $("v-candidates").replaceChildren(
    ...list.map((c) => {
      const chip = Object.assign(document.createElement("button"), { type: "button", className: `chip${c.number === reviewConfirmed ? " on" : ""}` });
      chip.append(`${c.number === reviewConfirmed ? "✓ " : ""}${c.number}`, Object.assign(document.createElement("small"), { textContent: ` ${c.name || c.source || ""}` }));
      chip.addEventListener("click", () => chooseNumber(c.number));
      return chip;
    }),
  );
  $("v-cand-hint").textContent = !list.length
    ? "Inget modellnummer hittades."
    : reviewConfirmed
      ? `Bekräftat: ${reviewConfirmed}.`
      : `Texten använder ${used || "inget nummer"} – tryck på rätt nummer, eller godkänn utan om det är ett tillbehör eller parti.`;
}

async function chooseNumber(number) {
  const used = reviewing.listing?.article?.number ?? "";
  if (number === used || number === reviewConfirmed) {
    reviewConfirmed = number;
    renderCandidates();
    return;
  }
  // Annat nummer än texten bygger på: hämta data, priser och text på nytt.
  if (!confirm(`Hämta priser och skriv om annonsen för ${number}?`)) return;
  try {
    await listingsApi({ action: "requeue", id: reviewing.id, confirmed: number });
    openGroups();
  } catch (err) {
    $("v-cand-hint").textContent = `⚠️ ${err.message}`;
  }
}

$("v-other-use").addEventListener("click", () => {
  const n = $("v-other").value.trim();
  if (n) chooseNumber(n);
});
$("v-title").addEventListener("input", () => ($("v-title-count").textContent = `${$("v-title").value.length}/80`));
$("v-channel").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  reviewChannel = chip.dataset.channel;
  for (const c of $("v-channel").querySelectorAll(".chip")) c.classList.toggle("on", c === chip);
});

async function saveReview(status) {
  const hasCandidates = (reviewing.listing?.candidates ?? []).length > 0;
  // Tillbehör och partier har inget modellnummer: fråga, men tvinga inte.
  if (status === "Godkänd" && hasCandidates && !reviewConfirmed && !confirm("Godkänn utan modellnummer? (T.ex. tillbehör eller parti.)")) {
    $("v-hint").textContent = "Tryck på rätt modellnummer, eller godkänn utan.";
    return;
  }
  const fields = {
    title: $("v-title").value,
    description: $("v-desc").value,
    price: $("v-price").value,
    channel: reviewChannel,
    confirmed: reviewConfirmed,
    ...(status ? { status } : {}),
  };
  $("v-hint").textContent = "Sparar…";
  try {
    await listingsApi({ action: "update", id: reviewing.id, fields });
    Object.assign(reviewing, fields, status ? { status } : {});
    $("v-hint").textContent = status === "Godkänd" ? "✓ Godkänd och tillagd i Lager." : "✓ Sparat.";
    if (status) openGroups();
  } catch (err) {
    $("v-hint").textContent = `⚠️ ${err.message}`;
  }
}

$("v-approve").addEventListener("click", () => saveReview("Godkänd"));
$("v-save").addEventListener("click", () => saveReview(""));
$("v-retry").addEventListener("click", async () => {
  try {
    await listingsApi({ action: "requeue", id: reviewing.id, confirmed: reviewing.confirmed || "" });
    openGroups();
  } catch (err) {
    $("v-hint").textContent = `⚠️ ${err.message}`;
  }
});
$("v-delete").addEventListener("click", async () => {
  if (!confirm("Ta bort annonsen och dess bilder i Drive?")) return;
  try {
    await listingsApi({ action: "delete", id: reviewing.id });
    openGroups();
  } catch (err) {
    $("v-hint").textContent = `⚠️ ${err.message}`;
  }
});
$("g-refresh").addEventListener("click", renderSent);

// ---------- export till ProLister ----------
let exportFile = null;
$("g-export").addEventListener("click", async () => {
  const btn = $("g-export");
  btn.disabled = true;
  $("g-export-hint").textContent = "Skapar filen…";
  $("g-export-links").hidden = true;
  $("g-export-skipped").replaceChildren();
  try {
    const res = await fetch("/api/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({ action: "export", include_exported: $("g-export-all").checked, settings: getSettings() }),
    });
    const data = await res.json().catch(() => ({}));
    showSkipped(data.skipped);
    if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
    exportFile = new File([data.csv], data.name, { type: "text/csv" });
    $("g-export-hint").textContent = `✓ ${data.count} ${data.count === 1 ? "annons" : "annonser"} i ${data.name}. Filen ligger i Drive under Loppisskannern/Export – importera den i ProLister.`;
    $("g-export-links").hidden = false;
    $("g-export-drive").hidden = !data.url;
    if (data.url) $("g-export-drive").href = data.url;
    renderSent();
  } catch (err) {
    $("g-export-hint").textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function showSkipped(skipped = []) {
  $("g-export-skipped").replaceChildren(
    ...skipped.map((s) => Object.assign(document.createElement("li"), { textContent: `Togs inte med: ${s.title || s.id} – ${s.reason}` })),
  );
}

// Dela-menyn på iPhone: spara i Filer, AirDrop till datorn, mejla …
$("g-export-save").addEventListener("click", async () => {
  if (!exportFile) return;
  try {
    if (navigator.canShare?.({ files: [exportFile] })) return await navigator.share({ files: [exportFile] });
  } catch (err) {
    if (err.name === "AbortError") return;
  }
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(exportFile), download: exportFile.name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

// Kopiera rubrik och text (t.ex. till Vinted, som saknar import).
$("v-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`${$("v-title").value}\n\n${$("v-desc").value}`);
    $("v-hint").textContent = "✓ Kopierat.";
  } catch {
    $("v-hint").textContent = "Markera texten och kopiera.";
  }
});

// ---------- inställningar ----------
let viewBeforeSettings = "home";

function numberInput(value) {
  return Object.assign(document.createElement("input"), {
    type: "number", inputMode: "decimal", min: 0, step: "any", value,
  });
}

function modelOptions(selected, extra = []) {
  return [...MODEL_OPTIONS, ...extra].map(([value, label]) =>
    Object.assign(document.createElement("option"), { value, textContent: label, selected: value === selected }),
  );
}

function openSettings(message = "") {
  const visible = views.find((v) => !$(`view-${v}`).hidden);
  if (visible && visible !== "settings") viewBeforeSettings = visible;
  $("s-token").value = getToken();
  const s = getSettings();
  $("s-fees").replaceChildren(
    ...Object.entries(s.platforms).map(([name, p]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${name}</td>`;
      for (const key of ["fee_percent", "fee_fixed", "shipping"]) {
        const td = document.createElement("td");
        const input = numberInput(p[key]);
        input.dataset.platform = name;
        input.dataset.key = key;
        td.append(input);
        tr.append(td);
      }
      return tr;
    }),
  );
  $("s-fx").replaceChildren(
    ...Object.entries(s.fx).map(([cur, rate]) => {
      const label = document.createElement("label");
      label.textContent = cur;
      const input = numberInput(rate);
      input.dataset.fx = cur;
      label.append(input);
      return label;
    }),
  );
  $("s-model-id").replaceChildren(...modelOptions(s.models.identify));
  $("s-model-search").replaceChildren(
    ...modelOptions(s.models.search, [["gemini", "Gemini + Google-sökning"]]),
  );
  $("s-rules").replaceChildren(
    ...RULE_FIELDS.map(([key, text]) => {
      const label = Object.assign(document.createElement("label"), { className: "field" });
      const input = numberInput(s.decision[key]);
      input.dataset.rule = key;
      label.append(Object.assign(document.createElement("span"), { textContent: text }), input);
      return label;
    }),
    (() => {
      const label = Object.assign(document.createElement("label"), { className: "field" });
      const input = Object.assign(document.createElement("input"), { type: "text", value: s.decision.small_brands.join(", "), id: "s-small-brands" });
      label.append(Object.assign(document.createElement("span"), { textContent: "Småfigurer: märken (kommaseparerade)" }), input);
      return label;
    })(),
  );
  $("s-closing").value = s.listing.closing;
  $("s-google-limit").value = s.budget.google_limit || "";
  $("s-google-spent").value = s.budget.google_spent || "";
  $("s-google-at").textContent = s.budget.google_spent_at
    ? `Senast avläst ${new Date(s.budget.google_spent_at).toLocaleString("sv-SE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. Ändrar du "förbrukat" räknas tiden från nu.`
    : "";
  $("s-schleich-category").value = s.listing.schleich_category;
  $("s-schleich-condition").value = s.listing.schleich_condition ?? s.listing.schleich_attributes?.replace(/^\s*\d+\s*:\s*/, "") ?? "";
  $("s-schleich-shipping").value = s.listing.schleich_shipping;
  $("s-vision").checked = s.vision;
  $("s-gemini").checked = s.gemini;
  $("s-mode").value = s.mode;
  $("s-lens").checked = s.lens;
  $("s-tradera").checked = s.tradera;
  const month = store.get("costs", {})[new Date().toISOString().slice(0, 7)];
  $("s-costs").textContent = month
    ? `Den här månaden (denna telefon): ${month.scans} skanningar, ${month.sek.toFixed(2).replace(".", ",")} kr. Exakt kostnad per skanning loggas i Sheet.`
    : "";
  $("s-test").textContent = message;
  show("settings");
}

$("btn-settings").addEventListener("click", () => openSettings());
// ---------- startsidan och tillbaka-pilen ----------
function openHome() {
  leaveHistoryCard();
  show("home");
  renderHome();
}

// Tillbaka går ett steg upp: granskning → annonser, kort i historiken → historik,
// resultat → skanna, inställningar → där du var, allt annat → startsidan.
function goBack() {
  if (currentView === "capture" && groupPhotos.length && !editingGroup && !confirm("Bilderna för den här annonsen är inte sparade. Lämna ändå?")) return;
  if (currentView === "review") return openGroups();
  if (currentView === "result") return historyIndex >= 0 ? openHistory() : show("scan");
  if (currentView === "capture") return captureFrom === "groups" ? openGroups() : openHome();
  if (currentView === "settings" && viewBeforeSettings !== "home") return show(viewBeforeSettings);
  openHome();
}

$("btn-back").addEventListener("click", goBack);
const TAB_OPEN = { home: openHome, scan: resetScan, capture: () => openCapture(null, "home"), groups: openGroups, history: openHistory };
for (const b of document.querySelectorAll("#tabbar .tab")) {
  b.addEventListener("click", () => {
    if (currentView === "capture" && groupPhotos.length && !editingGroup && !confirm("Bilderna för den här annonsen är inte sparade. Lämna ändå?")) return;
    TAB_OPEN[b.dataset.tab]();
  });
}
$("h-go-scan").addEventListener("click", resetScan);
$("h-go-capture").addEventListener("click", () => openCapture(null, "home"));
$("h-go-groups").addEventListener("click", openGroups);
$("h-go-history").addEventListener("click", openHistory);
$("h-go-lego").addEventListener("click", openLego);
$("h-go-seller").addEventListener("click", openSeller);
$("h-go-market").addEventListener("click", openMarket);
$("h-go-lots").addEventListener("click", openLots);
$("h-go-settings").addEventListener("click", () => openSettings());

const sek = (n) => `${n.toFixed(2).replace(".", ",")} kr`;
function meter(id, share) {
  const bar = $(id);
  const p = Math.max(0, Math.min(1, share));
  bar.style.width = `${Math.round(p * 100)}%`;
  bar.className = p <= 0.05 ? "empty" : p <= 0.2 ? "low" : "";
}

// Siffrorna på startsidan: Lens live från SerpApi, Google Cloud från din
// avläsning + appens räkning sedan dess, och antal exporterade annonser.
async function renderHome() {
  const groups = await allGroups().catch(() => []);
  $("h-capture-note").textContent = groups.length
    ? `${groups.length} ${groups.length === 1 ? "annons" : "annonser"} i telefonen, inte skickade`
    : "Fota det du ska sälja";
  if (!getToken()) return;
  const budget = getSettings().budget;
  let data;
  try {
    const res = await fetch("/api/home", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({ since: budget.google_spent_at }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
    $("h-status").textContent = "";
  } catch (err) {
    $("h-status").textContent = `⚠️ Kunde inte hämta siffrorna: ${err.message}`;
    return;
  }

  const lens = data.lens;
  if (lens?.left != null) {
    const total = lens.per_month ?? 250;
    $("m-lens").textContent = `${lens.left} kvar av ${total}`;
    meter("m-lens-bar", lens.left / total);
    $("m-lens-note").textContent = lens.used != null ? `${lens.used} använda denna period` : "";
  } else {
    $("m-lens").textContent = "–";
    $("m-lens-note").textContent = lens?.error ? `⚠️ ${lens.error}` : "SerpApi är inte inställt";
  }

  if (budget.google_limit > 0 && data.usage && !data.usage.error) {
    const spent = (Number(budget.google_spent) || 0) + (data.usage.sek_since ?? 0);
    const left = budget.google_limit - spent;
    $("m-google").textContent = `${sek(Math.max(0, left))} kvar av ${sek(budget.google_limit)}`;
    meter("m-google-bar", left / budget.google_limit);
    const at = budget.google_spent_at ? new Date(budget.google_spent_at).toLocaleDateString("sv-SE", { day: "numeric", month: "short" }) : "";
    $("m-google-note").textContent = at
      ? `${sek(spent)} förbrukat · avläst ${at} + ${sek(data.usage.sek_since ?? 0)} sedan dess`
      : `${sek(spent)} förbrukat enligt appen · stäm av under ⚙︎ → Budget`;
  } else {
    $("m-google").textContent = "–";
    $("m-google-note").textContent = data.usage?.error ? `⚠️ ${data.usage.error}` : "Ställ in saldot under ⚙︎ → Budget";
  }

  const l = data.listings;
  $("m-exported").textContent = l ? String(l.exported) : "–";
  $("h-groups-note").textContent = l
    ? [l.ready ? `${l.ready} att granska` : "", l.approved ? `${l.approved} godkända att exportera` : ""].filter(Boolean).join(" · ") || "Skicka, granska och exportera"
    : "Skicka, granska och exportera";
}

$("btn-settings-save").addEventListener("click", () => {
  store.set("token", $("s-token").value.trim());
  const s = getSettings();
  for (const input of $("s-fees").querySelectorAll("input")) {
    s.platforms[input.dataset.platform][input.dataset.key] = Number(input.value) || 0;
  }
  for (const input of $("s-fx").querySelectorAll("input")) s.fx[input.dataset.fx] = Number(input.value) || 0;
  s.models = { identify: $("s-model-id").value, search: $("s-model-search").value };
  s.vision = $("s-vision").checked;
  s.gemini = $("s-gemini").checked;
  s.mode = $("s-mode").value;
  s.lens = $("s-lens").checked;
  s.tradera = $("s-tradera").checked;
  for (const input of $("s-rules").querySelectorAll("input[data-rule]")) {
    const n = Number(input.value);
    if (input.value !== "" && Number.isFinite(n) && n >= 0) s.decision[input.dataset.rule] = n;
  }
  s.listing.closing = $("s-closing").value.trim();
  const limit = Number($("s-google-limit").value);
  const spent = Number($("s-google-spent").value);
  if (Number.isFinite(limit) && limit >= 0) s.budget.google_limit = limit;
  // Ny avläsning: appen räknar bara med det som körts efter den här tidpunkten.
  if (Number.isFinite(spent) && spent >= 0 && (spent !== s.budget.google_spent || !s.budget.google_spent_at)) {
    s.budget.google_spent = spent;
    s.budget.google_spent_at = new Date().toISOString();
  }
  s.listing.schleich_category = $("s-schleich-category").value.trim();
  s.listing.schleich_condition = $("s-schleich-condition").value.trim();
  delete s.listing.schleich_attributes;
  s.listing.schleich_shipping = $("s-schleich-shipping").value.replace(/\s+/g, "");
  s.decision.small_brands = $("s-small-brands").value.split(",").map((b) => b.trim()).filter(Boolean);
  store.set("settings", s);
  $("s-test").textContent = "Sparat.";
});

$("btn-test").addEventListener("click", async () => {
  const token = $("s-token").value.trim();
  $("s-test").textContent = "Testar…";
  try {
    const res = await fetch("/api/ping?check=1", { headers: { "x-app-token": token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
    store.set("token", token);
    const label = (id) => data.models[id] ?? id;
    const c = data.checks;
    const line = (name, check, configured) =>
      c ? `${check.ok ? "✓" : "✗"} ${name}: ${check.detail}` : `${configured ? "✓" : "–"} ${name}: ${configured ? "konfigurerat" : "inte konfigurerat"}`;
    $("s-test").textContent = [
      "✓ Lösenordet stämmer.",
      line("Claude", c?.claude, data.api_key),
      line(`Gemini (${data.gemini_model})`, c?.gemini, data.gemini),
      line("Google Lens (SerpApi)", c?.lens, data.lens),
      line("Tradera", c?.tradera, data.tradera),
      line("Bildsök (Cloud Vision)", c?.vision, data.vision),
      line("Google Sheet", c?.sheet, data.storage),
      `Standard: identifiering ${label(data.defaults.identify)}, prissök ${label(data.defaults.search)}.` +
        (data.mock ? " (testläge)" : ""),
    ].join("\n");
  } catch (err) {
    $("s-test").textContent = `✗ ${err.message}`;
  }
});

// ---------- Lego i bulk ----------
// Kilopris från sålda Tradera-partier. Senaste hämtningen sparas i telefonen och
// visas direkt; ny hämtning när den är äldre än 12 timmar eller när du ber om det.
let lego = store.get("lego", null);
let legoPeriod = "d90";
let legoShown = 50;
const kgText = (kg) => `${String(kg).replace(".", ",")} kg`;

async function legoApi(body) {
  const res = await fetch("/api/lego", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-token": getToken() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

function openLego() {
  show("lego");
  renderLego();
  if (!lego || Date.now() - Date.parse(lego.fetched_at) > 12 * 60 * 60 * 1000) fetchLego();
}

async function fetchLego() {
  $("l-status").textContent = "Hämtar sålda partier från Tradera…";
  $("l-refresh").disabled = true;
  try {
    lego = await legoApi({ action: "stats" });
    store.set("lego", lego);
    renderLego();
  } catch (err) {
    $("l-status").textContent = `⚠️ Kunde inte hämta: ${err.message}`;
  } finally {
    $("l-refresh").disabled = false;
  }
}

const spread = (s) => (s?.n ? `${s.p25}–${s.p75} kr/kg · ${s.n} partier` : "för få partier");

function renderLego() {
  for (const b of document.querySelectorAll("#l-period .chip")) b.classList.toggle("on", b.dataset.period === legoPeriod);
  if (!lego) return;
  const p = lego.stats[legoPeriod];
  const when = new Date(lego.fetched_at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  $("l-status").textContent = `Kilopris från sålda auktioner på Tradera (med bud). Hämtat ${when}.`;
  $("l-plain").textContent = p.plain.n ? `${p.plain.median} kr/kg` : "–";
  $("l-plain-note").textContent = spread(p.plain);
  $("l-figs").textContent = p.figs.n ? `${p.figs.median} kr/kg` : "–";
  $("l-figs-note").textContent = spread(p.figs);
  $("l-sizes").replaceChildren(
    ...Object.entries(p.sizes).map(([name, s]) => {
      const tr = document.createElement("tr");
      for (const text of [name, s.n ? `${s.median} kr/kg` : "–", s.n ? `${s.p25}–${s.p75}` : "", String(s.n)]) tr.append(Object.assign(document.createElement("td"), { textContent: text }));
      return tr;
    }),
  );
  const ex = Object.entries(lego.excluded ?? {}).map(([why, n]) => `${n} ${why}`).join(", ");
  $("l-info").textContent =
    `${lego.used} sålda partier används (sedan ${String(lego.oldest).slice(0, 10)}). ` +
    `${lego.unsold} avslutades utan bud och räknas inte` +
    (ex ? `. Bortsorterade: ${ex}.` : ".") +
    " Tryck på ett parti för att se det på Tradera.";
  const since = { d30: 30, d90: 90 }[legoPeriod];
  const list = lego.lots.filter((l) => !since || Date.now() - Date.parse(l.end) <= since * 86400000);
  $("l-lots").replaceChildren(
    ...list.slice(0, legoShown).map((l) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: l.url, target: "_blank", rel: "noopener" });
      const t = Object.assign(document.createElement("div"), { className: "t" });
      t.append(
        Object.assign(document.createElement("b"), { textContent: l.title }),
        Object.assign(document.createElement("small"), {
          textContent: `${String(l.end).slice(0, 10)} · ${l.bids} bud · ${kgText(l.kg)}${l.figs ? " · figurer/tema" : ""}`,
        }),
      );
      const k = Object.assign(document.createElement("div"), { className: "k", textContent: `${l.kr_per_kg} kr/kg` });
      k.append(Object.assign(document.createElement("small"), { textContent: kr(l.price) }));
      a.append(t, k);
      li.append(a);
      return li;
    }),
  );
  $("l-more").hidden = list.length <= legoShown;
  calcLego();
}

// Räknaren använder kilopriset för partier utan figurer i samma storlek (minst 8
// partier), annars alla utan figurer – för vald period.
let calcSeq = 0;
async function calcLego() {
  const weight = Number($("l-weight").value.replace(",", "."));
  const price = Number($("l-price").value) || 0;
  if (!lego || !(weight > 0)) {
    $("l-result").hidden = true;
    $("l-basis").textContent = lego ? "Skriv in vikten för att räkna." : "";
    return;
  }
  const p = lego.stats[legoPeriod];
  // Samma gränser som SIZES i lib/lego.js.
  const size = weight < 3 ? "1–3 kg" : weight < 10 ? "3–10 kg" : "10 kg+";
  const bySize = p.sizes[size];
  const basis = bySize?.n >= 8 ? { s: bySize, text: `partier ${size} utan figurer` } : { s: p.plain, text: "alla partier utan figurer" };
  if (!basis.s.n) {
    $("l-result").hidden = true;
    $("l-basis").textContent = "För få sålda partier för att räkna.";
    return;
  }
  const seq = ++calcSeq;
  try {
    const r = await legoApi({ action: "calc", weight, price, kr_per_kg: basis.s.median, settings: getSettings() });
    if (seq !== calcSeq) return;
    const d = r.decision;
    $("l-result").hidden = false;
    $("l-result").className = `decision ${d.color}`;
    $("l-verdict").textContent = d.verdict;
    $("l-numbers").textContent =
      `Värt ca ${kr(r.sale)} (${r.kr_per_kg} kr/kg × ${kgText(r.kg)}), netto ${kr(r.net)} efter avgift` +
      (d.known ? ` · vinst ${kr(d.profit)}` : "");
    $("l-basis").textContent =
      `Räknat på median för ${basis.text} (${basis.s.n} st, spann ${basis.s.p25}–${basis.s.p75} kr/kg). ` +
      "Köparen betalar frakten. Figurer du sorterar ut är en extra vinst ovanpå.";
  } catch (err) {
    if (seq === calcSeq) $("l-basis").textContent = `⚠️ ${err.message}`;
  }
}

$("l-refresh").addEventListener("click", fetchLego);
$("l-weight").addEventListener("input", calcLego);
$("l-price").addEventListener("input", calcLego);
$("l-more").addEventListener("click", () => {
  legoShown += 50;
  renderLego();
});
for (const b of document.querySelectorAll("#l-period .chip")) {
  b.addEventListener("click", () => {
    legoPeriod = b.dataset.period;
    legoShown = 50;
    renderLego();
  });
}

// ---------- Fynd: Schleich-partier ----------
// Aktiva partier jämförda med vad partier sålts för per figur. Senaste
// hämtningen sparas i telefonen; ny hämtning när den är äldre än 3 timmar.
const LOTS_VERSION = 6; // samma som lib/lots.js – äldre sparade listor hämtas om
const lotsStale = (d) => !d || d.version !== LOTS_VERSION || Date.now() - Date.parse(d.fetched_at) > 3 * 60 * 60 * 1000;
let lotsNiche = store.get("lots_niche", "djur");
let lotsData = store.get(`lots_${lotsNiche}`, null);
let lotsFilter = "deals";

function openLots() {
  show("lots");
  renderLots();
  if (lotsStale(lotsData)) fetchLots();
}

async function fetchLots() {
  const niche = lotsNiche;
  $("f-status").textContent = "Söker igenom annonser och hämtar frakten för partierna… (20–60 sekunder)";
  $("f-refresh").disabled = true;
  try {
    const res = await fetch("/api/marketdata", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({ action: "lots", niche, settings: getSettings() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
    store.set(`lots_${niche}`, data);
    if (niche !== lotsNiche) return; // bytte nisch under tiden
    lotsData = data;
    renderLots();
  } catch (err) {
    $("f-status").textContent = `⚠️ ${err.message}`;
  } finally {
    $("f-refresh").disabled = false;
  }
}

const perFig = (s) => (s?.n ? `${s.median} kr/figur` : "–");
const spreadFig = (s) => (s?.n ? `${s.p25}–${s.p75} kr · ${s.n} partier` : "för få sålda partier");
const MIN_SINGLES = 10; // samma gräns som lib/lots.js

const GROUP_LABELS = { hästar: "Hästar", blandat: "Övriga djur", smurfar: "Smurfar" };
const COLOR_TEXT = { green: "Köp", yellow: "Tveksamt", red: "Låt bli" };

function lotMetric(d, g) {
  const s = d.singles?.[g];
  const lot = d.benchmark?.[g];
  const m = Object.assign(document.createElement("div"), { className: `metric${(d.groups ?? []).length === 1 ? " wide" : ""}` });
  if (s?.n >= MIN_SINGLES) {
    m.append(
      Object.assign(document.createElement("span"), { className: "metric-label", textContent: `${GROUP_LABELS[g] ?? g}, sålda styckvis` }),
      Object.assign(document.createElement("span"), { className: "metric-value big-number", textContent: `${s.median} kr` }),
      Object.assign(document.createElement("span"), {
        className: "metric-note",
        textContent: `${s.p25}–${s.p75} kr · ${s.n} sålda · netto ${s.net} kr efter avgift${s.sell_through != null ? ` · säljgrad ${s.sell_through} %` : ""}` + (lot?.n ? ` · partier går för ${lot.median} kr/figur` : ""),
      }),
    );
  } else {
    m.append(
      Object.assign(document.createElement("span"), { className: "metric-label", textContent: `${GROUP_LABELS[g] ?? g}, sålda partier` }),
      Object.assign(document.createElement("span"), { className: "metric-value big-number", textContent: perFig(lot) }),
      Object.assign(document.createElement("span"), { className: "metric-note", textContent: `${spreadFig(lot)} · för lite styckförsäljning i Marknad (${s?.n ?? 0} sålda)` }),
    );
  }
  return m;
}

function renderLots() {
  for (const b of document.querySelectorAll("#f-filter .chip")) b.classList.toggle("on", b.dataset.filter === lotsFilter);
  for (const b of document.querySelectorAll("#f-niche .chip")) b.classList.toggle("on", b.dataset.niche === lotsNiche);
  if (currentView === "lots") $("top-title").textContent = `Fynd: ${lotsNiche === "smurfar" ? "Smurfar" : "Schleich-djur"}`;
  if (!lotsData) {
    $("f-metrics").replaceChildren();
    $("f-list").replaceChildren();
    $("f-info").textContent = "";
    return;
  }
  const d = lotsData;
  const when = new Date(d.fetched_at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  $("f-status").textContent =
    `Värdet bygger på vad enskilda figurer sålts för hos de säljare du bevakar (fliken Marknad), minus Traderas avgift. ` +
    `Betala högst = dina köpregler för småfigurer (grön vid ${String(d.rules?.small_green ?? 2).replace(".", ",")}×). Hämtat ${when}.`;
  $("f-metrics").replaceChildren(...(d.groups ?? ["hästar", "blandat"]).map((g) => lotMetric(d, g)));
  // Köp nu-fynd: grönt enligt köpreglerna, med känd frakt. Auktioner: under
  // budtaket först, sedan de som slutar först.
  const list =
    lotsFilter === "deals"
      ? d.deals.filter((l) => l.deal).sort((a, b) => (b.buy_now_ok ? b.buy_now_multiple : b.multiple ?? 0) - (a.buy_now_ok ? a.buy_now_multiple : a.multiple ?? 0))
      : lotsFilter === "auctions"
        ? d.deals.filter((l) => l.price_kind === "bud").sort((a, b) => Number(b.under_max) - Number(a.under_max) || String(a.end).localeCompare(String(b.end)))
        : d.deals;
  const under = d.deals.filter((l) => l.under_max).length;
  $("f-auction-count").textContent = under ? `(${under})` : "";
  const shipText = (l) =>
    (l.buyer_fee ? ` + köparskydd ${kr(l.buyer_fee)}` : "") + (l.shipping != null ? ` + frakt ${kr(l.shipping)}` : l.pickup_only ? " · bara avhämtning" : " · frakt okänd");
  // Antal från rubriken, eller räknat på bilderna (värderas på det lägsta).
  const countText = (l) => {
    const e = l.count_estimate;
    if (!e) return `${l.count} figurer`;
    const span = e.min === e.max ? `${e.min}` : `${e.min}–${e.max}`;
    return `≈ ${span} figurer (räknat på bilderna${e.confidence === "low" ? ", osäkert" : ""}, värderat på ${l.count})`;
  };
  const valueText = (l) =>
    l.basis === "styckvis" ? ` · värt ca ${kr(l.value)} netto styckvis (${l.per_figure_value} kr/figur)` : l.value ? ` · värt ca ${kr(l.value)} som parti` : "";
  $("f-list").replaceChildren(
    ...list.map((l) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: l.url, target: "_blank", rel: "noopener" });
      const img = Object.assign(document.createElement("img"), { alt: "", loading: "lazy" });
      img.addEventListener("error", () => (img.style.visibility = "hidden"));
      if (l.thumbnail) img.src = l.thumbnail;
      else img.style.visibility = "hidden";
      const auction = l.price_kind === "bud";
      const t = Object.assign(document.createElement("div"), { className: "t" });
      t.append(
        Object.assign(document.createElement("b"), { textContent: l.title }),
        Object.assign(document.createElement("small"), {
          textContent: auction
            ? `${countText(l)} · ${l.bids ? `bud nu ${kr(l.price)} (${l.bids} bud)` : `utrop ${kr(l.price)} (inga bud)`}${shipText(l)}${valueText(l)}` +
              (l.max_bid != null ? ` · bjud högst ${kr(l.max_bid)}` : "") +
              (l.buy_now ? ` · köp nu ${kr(l.buy_now)}${l.buy_now_total != null ? ` (${l.buy_now_ok ? "under gränsen – köp direkt" : "för dyrt"})` : ""}` : "") +
              ` · slutar ${new Date(l.end).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}`
            : `${countText(l)} · köp nu ${kr(l.price)}${shipText(l)}${l.shipping != null ? ` = ${kr(l.total)}` : ""}${valueText(l)}` +
              (l.pay_max != null ? ` · betala högst ${kr(l.pay_max)} inkl. frakt` : "") +
              ` · slutar ${String(l.end).slice(0, 10)}`,
        }),
      );
      let k;
      if (auction && lotsFilter === "deals" && l.buy_now_ok) {
        // Köp nu-priset på en auktion är under gränsen: visa det som ett Köp nu-fynd.
        k = Object.assign(document.createElement("div"), { className: "k good", textContent: l.buy_now_multiple != null ? `${String(l.buy_now_multiple).replace(".", ",")}×` : "köp nu" });
        k.append(Object.assign(document.createElement("small"), { textContent: `köp nu ${kr(l.buy_now)}` }));
      } else if (auction) {
        k = Object.assign(document.createElement("div"), { className: `k${l.under_max ? " good" : ""}`, textContent: l.max_bid != null ? `max ${kr(l.max_bid)}` : "–" });
        k.append(
          Object.assign(document.createElement("small"), {
            textContent: l.max_bid != null ? (l.under_max ? "under gränsen" : "över gränsen") : l.shipping == null ? "frakt okänd" : "värde saknas",
          }),
        );
      } else if (l.basis === "styckvis") {
        k = Object.assign(document.createElement("div"), { className: `k${l.color === "green" ? " good" : ""}`, textContent: l.multiple != null ? `${String(l.multiple).replace(".", ",")}×` : "–" });
        k.append(Object.assign(document.createElement("small"), { textContent: COLOR_TEXT[l.color] ?? "" }));
      } else {
        k = Object.assign(document.createElement("div"), { className: `k${l.deal ? " good" : ""}`, textContent: `${l.per_figure} kr/fig` });
        k.append(Object.assign(document.createElement("small"), { textContent: `${Math.round(l.share * 100)} %` }));
      }
      a.append(img, t, k);
      li.append(a);
      return li;
    }),
  );
  $("f-info").textContent =
    `${list.length ? "" : lotsFilter === "deals" ? "Inga Köp nu-fynd just nu. " : lotsFilter === "auctions" ? "Inga auktioner med antal just nu. " : ""}` +
    `${d.scanned} annonser från ${d.queries?.length ?? 1} partisökningar: ${d.lots} partier, varav ${d.active_lots} aktiva. ` +
    (d.truncated?.length ? `⚠️ För många träffar, alla hämtades inte: ${d.truncated.join(", ")}. ` : "") +
    (d.market_source === "ark" ? "Styckpriserna kommer från arket – databasen svarade inte. " : "") +
    (d.image_counted ? `${d.image_counted} partier utan antal i rubriken är räknade på bilderna (≈). ` : "") +
    (d.count_pending ? `${d.count_pending} väntar på bildräkning – hämta igen om en stund. ` : "") +
    (d.without_count - (d.count_pending ?? 0) > 0 ? `${d.without_count - (d.count_pending ?? 0)} aktiva partier saknar antal och gick inte att räkna – de visas inte. ` : "") +
    "Pris inkl. billigaste frakt (fraktsätt för 0 kr räknas inte) och Traderas köparskydd (2 kr + 5 % av priset, max 499 kr). Värdet antar att alla figurer i partiet säljs till medianpriset – säljgraden visar hur stor andel som brukar säljas. " +
    "Tryck på ett parti för att öppna det på Tradera.";
}

$("f-refresh").addEventListener("click", fetchLots);
$("f-check").addEventListener("click", async () => {
  const link = $("f-check-link").value.trim();
  if (!link) return;
  const out = $("f-check-out");
  out.textContent = "Kontrollerar annonsen och alla partisökningar… (upp till en halv minut)";
  try {
    const res = await fetch("/api/marketdata", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({ action: "lots_check", link }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok || !r.ok) throw new Error(r.error || `Fel ${res.status}`);
    const hits = r.found.filter((f) => f.page);
    out.textContent = [
      `"${r.title}"`,
      `Nisch: ${r.niche ?? "ingen"} · antal: ${r.count ?? "okänt"} · frakt: ${r.shipping.shipping != null ? kr(r.shipping.shipping) : "okänd"}${r.ended ? " · avslutad" : ""}`,
      r.is_lot ? "✓ Filtren godkänner partiet." : `✗ Filtren: ${r.reasons.join("; ")}.`,
      hits.length ? `✓ Hittas av: ${hits.map((f) => `${f.query} (sida ${f.page})`).join(", ")}.` : "✗ Ingen av partisökningarna hittar annonsen.",
      `Sökningar utan träff: ${r.found.filter((f) => !f.page).map((f) => `${f.query}${f.pages > 10 ? " – för många sidor" : ""}`).join(", ") || "inga"}.`,
    ].join("\n");
  } catch (err) {
    out.textContent = `⚠️ ${err.message}`;
  }
});
for (const b of document.querySelectorAll("#f-niche .chip")) {
  b.addEventListener("click", () => {
    lotsNiche = b.dataset.niche;
    store.set("lots_niche", lotsNiche);
    lotsData = store.get(`lots_${lotsNiche}`, null);
    renderLots();
    if (lotsStale(lotsData)) fetchLots();
  });
}
for (const b of document.querySelectorAll("#f-filter .chip")) {
  b.addEventListener("click", () => {
    lotsFilter = b.dataset.filter;
    renderLots();
  });
}

// ---------- Marknadsdata ----------
// Bevakade säljare samlas in varje natt (Apps Script-timer → /api/marketdata).
let marketSellers = [];
let marketNiche = store.get("market_niche", "djur");
let marketFound = store.get(`market_found_${marketNiche}`, null);
// Insamlingen körs i bakgrunden på servern. Appen visar bara status (fliken
// Körningar) och uppdaterar listan var 5:e sekund medan den pågår.
let marketRun = null;
let marketPoll = null;

async function marketApi(body) {
  const res = await fetch("/api/marketdata", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-app-token": getToken() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
  return data;
}

function openMarket() {
  show("market");
  renderFound();
  loadMarketSellers();
  loadDbStatus();
  loadSweepStatus();
  loadSuggestions();
}

// Förslag på konkurrenter: mest sålt Schleich enligt databasen.
const MIX_LABELS = { djur: "djur", smurfar: "smurfar", övrigt: "övrigt" };
let suggestions = null;
async function loadSuggestions() {
  $("m-suggest-status").textContent = suggestions ? "" : "Hämtar…";
  try {
    suggestions = (await marketApi({ action: "competitors", limit: 40 })).sellers ?? [];
    renderSuggestions();
  } catch (err) {
    $("m-suggest-status").textContent = `⚠️ ${err.message}`;
  }
}

function renderSuggestions() {
  if (!suggestions) return;
  const watchedIds = new Set(marketSellers.filter((s) => s.watched).map((s) => String(s.id)));
  const fresh = suggestions.filter((s) => !s.watched && !watchedIds.has(String(s.id))).length;
  $("m-suggest-status").textContent = suggestions.length ? `${suggestions.length} säljare med minst 10 Schleich-annonser – ${fresh} bevakas inte.` : "Inga säljare i databasen än – kör Hämta all Schleich nu.";
  $("m-suggest").replaceChildren(
    ...suggestions.map((s) => {
      const li = Object.assign(document.createElement("li"), { className: "m-row" });
      const t = Object.assign(document.createElement("div"), { className: "t" });
      const mix = (s.mix ?? []).map((m) => `${SERIES_LABELS[m.key] ?? MIX_LABELS[m.key] ?? m.key}\u00a0${m.share}\u00a0%`).join(", ");
      t.append(
        Object.assign(document.createElement("b"), { textContent: s.alias || `Säljare ${s.id}` }),
        Object.assign(document.createElement("small"), {
          textContent:
            `${s.sold} sålda${s.sold_90d ? ` (${s.sold_90d} senaste 90 dagarna)` : ""} av ${s.listings} annonser · ${s.active} aktiva` +
            (s.sell_through != null ? ` · säljgrad ${s.sell_through}\u00a0%` : "") +
            (s.median_sold ? ` · median ${kr(s.median_sold)}` : "") +
            (mix ? ` · mest ${mix}` : ""),
        }),
      );
      const on = s.watched || watchedIds.has(String(s.id));
      const niche = s.mix?.find((m) => m.key === "smurfar" || m.key === "djur")?.key ?? "djur";
      li.append(
        t,
        on
          ? Object.assign(document.createElement("span"), { className: "chip on", textContent: "✓ Bevakas" })
          : smallBtn("Bevaka", "chip", () => watchSeller({ id: s.id, alias: s.alias, total: s.listings, active: s.active, ended: (s.sold ?? 0) + (s.unsold ?? 0), niche }, true)),
      );
      return li;
    }),
  );
}
$("m-suggest-refresh").addEventListener("click", loadSuggestions);

// Schleich-insamlingen (hela Tradera): status, uppdateras medan den pågår.
let sweepPoll = null;
async function loadSweepStatus() {
  clearTimeout(sweepPoll);
  try {
    const { sweep: st } = await marketApi({ action: "sweep_status" });
    const when = (iso) => (iso ? new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "");
    $("m-sweep").disabled = Boolean(st?.running);
    $("m-sweep-status").textContent = !st
      ? "Har inte körts än."
      : st.running
        ? `⏳ Hämtar sedan ${when(st.started)} – det tar någon minut. Du kan stänga appen.`
        : st.status === "Klar"
          ? `✓ ${when(st.last)}: ${st.listings} annonser – ${st.summary}`
          : `⚠️ ${st.status} (${when(st.last)})`;
    if (st?.running && !$("view-market").hidden) sweepPoll = setTimeout(loadSweepStatus, 5000);
    else if (st?.status === "Klar") loadDbStatus();
  } catch (err) {
    $("m-sweep-status").textContent = `⚠️ ${err.message}`;
  }
}

$("m-sweep").addEventListener("click", async () => {
  $("m-sweep-status").textContent = "Startar…";
  try {
    await marketApi({ action: "sweep" });
  } catch (err) {
    $("m-sweep-status").textContent = `⚠️ ${err.message}`;
    return;
  }
  await loadSweepStatus();
});

// Databasen (D1): antal annonser och sålda per nisch.
async function loadDbStatus() {
  try {
    const { db } = await marketApi({ action: "db_status" });
    const niches = (db.niches ?? []).filter((n) => n.niche).map((n) => `${n.niche} ${n.listings} (${n.sold} sålda)`).join(", ");
    $("m-db-status").textContent =
      `${db.listings} annonser, varav ${db.sold} sålda${niches ? ` – ${niches}` : ""} · ${db.sellers} säljare · ${db.price_points} prispunkter` +
      (db.last_seen ? ` · senast uppdaterad ${new Date(db.last_seen).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })}` : "");
  } catch (err) {
    $("m-db-status").textContent = `⚠️ ${err.message}`;
  }
}

$("m-db-copy").addEventListener("click", async () => {
  const btn = $("m-db-copy");
  btn.disabled = true;
  try {
    let offset = 0;
    for (;;) {
      $("m-db-status").textContent = `Kopierar… ${offset} annonser klara`;
      const r = await marketApi({ action: "db_copy", offset });
      offset = r.next;
      if (r.done) {
        $("m-db-status").textContent = `✓ ${r.total} annonser kopierade.`;
        break;
      }
    }
    await loadDbStatus();
  } catch (err) {
    $("m-db-status").textContent = `⚠️ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

async function loadMarketSellers() {
  if (!marketSellers.length) $("m-status").textContent = "Hämtar…";
  try {
    const data = await marketApi({ action: "status" });
    marketSellers = data.sellers ?? [];
    marketRun = data.run ?? null;
    renderRun();
    renderWatched();
    renderFound();
    renderSuggestions();
  } catch (err) {
    $("m-status").textContent = `⚠️ ${err.message}`;
  }
  // Uppdatera av sig själv medan en insamling pågår och vyn visas.
  clearTimeout(marketPoll);
  if (marketRun?.running && !$("view-market").hidden) marketPoll = setTimeout(loadMarketSellers, 5000);
}

const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : "");

function renderRun() {
  const r = marketRun;
  $("m-collect-all").disabled = Boolean(r?.running);
  if (!marketSellers.some((s) => s.watched)) return ($("m-status").textContent = "Inga bevakade säljare ännu. Lägg till med alias eller via Hitta konkurrenter.");
  if (r?.running) return ($("m-status").textContent = `⏳ Insamling pågår i bakgrunden – ${r.done} klara${r.left ? `, ${r.left} kvar` : ""}. Du kan stänga appen.`);
  if (r?.status === "Klar") return ($("m-status").textContent = `✓ Senaste insamlingen klar ${hhmm(r.last)}.`);
  if (r?.status === "Avbruten") return ($("m-status").textContent = `⚠️ Senaste insamlingen stannade ${hhmm(r.last)}. Tryck Samla alla för att fortsätta.`);
  $("m-status").textContent = "";
}

const smallBtn = (text, cls, onClick) => {
  const b = Object.assign(document.createElement("button"), { type: "button", className: cls, textContent: text });
  b.addEventListener("click", onClick);
  return b;
};

function renderWatched() {
  const watched = marketSellers.filter((s) => s.watched);
  $("m-watched").replaceChildren(
    ...watched.map((s) => {
      const li = Object.assign(document.createElement("li"), { className: "m-row" });
      const t = Object.assign(document.createElement("div"), { className: "t" });
      const when = s.collected ? new Date(s.collected).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "inte ännu";
      t.append(
        Object.assign(document.createElement("b"), { textContent: s.alias }),
        Object.assign(document.createElement("small"), {
          textContent: `${s.in_db} annonser i databasen (${s.sold_in_db} sålda) · insamlad ${when}${s.niches?.length ? ` · ${s.niches.map((n) => NICHE_LABELS[n] ?? n).join(", ")}` : ""}`,
        }),
      );
      // Insamlad under pågående körning = klar; annars väntar den på sin tur.
      const fresh = marketRun?.started && s.collected >= marketRun.started;
      if (marketRun?.running) t.append(Object.assign(document.createElement("small"), { className: "result", textContent: fresh ? "✓ Insamlad nu" : "Väntar på sin tur…" }));
      if (s.error) t.append(Object.assign(document.createElement("small"), { className: "result err", textContent: `⚠️ ${s.error}` }));
      const acts = Object.assign(document.createElement("div"), { className: "acts" });
      const busy = Boolean(marketRun?.running);
      const collectBtn = smallBtn(busy ? "Pågår…" : "Samla nu", "chip", () => collectNow(s));
      collectBtn.disabled = busy;
      acts.append(collectBtn, smallBtn("✕", "chip", () => watchSeller(s, false)));
      li.append(t, acts);
      return li;
    }),
  );
}

const NICHE_LABELS = { djur: "Schleich-djur", smurfar: "Smurfar" };

function renderFound() {
  for (const b of document.querySelectorAll("#m-niche .chip")) b.classList.toggle("on", b.dataset.niche === marketNiche);
  if (!marketFound) {
    $("m-discover-status").textContent = "";
    $("m-found").replaceChildren();
    return;
  }
  const watchedIds = new Set(marketSellers.filter((s) => s.watched).map((s) => String(s.id)));
  $("m-discover-status").textContent = `${marketFound.sellers.length} säljare med minst 15 annonser (av ${marketFound.sellers_found} säljare och ${marketFound.scanned} annonser).`;
  $("m-found").replaceChildren(
    ...marketFound.sellers.map((s) => {
      const li = Object.assign(document.createElement("li"), { className: "m-row" });
      const t = Object.assign(document.createElement("div"), { className: "t" });
      t.append(
        Object.assign(document.createElement("b"), { textContent: s.alias }),
        Object.assign(document.createElement("small"), {
          textContent: `${s.total} annonser (${s.active} aktiva, ${s.ended} avslutade) · ${s.number_share} % nummer i rubriken${s.rating ? ` · betyg ${String(s.rating).replace(".", ",")}` : ""}`,
        }),
      );
      const on = watchedIds.has(String(s.id));
      li.append(t, on ? Object.assign(document.createElement("span"), { className: "chip on", textContent: "✓ Bevakas" }) : smallBtn("Bevaka", "chip", () => watchSeller(s, true)));
      return li;
    }),
  );
}

async function watchSeller(s, watch) {
  if (!watch && !confirm(`Sluta bevaka ${s.alias}? Annonserna som redan samlats in ligger kvar i Sheet.`)) return;
  $("m-status").textContent = watch ? `Lägger till ${s.alias}…` : `Tar bort ${s.alias}…`;
  try {
    const res = await marketApi({ action: "watch", seller: { id: s.id, alias: s.alias, total: s.total, active: s.active, ended: s.ended, number_share: s.number_share, rating: s.rating, niche: s.niche }, watch });
    await loadMarketSellers();
    // Första insamlingen direkt, så att databasen inte står tom till i natt.
    if (watch) await collectNow(res.seller ?? s);
  } catch (err) {
    $("m-status").textContent = `⚠️ ${err.message}`;
  }
}

// Startar insamling i bakgrunden: en säljare (Samla nu) eller alla (Samla alla).
// Servern svarar direkt; listan uppdateras medan den pågår.
async function startCollect(only = null) {
  $("m-status").textContent = "Startar insamling…";
  try {
    const res = await marketApi({ action: "collect_all", ...(only ? { only } : {}) });
    if (res.running) $("m-status").textContent = "En insamling pågår redan – vänta tills den är klar.";
  } catch (err) {
    $("m-status").textContent = `⚠️ ${err.message}`;
    return;
  }
  await loadMarketSellers();
}

const collectNow = (s) => startCollect([String(s.id)]);

$("m-refresh").addEventListener("click", loadMarketSellers);
for (const b of document.querySelectorAll("#m-niche .chip")) {
  b.addEventListener("click", () => {
    marketNiche = b.dataset.niche;
    store.set("market_niche", marketNiche);
    marketFound = store.get(`market_found_${marketNiche}`, null);
    renderFound();
  });
}
$("m-collect-all").addEventListener("click", () => startCollect());
$("m-add").addEventListener("click", () => {
  const alias = $("m-alias").value.trim();
  if (alias) watchSeller({ alias }, true).then(() => ($("m-alias").value = ""));
});
$("m-discover").addEventListener("click", async () => {
  $("m-discover").disabled = true;
  $("m-discover-status").textContent = "Söker igenom Schleich-annonser på Tradera… (10–30 sekunder)";
  try {
    const niche = marketNiche;
    const found = await marketApi({ action: "discover", niche });
    store.set(`market_found_${niche}`, found);
    if (niche === marketNiche) marketFound = found;
    renderFound();
  } catch (err) {
    $("m-discover-status").textContent = `⚠️ ${err.message}`;
  } finally {
    $("m-discover").disabled = false;
  }
});

// ---------- Konkurrent ----------
// En säljares annonser per modellnummer. Senaste hämtningen sparas i telefonen.
let seller = store.get("seller", null);
let sellerSort = "sold";
let sellerShown = 40;
const sellerOpen = new Set();

function openSeller() {
  show("seller");
  $("k-alias").value = seller?.alias ?? store.get("seller_alias", "");
  renderSeller();
}

async function fetchSeller() {
  const alias = $("k-alias").value.trim();
  if (!alias) return ($("k-status").textContent = "Skriv säljarens alias (namnet som syns på Tradera).");
  store.set("seller_alias", alias);
  $("k-status").textContent = "Hämtar säljarens annonser från Tradera…";
  $("k-fetch").disabled = true;
  try {
    const res = await fetch("/api/seller", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({ alias }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Fel ${res.status}`);
    seller = data;
    store.set("seller", data);
    sellerOpen.clear();
    sellerShown = 40;
    renderSeller();
  } catch (err) {
    $("k-status").textContent = `⚠️ ${err.message}`;
  } finally {
    $("k-fetch").disabled = false;
  }
}

const SELLER_SORT = {
  sold: (a, b) => b.sold - a.sold || (b.median_sold ?? 0) - (a.median_sold ?? 0),
  price: (a, b) => (b.median_sold ?? -1) - (a.median_sold ?? -1),
  rate: (a, b) => (b.ended >= 3) - (a.ended >= 3) || (b.sell_through ?? -1) - (a.sell_through ?? -1) || b.sold - a.sold,
  fast: (a, b) => (a.days_to_sell ?? 9999) - (b.days_to_sell ?? 9999) || b.sold - a.sold,
};

function renderSeller() {
  for (const b of document.querySelectorAll("#k-sort .chip")) b.classList.toggle("on", b.dataset.sort === sellerSort);
  $("k-body").hidden = !seller;
  if (!seller) return;
  const s = seller;
  const when = new Date(s.fetched_at).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
  $("k-status").textContent =
    `${s.alias}: ${s.total} annonser (${s.active} aktiva, ${s.ended} avslutade), äldsta slutdatum ${String(s.oldest).slice(0, 10)}. ` +
    `Modellnummer i ${s.with_number} av ${s.total}` +
    (s.number_from_text ? ` (${s.number_from_text} ur annonstexten)` : "") +
    (s.number_ambiguous ? `, ${s.number_ambiguous} osäkra (flera nummer i texten)` : "") +
    (s.with_description != null ? `. Annonstext för ${s.with_description} av ${s.total}` : "") +
    (s.detail?.fetched ? ` (${s.detail.fetched} hämtade en och en${s.detail.errors ? `, ${s.detail.errors} fel` : ""})` : "") +
    `. Hämtat ${when}.`;
  $("k-sold").textContent = String(s.sold);
  $("k-sold-note").textContent = s.sell_through != null ? `${s.sell_through} % av de avslutade såldes` : "";
  $("k-median").textContent = s.median_sold ? kr(s.median_sold) : "–";
  $("k-median-note").textContent = s.days_to_sell != null ? `median ${s.days_to_sell} dagar till försäljning` : "";
  $("k-prices").replaceChildren(
    ...s.prices.map((p) => Object.assign(document.createElement("span"), { className: "chip", textContent: `${kr(p.price)} × ${p.count}` })),
  );
  const q = $("k-filter").value.trim().toLowerCase();
  const models = s.models.filter((m) => !q || m.number.includes(q) || m.title.toLowerCase().includes(q)).sort(SELLER_SORT[sellerSort]);
  $("k-models").replaceChildren(
    ...models.slice(0, sellerShown).map((m) => {
      const li = document.createElement("li");
      const row = Object.assign(document.createElement("button"), { type: "button", className: "row" });
      const t = Object.assign(document.createElement("div"), { className: "t" });
      t.append(
        Object.assign(document.createElement("b"), {
          textContent: `${m.number} · ${m.title.replace(m.number, "").replace(/^schleich\s+/i, "").replace(/\s+/g, " ").trim()}`,
        }),
        Object.assign(document.createElement("small"), {
          textContent:
            `${m.sold} sålda av ${m.ended} avslutade${m.sell_through != null ? ` (${m.sell_through} %)` : ""}` +
            (m.days_to_sell != null ? ` · ${m.days_to_sell} d` : "") +
            (m.active ? ` · ${m.active} aktiva à ${kr(m.active_price)}` : ""),
        }),
      );
      const k = Object.assign(document.createElement("div"), { className: "k", textContent: m.median_sold ? kr(m.median_sold) : "–" });
      k.append(Object.assign(document.createElement("small"), { textContent: m.low != null && m.high !== m.low ? `${m.low}–${m.high}` : "" }));
      row.append(t, k);
      row.addEventListener("click", () => {
        if (sellerOpen.has(m.number)) sellerOpen.delete(m.number);
        else sellerOpen.add(m.number);
        renderSeller();
      });
      li.append(row);
      if (sellerOpen.has(m.number)) {
        const sub = Object.assign(document.createElement("ul"), { className: "sub" });
        for (const i of s.items.filter((x) => x.number === m.number)) {
          const a = Object.assign(document.createElement("a"), { href: i.url, target: "_blank", rel: "noopener" });
          const it = Object.assign(document.createElement("div"), { className: "t" });
          it.append(
            Object.assign(document.createElement("b"), { textContent: i.title }),
            Object.assign(document.createElement("small"), {
              textContent: `${i.sold ? "såld" : i.ended ? "ej såld" : "aktiv"} · ${i.type}${i.bids ? ` · ${i.bids} bud` : ""} · ${String(i.end).slice(0, 10)}`,
            }),
          );
          a.append(it, Object.assign(document.createElement("div"), { className: "k", textContent: i.price ? kr(i.price) : "–" }));
          const subLi = document.createElement("li");
          subLi.append(a);
          sub.append(subLi);
        }
        li.append(sub);
      }
      return li;
    }),
  );
  $("k-more").hidden = models.length <= sellerShown;
  const types = Object.entries(s.types).map(([t, n]) => `${n} ${t}`).join(", ");
  $("k-info").textContent =
    `${s.models.length} modellnummer. ${s.total - s.with_number} annonser saknar nummer och visas inte i listan. ` +
    (s.with_description != null ? `Annonstext fanns för ${s.with_description} av ${s.total}. ` : "") +
    `Typer: ${types}. Äldsta: ${String(s.oldest).slice(0, 10)}.` +
    (s.with_status < s.total ? ` Status saknades för ${s.total - s.with_status} annonser – där räknas bud eller minskat antal som sålt.` : "");
}

$("k-fetch").addEventListener("click", fetchSeller);
$("k-alias").addEventListener("keydown", (e) => e.key === "Enter" && fetchSeller());
$("k-filter").addEventListener("input", () => {
  sellerShown = 40;
  renderSeller();
});
$("k-more").addEventListener("click", () => {
  sellerShown += 40;
  renderSeller();
});
for (const b of document.querySelectorAll("#k-sort .chip")) {
  b.addEventListener("click", () => {
    sellerSort = b.dataset.sort;
    renderSeller();
  });
}

// Test: söker avslutade "lego kg"-partier på Tradera och visar vad som går att få ut.
$("btn-test-lego").addEventListener("click", async () => {
  const out = $("s-test-lego");
  out.textContent = "Söker på Tradera…";
  try {
    const res = await fetch("/api/ping?probe=lego", { headers: { "x-app-token": $("s-token").value.trim() } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
    const variant = (v) =>
      v.error
        ? `✗ ${v.name}: ${v.error}`
        : `${v.ended ? "✓" : "–"} ${v.name}: ${v.count} träffar (totalt ${v.total}), ${v.ended} avslutade, ${v.sold} med bud, ${v.with_kg} med vikt` +
          (v.median_kr_per_kg ? `, median ${v.median_kr_per_kg} kr/kg (${v.priced} st)` : "") +
          (v.errors?.length ? ` · fel: ${JSON.stringify(v.errors).slice(0, 120)}` : "");
    const lot = (l) =>
      `• ${l.title.slice(0, 60)} – ${l.price ? kr(l.price) : "inget pris"}, ${l.bids} bud, ${l.kg ? `${String(l.kg).replace(".", ",")} kg` : "vikt?"}` +
      (l.kr_per_kg ? ` = ${l.kr_per_kg} kr/kg` : "") +
      ` (${String(l.end).slice(0, 10)}${l.sold ? ", såld" : ""})`;
    const fields = data.variants.find((v) => v.fields?.length)?.fields ?? [];
    out.textContent = [
      `Sökning: "${data.query}"`,
      ...data.variants.map(variant),
      data.sample.length ? `\nAvslutade (${data.best}):` : "\nInga avslutade annonser hittades.",
      ...data.sample.map(lot),
      fields.length ? `\nFält: ${fields.join(", ")}` : "",
    ].join("\n");
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (!getToken()) openSettings("Välkommen! Ange ditt lösenord (APP_TOKEN) och tryck Spara.");
else {
  openHome();
  retryFailed();
}

// ---------- Drift: körningar, anrop och databasen ----------
const RUN_INFO = {
  marknad: { label: "Nattlig säljarinsamling", every: 26 },
  schleich: { label: "All Schleich på Tradera", every: 26 },
  detaljer: { label: "Annonsdetaljer (beskrivning m.m.)", every: 26 },
};
// Gränser per dygn (Tradera per metod, D1 gratisnivå). Övriga visas som antal.
const USAGE_INFO = [
  { api: "tradera_search", label: "Tradera – sökningar", limit: 10000 },
  { api: "tradera_item", label: "Tradera – annonsdetaljer", limit: 10000 },
  { api: "tradera_seller", label: "Tradera – säljarnas annonser", limit: 10000 },
  { api: "d1_rows", label: "Databasen – skrivna rader", limit: 100000 },
  { api: "gemini", label: "Gemini (AI)" },
  { api: "serpapi", label: "Google Lens (SerpApi)" },
  { api: "vision", label: "Google Vision" },
  { api: "claude", label: "Claude (AI)" },
  { api: "notis_telegram", label: "Notiser via Telegram" },
  { api: "notis_ntfy", label: "Notiser via ntfy (reserv)" },
  { api: "fel_notis", label: "Notiser som inte gick fram", bad: true },
  { api: "fel_bevakning", label: "Fel i bevakningen", bad: true },
];
const SERIES_LABELS = {
  bayala: "Bayala", eldrador: "Eldrador", wizarding_world: "Harry Potter", riddare: "Riddartiden", vilda_vastern: "Vilda Västern",
  peanuts: "Snobben", star_wars: "Star Wars", smurfar: "Smurfar", horse_club: "Horse Club", wild_life: "Wild Life", farm_world: "Farm World", dinosaurs: "Dinosaurs",
};
const nf = (n) => Number(n ?? 0).toLocaleString("sv-SE");
const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return min < 1 ? "nyss" : min < 60 ? `${min} min sedan` : min < 48 * 60 ? `${Math.round(min / 60)} h sedan` : `${Math.round(min / 1440)} dagar sedan`;
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "–");
const duration = (a, b) => {
  if (!a || !b) return "";
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

// Hälsokontroller: ok / warn / bad med en mening var.
function opsHealth(d) {
  const out = [];
  const w = d.watcher;
  if (!w) out.push(["bad", "Bevakningen svarar inte."]);
  else if (w.paused) out.push(["warn", "Bevakningen är pausad."]);
  else if (!w.stats?.last_poll || Date.now() - Date.parse(w.stats.last_poll) > 3 * 60000) out.push(["bad", `Bevakningen har inte sökt sedan ${w.stats?.last_poll ? ago(w.stats.last_poll) : "start"}.`]);
  else out.push(["ok", `Bevakningen söker – senast ${ago(w.stats.last_poll)}.`]);
  if (w?.last_error && Date.now() - Date.parse(w.last_error.at) < 6 * 3600000) out.push(["warn", `Fel i bevakningen ${ago(w.last_error.at)}: ${w.last_error.message}`]);
  if (w && !w.telegram?.linked) out.push(["warn", "Telegram är inte kopplat – notiserna går via ntfy."]);
  else if (w?.telegram?.error) out.push(["warn", `Telegram: ${w.telegram.error}`]);
  for (const [name, info] of Object.entries(RUN_INFO)) {
    const last = d.runs?.[name]?.[0];
    if (!last) out.push(["warn", `${info.label}: ingen körning registrerad än.`]);
    else if (last.status === "Pågår" && Date.now() - Date.parse(last.started_at) > 30 * 60000) out.push(["bad", `${info.label} har stannat (startade ${ago(last.started_at)}).`]);
    else if (/^Fel/.test(last.status ?? "")) out.push(["bad", `${info.label}: ${last.status}`]);
    else if (Date.now() - Date.parse(last.started_at) > info.every * 3600000) out.push(["bad", `${info.label} har inte körts sedan ${ago(last.started_at)}.`]);
    else if (/fel/.test(last.status ?? "")) out.push(["warn", `${info.label}: ${last.status}`]);
    else out.push(["ok", `${info.label}: ${last.status === "Pågår" ? "pågår" : `klar ${ago(last.finished_at ?? last.started_at)}`}.`]);
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const u of USAGE_INFO.filter((x) => x.limit)) {
    const n = d.usage?.find((r) => r.day === today && r.api === u.api)?.count ?? 0;
    if (n > u.limit * 0.8) out.push([n >= u.limit ? "bad" : "warn", `${u.label}: ${nf(n)} av ${nf(u.limit)} i dag.`]);
  }
  if (d.db?.unresolved > 1000) out.push(["warn", `${nf(d.db.unresolved)} avslutade Köp nu-annonser väntar på utfall.`]);
  return out;
}

// Stapeldiagram (en serie): tunna staplar med rundade toppar, 2 px mellanrum,
// baslinje, högsta värdet som skala. Tryck/hovra på en stapel visar värdet.
function barChart(points, { unit = "" } = {}) {
  const wrap = Object.assign(document.createElement("div"), { className: "bars" });
  if (!points.length) {
    wrap.append(Object.assign(document.createElement("p"), { className: "hint", textContent: "Ingen data än." }));
    return wrap;
  }
  const W = 320, H = 120, PAD_TOP = 14, PAD_BOTTOM = 18;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = W / points.length;
  const barW = Math.max(2, step - 2);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  const caption = Object.assign(document.createElement("p"), { className: "bars-caption" });
  const setCaption = (p) => (caption.textContent = p ? `${p.label}: ${nf(p.value)}${unit}` : `Högst ${nf(max)}${unit} · ${points[0].label} – ${points[points.length - 1].label}`);
  const base = H - PAD_BOTTOM;
  const line = document.createElementNS(ns, "line");
  Object.entries({ x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, class: "bars-axis" }).forEach(([k, v]) => line.setAttribute(k, v));
  svg.append(line);
  points.forEach((p, i) => {
    const h = p.value ? Math.max(2, ((base - PAD_TOP) * p.value) / max) : 0;
    const x = i * step + (step - barW) / 2;
    const r = Math.min(4, barW / 2, h);
    const g = document.createElementNS(ns, "g");
    if (h) {
      const bar = document.createElementNS(ns, "path");
      const y = base - h;
      bar.setAttribute("d", `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${base} Z`);
      bar.setAttribute("class", "bars-bar");
      g.append(bar);
    }
    // Träffytan är hela kolumnen, större än stapeln.
    const hit = document.createElementNS(ns, "rect");
    Object.entries({ x: i * step, y: 0, width: step, height: H, fill: "transparent" }).forEach(([k, v]) => hit.setAttribute(k, v));
    const title = document.createElementNS(ns, "title");
    title.textContent = `${p.label}: ${nf(p.value)}${unit}`;
    hit.append(title);
    hit.addEventListener("pointerenter", () => setCaption(p));
    hit.addEventListener("click", () => setCaption(p));
    g.append(hit);
    svg.append(g);
  });
  svg.addEventListener("pointerleave", () => setCaption(null));
  const labels = Object.assign(document.createElement("div"), { className: "bars-labels" });
  labels.append(Object.assign(document.createElement("span"), { textContent: points[0].label }), Object.assign(document.createElement("span"), { textContent: points[points.length - 1].label }));
  setCaption(null);
  wrap.append(caption, svg, labels);
  return wrap;
}

// Dagar utan nya annonser fylls med 0, så att tiden blir rätt.
function dailySeries(rows, days = 30) {
  const by = Object.fromEntries((rows ?? []).map((r) => [r.day, r.n]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
    return { label: day.slice(5), value: by[day] ?? 0 };
  });
}

function renderOps(d) {
  $("o-health").replaceChildren(
    ...opsHealth(d).map(([level, text]) => {
      const li = Object.assign(document.createElement("li"), { className: `ops-${level}` });
      li.append(Object.assign(document.createElement("span"), { className: "ops-icon", textContent: level === "ok" ? "✓" : level === "warn" ? "!" : "✕" }), Object.assign(document.createElement("span"), { textContent: text }));
      return li;
    }),
  );
  const bad = opsHealth(d).filter(([l]) => l !== "ok").length;
  $("h-ops-note").textContent = bad ? `⚠️ ${bad} saker att titta på` : "Allt rullar";

  // Körningar: de tre senaste per typ + bevakningen.
  const runCards = Object.entries(RUN_INFO).map(([name, info]) => {
    const card = Object.assign(document.createElement("div"), { className: "metric wide ops-run" });
    card.append(Object.assign(document.createElement("span"), { className: "metric-label", textContent: info.label }));
    const runs = d.runs?.[name] ?? [];
    if (!runs.length) card.append(Object.assign(document.createElement("span"), { className: "metric-note", textContent: "Ingen körning registrerad än." }));
    for (const r of runs) {
      const row = Object.assign(document.createElement("div"), { className: "ops-run-row" });
      row.append(
        Object.assign(document.createElement("b"), { textContent: `${fmtTime(r.started_at)}${r.finished_at ? ` · ${duration(r.started_at, r.finished_at)}` : ""}` }),
        Object.assign(document.createElement("span"), { className: /^Fel|fel/.test(r.status ?? "") ? "ops-bad-text" : "", textContent: r.status ?? "" }),
        Object.assign(document.createElement("small"), { textContent: r.summary ?? "" }),
      );
      card.append(row);
    }
    return card;
  });
  const w = d.watcher;
  const wc = Object.assign(document.createElement("div"), { className: "metric wide ops-run" });
  wc.append(Object.assign(document.createElement("span"), { className: "metric-label", textContent: "Bevakningen (var 30:e sekund)" }));
  wc.append(
    Object.assign(document.createElement("span"), {
      className: "metric-note",
      textContent: w
        ? `${w.running ? "Igång" : w.paused ? "Pausad" : "Stoppad"} · senaste sökning ${w.stats?.last_poll ? ago(w.stats.last_poll) : "–"} · ${nf(w.stats?.polls)} sökningar, ${nf(w.stats?.items)} nya annonser, ${nf(w.stats?.candidates)} kandidater, ${nf(w.stats?.deals)} notiser sedan start` +
          (w.stats?.last_deal ? ` · senaste träff ${fmtTime(w.stats.last_deal.at)}: ${w.stats.last_deal.title}` : "") +
          ` · Telegram: ${w.telegram?.linked ?? "inte kopplat"}`
        : "Svarar inte.",
    }),
  );
  $("o-runs").replaceChildren(...runCards, wc);

  // Anrop i dag (mot gränsen) + summa senaste 7 dagarna.
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const sum = (api, from) => (d.usage ?? []).filter((r) => r.api === api && r.day >= from).reduce((a, r) => a + r.count, 0);
  $("o-usage").replaceChildren(
    ...USAGE_INFO.filter((u) => u.limit || sum(u.api, weekAgo)).map((u) => {
      const n = sum(u.api, today);
      const row = Object.assign(document.createElement("div"), { className: "ops-usage-row" });
      const head = Object.assign(document.createElement("div"), { className: "ops-usage-head" });
      head.append(
        Object.assign(document.createElement("span"), { textContent: u.label }),
        Object.assign(document.createElement("b"), { className: u.bad && n ? "ops-bad-text" : "", textContent: `${nf(n)}${u.limit ? ` / ${nf(u.limit)}` : ""}` }),
      );
      row.append(head);
      if (u.limit) {
        const meter = Object.assign(document.createElement("div"), { className: "meter" });
        const share = n / u.limit;
        const fill = Object.assign(document.createElement("span"), { className: share >= 1 ? "empty" : share > 0.8 ? "low" : "" });
        fill.style.width = `${Math.min(100, Math.max(n ? 1 : 0, share * 100))}%`;
        meter.append(fill);
        row.append(meter);
      }
      row.append(Object.assign(document.createElement("small"), { className: "metric-note", textContent: `${nf(sum(u.api, weekAgo))} senaste 7 dagarna` }));
      return row;
    }),
  );

  // Databasen: siffror, tillväxt, sålda per månad och fördelning.
  const db = d.db ?? {};
  const tile = (label, value, note = "") => {
    const t = Object.assign(document.createElement("div"), { className: "metric" });
    t.append(Object.assign(document.createElement("span"), { className: "metric-label", textContent: label }), Object.assign(document.createElement("span"), { className: "metric-value", textContent: value }));
    if (note) t.append(Object.assign(document.createElement("span"), { className: "metric-note", textContent: note }));
    return t;
  };
  $("o-db").replaceChildren(
    tile("Annonser", nf(db.listings), `${nf(db.active)} aktiva`),
    tile("Sålda", nf(db.sold), `${nf(db.unsold)} osålda`),
    tile("Utan utfall", nf(db.unresolved), "avslutade Köp nu som väntar"),
    tile("Säljare", nf(db.all_sellers), `${nf(db.watched)} bevakade`),
    tile("Prispunkter", nf(db.price_points), "pris vid varje ändring"),
    tile("Storlek", db.size_bytes ? `${(db.size_bytes / 1e6).toLocaleString("sv-SE", { maximumFractionDigits: 1 })} MB` : "–", "av 5 000 MB gratis"),
  );
  $("o-growth").replaceChildren(barChart(dailySeries(d.growth, 30), { unit: " nya" }));
  const months = (d.sold_by_month ?? []).filter((m) => m.month && m.month >= "2023-01");
  $("o-sold").replaceChildren(barChart(months.map((m) => ({ label: m.month, value: m.n })), { unit: " sålda" }));
  const list = (title, rows, labelOf) => {
    const box = Object.assign(document.createElement("div"), { className: "metric wide" });
    box.append(Object.assign(document.createElement("span"), { className: "metric-label", textContent: title }));
    const ul = Object.assign(document.createElement("ul"), { className: "ops-list" });
    for (const r of rows ?? []) {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("span"), { textContent: labelOf(r.key) }), Object.assign(document.createElement("b"), { textContent: `${nf(r.listings)}${r.sold != null ? ` · ${nf(r.sold)} sålda` : ""}` }));
      ul.append(li);
    }
    box.append(ul);
    return box;
  };
  $("o-breakdown").replaceChildren(
    list("Per nisch", db.niches, (k) => ({ djur: "Schleich-djur", smurfar: "Smurfar", "": "Övrigt (inte nisch)" })[k] ?? k),
    list("Per serie", db.series, (k) => (k ? k.split(",").map((s) => SERIES_LABELS[s] ?? s).join(" + ") : "Ingen serie")),
    list("Per källa", db.sources, (k) => ({ säljare: "Bevakade säljare", sök: "Schleich-sökningen", arket: "Kopierat från arket" })[k] ?? k),
  );
}

async function loadOps() {
  $("o-health").replaceChildren(Object.assign(document.createElement("li"), { className: "ops-ok", textContent: "Hämtar…" }));
  loadProducts();
  try {
    renderOps(await marketApi({ action: "dashboard" }));
  } catch (err) {
    $("o-health").replaceChildren(Object.assign(document.createElement("li"), { className: "ops-bad", textContent: `⚠️ ${err.message}` }));
  }
}

// Produkter: hur stor del av Schleich-annonserna som är kopplade, och de mest sålda modellerna.
const METHOD_LABELS = { rubrik: "nummer i rubriken", text: "nummer i texten", ai: "AI" };
async function loadProducts() {
  try {
    const d = await marketApi({ action: "products", limit: 15 });
    const c = d.coverage ?? {};
    const tile = (label, value, note = "") => {
      const t = Object.assign(document.createElement("div"), { className: "metric" });
      t.append(Object.assign(document.createElement("span"), { className: "metric-label", textContent: label }), Object.assign(document.createElement("span"), { className: "metric-value", textContent: value }));
      if (note) t.append(Object.assign(document.createElement("span"), { className: "metric-note", textContent: note }));
      return t;
    };
    $("o-products-status").textContent = (d.methods ?? []).length ? `Kopplingar: ${d.methods.map((m) => `${nf(m.n)} via ${METHOD_LABELS[m.method] ?? m.method}`).join(", ")}.` : "";
    $("o-products").replaceChildren(
      tile("Kopplade annonser", `${c.share ?? 0}\u00a0%`, `${nf(c.linked)} av ${nf(c.schleich)} Schleich-annonser`),
      tile("Med annonsdetalj", `${c.schleich ? Math.round((100 * (c.detailed ?? 0)) / c.schleich) : 0}\u00a0%`, `${nf(c.detailed)} av ${nf(c.schleich)} – beskrivning, startdatum, utropspris, frakt`),
      tile("Modeller", nf(c.products), "olika modellnummer"),
      tile("Observationer", nf(c.snapshots), "pris, bud och status över tid"),
      tile("Kategorier", nf(c.categories), "från Tradera"),
    );
    const box = Object.assign(document.createElement("div"), { className: "metric wide" });
    box.append(Object.assign(document.createElement("span"), { className: "metric-label", textContent: "Mest sålda modeller" }));
    const ul = Object.assign(document.createElement("ul"), { className: "ops-list ops-products" });
    for (const p of d.products ?? []) {
      const li = document.createElement("li");
      const left = document.createElement("span");
      left.append(Object.assign(document.createElement("b"), { textContent: p.key.replace("SCHLEICH-", "") }), Object.assign(document.createElement("small"), { textContent: ` ${p.name ?? ""}` }));
      li.append(
        left,
        Object.assign(document.createElement("b"), {
          textContent: `${nf(p.sold)} sålda${p.median_sold ? ` · ${kr(p.median_sold)}` : ""}${p.sell_through != null ? ` · ${p.sell_through}\u00a0%` : ""}`,
        }),
      );
      ul.append(li);
    }
    box.append(ul);
    $("o-top-products").replaceChildren(box);
  } catch (err) {
    $("o-products-status").textContent = `⚠️ ${err.message}`;
  }
}

$("o-relink").addEventListener("click", async () => {
  $("o-products-status").textContent = "Kopplar…";
  try {
    const r = await marketApi({ action: "products_relink" });
    $("o-products-status").textContent = `✓ ${nf(r.linked)} nya kopplingar av ${nf(r.scanned)} annonser utan produkt.`;
    setTimeout(loadProducts, 1500);
  } catch (err) {
    $("o-products-status").textContent = `⚠️ ${err.message}`;
  }
});

$("h-go-ops").addEventListener("click", () => {
  show("ops");
  loadOps();
});
$("o-refresh").addEventListener("click", loadOps);
