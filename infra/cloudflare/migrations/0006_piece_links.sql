-- Fol e ar · 0006: ligazóns a recursos externos nas pezas das persoas.
-- Aditiva e idempotente (pódese repetir sen dano). Non toca ningún dato existente.
-- As ligazóns viven coa peza: se a peza é privada, as súas ligazóns tamén; se se
-- borra, bórranse con ela. Non entran no inventario público de recursos (media).

CREATE TABLE IF NOT EXISTS piece_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_id INTEGER NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_piece_links_piece ON piece_links(piece_id, position);
