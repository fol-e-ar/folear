-- 0004 · perfís, favoritos e versión de datos (aditiva, sen borrar nada)
--
-- profiles: unha fila por persoa, creada só cando a persoa garda o seu perfil.
--   handle        enderezo curto único (minúsculas, números e guións); NULL ata que o elixe.
--   display_name  nome que se amosa; por defecto non se usa o nome de Google.
--   territory_id  lugar opcional (referencia a territories.id).
--   is_public     0 = perfil privado (valor por defecto); 1 = aparece no directorio e ten páxina propia.
--   show_favorites 0/1: amosar os favoritos no perfil público.
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  territory_id TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  show_favorites INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_profiles_public ON profiles(is_public, display_name);

-- favorites: táboa xenérica (kind = copla | territory | tag | media | melody | piece).
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, kind, ref)
);

-- site_meta: pequenos valores do sitio. data_version sobe con cada escritura de
-- coplas, recursos ou melodías e serve para cachear os exportes públicos
-- (ETag + caché do bordo) sen perder frescura.
CREATE TABLE IF NOT EXISTS site_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO site_meta (key, value) VALUES ('data_version', '1');
