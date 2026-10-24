// Loppisskannern – fas 1: fota → (inköpspris) → skanna → resultatkort.

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
  };
};

// ---------- vyer ----------
const views = ["scan", "result", "settings"];
function show(name) {
  for (const v of views) $(`view-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
}

// ---------- bild ----------
let photo = null; // dataURL efter komprimering

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

$("photo").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $("btn-scan").disabled = true;
  $("scan-hint").textContent = "Förbereder bild…";
  try {
    photo = await compress(file);
    $("preview").src = photo;
    $("preview").hidden = false;
    $("camera-label").classList.add("has-photo");
    $("camera-text").textContent = "Tryck för att fota igen";
    $("btn-scan").disabled = false;
    $("scan-hint").textContent = `${Math.round((photo.length * 0.75) / 1024)} kB`;
  } catch (err) {
    $("scan-hint").textContent = err.message;
  }
  e.target.value = "";
});

function resetScan() {
  photo = null;
  $("preview").hidden = true;
  $("preview").removeAttribute("src");
  $("camera-label").classList.remove("has-photo");
  $("camera-text").innerHTML = "📷<br>Fota föremål";
  $("buy-price").value = "";
  $("btn-scan").disabled = true;
  $("scan-hint").textContent = "";
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
  $("card-img").src = photo;
  $("r-name").textContent = "Identifierar…";
  $("r-sub").textContent = "";
  for (const id of ["r-main", "r-verdict", "r-details", "r-sources-title", "btn-save"]) $(id).hidden = true;
  for (const id of ["r-reason", "r-cost"]) $(id).textContent = "";
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

  $("r-flags").replaceChildren(
    ...r.flags.map((f) => Object.assign(document.createElement("li"), { textContent: f })),
  );

  const e = r.economics;
  const rows = [
    ["Jämförelser", `${p.comparables} sålda · säkerhet ${confText[p.confidence]}`],
    ["Identifiering", `säkerhet ${confText[r.item.confidence_id]}`],
  ];
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

  $("r-sources-title").hidden = r.sources.length === 0;
  $("r-sources").replaceChildren(
    ...r.sources.map((s) => {
      const li = document.createElement("li");
      const a = Object.assign(document.createElement("a"), { href: s.url, target: "_blank", rel: "noopener" });
      const title = document.createElement("span");
      title.append(Object.assign(document.createElement("span"), { className: "tag", textContent: s.platform }), s.title || s.url);
      const price = document.createElement("span");
      price.textContent = (s.price_sek ? kr(s.price_sek) : "") + (s.sold ? "" : " · ej såld");
      a.append(title, price);
      li.append(a);
      return li;
    }),
  );

  const secs = (data.duration_ms / 1000).toFixed(1);
  $("r-cost").textContent = `Kostnad ${data.cost.sek.toFixed(2).replace(".", ",")} kr · ${data.cost.web_searches} sökningar · ${secs} s`;
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
  if (!photo) return;
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
      body: JSON.stringify({ image: photo, buyPrice: Number($("buy-price").value) || 0, settings: getSettings() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Fel ${res.status}`);
    }
    await readNdjson(res, (msg) => {
      if (msg.type === "status") setStatus(msg.text);
      else if (msg.type === "prelim") {
        renderPrelim(msg.item);
        setStatus("Preliminärt – söker sålda priser…");
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
    $("s-test").textContent =
      `✓ Ansluten (${data.model}). API-nyckel: ${data.api_key ? "ja" : "SAKNAS"}. ` +
      `Google Sheet: ${data.storage ? "ja" : "inte konfigurerat"}.${data.mock ? " (testläge)" : ""}`;
  } catch (err) {
    $("s-test").textContent = `✗ ${err.message}`;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
if (!getToken()) openSettings("Välkommen! Ange ditt lösenord (APP_TOKEN) och tryck Spara.");
