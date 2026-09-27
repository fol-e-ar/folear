-- Fol e ar · seed de 'tags' xerado desde data/db/coplas.sqlite
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
INSERT INTO tags (id, name, slug) VALUES (1, 'paxaro', 'paxaro');
INSERT INTO tags (id, name, slug) VALUES (2, 'amor', 'amor');
INSERT INTO tags (id, name, slug) VALUES (3, 'diñeiro', 'dineiro');
INSERT INTO tags (id, name, slug) VALUES (4, 'paxaros', 'paxaros');
INSERT INTO tags (id, name, slug) VALUES (5, 'horta', 'horta');
INSERT INTO tags (id, name, slug) VALUES (6, 'enfermidade', 'enfermidade');
INSERT INTO tags (id, name, slug) VALUES (7, 'lingua-galego', 'lingua-galego');
COMMIT;
