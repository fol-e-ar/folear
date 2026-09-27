-- 007: engade "úsase como volta" ás coplas e unha táboa de trazos/características
-- de territorio (para poder documentar cousas como "tócase lata", "báilase maneo",
-- "gheada", etc. a calquera nivel territorial, con herdanza calculada no frontend).
--
-- A columna is_volta engádese de forma defensiva desde Python (db.py), non aquí,
-- porque SQLite non soporta "ALTER TABLE ... ADD COLUMN IF NOT EXISTS".

CREATE TABLE IF NOT EXISTS territory_traits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  territory_id TEXT NOT NULL,
  trait TEXT NOT NULL,
  category TEXT,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_territory_traits_territory ON territory_traits(territory_id);
