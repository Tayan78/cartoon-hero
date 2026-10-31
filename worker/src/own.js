// Ditt Tradera-konto: nyckeln (token) och dina försäljningar ur Traderas ordrar.
// Nyckeln lämnar bara databasen mot appens server (skyddad med APP_TOKEN).

const SALE_COLS = ["order_id", "item_id", "title", "quantity", "unit_price", "order_total", "shipping_cost", "shipping_type", "paid_amount", "paid_at", "created_at", "updated_at"];

export async function own(db, body = {}, now = new Date().toISOString()) {
  switch (body.op) {
    case "auth_get": {
      const { results } = await db.prepare("SELECT value FROM app_secrets WHERE key = 'tradera_user'").all();
      return { auth: results[0]?.value ? JSON.parse(results[0].value) : null };
    }
    case "auth_set": {
      const a = body.auth ?? {};
      if (!a.token || !a.user_id) throw new Error("token och user_id krävs");
      const value = JSON.stringify({ user_id: String(a.user_id), alias: a.alias ?? null, token: String(a.token), expires: a.expires ?? null, connected_at: now });
      await db.prepare("INSERT INTO app_secrets (key, value, updated_at) VALUES ('tradera_user', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(value, now).run();
      return { saved: true };
    }
    case "auth_delete":
      await db.prepare("DELETE FROM app_secrets WHERE key = 'tradera_user'").run();
      return { deleted: true };
    case "sales_upsert": {
      const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r) => r && r.order_id != null && r.item_id).slice(0, 500);
      if (rows.length) {
        await db.batch(
          rows.map((r) =>
            db
              .prepare(
                `INSERT INTO own_sales (${SALE_COLS.join(", ")}) VALUES (${SALE_COLS.map((_, i) => `?${i + 1}`).join(", ")})
                 ON CONFLICT(order_id, item_id) DO UPDATE SET ${SALE_COLS.slice(2).map((c) => `${c} = excluded.${c}`).join(", ")}
                 WHERE own_sales.updated_at IS NOT excluded.updated_at OR own_sales.paid_at IS NOT excluded.paid_at`,
              )
              .bind(...SALE_COLS.map((c) => r[c] ?? null)),
          ),
        );
      }
      if (body.synced_at) {
        await db
          .prepare("INSERT INTO app_secrets (key, value, updated_at) VALUES ('orders_sync', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
          .bind(JSON.stringify({ synced_at: body.synced_at, fetched: rows.length }), now)
          .run();
      }
      return { upserted: rows.length };
    }
    case "status": {
      const [auth, sync, sales] = await db.batch([
        db.prepare("SELECT json_extract(value, '$.alias') AS alias, json_extract(value, '$.expires') AS expires, json_extract(value, '$.connected_at') AS connected_at FROM app_secrets WHERE key = 'tradera_user'"),
        db.prepare("SELECT value FROM app_secrets WHERE key = 'orders_sync'"),
        db.prepare("SELECT COUNT(*) AS n, SUM(unit_price * COALESCE(quantity, 1)) AS revenue, MIN(created_at) AS first, MAX(created_at) AS last FROM own_sales"),
      ]);
      const a = auth.results[0];
      return {
        connected: Boolean(a),
        alias: a?.alias ?? null,
        expires: a?.expires ?? null,
        connected_at: a?.connected_at ?? null,
        sync: sync.results[0]?.value ? JSON.parse(sync.results[0].value) : null,
        sales: sales.results[0] ?? { n: 0 },
      };
    }
    default:
      throw new Error("Okänd op");
  }
}
