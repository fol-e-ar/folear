PRAGMA foreign_keys = OFF;

ALTER TABLE piece_coplas RENAME TO piece_coplas_old;

CREATE TABLE piece_coplas (
  piece_id INTEGER NOT NULL,
  copla_id INTEGER,
  inline_text TEXT,
  position INTEGER NOT NULL,
  section_label TEXT,
  role TEXT NOT NULL DEFAULT 'copla',
  notes TEXT,
  CHECK (copla_id IS NOT NULL OR COALESCE(length(trim(inline_text)), 0) > 0),
  PRIMARY KEY (piece_id, position),
  FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
  FOREIGN KEY (copla_id) REFERENCES coplas(id) ON DELETE CASCADE
);

INSERT INTO piece_coplas (
  piece_id, copla_id, inline_text, position, section_label, role, notes
)
SELECT
  piece_id, copla_id, NULL, position, section_label, 'copla', notes
FROM piece_coplas_old;

DROP TABLE piece_coplas_old;

PRAGMA foreign_keys = ON;
