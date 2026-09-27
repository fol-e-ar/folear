-- Fol e ar · seed de 'copla_territories' xerado desde data/db/coplas.sqlite
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct) VALUES (2, 'con:15052', 'direct', 1);
INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct) VALUES (3, 'par:1501711', 'direct', 1);
INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct) VALUES (4, 'par:1504303', 'direct', 1);
INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct) VALUES (5, 'par:3603704', 'direct', 1);
INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct) VALUES (6, 'par:3603704', 'direct', 1);
COMMIT;
