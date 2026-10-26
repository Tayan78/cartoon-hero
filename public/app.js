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
const views = ["home", "scan", "result", "history", "capture", "groups", "review", "settings"];
const TITLES = {
  home: "Loppisskannern",
  scan: "Skanna",
  result: "Resultat",
  history: "Historik",
  capture: "Fota annonser",
  groups: "Annonser",
  review: "Granska annons",
  settings: "Inställningar",
};
let currentView = "home";
function show(name) {
  if (name !== "capture") stopCamera();
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  currentView = name;
  $("top-title").textContent = TITLES[name] ?? "Loppisskannern";
  $("btn-back").hidden = name === "home";
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
  $("g-sent-hint").textContent = !sentListings.length
    ? "Inga skickade annonser ännu."
    : working
      ? `AI:n arbetar med ${working} ${working === 1 ? "annons" : "annonser"} – du kan stänga appen.`
      : "Tryck på en annons för att granska den.";
  $("g-sent").replaceChildren(
    ...sentListings.map((l) => {
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
    }),
  );
  renderApproveBar();
  const approved = sentListings.filter((l) => l.status === "Godkänd" && (l.channel || "Tradera") === "Tradera").length;
  const exported = sentListings.some((l) => l.status === "Exporterad");
  $("g-export").hidden = !approved && !exported;
  $("g-export-all-label").hidden = !exported;
  $("g-export").textContent = approved ? `📄 Exportera till ProLister (${approved})` : "📄 Exportera till ProLister";
  // Uppdatera av sig själv medan AI:n arbetar och listan visas.
  if (working && !$("view-groups").hidden) sentTimer = setTimeout(renderSent, 15000);
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
      : `Texten använder ${used || "inget nummer"} – bekräfta rätt nummer innan du godkänner.`;
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
  if (status === "Godkänd" && hasCandidates && !reviewConfirmed) {
    $("v-hint").textContent = "Tryck på rätt modellnummer först.";
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
$("h-go-scan").addEventListener("click", resetScan);
$("h-go-capture").addEventListener("click", () => openCapture(null, "home"));
$("h-go-groups").addEventListener("click", openGroups);
$("h-go-history").addEventListener("click", openHistory);
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

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (!getToken()) openSettings("Välkommen! Ange ditt lösenord (APP_TOKEN) och tryck Spara.");
else {
  openHome();
  retryFailed();
}
