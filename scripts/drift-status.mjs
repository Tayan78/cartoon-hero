// Driftläget ur D1 (bara läsning): senaste körningarna, dagens anrop, ditt konto,
// produktkopplingar och tabellstorlekar. Aldrig nycklar eller köparuppgifter.
import { execFileSync } from "node:child_process";

const q = (sql) => {
  try {
    const out = execFileSync("npx", ["--yes", "wrangler@4.150.0", "d1", "execute", "loppis", "--remote", "--json", "--command", sql], { cwd: "worker", maxBuffer: 64 * 1024 * 1024 }).toString();
    return JSON.parse(out)[0].results;
  } catch (err) {
    return [{ error: String(err.message).slice(0, 200) }];
  }
};
const report = {
  migrations: q("SELECT name, applied_at FROM d1_migrations ORDER BY id"),
  runs: q("SELECT name, started_at, finished_at, status, summary FROM runs ORDER BY started_at DESC LIMIT 15"),
  usage_today: q("SELECT day, api, count FROM usage WHERE day >= date('now', '-1 day') ORDER BY day, api"),
  own_seller: q("SELECT id, alias, watched, collected_at, in_db, sold_in_db FROM sellers WHERE own = 1"),
  own_listings: q("SELECT status, COUNT(*) AS n FROM listings WHERE seller_id IN (SELECT id FROM sellers WHERE own = 1) GROUP BY status"),
  own_auth: q("SELECT key, json_extract(value, '$.expires') AS expires, updated_at FROM app_secrets"),
  own_sales: q("SELECT COUNT(*) AS n FROM own_sales"),
  ads: q(`SELECT id, status, title, price, price_basis, model_number, confirmed, brand, name, category, error,
    json_extract(result, '$.flags') AS flags, json_extract(result, '$.market') AS market, json_extract(result, '$.article') AS article,
    json_extract(result, '$.candidates') AS candidates, json_extract(result, '$.sources') AS sources, json_extract(result, '$.for_sale') AS for_sale
    FROM ads ORDER BY created_at DESC LIMIT 5`),
  counts: q(`SELECT (SELECT COUNT(*) FROM listings) AS listings, (SELECT COUNT(*) FROM listing_products) AS linked,
    (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM categories) AS categories,
    (SELECT COUNT(*) FROM listings WHERE detail_at IS NOT NULL) AS detailed, (SELECT COUNT(*) FROM purchases) AS purchases`),
};
console.log(JSON.stringify(report, null, 2));
