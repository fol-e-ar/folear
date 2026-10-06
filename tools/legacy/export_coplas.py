#!/usr/bin/env python3
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.db import connect, migrate
from backend.services.db_paths import COPLAS_EXPORT_JSON
from backend.services.exporters import ensure_export_dirs, export_coplas, write_json


if __name__ == "__main__":
    migrate()
    ensure_export_dirs()

    conn = connect()
    try:
        payload = export_coplas(conn)
    finally:
        conn.close()

    write_json(COPLAS_EXPORT_JSON, payload)
    print(f"Exportadas {len(payload)} coplas a {COPLAS_EXPORT_JSON}")
