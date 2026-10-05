import json
import sqlite3

from .db_paths import (
    COPLAS_EXPORT_DIR,
    COPLAS_EXPORT_JSON,
    MEDIA_EXPORT_DIR,
    MEDIA_EXPORT_JSON,
    MELODIES_EXPORT_DIR,
    MELODIES_EXPORT_JSON,
    PIECES_EXPORT_DIR,
    PIECES_EXPORT_JSON,
    TERRITORIES_EXPORT_DIR,
    TERRITORIES_EXPORT_JSON,
)


def ensure_export_dirs() -> None:
    TERRITORIES_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    COPLAS_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    PIECES_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    MELODIES_EXPORT_DIR.mkdir(parents=True, exist_ok=True)


def export_territories(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
          id,
          tipo,
          cod,
          nome,
          slug,
          search,
          prov_cod AS prov,
          com_cod AS com,
          con_cod AS con,
          parent_id
        FROM territories
        ORDER BY tipo, nome
        """
    ).fetchall()

    trait_rows = conn.execute(
        """
        SELECT id, territory_id, trait, category, notes
        FROM territory_traits
        ORDER BY territory_id, category, trait
        """
    ).fetchall()
    traits_by_territory: dict[str, list[dict]] = {}
    for trait in trait_rows:
        traits_by_territory.setdefault(trait["territory_id"], []).append(
            {
                "id": trait["id"],
                "trait": trait["trait"],
                "category": trait["category"],
                "notes": trait["notes"],
            }
        )

    result = []
    for row in rows:
        item = dict(row)
        item["traits"] = traits_by_territory.get(row["id"], [])
        result.append(item)
    return result


def export_coplas(conn: sqlite3.Connection) -> list[dict]:
    coplas = conn.execute(
        """
        SELECT
          c.id,
          c.text,
          c.normalized_text,
          c.incipit,
          c.notes,
          c.status,
          c.territory_state,
          c.is_volta,
          c.created_at,
          c.updated_at
        FROM coplas c
        ORDER BY c.id DESC
        """
    ).fetchall()

    result = []
    for copla in coplas:
        territories = conn.execute(
            """
            SELECT t.id, t.nome, t.tipo, ct.relation_type, ct.is_direct
            FROM copla_territories ct
            JOIN territories t ON t.id = ct.territory_id
            WHERE ct.copla_id = ?
            ORDER BY t.tipo, t.nome
            """,
            (copla["id"],),
        ).fetchall()
        tags = conn.execute(
            """
            SELECT tg.name
            FROM copla_tags ct
            JOIN tags tg ON tg.id = ct.tag_id
            WHERE ct.copla_id = ?
            ORDER BY tg.name
            """,
            (copla["id"],),
        ).fetchall()
        version_rows = conn.execute(
            """
            SELECT id, label, text, normalized_text, incipit, notes, position, created_at, updated_at
            FROM copla_versions
            WHERE copla_id = ?
            ORDER BY position ASC, id ASC
            """,
            (copla["id"],),
        ).fetchall()
        versions = []
        for version in version_rows:
            version_territories = conn.execute(
                """
                SELECT t.id, t.nome, t.tipo
                FROM copla_version_territories cvt
                JOIN territories t ON t.id = cvt.territory_id
                WHERE cvt.version_id = ?
                ORDER BY t.tipo, t.nome
                """,
                (version["id"],),
            ).fetchall()
            version_data = dict(version)
            version_data["territory_mode"] = "custom" if version_territories else "inherit"
            version_data["territories"] = [dict(item) for item in version_territories]
            versions.append(version_data)

        result.append(
            {
                "id": copla["id"],
                "text": copla["text"],
                "normalized_text": copla["normalized_text"],
                "incipit": copla["incipit"],
                "notes": copla["notes"],
                "status": copla["status"],
                "territory_state": copla["territory_state"],
                "is_volta": bool(copla["is_volta"]),
                "created_at": copla["created_at"],
                "updated_at": copla["updated_at"],
                "territories": [dict(item) for item in territories],
                "tags": [item["name"] for item in tags],
                "versions": versions,
            }
        )

    return result


def export_pieces(conn: sqlite3.Connection) -> list[dict]:
    pieces = conn.execute(
        """
        SELECT
          p.id,
          p.title,
          p.slug,
          p.author,
          p.context_territory_id,
          p.description,
          p.notes,
          p.status,
          p.created_at,
          p.updated_at,
          t.nome AS context_nome,
          t.tipo AS context_tipo
        FROM pieces p
        LEFT JOIN territories t ON t.id = p.context_territory_id
        ORDER BY p.updated_at DESC, p.id DESC
        """
    ).fetchall()

    result = []
    for piece in pieces:
        coplas = conn.execute(
            """
            SELECT
              pc.position,
              pc.section_label,
              pc.notes,
              pc.role,
              c.id,
              COALESCE(c.incipit, '') AS incipit,
              COALESCE(NULLIF(pc.inline_text, ''), c.text) AS text
            FROM piece_coplas pc
            LEFT JOIN coplas c ON c.id = pc.copla_id
            WHERE pc.piece_id = ?
            ORDER BY pc.position ASC
            """,
            (piece["id"],),
        ).fetchall()

        result.append(
            {
                "id": piece["id"],
                "title": piece["title"],
                "slug": piece["slug"],
                "author": piece["author"],
                "context_territory": (
                    {
                        "id": piece["context_territory_id"],
                        "nome": piece["context_nome"],
                        "tipo": piece["context_tipo"],
                    }
                    if piece["context_territory_id"]
                    else None
                ),
                "description": piece["description"],
                "notes": piece["notes"],
                "status": piece["status"],
                "created_at": piece["created_at"],
                "updated_at": piece["updated_at"],
                "copla_count": len(coplas),
                "coplas": [dict(item) for item in coplas],
            }
        )

    return result


def export_media(conn: sqlite3.Connection) -> list[dict]:
    media_rows = conn.execute(
        """
        SELECT
          id,
          provider,
          media_kind,
          title,
          url,
          description,
          author_or_source,
          thumbnail_url,
          status,
          created_at,
          updated_at
        FROM media
        ORDER BY updated_at DESC, id DESC
        """
    ).fetchall()

    result = []
    for media in media_rows:
        links = conn.execute(
            """
            SELECT entity_type, entity_id, relation_type
            FROM media_links
            WHERE media_id = ?
            ORDER BY entity_type, entity_id
            """,
            (media["id"],),
        ).fetchall()
        result.append(
            {
                "id": media["id"],
                "provider": media["provider"],
                "media_kind": media["media_kind"],
                "title": media["title"],
                "url": media["url"],
                "description": media["description"],
                "author_or_source": media["author_or_source"],
                "thumbnail_url": media["thumbnail_url"],
                "status": media["status"],
                "created_at": media["created_at"],
                "updated_at": media["updated_at"],
                "links": [dict(item) for item in links],
            }
        )

    return result


def melody_name(rhythm: str, number: int, territory_name: str) -> str:
    return f"{rhythm} número {number} de {territory_name}"


def export_melodies(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
          m.id,
          m.territory_id,
          m.rhythm,
          m.number,
          m.notes,
          m.created_at,
          m.updated_at,
          t.nome AS territory_nome
        FROM melodies m
        JOIN territories t ON t.id = m.territory_id
        ORDER BY t.nome, m.rhythm_key, m.number
        """
    ).fetchall()
    return [
        {
            "id": row["id"],
            "territory_id": row["territory_id"],
            "rhythm": row["rhythm"],
            "number": row["number"],
            "name": melody_name(row["rhythm"], row["number"], row["territory_nome"]),
            "notes": row["notes"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def write_json(path, payload) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def export_web(conn: sqlite3.Connection) -> dict[str, int]:
    ensure_export_dirs()

    territories = export_territories(conn)
    coplas = export_coplas(conn)
    pieces = export_pieces(conn)
    media = export_media(conn)
    melodies = export_melodies(conn)

    write_json(TERRITORIES_EXPORT_JSON, territories)
    write_json(COPLAS_EXPORT_JSON, coplas)
    write_json(PIECES_EXPORT_JSON, pieces)
    write_json(MEDIA_EXPORT_JSON, media)
    write_json(MELODIES_EXPORT_JSON, melodies)

    return {
        "territories": len(territories),
        "coplas": len(coplas),
        "pieces": len(pieces),
        "media": len(media),
        "melodies": len(melodies),
    }
