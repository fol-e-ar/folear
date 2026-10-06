#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "db" / "coplas.sqlite"


def fetch_copla(conn, copla_id: int):
    return conn.execute(
        """
        SELECT id, text, incipit, notes, created_at
        FROM coplas
        WHERE id = ?
        """,
        (copla_id,),
    ).fetchone()


def fetch_territories(conn, copla_id: int):
    return conn.execute(
        """
        SELECT t.id, t.nome, t.tipo
        FROM copla_territories ct
        JOIN territories t ON t.id = ct.territory_id
        WHERE ct.copla_id = ?
        ORDER BY t.tipo, t.nome
        """,
        (copla_id,),
    ).fetchall()


def fetch_tags(conn, copla_id: int):
    return conn.execute(
        """
        SELECT tg.name
        FROM copla_tags ct
        JOIN tags tg ON tg.id = ct.tag_id
        WHERE ct.copla_id = ?
        ORDER BY tg.name
        """,
        (copla_id,),
    ).fetchall()


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        raw = input("ID da copla a borrar: ").strip()
        if not raw.isdigit():
            print("ID non válido.")
            return

        copla_id = int(raw)
        copla = fetch_copla(conn, copla_id)

        if not copla:
            print("Non existe ningunha copla con ese ID.")
            return

        territories = fetch_territories(conn, copla_id)
        tags = fetch_tags(conn, copla_id)

        print("\n=== Copla atopada ===\n")
        print(f"ID: {copla['id']}")
        print(f"Incipit: {copla['incipit'] or '(sen incipit)'}")
        print("Texto:")
        print(copla["text"])
        print(f"\nNotas: {copla['notes'] or 'sen notas'}")
        print(f"Creada: {copla['created_at']}")

        if territories:
            print("\nTerritorios:")
            for t in territories:
                print(f"- {t['nome']} [{t['tipo']}] ({t['id']})")
        else:
            print("\nTerritorios: sen territorio")

        if tags:
            print("\nEtiquetas:")
            for t in tags:
                print(f"- {t['name']}")
        else:
            print("\nEtiquetas: sen etiquetas")

        confirm = input("\nSeguro que queres borrar esta copla? [s/N]: ").strip().lower()
        if confirm != "s":
            print("Operación cancelada.")
            return

        conn.execute("DELETE FROM coplas WHERE id = ?", (copla_id,))
        conn.commit()

        print(f"\nCopla #{copla_id} borrada correctamente.")
        print("As relacións territoriais e etiquetas asociadas elimináronse tamén.")

    finally:
        conn.close()


if __name__ == "__main__":
    main()