-- Dina annonser (Fota → Granska → Godkänd → Exporterad), tidigare fliken Annonser
-- i Google Sheet. Bilderna ligger i R2 (loppis-bilder), här bara deras nycklar.
CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,          -- appens id, t.ex. G1730000000000
  created_at TEXT,
  updated_at TEXT,
  status TEXT,                  -- Laddar upp / Väntar / Bearbetas / Klar / Godkänd / Exporterad / Fel
  note TEXT,
  settings TEXT,                -- appens inställningar när annonsen skickades (JSON)
  purchase_id INTEGER,
  images TEXT,                  -- JSON-lista: R2-nycklar (ads/<id>/<n>.jpg) eller äldre länkar
  title TEXT,
  description TEXT,
  price INTEGER,
  channel TEXT,
  model_number TEXT,
  confirmed TEXT,               -- modellnummer du valt
  name TEXT,
  brand TEXT,
  category TEXT,
  price_basis TEXT,
  cost_sek REAL,
  error TEXT,
  result TEXT,                  -- AI:ns hela svar (JSON)
  in_inventory INTEGER,
  exported_at TEXT,
  source TEXT                   -- app / ark (kopierad från Google Sheet)
);
CREATE INDEX IF NOT EXISTS ads_status ON ads (status, updated_at);
