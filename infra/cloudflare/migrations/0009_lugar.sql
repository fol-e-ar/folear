-- Fol e ar · 0009: «lugar» (subdivisión dunha parroquia: Laxoso, Moscoso...).
--
-- Os lugares non existen como territorios (o mapa e os códigos oficiais chegan ata a
-- parroquia), así que se garda o nome como texto libre na copla e na peza, ligado ao
-- territorio (a parroquia) que xa teñen. Aditiva: só engade dúas columnas nulas.
-- Sen esta migración a web segue funcionando; o campo «lugar» simplemente non se garda.

ALTER TABLE coplas ADD COLUMN lugar TEXT;
ALTER TABLE pieces ADD COLUMN lugar TEXT;
