-- Marknadsdatabasen (Cloudflare D1, SQLite). Samma fält som flikarna Säljare och
-- Marknad i Google Sheet, plus prishistorik. Körs av deploy-flödet
-- (wrangler d1 migrations apply) innan workern deployas.

CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  alias TEXT,
  watched INTEGER,           -- 1 = bevakas varje natt
  niches TEXT,               -- t.ex. "djur,smurfar"
  listings_found INTEGER,    -- annonser i nischen när säljaren hittades
  active INTEGER,
  ended INTEGER,
  number_share INTEGER,      -- % av annonserna med modellnummer
  rating REAL,
  added_at TEXT,
  collected_at TEXT,
  in_db INTEGER,
  sold_in_db INTEGER,
  error TEXT
);

-- En rad per Tradera-annons, uppdateras vid varje insamling.
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  seller TEXT,
  seller_id TEXT,
  title TEXT,
  model_number TEXT,
  number_source TEXT,        -- rubrik / text
  type TEXT,                 -- auktion / köp nu / butik
  status TEXT,               -- Aktiv / Såld / Osåld
  price INTEGER,
  first_price INTEGER,
  lowest_price INTEGER,
  price_changes INTEGER,
  bids INTEGER,
  shipping INTEGER,
  condition TEXT,
  start_at TEXT,
  end_at TEXT,
  days INTEGER,
  restarts INTEGER,
  url TEXT,
  first_seen TEXT,
  last_seen TEXT,
  sold_seen TEXT,            -- när vi upptäckte att den sålts
  text TEXT,
  niche TEXT,
  category_id INTEGER        -- Traderas kategori (fylls i när alla kategorier samlas in)
);
CREATE INDEX IF NOT EXISTS listings_seller ON listings (seller_id);
CREATE INDEX IF NOT EXISTS listings_niche_status ON listings (niche, status);
CREATE INDEX IF NOT EXISTS listings_model ON listings (model_number);

-- Varje pris vi sett för en annons (första priset + varje ändring).
CREATE TABLE IF NOT EXISTS price_history (
  listing_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  price INTEGER NOT NULL,
  PRIMARY KEY (listing_id, seen_at)
);
