#!/usr/bin/env python3
import sqlite3
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.text_utils import make_incipit, normalize_text, slugify


def search_territories(conn, query: str):
    query = query.strip().lower()

    if query.isdigit():
        rows = conn.execute(
            """
            SELECT id, tipo, cod, nome
            FROM territories
            WHERE cod = ?
            ORDER BY tipo, nome
            """,
            (int(query),),
        ).fetchall()
        return rows

    like_query = f"%{query}%"
    rows = conn.execute(
        """
        SELECT id, tipo, cod, nome
        FROM territories
        WHERE lower(nome) LIKE ?
           OR lower(search) LIKE ?
           OR lower(id) LIKE ?
           OR CAST(cod AS TEXT) LIKE ?
        ORDER BY tipo, nome
        """,
        (like_query, like_query, like_query, like_query),
    ).fetchall()
    return rows


def get_or_create_tag(conn, tag_name: str) -> int:
    existing = conn.execute(
        "SELECT id FROM tags WHERE name = ?",
        (tag_name,),
    ).fetchone()

    if existing:
        return existing["id"]

    cur = conn.execute(
        """
        INSERT INTO tags (name, slug)
        VALUES (?, ?)
        """,
        (tag_name, slugify(tag_name)),
    )
    return cur.lastrowid


def choose_multiple_territories(conn):
    selected = []

    territory_choice = input("Queres engadir territorio(s)? [s/N]: ").strip().lower()
    if territory_choice != "s":
        return selected

    while True:
        print("\nTerritorios xa seleccionados:")
        if selected:
            for i, item in enumerate(selected, start=1):
                print(f"  {i}. {item['nome']} [{item['tipo']}] ({item['id']}, cod={item['cod']})")
        else:
            print("  ningún")

        query = input("\nBusca territorio por nome, ID ou código (Enter para rematar): ").strip()
        if not query:
            break

        matches = search_territories(conn, query)

        if not matches:
            print("Non se atoparon territorios.")
            continue

        print("\nTerritorios atopados:")
        shown = matches[:20]
        for i, row in enumerate(shown, start=1):
            print(f"{i}. {row['nome']} [{row['tipo']}] ({row['id']}, cod={row['cod']})")

        choice = input("\nEscolle número (ou Enter para volver buscar): ").strip()
        if not choice:
            continue

        if not choice.isdigit():
            print("Selección non válida.")
            continue

        idx = int(choice) - 1
        if idx < 0 or idx >= len(shown):
            print("Selección fóra de rango.")
            continue

        picked = shown[idx]

        if any(item["id"] == picked["id"] for item in selected):
            print("Ese territorio xa estaba engadido.")
            continue

        selected.append(picked)
        print(f"Engadido: {picked['nome']} [{picked['tipo']}]")

    return selected


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        print("\n=== Engadir copla ===\n")

        print("Texto da copla (remata cunha liña baleira):")
        lines = []
        while True:
            line = input()
            if line == "":
                break
            lines.append(line)

        text = "\n".join(lines).strip()

        if not text:
            print("Non se pode gardar unha copla baleira.")
            return

        normalized_text = normalize_text(text)
        incipit = make_incipit(text)
        notes = input("Notas (opcional): ").strip()

        selected_territories = choose_multiple_territories(conn)

        raw_tags = input("Etiquetas (separadas por comas, opcional): ").strip()
        tags = []
        if raw_tags:
            tags = [t.strip().lower() for t in raw_tags.split(",") if t.strip()]

        print("\nResumo:")
        print(f"- Copla:\n{text}")
        print(f"- Normalizada: {normalized_text}")
        print(f"- Incipit: {incipit}")

        if selected_territories:
            print("- Territorios:")
            for t in selected_territories:
                print(f"  - {t['nome']} [{t['tipo']}] ({t['id']})")
        else:
            print("- Territorios: sen territorio")

        print(f"- Etiquetas: {', '.join(tags) if tags else 'sen etiquetas'}")
        print(f"- Notas: {notes or 'sen notas'}")

        confirm = input("\nGardar? [s/N]: ").strip().lower()
        if confirm != "s":
            print("Operación cancelada.")
            return

        cur = conn.execute(
            """
            INSERT INTO coplas (text, normalized_text, incipit, notes, status, updated_at)
            VALUES (?, ?, ?, ?, 'published', CURRENT_TIMESTAMP)
            """,
            (text, normalized_text, incipit, notes or None),
        )
        copla_id = cur.lastrowid

        for territory in selected_territories:
            conn.execute(
                """
                INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct)
                VALUES (?, ?, 'direct', 1)
                """,
                (copla_id, territory["id"]),
            )

        for tag_name in tags:
            tag_id = get_or_create_tag(conn, tag_name)
            conn.execute(
                """
                INSERT OR IGNORE INTO copla_tags (copla_id, tag_id)
                VALUES (?, ?)
                """,
                (copla_id, tag_id),
            )

        conn.commit()
        print(f"\nCopla gardada con id {copla_id}.")

    finally:
        conn.close()


if __name__ == "__main__":
    main()
