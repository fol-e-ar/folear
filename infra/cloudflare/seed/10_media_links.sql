-- Fol e ar · seed de 'media_links' xerado desde data/db/coplas.sqlite
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
INSERT INTO media_links (media_id, entity_type, entity_id, relation_type) VALUES (1, 'territory', 'par:3603702', 'direct');
INSERT INTO media_links (media_id, entity_type, entity_id, relation_type) VALUES (2, 'territory', 'par:3603704', 'documental');
INSERT INTO media_links (media_id, entity_type, entity_id, relation_type) VALUES (3, 'territory', 'par:3603704', 'mixed');
COMMIT;
