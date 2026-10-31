-- Dina egna affärer: inköp (partier, loppisfynd, gammalt lager) och de objekt
-- (annonser) som kommer från dem. Kopplingen görs när du fotar annonsen.
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  bought_at TEXT,              -- inköpsdatum (YYYY-MM-DD)
  source TEXT,                 -- tradera / loppis / blocket / vinted / annat / gammalt
  url TEXT,
  tradera_id TEXT,
  title TEXT,
  price INTEGER,               -- varupris
  shipping INTEGER,
  fees INTEGER,                -- köparskydd m.m.
  total_cost INTEGER,          -- allt du betalade
  item_count INTEGER,          -- antal figurer/objekt enligt annonsen
  thumbnail TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'öppen',  -- öppen (fotas) / klar
  legacy INTEGER NOT NULL DEFAULT 0      -- 1 = gammalt lager (utanför avkastningsstatistiken)
);

-- Ett objekt = en annons du fotat. id = appens annons-id (G…).
CREATE TABLE IF NOT EXISTS own_items (
  id TEXT PRIMARY KEY,
  purchase_id INTEGER,
  created_at TEXT,
  status TEXT,                 -- fotad / ute / såld / utgått / restparti
  title TEXT,
  model_number TEXT,
  expected_value INTEGER,      -- för fördelning av inköpskostnaden
  cost_share INTEGER,          -- objektets del av inköpskostnaden
  tradera_item_id TEXT,        -- din annons på Tradera när den kopplats
  sold_at TEXT,
  sold_price INTEGER,
  bundle_id TEXT,              -- restpartiet objektet såldes i
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS own_items_purchase ON own_items (purchase_id);

-- Ditt eget säljarkonto (samlas in som en bevakad säljare men är ingen konkurrent).
ALTER TABLE sellers ADD COLUMN own INTEGER;
