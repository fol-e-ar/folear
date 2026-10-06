#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

query = input("Buscar territorio: ").strip().lower()
rows = conn.execute(
    """
    SELECT id, tipo, nome
    FROM territories
    WHERE lower(nome) LIKE ?
       OR lower(search) LIKE ?
       OR lower(id) LIKE ?
    ORDER BY tipo, nome
    """,
    (f"%{query}%", f"%{query}%", f"%{query}%"),
).fetchall()

for row in rows:
    print(dict(row))

conn.close()