-- Fol e ar · seed de 'media' xerado desde data/db/coplas.sqlite
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
INSERT INTO media (id, provider, media_kind, title, url, description, author_or_source, thumbnail_url, status, created_at, updated_at) VALUES (1, 'youtube', 'youtube', 'Pandereteiras de Sequeiros (Pazos de Borbén - Pontevedra)', 'https://www.youtube.com/watch?v=D-euF54Mvb8&list=RDD-euF54Mvb8&start_radio=1', NULL, NULL, NULL, 'published', '2026-08-25 21:57:48', '2026-08-25 21:57:48');
INSERT INTO media (id, provider, media_kind, title, url, description, author_or_source, thumbnail_url, status, created_at, updated_at) VALUES (2, 'youtube', 'youtube', 'Xota 1', 'https://www.youtube.com/watch?v=DXZvFnz6WCc&list=RDDXZvFnz6WCc&start_radio=1', NULL, NULL, NULL, 'published', '2026-08-25 22:47:08', '2026-08-25 22:47:08');
INSERT INTO media (id, provider, media_kind, title, url, description, author_or_source, thumbnail_url, status, created_at, updated_at) VALUES (3, 'youtube', 'youtube', 'Mazurca 1', 'https://youtu.be/uN7-bEahHgA?si=jbn747fq9mTUHfXe', NULL, NULL, NULL, 'published', '2026-08-25 23:01:46', '2026-08-25 23:01:46');
COMMIT;
