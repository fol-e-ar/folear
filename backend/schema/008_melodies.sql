-- 008: inventario de melodías.
--
-- Unha melodía é unha "peza musical abstracta" dun lugar: un ritmo (xota,
-- muiñeira...) máis un número dentro dese ritmo e dese lugar, rexistrada no
-- territorio MÁIS BAIXO no que se documenta. Non hai xerarquía propia: o nome
-- legible ("Xota número 1 de Moscoso") constrúese a partir de ritmo + número +
-- territorio, e é o que fai distinguibles as melodías ao subir a un
-- supraterritorio.
--
-- A relación coa media (moitos a moitos) reutiliza media_links con
-- entity_type = 'melody' e entity_id = melodies.id, igual que xa se fai coas
-- coplas e as pezas. Non se rompe nada existente.
--
-- rhythm_key é o ritmo normalizado (sen maiúsculas nin acentos) para que
-- "Xota", "xota" e "XOTA" sexan o mesmo ritmo ao numerar.

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
