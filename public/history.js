// Historik: varje skanning sparas i telefonen (IndexedDB) med hela kortet, en
// liten miniatyrbild, tid och inköpspris – fungerar utan nät. Sheet-loggningen
// är oförändrad; det här är telefonens egen kopia.
const DB_NAME = "loppisskannern";
const STORE = "scans";

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in self)) return reject(new Error("Telefonen saknar lagring för historik"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("ts", "ts");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Kunde inte öppna historiken"));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Avbrutet"));
  });
}

export const putScan = (record) => run("readwrite", (s) => s.put(record));
export const getScan = (id) => run("readonly", (s) => s.get(id));
export const deleteScan = (id) => run("readwrite", (s) => s.delete(id));
// Nyast först.
export const allScans = async () => ((await run("readonly", (s) => s.getAll())) ?? []).sort((a, b) => b.ts - a.ts);

// Uppdaterar några fält i en sparad skanning (t.ex. bildlänk eller "sparad i lager").
export async function updateScan(id, fields) {
  const rec = await getScan(id);
  if (rec) await putScan({ ...rec, ...fields });
}

// Ber iOS att inte rensa historiken när lagringen blir trång (beviljas oftast
// för appar på hemskärmen).
export async function askPersistent() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}

// Miniatyr för listan och kortet: kvadratisk mittbeskärning, ca 10–20 kB.
export async function thumbnail(dataUrl, side = 240) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Kunde inte läsa bilden"));
    i.src = dataUrl;
  });
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = Object.assign(document.createElement("canvas"), { width: side, height: side });
  canvas
    .getContext("2d")
    .drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side);
  return canvas.toDataURL("image/jpeg", 0.75);
}

// Filter och sökning för listan. color: "" | "green" | "yellow" | "red" | "none";
// saved: "" | "yes" | "no"; q matchar namn, märke och modellnummer.
export function filterScans(list, { color = "", saved = "", q = "" } = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((rec) => {
    const r = rec.data?.result ?? {};
    if (color && (r.decision?.color ?? "none") !== color) return false;
    if (saved === "yes" && !rec.saved) return false;
    if (saved === "no" && rec.saved) return false;
    if (!words.length) return true;
    const text = [r.item?.name, r.item?.brand, r.item?.model, r.item?.article_number, r.article?.number, rec.note]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
