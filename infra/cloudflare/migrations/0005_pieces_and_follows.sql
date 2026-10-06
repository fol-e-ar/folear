-- 0005 · pezas con dono e visibilidade; seguir persoas (aditiva)
--
-- EXECÚTASE UNHA SÓ VEZ (os ALTER TABLE non son idempotentes: unha segunda
-- execución daría «duplicate column name», sen estragar nada).
--
-- pieces.owner_user_id  NULL = peza do arquivo (editorial, editable por guías);
--                       un id = peza dunha persoa (só ela a xestiona).
-- pieces.visibility     'public' (aparece na biblioteca) ou 'private' (só a dona).
--                       As pezas que xa existen quedan 'public', coma ata agora.
-- pieces.status         engádese o valor 'hidden': peza pública agochada por moderación.
ALTER TABLE pieces ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pieces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
CREATE INDEX IF NOT EXISTS idx_pieces_owner ON pieces(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_pieces_visibility ON pieces(visibility, status);

-- follows: unha persoa segue outros perfís públicos.
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
