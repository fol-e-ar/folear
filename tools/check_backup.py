#!/usr/bin/env python3
"""Comproba que un dump SQL da D1 (wrangler d1 export) se pode restaurar e cantos datos leva.

Carga o dump nunha SQLite en memoria (non toca ningunha base real) e amosa o
reconto das táboas principais. Sae con código 1 se algo falla.

    python3 tools/check_backup.py ruta/ao/dump.sql
"""
import sqlite3
import sys
from pathlib import Path

KEY_TABLES = [
    "territories", "coplas", "copla_versions", "tags", "media", "media_links",
    "melodies", "pieces", "piece_coplas", "piece_links", "users", "profiles", "favorites", "follows",
]
MIN_ROWS = {"territories": 1, "coplas": 1}


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    path = Path(argv[1])
    if not path.is_file():
        print(f"Non existe {path}")
        return 1
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript(path.read_text(encoding="utf-8"))
    except sqlite3.Error as exc:
        print(f"ERRO restaurando o dump: {exc}")
        return 1
    existing = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    bad = False
    for table in KEY_TABLES:
        if table not in existing:
            print(f"  {table:<16} (non existe)")
            continue
        count = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        flag = ""
        if count < MIN_ROWS.get(table, 0):
            flag = "  <-- BALEIRA"
            bad = True
        print(f"  {table:<16} {count:>7}{flag}")
    orphans = conn.execute("PRAGMA foreign_key_check").fetchall()
    print(f"Filas orfas (foreign_key_check): {len(orphans)}")
    print("Copia VÁLIDA" if not bad else "Copia SOSPEITOSA")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
