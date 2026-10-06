-- Fol e ar · 0008: os recursos ligados ás pezas pasan a ser recursos de Media.
--
-- Cada recurso dunha peza é unha fila de `media` (con datos completos: título, plataforma,
-- tipo, fonte, miniatura...) ligada á peza en `media_links` e marcada coa peza que a creou
-- (`piece_id`), a súa dona (`owner_user_id`) e a visibilidade (`visibility`: 'public' ou
-- 'private'; segue a da peza). A Media pública só amosa as públicas; cada persoa ve as
-- súas privadas (/api/me/media).
--
-- Aditiva: só engade columnas e copia as ligazóns que xa había en `piece_links` (a táboa
-- queda como está, sen borrar nada). Sen esta migración a web segue funcionando coma antes.

ALTER TABLE media ADD COLUMN owner_user_id INTEGER;
ALTER TABLE media ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE media ADD COLUMN piece_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_media_piece ON media(piece_id);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_user_id);

-- As ligazóns xa gardadas pasan a Media (non se perde ningunha).
INSERT INTO media (provider, media_kind, title, url, status, owner_user_id, visibility, piece_id, updated_at)
SELECT k.kind, k.kind, pl.title, pl.url, 'published', p.owner_user_id, COALESCE(p.visibility, 'public'), pl.piece_id, CURRENT_TIMESTAMP
FROM piece_links pl
JOIN (
  SELECT id, CASE
    WHEN url LIKE '%youtube.com%' OR url LIKE '%youtu.be%' THEN 'youtube'
    WHEN url LIKE '%open.spotify.com%' THEN 'spotify'
    WHEN url LIKE '%soundcloud.com%' THEN 'soundcloud'
    WHEN lower(url) LIKE '%.mp3' OR lower(url) LIKE '%.ogg' OR lower(url) LIKE '%.wav' OR lower(url) LIKE '%.m4a' THEN 'audio'
    WHEN lower(url) LIKE '%.pdf' THEN 'pdf'
    ELSE 'web' END AS kind
  FROM piece_links
) k ON k.id = pl.id
JOIN pieces p ON p.id = pl.piece_id
WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.piece_id = pl.piece_id AND m.url = pl.url)
ORDER BY pl.piece_id, pl.position;

INSERT OR IGNORE INTO media_links (media_id, entity_type, entity_id, relation_type)
SELECT id, 'piece', CAST(piece_id AS TEXT), 'documental' FROM media WHERE piece_id IS NOT NULL;
