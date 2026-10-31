-- Grunden för produktstatistik: produkter, kopplingen annons ↔ produkt (flera
-- produkter per annons för paket), observationer över tid och kategorinamn.

-- En standardiserad produkt, t.ex. SCHLEICH-13729.
CREATE TABLE IF NOT EXISTS products (
  key TEXT PRIMARY KEY,
  brand TEXT,
  model_number TEXT,
  name TEXT,                   -- fylls i senare (vanligaste rubriken / AI)
  series TEXT,
  first_seen TEXT
);

-- Annons ↔ produkt. method: rubrik / text / ai; confidence 0–1; model_version
-- för AI-tolkningar. Rådatan i listings skrivs aldrig över av tolkningen.
CREATE TABLE IF NOT EXISTS listing_products (
  listing_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  method TEXT,
  confidence REAL,
  model_version TEXT,
  created_at TEXT,
  PRIMARY KEY (listing_id, product_key)
);
CREATE INDEX IF NOT EXISTS listing_products_product ON listing_products (product_key);

-- Annonsens läge vid varje observation där pris, bud eller status ändrats.
CREATE TABLE IF NOT EXISTS listing_snapshots (
  listing_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  price INTEGER,
  bids INTEGER,
  status TEXT,
  source TEXT,
  PRIMARY KEY (listing_id, seen_at)
);

-- Traderas kategorier (namn och sökväg till kategori-id:t i annonserna).
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT,
  parent_id INTEGER,
  path TEXT                    -- t.ex. "Leksaker > Figurer > Miniatyrer & leksaksfigurer"
);

-- Utgångsläget: en observation per annons som redan finns (sedan bara vid ändring).
INSERT OR IGNORE INTO listing_snapshots (listing_id, seen_at, price, bids, status, source)
  SELECT id, COALESCE(last_seen, first_seen, datetime('now')), price, bids, status, COALESCE(source, 'arket') FROM listings;
