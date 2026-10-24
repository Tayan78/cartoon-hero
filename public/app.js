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
};
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
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addPhoto(file, replaceMain) {
  $("btn-scan").disabled = true;
  $("scan-hint").textContent = "Förbereder bild…";
  try {
    const url = await compress(file);
    if (replaceMain && photos.length) photos[0] = url;
    else photos.push(url);
  } catch (err) {
    $("scan-hint").textContent = err.message;
  }
  renderPhotos();
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
  for (const id of ["r-main", "r-verdict", "r-details", "r-sources-title", "btn-save"]) $(id).hidden = true;
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

const colorFor = (score) => (score >= 70 ? "green" : score >= 40 ? "yellow" : "red");
const confText = { high: "hög", medium: "medel", low: "låg" };

function renderResult(data) {
  const r = data.result;
  const p = r.price_sek;
  renderPrelim(r.item);
  if (r.item.condition) $("r-sub").textContent += (r.item.age ? ` · ${r.item.age}` : "") + ` · ${r.item.condition}`;

  $("r-main").hidden = false;
  $("r-median").textContent = p.median > 0 ? kr(p.median) : "–";
  $("r-range").textContent = p.median > 0 ? `${kr(p.low)} – ${kr(p.high)}` : "Inget pris hittat";

  const color = colorFor(r.buy_score);
  $("r-score").className = `score ${color}`;
  $("r-score-num").textContent = r.buy_score;
  $("r-verdict").hidden = false;
  $("r-verdict").className = `verdict ${color}`;
  $("r-verdict").textContent = r.verdict;
  $("r-reason").textContent = r.reason;
  $("r-evidence").textContent = r.evidence ? `Identifiering: ${r.evidence}` : "";

  $("r-flags").replaceChildren(
    ...r.flags.map((f) => Object.assign(document.createElement("li"), { textContent: f })),
  );

  const e = r.economics;
  const rows = [
    ["Jämförelser", `${p.comparables} sålda · säkerhet ${confText[p.confidence]}`],
    ["Identifiering", `säkerhet ${confText[r.item.confidence_id]}`],
  ];
  const fs = r.for_sale;
  if (fs?.count > 0) {
    const range = fs.low && fs.high && fs.low !== fs.high ? `${kr(fs.low)}–${kr(fs.high)}` : kr(fs.high || fs.low);
    rows.splice(1, 0, ["Till salu nu", `${range} (${fs.count} annonser)`]);
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
    ["Försäljningspris", kr(e.sale_price)],
    ["Avgift", `−${kr(e.fees)}`],
    ["Frakt", `−${kr(e.shipping)}`],
    ["Inköpspris", `−${kr(e.buy_price)}`],
    ["Netto", kr(e.net_profit)],
  );
  if (r.item.article_number) rows.unshift(["Artikelnr", r.item.article_number]);
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
  const short = (m) => (m?.match(/opus|sonnet|haiku/i)?.[0] ?? "").replace(/^./, (c) => c.toUpperCase());
  const parts = data.cost.steps
    .map((st) => `${st.step}${short(st.model) ? ` (${short(st.model)})` : ""} ${sek(st.sek)}`)
    .join(" · ");
  $("r-cost").textContent =
    `Kostnad ${sek(data.cost.sek)} (${parts}) · ${data.cost.web_fetches ?? 0} sidor lästa · ${data.cost.web_searches} sökningar · ${data.images} bild${data.images === 1 ? "" : "er"} · ${secs} s`;
  $("btn-save").hidden = false;
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
      body: JSON.stringify({ images: photos, buyPrice: Number($("buy-price").value) || 0, settings: getSettings() }),
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

// ---------- inställningar ----------
let viewBeforeSettings = "scan";

function numberInput(value) {
  return Object.assign(document.createElement("input"), {
    type: "number", inputMode: "decimal", min: 0, step: "any", value,
  });
}

function modelOptions(selected) {
  return MODEL_OPTIONS.map(([value, label]) =>
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
  $("s-model-search").replaceChildren(...modelOptions(s.models.search));
  $("s-vision").checked = s.vision;
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
  store.set("settings", s);
  $("s-test").textContent = "Sparat.";
});

$("btn-test").addEventListener("click", async () => {
  const token = $("s-token").value.trim();
  $("s-test").textContent = "Testar…";
  try {
    const res = await fetch("/api/ping", { headers: { "x-app-token": token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fel ${res.status}`);
    store.set("token", token);
    const label = (id) => data.models[id] ?? id;
    $("s-test").textContent =
      `✓ Ansluten. API-nyckel: ${data.api_key ? "ja" : "SAKNAS"}. ` +
      `Bildsök: ${data.vision ? "ja" : "inte konfigurerat"}. ` +
      `Google Sheet: ${data.storage ? "ja" : "inte konfigurerat"}. ` +
      `Standard: identifiering ${label(data.defaults.identify)}, prissök ${label(data.defaults.search)}.` +
      (data.mock ? " (testläge)" : "");
  } catch (err) {
    $("s-test").textContent = `✗ ${err.message}`;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (!getToken()) openSettings("Välkommen! Ange ditt lösenord (APP_TOKEN) och tryck Spara.");
