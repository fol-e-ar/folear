import sqlite3
from collections import OrderedDict
from typing import Any


TYPE_LABELS = {
    "prov": "Provincia",
    "com": "Comarca",
    "con": "Concello",
    "par": "Parroquia",
}


def first_line(text: str | None) -> str:
    if not text:
        return ""
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def fetch_territory(conn: sqlite3.Connection, territory_id: str) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT id, tipo, cod, nome, slug, prov_cod, com_cod, con_cod, parent_id
        FROM territories
        WHERE id = ?
        """,
        (territory_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"Non existe o territorio {territory_id}.")
    return dict(row)


def territory_hierarchy(conn: sqlite3.Connection, territory: dict[str, Any]) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, tipo, nome, prov_cod, com_cod, con_cod
        FROM territories
        WHERE id = ?
           OR (tipo = 'prov' AND cod = ?)
           OR (tipo = 'com' AND cod = ?)
           OR (tipo = 'con' AND cod = ?)
        """,
        (
            territory["id"],
            territory.get("prov_cod"),
            territory.get("com_cod"),
            territory.get("con_cod"),
        ),
    ).fetchall()
    by_type = {row["tipo"]: dict(row) for row in rows}
    order = ["prov", "com", "con", "par"]
    return [by_type[tipo] for tipo in order if tipo in by_type]


def parent_council_name(conn: sqlite3.Connection, territory: dict[str, Any]) -> str:
    if territory.get("tipo") == "con":
        return territory.get("nome") or ""
    con_cod = territory.get("con_cod")
    if not con_cod:
        return ""
    row = conn.execute(
        "SELECT nome FROM territories WHERE tipo = 'con' AND cod = ? LIMIT 1",
        (con_cod,),
    ).fetchone()
    return row["nome"] if row else ""


def territory_label(conn: sqlite3.Connection, territory: dict[str, Any] | None) -> str:
    if not territory:
        return ""
    label = territory.get("nome") or ""
    if territory.get("tipo") == "par":
        council = parent_council_name(conn, territory)
        if council:
            label = f"{label} \\ {council}"
    return label


def territory_context(conn: sqlite3.Connection, territory: dict[str, Any]) -> str:
    parts = []
    for item in territory_hierarchy(conn, territory):
        tipo = TYPE_LABELS.get(item["tipo"], item["tipo"])
        parts.append(f"{tipo}: {item['nome']}")
    return " \\ ".join(parts)


