-- Fol e ar · baseline do rexistro de migracións de Wrangler.
--
-- As migracións 0001-0005 aplicáronse a man con `wrangler d1 execute --file`, así
-- que a D1 de produción non ten constancia delas. Este script crea a táboa
-- `d1_migrations` (a que usa `wrangler d1 migrations apply`) e marca 0001-0005
-- como aplicadas, para que a partir de agora `migrations apply` só execute as novas
-- (0006, 0007...). É idempotente: pódese repetir sen dano.
--
--   npx wrangler d1 execute fol-e-ar-db --remote --file=scripts/baseline_migrations.sql
--
-- Execútase UNHA vez, despois de aplicar a 0005 (xa feito) e antes do primeiro
-- `wrangler d1 migrations apply`.

CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_init.sql'),
  ('0002_melodies.sql'),
  ('0003_users.sql'),
  ('0004_profiles.sql'),
  ('0005_pieces_and_follows.sql');
