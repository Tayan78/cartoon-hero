// Dina annonser i databasen och bilderna i R2. Spärrar så att inget går över det
// som ingår i Cloudflares betalplan (R2: 10 GB och 1 miljon skrivningar per månad).
import { addUsage } from "./monitor.js";

export const R2_MAX_BYTES = 8 * 1024 ** 3; // stoppa vid 8 GB (10 GB ingår)
export const R2_DAILY_PUTS = 3000; // ~90 000 per månad (1 miljon ingår)
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES = 8;

const now = () => new Date().toISOString();
const json = (v) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
const parse = (v, fallback) => {
  try {
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};

async function r2Stats(db) {
  const { results } = await db.prepare("SELECT value FROM app_secrets WHERE key = 'r2_stats'").all();
  return parse(results[0]?.value, { bytes: 0, objects: 0 });
}
async function setR2Stats(db, stats) {
  await db
    .prepare("INSERT INTO app_secrets (key, value, updated_at) VALUES ('r2_stats', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(JSON.stringify(stats), now())
    .run();
}
async function putsToday(db) {
  const { results } = await db.prepare("SELECT count FROM usage WHERE day = ?1 AND api = 'r2_put'").bind(now().slice(0, 10)).all();
  return Number(results[0]?.count) || 0;
}

// Sparar en bild i R2 – eller vägrar om en spärr nås.
export async function putImage(env, key, bytes) {
  if (!env.IMAGES) throw new Error("Bildlagringen (R2) är inte kopplad");
  if (!bytes?.byteLength) throw new Error("Tom bild");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Bilden är för stor (max 2 MB)");
  const [stats, puts] = await Promise.all([r2Stats(env.DB), putsToday(env.DB)]);
  if (puts >= (Number(env.R2_DAILY_PUTS) || R2_DAILY_PUTS)) throw new Error(`Dygnets gräns för bilduppladdning är nådd (${puts}) – fortsätter i morgon`);
  if (stats.bytes + bytes.byteLength > (Number(env.R2_MAX_BYTES) || R2_MAX_BYTES)) throw new Error("Bildlagringen är nästan full (8 GB) – ta bort gamla annonser först");
  const old = await env.IMAGES.head(key);
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" } });
  await setR2Stats(env.DB, { bytes: stats.bytes + bytes.byteLength - (old?.size ?? 0), objects: stats.objects + (old ? 0 : 1) });
  await addUsage(env.DB, { r2_put: 1 });
  return key;
}

async function deleteImages(env, keys) {
  const own = keys.filter((k) => k.startsWith("ads/"));
  if (!own.length || !env.IMAGES) return;
  const heads = await Promise.all(own.map((k) => env.IMAGES.head(k)));
  await env.IMAGES.delete(own);
  const freed = heads.reduce((s, h) => s + (h?.size ?? 0), 0);
  const stats = await r2Stats(env.DB);
  await setR2Stats(env.DB, { bytes: Math.max(0, stats.bytes - freed), objects: Math.max(0, stats.objects - heads.filter(Boolean).length) });
}

const dataUrlBytes = (s) => {
  const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(String(s ?? ""));
  if (!m) throw new Error("Ogiltig bild");
  return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
};

const ROW = (r, base) => ({
  id: r.id,
  created: r.created_at,
  updated: r.updated_at,
  status: r.status,
  note: r.note ?? "",
  image_urls: parse(r.images, []).map((k) => (k.startsWith("ads/") ? `${base}/${k}` : k)),
  title: r.title ?? "",
  description: r.description ?? "",
  price: r.price ?? "",
  channel: r.channel ?? "",
  confirmed: r.confirmed ?? "",
  error: r.error ?? "",
  in_inventory: Number(r.in_inventory) === 1,
  purchase_id: r.purchase_id ?? null,
  source: r.source ?? "app",
  listing: parse(r.result, null),
});

async function get(db, id) {
  const { results } = await db.prepare("SELECT * FROM ads WHERE id = ?1").bind(String(id)).all();
  return results[0] ?? null;
}

export async function ads(env, body = {}) {
  const db = env.DB;
  const base = String(env.IMAGE_BASE ?? "").replace(/\/$/, "");
  const id = body.id != null ? String(body.id) : null;
  switch (body.op) {
    case "create": {
      // Ny annons (eller ny uppladdning av en som inte hunnit bli klar): bilderna nollställs.
      const row = await get(db, id);
      if (row && row.status !== "Laddar upp") return { duplicate: true };
      if (row) {
        await deleteImages(env, parse(row.images, []));
        await db.prepare("UPDATE ads SET images = '[]', note = ?2, purchase_id = ?3, updated_at = ?4 WHERE id = ?1").bind(id, body.note ?? "", body.purchase_id ?? null, now()).run();
        return { reset: true };
      }
      await db
        .prepare("INSERT INTO ads (id, created_at, updated_at, status, note, settings, purchase_id, images, source) VALUES (?1, ?2, ?2, 'Laddar upp', ?3, ?4, ?5, '[]', 'app')")
        .bind(id, now(), body.note ?? "", json(body.settings ?? {}), body.purchase_id ?? null)
        .run();
      return { created: true };
    }
    case "image": {
      const row = await get(db, id);
      if (!row) throw new Error("Annonsen finns inte");
      const images = parse(row.images, []);
      if (images.length >= MAX_IMAGES) throw new Error(`Max ${MAX_IMAGES} bilder`);
      const key = await putImage(env, `ads/${id}/${images.length + 1}.jpg`, dataUrlBytes(body.image));
      images.push(key);
      await db.prepare("UPDATE ads SET images = ?2, updated_at = ?3 WHERE id = ?1").bind(id, JSON.stringify(images), now()).run();
      return { image_url: `${base}/${key}` };
    }
    case "commit": {
      const row = await get(db, id);
      if (!row) throw new Error("Annonsen finns inte");
      if (!parse(row.images, []).length) throw new Error("Inga bilder uppladdade");
      await db.prepare("UPDATE ads SET status = 'Väntar', error = NULL, updated_at = ?2 WHERE id = ?1").bind(id, now()).run();
      return { queued: true };
    }
    case "requeue":
      await db.prepare("UPDATE ads SET status = 'Väntar', confirmed = ?2, error = NULL, updated_at = ?3 WHERE id = ?1").bind(id, String(body.confirmed ?? ""), now()).run();
      return { queued: true };
    case "claim": {
      // Ta annonsen om den väntar (eller fastnat i Bearbetas i över 10 minuter).
      const stale = new Date(Date.now() - 10 * 60000).toISOString();
      const { results } = await db
        .prepare("UPDATE ads SET status = 'Bearbetas', updated_at = ?2 WHERE id = ?1 AND (status = 'Väntar' OR (status = 'Bearbetas' AND updated_at < ?3)) RETURNING *")
        .bind(id, now(), stale)
        .all();
      const r = results[0];
      if (!r) return { job: null };
      return { job: { id: r.id, note: r.note ?? "", confirmed: r.confirmed ?? "", images: ROW(r, base).image_urls, settings: parse(r.settings, {}) } };
    }
    case "stuck": {
      // Annonser som väntat i över 2 minuter eller fastnat i Bearbetas (servern dog).
      const { results } = await db
        .prepare("SELECT id FROM ads WHERE (status = 'Väntar' AND updated_at < ?1) OR (status = 'Bearbetas' AND updated_at < ?2) ORDER BY updated_at LIMIT 10")
        .bind(new Date(Date.now() - 2 * 60000).toISOString(), new Date(Date.now() - 10 * 60000).toISOString())
        .all();
      return { ids: results.map((r) => r.id) };
    }
    case "result": {
      const r = body.result ?? {};
      if (!r.ok) {
        await db.prepare("UPDATE ads SET status = 'Fel', error = ?2, updated_at = ?3 WHERE id = ?1").bind(id, String(r.error ?? "Okänt fel").slice(0, 500), now()).run();
        return { saved: true };
      }
      const l = r.listing ?? {};
      const item = l.item ?? {};
      await db
        .prepare(
          `UPDATE ads SET status = 'Klar', title = ?2, description = ?3, price = ?4, channel = ?5, model_number = ?6, name = ?7, brand = ?8,
             category = ?9, price_basis = ?10, cost_sek = ?11, error = NULL, result = ?12, updated_at = ?13 WHERE id = ?1`,
        )
        .bind(id, l.title ?? "", l.description ?? "", Number(l.price) || null, l.channel ?? null, l.article?.number ?? null, item.name ?? null, item.brand ?? null, item.category ?? null, l.list_basis ?? null, l.cost?.sek ?? null, JSON.stringify(l), now())
        .run();
      return { saved: true };
    }
    case "list": {
      const { results } = await db.prepare("SELECT * FROM ads ORDER BY created_at DESC LIMIT ?1").bind(Math.min(Number(body.limit) || 300, 2000)).all();
      return { listings: results.map((r) => ROW(r, base)) };
    }
    case "update": {
      const f = body.fields ?? {};
      const map = { title: "title", description: "description", price: "price", channel: "channel", confirmed: "confirmed", status: "status" };
      const sets = Object.keys(map).filter((k) => f[k] !== undefined);
      if (f.status === "Godkänd") sets.push("in_inventory");
      if (!sets.length) return { updated: false };
      const values = sets.map((k) => (k === "in_inventory" ? 1 : k === "price" ? Number(f.price) || null : String(f[k])));
      await db
        .prepare(`UPDATE ads SET ${sets.map((k, i) => `${map[k] ?? k} = ?${i + 2}`).join(", ")}, updated_at = ?${sets.length + 2} WHERE id = ?1`)
        .bind(id, ...values, now())
        .run();
      return { updated: true };
    }
    case "approve": {
      const items = (Array.isArray(body.items) ? body.items : []).filter((i) => i?.id).slice(0, 200);
      if (items.length) {
        await db.batch(
          items.map((i) =>
            db.prepare("UPDATE ads SET status = 'Godkänd', in_inventory = 1, confirmed = COALESCE(?2, confirmed), updated_at = ?3 WHERE id = ?1 AND status = 'Klar'").bind(String(i.id), i.confirmed ? String(i.confirmed) : null, now()),
          ),
        );
      }
      return { approved: items.length };
    }
    case "exported": {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 500);
      if (ids.length) await db.batch(ids.map((x) => db.prepare("UPDATE ads SET status = 'Exporterad', exported_at = ?2, updated_at = ?2 WHERE id = ?1").bind(x, now())));
      return { marked: ids.length };
    }
    case "delete": {
      const row = await get(db, id);
      if (!row) return { deleted: false };
      await deleteImages(env, parse(row.images, []));
      await db.prepare("DELETE FROM ads WHERE id = ?1").bind(id).run();
      return { deleted: true };
    }
    case "summary": {
      const { results } = await db.prepare("SELECT status, COUNT(*) AS n, SUM(COALESCE(cost_sek, 0)) AS sek FROM ads GROUP BY status").all();
      const by = Object.fromEntries(results.map((r) => [r.status, r]));
      return { ready: by.Klar?.n ?? 0, approved: by.Godkänd?.n ?? 0, exported: by.Exporterad?.n ?? 0, total: results.reduce((s, r) => s + r.n, 0) };
    }
    case "import": {
      // En annons från Google Sheet (kopieringen). Finns den redan rörs den inte.
      const a = body.ad ?? {};
      if (!a.id) throw new Error("id saknas");
      const { results } = await db
        .prepare(
          `INSERT INTO ads (id, created_at, updated_at, status, note, settings, images, title, description, price, channel, model_number, confirmed,
             name, brand, category, price_basis, cost_sek, error, result, in_inventory, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 'ark')
           ON CONFLICT(id) DO NOTHING RETURNING id`,
        )
        .bind(
          String(a.id), a.created_at ?? now(), a.updated_at ?? now(), a.status ?? "Klar", a.note ?? "", json(a.settings ?? {}), a.title ?? "", a.description ?? "",
          Number(a.price) || null, a.channel ?? null, a.model_number ?? null, a.confirmed ?? null, a.name ?? null, a.brand ?? null, a.category ?? null,
          a.price_basis ?? null, Number(a.cost_sek) || null, a.error ?? null, json(a.result), a.in_inventory ? 1 : 0,
        )
        .all();
      return { imported: results.length > 0 };
    }
    case "import_image": {
      // Kopierar en bild från en publik länk (Drive) till R2 och lägger den sist på annonsen.
      const row = await get(db, id);
      if (!row) throw new Error("Annonsen finns inte");
      const images = parse(row.images, []);
      const n = Number(body.n) || images.length + 1;
      const key = `ads/${id}/${n}.jpg`;
      if (images.includes(key)) return { skipped: true };
      const res = await fetch(String(body.url), { redirect: "follow" });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) throw new Error(`Bilden kunde inte hämtas (${res.status})`);
      await putImage(env, key, new Uint8Array(await res.arrayBuffer()));
      images.push(key);
      images.sort((x, y) => Number(/\/(\d+)\.jpg$/.exec(x)?.[1] ?? 0) - Number(/\/(\d+)\.jpg$/.exec(y)?.[1] ?? 0));
      await db.prepare("UPDATE ads SET images = ?2 WHERE id = ?1").bind(id, JSON.stringify(images)).run();
      return { image_url: `${base}/${key}` };
    }
    case "storage":
      return { r2: await r2Stats(db), puts_today: await putsToday(db), max_bytes: Number(env.R2_MAX_BYTES) || R2_MAX_BYTES, daily_puts: Number(env.R2_DAILY_PUTS) || R2_DAILY_PUTS };
    default:
      throw new Error("Okänd op");
  }
}
