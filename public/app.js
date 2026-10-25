// Loppisskannern – fas 1: fota (1–4 vinklar) → (inköpspris) → skanna → resultatkort.

// Samma standardvärden som lib/settings.js på servern.
const DEFAULT_SETTINGS = {
  platforms: {
    Tradera: { fee_percent: 10, fee_fixed: 0, shipping: 59 },
    Vinted: { fee_percent: 0, fee_fixed: 0, shipping: 0 },
    Blocket: { fee_percent: 0, fee_fixed: 0, shipping: 59 },
    Annan: { fee_percent: 0, fee_fixed: 0, shipping: 59 },
  },
  fx: { USD: 10.5, EUR: 11.5, GBP: 13.5 },
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
    decision: { ...DEFAULT_SETTINGS.decision, ...(s?.decision ?? {}) },
  };
};

// ---------- vyer ----------
const views = ["scan", "result", "settings"];
function show(name) {
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
}

// ---------- bilder ----------
let photos = []; // dataURL:er efter komprimering, första = huvudbild

async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Kunde inte läsa bilden"));
      i.src = url;
    });
    // iOS roterar enligt EXIF när bilden ritas, så naturalWidth/Height stämmer.
    // Google Lens (SerpApi) tar max 500 kB: krymp kvalitet och storlek tills bilden ryms.
    let dataUrl = "";
    for (const [side, quality] of [[MAX_SIDE, JPEG_QUALITY], [MAX_SIDE, 0.7], [1200, 0.7], [1000, 0.65]]) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length * 0.75 <= MAX_BYTES) break;
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  for (const file of files) await addPhoto(file, false);
});

function resetScan() {
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

function resetCard() {
  $("card-img").src = photos[0];
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

function renderResult(data) {
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
      price.textContent = (s.price_sek ? kr(s.price_sek) : "") + (s.sold ? "" : " · till salu");
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
    if (m === "serpapi-google-lens") return "";
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
  trackCost(data.cost.sek);
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
  resetCard();
  show("result");
  setStatus("Skickar…");
  current = null;
  let gotResult = false;

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": getToken() },
      body: JSON.stringify({
        images: photos,
        buyPrice: Number($("buy-price").value) || 0,
        note: $("note").value.trim(),
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
      } else if (msg.type === "logged") {
        if (current) current.image_url = msg.image_url;
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
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Spara till lager";
    setStatus(`Kunde inte spara: ${err.message}`, false);
  }
});

$("btn-new").addEventListener("click", resetScan);

$("btn-copy-debug").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("r-debug-pre").textContent);
    $("btn-copy-debug").textContent = "✓ Kopierat";
  } catch {
    $("btn-copy-debug").textContent = "Markera texten och kopiera";
  }
});

// ---------- inställningar ----------
let viewBeforeSettings = "scan";

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
  $("s-vision").checked = s.vision;
  $("s-gemini").checked = s.gemini;
  $("s-mode").value = s.mode;
  $("s-lens").checked = s.lens;
  const month = store.get("costs", {})[new Date().toISOString().slice(0, 7)];
  $("s-costs").textContent = month
    ? `Den här månaden (denna telefon): ${month.scans} skanningar, ${month.sek.toFixed(2).replace(".", ",")} kr. Exakt kostnad per skanning loggas i Sheet.`
    : "";
  $("s-test").textContent = message;
  show("settings");
}

$("btn-settings").addEventListener("click", () => openSettings());
$("btn-settings-close").addEventListener("click", () => show(viewBeforeSettings));

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
  for (const input of $("s-rules").querySelectorAll("input[data-rule]")) {
    const n = Number(input.value);
    if (input.value !== "" && Number.isFinite(n) && n >= 0) s.decision[input.dataset.rule] = n;
  }
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
