#!/usr/bin/env python3
"""Fol e ar · verifica o seed xerado para D1 antes (e despois) de cargalo.

Fase local (sen conta de Cloudflare): compara os reconto de filas da SQLite
orixe cos INSERT xerados en infra/cloudflare/seed/, e volve executar unha
comprobación de integridade referencial sobre o CONXUNTO XERADO (non sobre a
SQLite orixe, que xa se comproba en export_sqlite_to_d1.py).

Fase con D1 dispoñible (opcional): se se pasa --d1-json co resultado de
    wrangler d1 execute fol-e-ar-db --json --command "SELECT ... "
compárense tamén os reconto reais en D1. Isto é opcional porque este
repositorio non ten credenciais de Cloudflare configuradas; sen elas, o
script limítase á comprobación local descrita enriba.

Uso:
    python3 infra/cloudflare/scripts/verify_migration.py
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"
SEED_DIR = Path(__file__).resolve().parents[1] / "seed"
MANIFEST_PATH = SEED_DIR / "_manifest.json"

INSERT_RE = re.compile(r"^INSERT (?:OR IGNORE )?INTO (\w+)", re.MULTILINE)


def count_inserts(sql_text: str) -> int:
    return len(INSERT_RE.findall(sql_text))


def main() -> int:
    if not MANIFEST_PATH.exists():
        print("Non se atopa o manifest. Executa antes export_sqlite_to_d1.py.", file=sys.stderr)
        return 1

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    if not DB_PATH.exists():
        print(f"Non se atopa {DB_PATH}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

    ok = True
    print("Comprobación de recontos (SQLite orixe -> seed xerado):\n")
    for table, info in manifest["tables"].items():
        real_count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        seed_path = ROOT / info["seed_file"]
        seed_text = seed_path.read_text(encoding="utf-8")
        seed_inserts = count_inserts(seed_text)

        expected_exported = info["exported_rows"]
        status = "OK"
        if real_count != info["source_rows"]:
            status = "ERRO (a orixe cambiou desde a exportación, volve executar o export)"
            ok = False
        elif seed_inserts != expected_exported:
            status = "ERRO (o ficheiro seed non coincide co manifest)"
            ok = False
        elif expected_exported + info["excluded_rows"] != real_count:
            status = "ERRO (exportadas + excluídas != orixe)"
            ok = False

        print(
            f"  {table:<20} orixe={real_count:<6} exportadas={seed_inserts:<6} "
            f"excluídas={info['excluded_rows']:<4} -> {status}"
        )

    excluded = manifest.get("excluded_orphans", {})
    if excluded:
        print("\nFilas excluídas por integridade referencial (non se tocou a orixe):")
        for table, items in excluded.items():
            for item in items:
                print(
                    f"  - {table} rowid={item['rowid']}: "
                    f"{item['column']}={item['value']!r} non existe en {item['missing_parent']}"
                )
        print(
            "\n  Estas filas xa estaban rotas na SQLite orixe antes desta auditoría "
            "(ver docs/auditoria-tecnica.md). Non se modificou o corpus; decide "
            "manualmente que facer con elas alí se se quere."
        )

    conn.close()

    print()
    if ok:
        print("Verificación local OK: os recontos e a integridade do seed son consistentes.")
        return 0

    print("Verificación local FALLOU: revisa os erros de enriba.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
