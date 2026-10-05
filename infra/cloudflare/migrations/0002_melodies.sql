-- Fol e ar · D1 (migración 0002): inventario de melodías.
--
-- Espello de backend/schema/008_melodies.sql (SQLite local). Unha melodía é un
-- ritmo + un número dentro dese ritmo e dese lugar, rexistrada no territorio
-- máis baixo no que se documenta; o nome ("Xota número 1 de Moscoso") calcúlase
-- a partir deses datos. A relación con media (moitos a moitos) reutiliza
-- media_links con entity_type = 'melody' e entity_id = melodies.id.
--
-- É aditiva e idempotente (IF NOT EXISTS): pódese executar máis dunha vez.

CREATE TABLE IF NOT EXISTS melodies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  territory_id TEXT NOT NULL,
  rhythm TEXT NOT NULL,
  rhythm_key TEXT NOT NULL,
  number INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (territory_id) REFERENCES territories(id) ON DELETE CASCADE,
  UNIQUE (territory_id, rhythm_key, number)
);

CREATE INDEX IF NOT EXISTS idx_melodies_territory ON melodies(territory_id);
