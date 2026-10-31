-- Översikten i appen: körningar (de senaste per typ) och anrop per dygn.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,          -- marknad / schleich / …
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,                 -- Pågår / Klar / Fel: …
  summary TEXT
);
CREATE INDEX IF NOT EXISTS runs_name ON runs (name, started_at);

-- Anrop per dygn och tjänst (tradera_search, tradera_item, gemini, serpapi,
-- d1_rows, notis_telegram …). Räknas ihop i minnet och skrivs samlat.
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  api TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, api)
);
