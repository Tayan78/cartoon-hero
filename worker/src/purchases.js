// Inköp och egna objekt (POST /data/purchases { op, … }).
const PURCHASE_FIELDS = ["bought_at", "source", "url", "tradera_id", "title", "price", "shipping", "fees", "total_cost", "item_count", "thumbnail", "note", "status", "legacy"];
const int = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const clean = (p) => {
  const out = {};
  for (const f of PURCHASE_FIELDS) {
    if (p[f] === undefined) continue;
    out[f] = ["price", "shipping", "fees", "total_cost", "item_count", "legacy"].includes(f) ? int(p[f]) : p[f] == null ? null : String(p[f]).slice(0, f === "note" ? 500 : 300);
  }
  return out;
};

export async function purchases(db, body = {}, now = new Date().toISOString()) {
  const op = body.op ?? "list";
  if (op === "save") {
    const p = clean(body.purchase ?? {});
    if (body.purchase?.id) {
      const keys = Object.keys(p);
      if (keys.length) await db.prepare(`UPDATE purchases SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`).bind(Number(body.purchase.id), ...keys.map((k) => p[k])).run();
      return { id: Number(body.purchase.id) };
    }
    const keys = ["created_at", ...Object.keys(p)];
    const vals = [now, ...Object.values(p)];
    const r = await db.prepare(`INSERT INTO purchases (${keys.join(", ")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")}) RETURNING id`).bind(...vals).all();
    return { id: r.results[0]?.id };
  }
  if (op === "item") {
    // Annonsen kopplas till ett inköp (eller inget, purchase_id = null).
    const it = body.item ?? {};
    if (!it.id) throw new Error("id saknas");
    await db
      .prepare(
        `INSERT INTO own_items (id, purchase_id, created_at, status, updated_at) VALUES (?1, ?2, ?3, 'fotad', ?3)
         ON CONFLICT(id) DO UPDATE SET purchase_id = excluded.purchase_id, updated_at = excluded.updated_at`,
      )
      .bind(String(it.id).slice(0, 40), it.purchase_id == null || it.purchase_id === "" ? null : Number(it.purchase_id), now)
      .run();
    return { id: it.id };
  }
  if (op === "own_seller") {
    await db.prepare("UPDATE sellers SET own = CASE WHEN id = ?1 THEN 1 ELSE 0 END WHERE own = 1 OR id = ?1").bind(String(body.seller_id)).run();
    return { seller_id: String(body.seller_id) };
  }
  // list: inköpen med antal fotade objekt, nyast först.
  const { results } = await db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM own_items o WHERE o.purchase_id = p.id) AS items_registered,
              (SELECT COUNT(*) FROM own_items o WHERE o.purchase_id = p.id AND o.status = 'såld') AS items_sold
       FROM purchases p ORDER BY (p.status = 'öppen') DESC, COALESCE(p.bought_at, p.created_at) DESC LIMIT 200`,
    )
    .all();
  const own = await db.prepare("SELECT id, alias FROM sellers WHERE own = 1").all();
  return { purchases: results, own_seller: own.results[0] ?? null };
}
