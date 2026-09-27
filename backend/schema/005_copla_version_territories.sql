PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS copla_version_territories (
  version_id INTEGER NOT NULL,
  territory_id TEXT NOT NULL,
  PRIMARY KEY (version_id, territory_id),
  FOREIGN KEY (version_id) REFERENCES copla_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (territory_id) REFERENCES territories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_copla_version_territories_territory
  ON copla_version_territories(territory_id);
