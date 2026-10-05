from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT / "backend"
SCHEMA_DIR = BACKEND_DIR / "schema"
TOOLS_DIR = ROOT / "tools"
DOCS_DIR = ROOT / "docs"
DATA_DIR = ROOT / "data"

DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"
DB_DIR = DATA_DIR / "db"
CANONICAL_DIR = DATA_DIR / "canonical"
EXPORTS_DIR = DATA_DIR / "exports"

TERRITORIOS_JSON = CANONICAL_DIR / "territorios.json"
TERRITORIES_EXPORT_DIR = EXPORTS_DIR / "territorios"
TERRITORIES_EXPORT_JSON = TERRITORIES_EXPORT_DIR / "territorios.json"

COPLAS_EXPORT_DIR = EXPORTS_DIR / "coplas"
COPLAS_EXPORT_JSON = COPLAS_EXPORT_DIR / "coplas.json"

PIECES_EXPORT_DIR = EXPORTS_DIR / "pezas"
PIECES_EXPORT_JSON = PIECES_EXPORT_DIR / "pezas.json"

MEDIA_EXPORT_DIR = EXPORTS_DIR / "media"
MEDIA_EXPORT_JSON = MEDIA_EXPORT_DIR / "media.json"

MELODIES_EXPORT_DIR = EXPORTS_DIR / "melodias"
MELODIES_EXPORT_JSON = MELODIES_EXPORT_DIR / "melodias.json"
