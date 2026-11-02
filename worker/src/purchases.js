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
  if (op === "titles") {
    // Rubriken annonsen fick (vid export) – den som ProLister lägger upp på Tradera.
    const items = (Array.isArray(body.items) ? body.items : []).filter((i) => i?.id && i.title).slice(0, 500);
    if (items.length) {
      await db.batch(items.map((i) => db.prepare("UPDATE own_items SET title = ?2, updated_at = ?3 WHERE id = ?1").bind(String(i.id), String(i.title).slice(0, 200), now)));
    }
    return { updated: items.length };
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
  const stats = await purchaseStats(db);
  const list = results.map((p) => ({ ...p, ...(stats.get(p.id) ?? emptyStats()) }));
  const totals = list
    .filter((p) => !Number(p.legacy))
    .reduce((t, p) => ({ cost: t.cost + (Number(p.total_cost ?? p.price) || 0), sold_revenue: t.sold_revenue + p.sold_revenue, sold_count: t.sold_count + p.sold_count, active_value: t.active_value + p.active_value }), { cost: 0, sold_revenue: 0, sold_count: 0, active_value: 0 });
  return { purchases: list, totals, own_seller: own.results[0] ?? null };
}

// ---------- Partiets utveckling ----------
// Annonserna som kopplats till ett inköp matchas mot dina annonser på Tradera via
// rubriken (ProLister lägger upp exakt den rubrik appen skrev). Samma rubrik flera
// gånger matchas i tidsordning; en annons som lagts upp igen (osåld → ny annons med
// samma rubrik) följs till den senaste. Sålt för = vad köparen betalade enligt dina
// ordrar, annars annonsens slutpris.
const norm = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const emptyStats = () => ({ registered: 0, matched: 0, sold_count: 0, sold_revenue: 0, sold_exact: 0, active_count: 0, active_value: 0 });

export async function purchaseStats(db) {
  const [items, listings, sales] = await db.batch([
    db.prepare(
      `SELECT o.id, o.purchase_id, o.created_at, COALESCE(o.title, a.title) AS title
       FROM own_items o LEFT JOIN ads a ON a.id = o.id WHERE o.purchase_id IS NOT NULL ORDER BY o.created_at, o.id`,
    ),
    db.prepare(
      `SELECT l.id, l.title, l.status, l.price, COALESCE(l.start_at, l.first_seen) AS seen,
         CASE WHEN json_valid(l.raw) THEN json_extract(l.raw, '$.ownReferences') END AS refs
       FROM listings l JOIN sellers s ON s.id = l.seller_id AND s.own = 1 ORDER BY seen, l.id`,
    ),
    db.prepare("SELECT item_id, SUM(unit_price * COALESCE(quantity, 1)) AS revenue FROM own_sales GROUP BY item_id"),
  ]);
  // Exakt: ProLister skickar appens annons-id som referens till Tradera.
  const byRef = new Map();
  for (const l of listings.results) {
    let refs = [];
    try {
      refs = [].concat(JSON.parse(l.refs ?? "[]") ?? []);
    } catch {
      refs = l.refs ? [l.refs] : [];
    }
    for (const r of refs) {
      const k = String(r).trim();
      if (!k) continue;
      if (!byRef.has(k)) byRef.set(k, []);
      byRef.get(k).push(l);
    }
  }
  const byTitle = new Map();
  for (const l of listings.results) {
    const k = norm(l.title);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(l);
  }
  const paid = new Map(sales.results.map((s) => [String(s.item_id), Number(s.revenue) || 0]));
  const used = new Set();
  const out = new Map();
  for (const it of items.results) {
    const s = out.get(it.purchase_id) ?? emptyStats();
    out.set(it.purchase_id, s);
    s.registered++;
    const exactChain = (byRef.get(String(it.id)) ?? []).filter((l) => !used.has(l.id));
    const chain = exactChain.length ? exactChain : (byTitle.get(norm(it.title)) ?? []).filter((l) => !used.has(l.id));
    if (!chain.length || (!exactChain.length && !it.title)) continue;
    let l = chain[0];
    used.add(l.id);
    // Osåld och upplagd igen: följ till den nya annonsen.
    for (let i = 1; l.status === "Osåld" && i < chain.length; i++) {
      l = chain[i];
      used.add(l.id);
    }
    s.matched++;
    const exact = paid.get(String(l.id));
    if (exact != null) {
      s.sold_count++;
      s.sold_revenue += exact;
      s.sold_exact++;
    } else if (l.status === "Såld") {
      s.sold_count++;
      s.sold_revenue += Number(l.price) || 0;
    } else if (l.status === "Aktiv") {
      s.active_count++;
      s.active_value += Number(l.price) || 0;
    }
  }
  return out;
}