def descendant_ids(conn: sqlite3.Connection, territory: dict[str, Any]) -> list[str]:
    tipo = territory["tipo"]
    if tipo == "prov":
        rows = conn.execute(
            """
            SELECT id FROM territories
            WHERE id = ? OR prov_cod = ?
            """,
            (territory["id"], territory["cod"]),
        ).fetchall()
    elif tipo == "com":
        rows = conn.execute(
            """
            SELECT id FROM territories
            WHERE id = ? OR com_cod = ?
            """,
            (territory["id"], territory["cod"]),
        ).fetchall()
    elif tipo == "con":
        rows = conn.execute(
            """
            SELECT id FROM territories
            WHERE id = ? OR con_cod = ?
            """,
            (territory["id"], territory["cod"]),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id FROM territories WHERE id = ?", (territory["id"],)).fetchall()
    return [row["id"] for row in rows]


def copla_territories(conn: sqlite3.Connection, copla_id: int) -> list[str]:
    rows = conn.execute(
        """
        SELECT t.id, t.tipo, t.nome, t.prov_cod, t.com_cod, t.con_cod
        FROM copla_territories ct
        JOIN territories t ON t.id = ct.territory_id
        WHERE ct.copla_id = ?
        ORDER BY t.tipo, t.nome
        """,
        (copla_id,),
    ).fetchall()
    return [territory_label(conn, dict(row)) for row in rows]


def fetch_copla(conn: sqlite3.Connection, copla_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT id, text, incipit, notes, territory_state
        FROM coplas
        WHERE id = ?
        """,
        (copla_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"Non existe a copla {copla_id}.")
    item = dict(row)
    item["incipit"] = item.get("incipit") or first_line(item.get("text"))
    item["territories"] = copla_territories(conn, copla_id)
    return item


def fetch_piece_sections(conn: sqlite3.Connection, piece_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT
          pc.position,
          pc.section_label,
          pc.notes,
          pc.role,
          c.id AS copla_id,
          COALESCE(NULLIF(pc.inline_text, ''), c.text) AS text,
          COALESCE(c.incipit, '') AS incipit
        FROM piece_coplas pc
        LEFT JOIN coplas c ON c.id = pc.copla_id
        WHERE pc.piece_id = ?
        ORDER BY pc.position ASC
        """,
        (piece_id,),
    ).fetchall()
    sections: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for row in rows:
        label = row["section_label"] or "Parte"
        sections.setdefault(label, [])
        copla = fetch_copla(conn, row["copla_id"]) if row["copla_id"] else {
            "id": None,
            "text": row["text"],
            "incipit": first_line(row["text"]),
            "notes": None,
            "territories": [],
        }
        copla.update(
            {
                "position": row["position"],
                "text": row["text"],
                "incipit": row["incipit"] or first_line(row["text"]),
                "role": row["role"] or "copla",
                "occurrence_notes": row["notes"],
            }
        )
        sections[label].append(copla)
    return [{"label": label, "coplas": coplas} for label, coplas in sections.items()]


def build_piece_document(conn: sqlite3.Connection, piece_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT id, title, slug, author, context_territory_id, description, notes, status
        FROM pieces
        WHERE id = ?
        """,
        (piece_id,),
    ).fetchone()
    if not row:
        raise ValueError(f"Non existe a peza {piece_id}.")
    piece = dict(row)
    territory = fetch_territory(conn, piece["context_territory_id"]) if piece.get("context_territory_id") else None
    return {
        "kind": "piece",
        "title": piece["title"] or "Peza sen título",
        "slug": piece["slug"],
        "author": piece["author"],
        "description": piece["description"],
        "notes": piece["notes"],
        "context": territory_label(conn, territory) if territory else "",
        "sections": fetch_piece_sections(conn, piece_id),
    }


def build_piece_draft_document(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    territory_id = payload.get("context_territory_id")
    territory = fetch_territory(conn, territory_id) if territory_id else None
    sections = []
    for section in payload.get("sections", []):
        coplas = []
        for item in section.get("coplas", []):
            copla_id = item.get("copla_id")
            if copla_id is None:
                text = item.get("text") or ""
                if not text.strip():
                    continue
                copla = {
                    "id": None,
                    "text": text,
                    "incipit": item.get("incipit") or first_line(text),
                    "notes": item.get("notes"),
                    "territories": [item.get("territory")] if item.get("territory") else [],
                }
            else:
                copla = fetch_copla(conn, int(copla_id))
            copla.update(
                {
                    "position": item.get("position"),
                    "role": item.get("role") or "copla",
                    "occurrence_notes": item.get("notes"),
                }
            )
            coplas.append(copla)
        sections.append({"label": section.get("label") or "Parte", "coplas": coplas})
    return {
        "kind": "piece",
        "title": payload.get("title") or "Peza sen título",
        "slug": payload.get("slug"),
        "author": payload.get("author"),
        "description": payload.get("description"),
        "notes": payload.get("notes"),
        "context": territory_label(conn, territory) if territory else "",
        "sections": sections,
    }


def build_territory_document(conn: sqlite3.Connection, territory_id: str) -> dict[str, Any]:
    territory = fetch_territory(conn, territory_id)
    ids = descendant_ids(conn, territory)
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT DISTINCT c.id, c.text, c.incipit, c.notes, c.territory_state
        FROM coplas c
        JOIN copla_territories ct ON ct.copla_id = c.id
        WHERE ct.territory_id IN ({placeholders})
        ORDER BY c.id DESC
        """,
        ids,
    ).fetchall()
    coplas = []
    for row in rows:
        item = dict(row)
        item["incipit"] = item.get("incipit") or first_line(item.get("text"))
        item["territories"] = copla_territories(conn, item["id"])
        coplas.append(item)
    return {
        "kind": "territory",
        "title": territory_label(conn, territory),
        "territory_type": TYPE_LABELS.get(territory["tipo"], territory["tipo"]),
        "context": territory_context(conn, territory),
        "coplas": coplas,
    }
