#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
db_path = ROOT / "data" / "db" / "coplas.sqlite"

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
try:
    rows = conn.execute("SELECT id, tipo, nome, parent_id FROM territories ORDER BY tipo, nome").fetchall()
    for row in rows:
        print(dict(row))
finally:
    conn.close()
