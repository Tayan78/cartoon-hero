-- Ditt Tradera-konto: nyckeln (token) som du godkänt via Traderas inloggning, och
-- dina försäljningar med det verkliga priset (även accepterade prisförslag).
-- Köparens namn och adress sparas aldrig.

CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,      -- t.ex. tradera_user
  value TEXT,                -- JSON
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS own_sales (
  order_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,     -- annons-id på Tradera
  title TEXT,
  quantity INTEGER,
  unit_price INTEGER,        -- vad köparen faktiskt betalade per styck
  order_total INTEGER,       -- orderns delsumma (alla objekt, utan frakt)
  shipping_cost INTEGER,     -- frakt som köparen betalade för ordern
  shipping_type TEXT,
  paid_amount INTEGER,
  paid_at TEXT,
  created_at TEXT,           -- när ordern skapades (= såld)
  updated_at TEXT,
  PRIMARY KEY (order_id, item_id)
);
CREATE INDEX IF NOT EXISTS own_sales_item ON own_sales (item_id);
CREATE INDEX IF NOT EXISTS own_sales_created ON own_sales (created_at);
