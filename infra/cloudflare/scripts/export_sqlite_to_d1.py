#!/usr/bin/env python3
"""Fol e ar · exporta data/db/coplas.sqlite a SQL de seed para D1.

- NON modifica nin escribe na SQLite orixe (abrese en modo read-only).
- Preserva os IDs de todas as táboas (INSERT explícitos con `id`).
- Xera un ficheiro .sql por táboa en infra/cloudflare/seed/, na orde que
  respecta as foreign keys.
- Detecta e EXCLÚE filas que xa violan integridade referencial na orixe
  (por exemplo copla_tags apuntando a unha copla borrada), en vez de
  falsealas ou deixar que rompan a importación en D1. Cada exclusión
  queda rexistrada en seed/_manifest.json para que se poida decidir
  manualmente que facer con eses rexistros na SQLite orixe (fóra deste
  script, que nunca escribe alí).

Uso:
    python3 infra/cloudflare/scripts/export_sqlite_to_d1.py

Xera:
    infra/cloudflare/seed/01_territories.sql
    infra/cloudflare/seed/02_tags.sql
    infra/cloudflare/seed/03_coplas.sql
    infra/cloudflare/seed/04_copla_versions.sql
    infra/cloudflare/seed/05_copla_tags.sql
    infra/cloudflare/seed/06_copla_territories.sql
    infra/cloudflare/seed/07_pieces.sql
    infra/cloudflare/seed/08_piece_coplas.sql
    infra/cloudflare/seed/09_media.sql
    infra/cloudflare/seed/10_media_links.sql
    infra/cloudflare/seed/_manifest.json

Para cargar en D1 local:
    wrangler d1 execute fol-e-ar-db --local --file=infra/cloudflare/migrations/0001_init.sql
    for f in infra/cloudflare/seed/*.sql; do
      wrangler d1 execute fol-e-ar-db --local --file="$f"
    done
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"
SEED_DIR = Path(__file__).resolve().parents[1] / "seed"

TABLES = [
    ("01_territories", "territories", [
        "id", "tipo", "cod", "nome", "slug", "search",
        "prov_cod", "com_cod", "con_cod", "parent_id",
    ]),
    ("02_tags", "tags", ["id", "name", "slug"]),
    ("03_coplas", "coplas", [
        "id", "text", "normalized_text", "incipit", "notes", "status",
        "territory_state", "is_volta", "created_at", "updated_at",
    ]),
    ("04_copla_versions", "copla_versions", [
        "id", "copla_id", "label", "text", "normalized_text", "incipit",
        "notes", "position", "created_at", "updated_at",
    ]),
    ("05_copla_tags", "copla_tags", ["copla_id", "tag_id"]),
    ("06_copla_territories", "copla_territories", [
        "copla_id", "territory_id", "relation_type", "is_direct",
    ]),
    ("07_pieces", "pieces", [
        "id", "title", "slug", "author", "context_territory_id",
        "description", "notes", "status", "created_at", "updated_at",
    ]),
    ("08_piece_coplas", "piece_coplas", [
        "piece_id", "copla_id", "inline_text", "position", "section_label",
        "role", "notes",
    ]),
    ("09_media", "media", [
        "id", "provider", "media_kind", "title", "url", "description",
        "author_or_source", "thumbnail_url", "status", "created_at",
        "updated_at",
    ]),
    ("10_media_links", "media_links", [
        "media_id", "entity_type", "entity_id", "relation_type",
    ]),
    ("11_copla_version_territories", "copla_version_territories", [
        "version_id", "territory_id",
    ]),
    ("12_territory_traits", "territory_traits", [
        "id", "territory_id", "trait", "category", "notes",
        "created_at", "updated_at",
    ]),
    # Inventario de melodías (migración 0002 / backend 008). Só se exporta se
    # a SQLite orixe xa a ten (as bases anteriores á 008 non teñen a táboa).
    ("13_melodies", "melodies", [
        "id", "territory_id", "rhythm", "rhythm_key", "number", "notes",
        "created_at", "updated_at",
    ]),
]

OPTIONAL_TABLES = {"melodies"}


def sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    text = str(value)
    escaped = text.replace("'", "''")
    return f"'{escaped}'"


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def known_ids(conn: sqlite3.Connection, table: str, id_col: str = "id") -> set:
    return {row[0] for row in conn.execute(f"SELECT {id_col} FROM {table}")}


def find_orphans(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    """Mirror of PRAGMA foreign_key_check, but read-only and descriptive."""
    orphans: dict[str, list[dict]] = {}

    copla_ids = known_ids(conn, "coplas")
    tag_ids = known_ids(conn, "tags")
    territory_ids = known_ids(conn, "territories")
    piece_ids = known_ids(conn, "pieces")
    media_ids = known_ids(conn, "media")

    version_ids = known_ids(conn, "copla_versions")

    checks = [
        ("copla_tags", "copla_id", copla_ids, "coplas"),
        ("copla_tags", "tag_id", tag_ids, "tags"),
        ("copla_territories", "copla_id", copla_ids, "coplas"),
        ("copla_territories", "territory_id", territory_ids, "territories"),
        ("copla_versions", "copla_id", copla_ids, "coplas"),
        ("piece_coplas", "piece_id", piece_ids, "pieces"),
        ("piece_coplas", "copla_id", copla_ids, "coplas"),
        ("media_links", "media_id", media_ids, "media"),
        ("copla_version_territories", "version_id", version_ids, "copla_versions"),
        ("copla_version_territories", "territory_id", territory_ids, "territories"),
        ("territory_traits", "territory_id", territory_ids, "territories"),
    ]
    if table_exists(conn, "melodies"):
        checks.append(("melodies", "territory_id", territory_ids, "territories"))

    for table, col, valid_ids, parent in checks:
        rows = conn.execute(f"SELECT rowid AS _rowid_, * FROM {table}").fetchall()
        for row in rows:
            value = row[col]
            if value is not None and value not in valid_ids:
                orphans.setdefault(table, []).append(
                    {
                        "rowid": row["_rowid_"],
                        "column": col,
                        "value": value,
                        "missing_parent": parent,
                        "row": {k: row[k] for k in row.keys() if k != "rowid"},
                    }
                )
    return orphans


def export() -> None:
    if not DB_PATH.exists():
        print(f"Non se atopa {DB_PATH}", file=sys.stderr)
        raise SystemExit(1)

    SEED_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect_readonly(DB_PATH)

    orphans = find_orphans(conn)
    orphan_rowids: dict[str, set[int]] = {
        table: {item["rowid"] for item in items} for table, items in orphans.items()
    }

    manifest = {"tables": {}, "excluded_orphans": {}}

    for filename, table, columns in TABLES:
        if table in OPTIONAL_TABLES and not table_exists(conn, table):
            print(f"{table}: a SQLite orixe aínda non ten esta táboa, omítese.")
            continue
        rows = conn.execute(f"SELECT rowid AS _rowid_, * FROM {table}").fetchall()
        skip_rowids = orphan_rowids.get(table, set())

        lines = [
            f"-- Fol e ar · seed de '{table}' xerado desde data/db/coplas.sqlite",
            "PRAGMA foreign_keys = ON;",
        ]
        exported = 0
        for row in rows:
            if row["_rowid_"] in skip_rowids:
                continue
            values = ", ".join(sql_literal(row[c]) for c in columns)
            cols = ", ".join(columns)
            lines.append(f"INSERT OR IGNORE INTO {table} ({cols}) VALUES ({values});")
            exported += 1
        # Nota: sen BEGIN TRANSACTION/COMMIT explicitos a proposito -- D1 en
        # --remote rexeita eses statements SQL (require a sua API de JS para
        # transaccions). `wrangler d1 execute --file=...` xa trata cada
        # ficheiro coma unha soa unidade atomica.

        out_path = SEED_DIR / f"{filename}.sql"
        out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        manifest["tables"][table] = {
            "source_rows": len(rows),
            "exported_rows": exported,
            "excluded_rows": len(skip_rowids),
            "seed_file": str(out_path.relative_to(ROOT)),
        }
        if table in orphans:
            manifest["excluded_orphans"][table] = orphans[table]

        print(f"{table}: {exported} filas exportadas ({len(skip_rowids)} excluídas por integridade)")

    manifest_path = SEED_DIR / "_manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(f"\nManifest: {manifest_path.relative_to(ROOT)}")

    if orphans:
        print("\nAVISO: atopáronse filas orfas na SQLite orixe (non se tocou a orixe,")
        print("só se excluíron do seed xerado). Detalle completo en _manifest.json.")
        for table, items in orphans.items():
            print(f"  - {table}: {len(items)} fila(s)")

    conn.close()


if __name__ == "__main__":
    export()
