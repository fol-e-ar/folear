-- Fol e ar · seed de 'coplas' xerado desde data/db/coplas.sqlite
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
INSERT INTO coplas (id, text, normalized_text, incipit, notes, status, territory_state, created_at, updated_at) VALUES (2, 'O páxaro cando neva
mete o rabo na silveira
así fan as boas mozas
cando non hai quen as queira.', 'o paxaro cando neva mete o rabo na silveira asi fan as boas mozas cando non hai quen as queira.', 'O páxaro cando neva mete o', NULL, 'published', 'assigned', '2026-03-25 20:37:25', '2026-03-25 20:37:25');
INSERT INTO coplas (id, text, normalized_text, incipit, notes, status, territory_state, created_at, updated_at) VALUES (3, 'Non chas quero, non chas quero
nabizas do teu nabal-e
non chas quero, non chas quero
que me poden facer mal-e.', 'non chas quero, non chas quero nabizas do teu nabal-e non chas quero, non chas quero que me poden facer mal-e.', 'Non chas quero, non chas quero', NULL, 'published', 'assigned', '2026-03-25 21:48:48', '2026-03-25 21:48:48');
INSERT INTO coplas (id, text, normalized_text, incipit, notes, status, territory_state, created_at, updated_at) VALUES (4, 'De onde son aqueles mozos
de onde son de onde serán?
Son da parroquia de Cambre
daquela terriña chan.', 'de onde son aqueles mozos de onde son de onde seran? son da parroquia de cambre daquela terrina chan.', 'De onde son aqueles mozos de', NULL, 'published', 'assigned', '2026-08-25 03:08:06', '2026-08-25 03:08:06');
INSERT INTO coplas (id, text, normalized_text, incipit, notes, status, territory_state, created_at, updated_at) VALUES (5, 'Costureiriña bonita,
onde tes a túa cama?
No poleiro das galiñas,
nunha feixiña de palla', 'costureirina bonita, onde tes a tua cama? no poleiro das galinas, nunha feixina de palla', 'Costureiriña bonita, onde tes a túa', NULL, 'published', 'assigned', '2026-08-25 22:49:31', '2026-08-25 22:49:31');
INSERT INTO coplas (id, text, normalized_text, incipit, notes, status, territory_state, created_at, updated_at) VALUES (6, 'Costureiriña bonita,
Onde tes os teus vestidos?
Téñoos gardados na hucha
para poñer os domingos.', 'costureirina bonita, onde tes os teus vestidos? tenoos gardados na hucha para poner os domingos.', 'Costureiriña bonita, Onde tes os teus', NULL, 'published', 'assigned', '2026-08-25 22:54:36', '2026-08-25 22:54:36');
COMMIT;
