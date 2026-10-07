-- Fol e ar · 0010: unha variante noutro territorio é outra copla.
--
-- Cando unha copla ten unha variante (copla_versions) adscrita a territorios que a copla principal
-- non ten, esa variante pasa a ser tamén unha copla propia (`coplas.variant_of` = a principal) nos
-- seus territorios, para que apareza nas buscas, listaxes e fichas dese territorio. As variantes
-- do mesmo territorio seguen sendo só variantes (non se duplica a copla). As fillas mantéñense
-- sincronizadas desde a principal cada vez que esta se garda (Worker: syncVariantCoplas).
--
-- Aditiva: unha columna nula e un índice. A parte final enche as fillas das variantes que xa existen.
-- Sen esta migración a web segue funcionando coma antes (sen coplas-variante).

ALTER TABLE coplas ADD COLUMN variant_of INTEGER REFERENCES coplas(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_coplas_variant_of ON coplas(variant_of);

-- 1) unha copla filla por cada variante con territorios que a principal non ten
INSERT INTO coplas (text, normalized_text, incipit, notes, status, territory_state, is_volta, variant_of, updated_at)
SELECT v.text, v.normalized_text, v.incipit, v.notes, c.status, 'assigned', c.is_volta, c.id, CURRENT_TIMESTAMP
FROM copla_versions v
JOIN coplas c ON c.id = v.copla_id
WHERE c.variant_of IS NULL
  AND EXISTS (
    SELECT 1 FROM copla_version_territories cvt
    WHERE cvt.version_id = v.id
      AND cvt.territory_id NOT IN (SELECT territory_id FROM copla_territories WHERE copla_id = c.id)
  )
  AND v.id = (SELECT MIN(v2.id) FROM copla_versions v2 WHERE v2.copla_id = v.copla_id AND v2.normalized_text = v.normalized_text);

-- 2) os seus territorios: os da variante que a principal non ten
INSERT OR IGNORE INTO copla_territories (copla_id, territory_id, relation_type, is_direct)
SELECT ch.id, cvt.territory_id, 'direct', 1
FROM coplas ch
JOIN copla_versions v ON v.copla_id = ch.variant_of AND v.normalized_text = ch.normalized_text
JOIN copla_version_territories cvt ON cvt.version_id = v.id
WHERE ch.variant_of IS NOT NULL
  AND cvt.territory_id NOT IN (SELECT territory_id FROM copla_territories WHERE copla_id = ch.variant_of);

-- 3) as etiquetas da principal
INSERT OR IGNORE INTO copla_tags (copla_id, tag_id)
SELECT ch.id, ct.tag_id
FROM coplas ch
JOIN copla_tags ct ON ct.copla_id = ch.variant_of
WHERE ch.variant_of IS NOT NULL;
