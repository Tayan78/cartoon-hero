-- Schleich-serie (bayala, eldrador, wizarding_world …), kommaseparerad. Sätts från
-- rubrik + text (lib/series.js) och kan räknas om.
ALTER TABLE listings ADD COLUMN series TEXT;
CREATE INDEX IF NOT EXISTS listings_series ON listings (series);
