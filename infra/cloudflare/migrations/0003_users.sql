-- Fol e ar · D1 (migración 0003): persoas usuarias e sesións (login con Google).
--
-- Aditiva e idempotente (IF NOT EXISTS): pódese executar máis dunha vez e non
-- toca ningunha táboa existente. Tres roles:
--   foleante: consulta e terá o seu espazo persoal (favoritos, pezas propias)
--   guia:     da de alta, edita e borra coplas, recursos e melodías
--   admin:    ademais, reparte roles
-- Das persoas con Google só se garda o identificador de Google (sub), o correo,
-- o nome e a foto que Google devolve. Do token de sesión só se garda o hash.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  role TEXT NOT NULL DEFAULT 'foleante' CHECK (role IN ('foleante', 'guia', 'admin')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
