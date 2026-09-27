-- Fol e ar · seed de 'copla_tags' xerado desde data/db/coplas.sqlite
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
INSERT INTO copla_tags (copla_id, tag_id) VALUES (2, 2);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (2, 3);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (2, 4);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (3, 5);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (3, 2);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (3, 6);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (5, 7);
INSERT INTO copla_tags (copla_id, tag_id) VALUES (6, 7);
COMMIT;
