#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

try:
    rows = conn.execute(
        """
        SELECT
          c.id,
          c.incipit,
          c.text,
          t.nome AS territory_nome,
          t.id AS territory_id
        FROM coplas c
        LEFT JOIN copla_territories ct ON ct.copla_id = c.id
        LEFT JOIN territories t ON t.id = ct.territory_id
        ORDER BY c.id DESC
        """
    ).fetchall()

    for row in rows:
        print(dict(row))
finally:
    conn.close()