import json
import sqlite3
from pathlib import Path
from urllib.parse import urlparse

from .text_utils import make_incipit, normalize_text, slugify


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_known_territories(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT id FROM territories").fetchall()
    return {row["id"] for row in rows}


def load_known_coplas(conn: sqlite3.Connection) -> set[int]:
    rows = conn.execute("SELECT id FROM coplas").fetchall()
    return {row["id"] for row in rows}


def load_known_media(conn: sqlite3.Connection) -> set[int]:
    rows = conn.execute("SELECT id FROM media").fetchall()
    return {row["id"] for row in rows}


def get_or_create_tag(conn: sqlite3.Connection, tag_name: str) -> int:
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


def validate_coplas_payload(payload, known_territories: set[str]) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict) or not isinstance(payload.get("coplas"), list):
        return ["O JSON debe ser un obxecto con clave 'coplas' en forma de lista."]

    known_copla_ids = payload.get("_known_copla_ids", set())

    for index, copla in enumerate(payload["coplas"], start=1):
        if not isinstance(copla, dict):
            errors.append(f"Copla #{index}: debe ser un obxecto.")
            continue
        copla_id = copla.get("id")
        if copla_id is not None:
            if not isinstance(copla_id, int):
                errors.append(f"Copla #{index}: 'id' debe ser enteiro cando existe.")
            elif known_copla_ids and copla_id not in known_copla_ids:
                errors.append(f"Copla #{index}: non existe unha copla co id {copla_id}.")
        text = copla.get("text")
        if not isinstance(text, str) or not text.strip():
            errors.append(f"Copla #{index}: falta 'text' ou está baleiro.")
        notes = copla.get("notes", "")
        if notes is not None and not isinstance(notes, str):
            errors.append(f"Copla #{index}: 'notes' debe ser string.")
        status = copla.get("status", "published")
        if status not in {"draft", "published"}:
            errors.append(f"Copla #{index}: 'status' debe ser 'draft' ou 'published'.")
        territory_state = copla.get("territory_state", "assigned")
        if territory_state not in {"assigned", "unassigned", "general"}:
            errors.append(
                f"Copla #{index}: 'territory_state' debe ser 'assigned', 'unassigned' ou 'general'."
            )
        is_volta = copla.get("is_volta", False)
        if not isinstance(is_volta, bool):
            errors.append(f"Copla #{index}: 'is_volta' debe ser booleano.")
        tags = copla.get("tags", [])
        if not isinstance(tags, list):
            errors.append(f"Copla #{index}: 'tags' debe ser unha lista.")
        versions = copla.get("versions", [])
        if not isinstance(versions, list):
            errors.append(f"Copla #{index}: 'versions' debe ser unha lista.")
        else:
            for version_index, version in enumerate(versions, start=1):
                if not isinstance(version, dict):
                    errors.append(
                        f"Copla #{index}, versión #{version_index}: debe ser un obxecto."
                    )
                    continue
                version_text = version.get("text")
                if not isinstance(version_text, str) or not version_text.strip():
                    errors.append(
                        f"Copla #{index}, versión #{version_index}: falta 'text' ou está baleiro."
                    )
                version_notes = version.get("notes", "")
                if version_notes is not None and not isinstance(version_notes, str):
                    errors.append(
                        f"Copla #{index}, versión #{version_index}: 'notes' debe ser string."
                    )
                version_territories = version.get("territories", [])
                if not isinstance(version_territories, list):
                    errors.append(
                        f"Copla #{index}, versión #{version_index}: 'territories' debe ser unha lista."
                    )
                else:
                    for territory in version_territories:
                        territory_id = territory.get("id") if isinstance(territory, dict) else None
                        if not territory_id or territory_id not in known_territories:
                            errors.append(
                                f"Copla #{index}, versión #{version_index}: territorio descoñecido: {territory_id}"
                            )
        territories = copla.get("territories", [])
        if not isinstance(territories, list):
            errors.append(f"Copla #{index}: 'territories' debe ser unha lista.")
        else:
            for territory in territories:
                if not isinstance(territory, dict) or not territory.get("id"):
                    errors.append(f"Copla #{index}: hai un territorio sen 'id' válido.")
                    continue
                if territory["id"] not in known_territories:
                    errors.append(
                        f"Copla #{index}: territorio descoñecido: {territory['id']}"
                    )
        if territory_state == "assigned" and not territories:
            errors.append(
                f"Copla #{index}: se 'territory_state' é 'assigned', cómpre indicar algún territorio."
            )
        if territory_state != "assigned" and territories:
            errors.append(
                f"Copla #{index}: se 'territory_state' non é 'assigned', a lista de territorios debe ir baleira."
            )
    return errors


def import_coplas(conn: sqlite3.Connection, payload) -> list[int]:
    known_territories = load_known_territories(conn)
    known_copla_ids = load_known_coplas(conn)
    payload = dict(payload)
    payload["_known_copla_ids"] = known_copla_ids
    errors = validate_coplas_payload(payload, known_territories)
    if errors:
        raise ValueError("\n".join(errors))

    imported_ids: list[int] = []
    for copla in payload["coplas"]:
        text = copla["text"].strip()
        normalized = normalize_text(text)
        incipit = make_incipit(text)
        notes = copla.get("notes") or None
        status = copla.get("status", "published")
        territory_state = copla.get("territory_state", "assigned")
        is_volta = 1 if copla.get("is_volta") else 0
        lugar = (str(copla.get("lugar") or "").strip()[:80]) or None
        copla_id = copla.get("id")

        if isinstance(copla_id, int):
            conn.execute(
                """
                UPDATE coplas
                SET
                  text = ?,
                  normalized_text = ?,
                  incipit = ?,
                  notes = ?,
                  status = ?,
                  territory_state = ?,
                  is_volta = ?,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (text, normalized, incipit, notes, status, territory_state, is_volta, copla_id),
            )
            conn.execute("UPDATE coplas SET lugar = ? WHERE id = ?", (lugar, copla_id))
            conn.execute("DELETE FROM copla_territories WHERE copla_id = ?", (copla_id,))
            conn.execute("DELETE FROM copla_tags WHERE copla_id = ?", (copla_id,))
        else:
            cur = conn.execute(
                """
                INSERT INTO coplas (
                  text,
                  normalized_text,
                  incipit,
                  notes,
                  status,
                  territory_state,
                  is_volta,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (text, normalized, incipit, notes, status, territory_state, is_volta),
            )
            copla_id = cur.lastrowid
            if lugar:
                conn.execute("UPDATE coplas SET lugar = ? WHERE id = ?", (lugar, copla_id))
        imported_ids.append(copla_id)

        conn.execute("DELETE FROM copla_versions WHERE copla_id = ?", (copla_id,))
        for position, version in enumerate(copla.get("versions", []), start=1):
            version_text = version["text"].strip()
            version_cur = conn.execute(
                """
                INSERT INTO copla_versions (
                  copla_id,
                  label,
                  text,
                  normalized_text,
                  incipit,
                  notes,
                  position,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    copla_id,
                    version.get("label") or None,
                    version_text,
                    normalize_text(version_text),
                    make_incipit(version_text),
                    version.get("notes") or None,
                    position,
                ),
            )
            version_id = version_cur.lastrowid
            for territory in version.get("territories", []):
                conn.execute(
                    """
                    INSERT INTO copla_version_territories (version_id, territory_id)
                    VALUES (?, ?)
                    """,
                    (version_id, territory["id"]),
                )

        for territory in copla.get("territories", []):
            conn.execute(
                """
                INSERT INTO copla_territories (
                  copla_id,
                  territory_id,
                  relation_type,
                  is_direct
                )
                VALUES (?, ?, 'direct', 1)
                """,
                (copla_id, territory["id"]),
            )

        for raw_tag in copla.get("tags", []):
            tag_name = normalize_text(raw_tag)
            if not tag_name:
                continue
            tag_id = get_or_create_tag(conn, tag_name)
            conn.execute(
                """
                INSERT OR IGNORE INTO copla_tags (copla_id, tag_id)
                VALUES (?, ?)
                """,
                (copla_id, tag_id),
            )

    return imported_ids


def validate_territory_traits_payload(payload, known_territories: set[str]) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict) or not isinstance(payload.get("traits"), list):
        return ["O JSON debe ser un obxecto con clave 'traits' en forma de lista."]

    for index, trait in enumerate(payload["traits"], start=1):
        if not isinstance(trait, dict):
            errors.append(f"Trazo #{index}: debe ser un obxecto.")
            continue
        trait_id = trait.get("id")
        if trait_id is not None and not isinstance(trait_id, int):
            errors.append(f"Trazo #{index}: 'id' debe ser enteiro cando existe.")
        if trait.get("_delete"):
            if trait_id is None:
                errors.append(f"Trazo #{index}: para borrar cómpre indicar 'id'.")
            continue
        territory_id = trait.get("territory_id")
        if not territory_id or territory_id not in known_territories:
            errors.append(f"Trazo #{index}: territorio descoñecido: {territory_id}")
        trait_name = trait.get("trait")
        if not isinstance(trait_name, str) or not trait_name.strip():
            errors.append(f"Trazo #{index}: falta 'trait' ou está baleiro.")
        category = trait.get("category")
        if category is not None and not isinstance(category, str):
            errors.append(f"Trazo #{index}: 'category' debe ser string.")
        notes = trait.get("notes")
        if notes is not None and not isinstance(notes, str):
            errors.append(f"Trazo #{index}: 'notes' debe ser string.")
    return errors


def import_territory_traits(conn: sqlite3.Connection, payload) -> list[int]:
    known_territories = load_known_territories(conn)
    errors = validate_territory_traits_payload(payload, known_territories)
    if errors:
        raise ValueError("\n".join(errors))

    affected_ids: list[int] = []
    for trait in payload["traits"]:
        trait_id = trait.get("id")

        if trait.get("_delete"):
            conn.execute("DELETE FROM territory_traits WHERE id = ?", (trait_id,))
            affected_ids.append(trait_id)
            continue

        territory_id = trait["territory_id"]
        trait_name = trait["trait"].strip()
        category = (trait.get("category") or "").strip() or None
        notes = (trait.get("notes") or "").strip() or None

        if isinstance(trait_id, int):
            conn.execute(
                """
                UPDATE territory_traits
                SET territory_id = ?, trait = ?, category = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (territory_id, trait_name, category, notes, trait_id),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO territory_traits (territory_id, trait, category, notes, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (territory_id, trait_name, category, notes),
            )
            trait_id = cur.lastrowid
        affected_ids.append(trait_id)

    return affected_ids


def validate_pieces_payload(conn: sqlite3.Connection, payload) -> list[str]:
    errors: list[str] = []
    known_territories = load_known_territories(conn)
    known_coplas = load_known_coplas(conn)

    if not isinstance(payload, dict) or not isinstance(payload.get("pieces"), list):
        return ["O JSON debe ser un obxecto con clave 'pieces' en forma de lista."]

    for index, piece in enumerate(payload["pieces"], start=1):
        if not isinstance(piece, dict):
            errors.append(f"Peza #{index}: debe ser un obxecto.")
            continue
        for field in ("title", "slug", "author"):
            value = piece.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"Peza #{index}: falta '{field}' ou está baleiro.")

        context_territory_id = piece.get("context_territory_id")
        if context_territory_id and context_territory_id not in known_territories:
            errors.append(
                f"Peza #{index}: territory de contexto descoñecido: {context_territory_id}"
            )

        status = piece.get("status", "draft")
        if status not in {"draft", "published"}:
            errors.append(f"Peza #{index}: 'status' debe ser 'draft' ou 'published'.")

        coplas = piece.get("coplas")
        if not isinstance(coplas, list) or not coplas:
            errors.append(f"Peza #{index}: 'coplas' debe ser unha lista non baleira.")
            continue

        positions: set[int] = set()
        for item in coplas:
            if not isinstance(item, dict):
                errors.append(f"Peza #{index}: cada elemento de 'coplas' debe ser un obxecto.")
                continue
            copla_id = item.get("copla_id")
            inline_text = item.get("text")
            position = item.get("position")
            has_known_copla = isinstance(copla_id, int) and copla_id in known_coplas
            has_inline_text = isinstance(inline_text, str) and bool(inline_text.strip())
            if not has_known_copla and not has_inline_text:
                errors.append(
                    f"Peza #{index}: cada aparición precisa unha 'copla_id' coñecida ou texto."
                )
            if copla_id is not None and not has_known_copla:
                errors.append(f"Peza #{index}: copla descoñecida: {copla_id}")
            role = item.get("role", "copla")
            if role not in {"copla", "retrouso"}:
                errors.append(f"Peza #{index}: tipo textual non válido: {role}")
            if not isinstance(position, int) or position < 1:
                errors.append(f"Peza #{index}: posición non válida: {position}")
            elif position in positions:
                errors.append(f"Peza #{index}: posición repetida: {position}")
            else:
                positions.add(position)

    return errors


def import_pieces(conn: sqlite3.Connection, payload) -> list[int]:
    errors = validate_pieces_payload(conn, payload)
    if errors:
        raise ValueError("\n".join(errors))

    imported_ids: list[int] = []
    for piece in payload["pieces"]:
        cur = conn.execute(
            """
            INSERT INTO pieces (
              title,
              slug,
              author,
              context_territory_id,
              description,
              notes,
              status,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                piece["title"].strip(),
                piece["slug"].strip(),
                piece["author"].strip(),
                piece.get("context_territory_id"),
                piece.get("description"),
                piece.get("notes"),
                piece.get("status", "draft"),
            ),
        )
        piece_id = cur.lastrowid
        imported_ids.append(piece_id)
        lugar = (str(piece.get("lugar") or "").strip()[:80]) or None
        if lugar:
            conn.execute("UPDATE pieces SET lugar = ? WHERE id = ?", (lugar, piece_id))

        for item in sorted(piece["coplas"], key=lambda value: value["position"]):
            conn.execute(
                """
                INSERT INTO piece_coplas (
                  piece_id,
                  copla_id,
                  inline_text,
                  position,
                  section_label,
                  role,
                  notes
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    piece_id,
                    item.get("copla_id"),
                    (item.get("text") or "").strip() or None,
                    item["position"],
                    item.get("section_label"),
                    item.get("role", "copla"),
                    item.get("notes"),
                ),
            )

    return imported_ids


def is_valid_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def validate_media_payload(conn: sqlite3.Connection, payload) -> list[str]:
    errors: list[str] = []
    known_territories = load_known_territories(conn)
    known_coplas = load_known_coplas(conn)
    known_pieces = {row["id"] for row in conn.execute("SELECT id FROM pieces").fetchall()}
    known_melodies = {row["id"] for row in conn.execute("SELECT id FROM melodies").fetchall()}
    known_media_ids = {row["id"] for row in conn.execute("SELECT id FROM media").fetchall()}

    if not isinstance(payload, dict) or not isinstance(payload.get("media"), list):
        return ["O JSON debe ser un obxecto con clave 'media' en forma de lista."]

    for index, media in enumerate(payload["media"], start=1):
        if not isinstance(media, dict):
            errors.append(f"Media #{index}: debe ser un obxecto.")
            continue
        media_id = media.get("id")
        if media_id is not None:
            if not isinstance(media_id, int):
                errors.append(f"Media #{index}: 'id' debe ser enteiro cando existe.")
            elif media_id not in known_media_ids:
                errors.append(f"Media #{index}: non existe unha media co id {media_id}.")
        for field in ("provider", "media_kind", "title", "url"):
            value = media.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"Media #{index}: falta '{field}' ou está baleiro.")

        if isinstance(media.get("url"), str) and not is_valid_url(media["url"]):
            errors.append(f"Media #{index}: URL non válida: {media['url']}")

        status = media.get("status", "published")
        if status not in {"draft", "published"}:
            errors.append(f"Media #{index}: 'status' debe ser 'draft' ou 'published'.")

        links = media.get("links")
        if not isinstance(links, list) or not links:
            errors.append(f"Media #{index}: 'links' debe ser unha lista non baleira.")
            continue

        for link in links:
            if not isinstance(link, dict):
                errors.append(f"Media #{index}: cada link debe ser un obxecto.")
                continue
            entity_type = link.get("entity_type")
            entity_id = link.get("entity_id")
            if entity_type not in {"territory", "copla", "piece", "melody"}:
                errors.append(f"Media #{index}: entity_type non válido: {entity_type}")
                continue
            if entity_type == "territory" and entity_id not in known_territories:
                errors.append(f"Media #{index}: territorio descoñecido: {entity_id}")
            if entity_type == "copla":
                try:
                    numeric_id = int(entity_id)
                except (TypeError, ValueError):
                    errors.append(f"Media #{index}: copla_id non válido: {entity_id}")
                else:
                    if numeric_id not in known_coplas:
                        errors.append(f"Media #{index}: copla descoñecida: {entity_id}")
            if entity_type == "piece":
                try:
                    numeric_id = int(entity_id)
                except (TypeError, ValueError):
                    errors.append(f"Media #{index}: piece_id non válido: {entity_id}")
                else:
                    if numeric_id not in known_pieces:
                        errors.append(f"Media #{index}: peza descoñecida: {entity_id}")
            if entity_type == "melody":
                try:
                    numeric_id = int(entity_id)
                except (TypeError, ValueError):
                    errors.append(f"Media #{index}: melody_id non válido: {entity_id}")
                else:
                    if numeric_id not in known_melodies:
                        errors.append(f"Media #{index}: melodía descoñecida: {entity_id}")

    return errors


def delete_coplas(conn: sqlite3.Connection, copla_ids) -> list[int]:
    if not isinstance(copla_ids, list) or not copla_ids:
        raise ValueError("Cómpre indicar polo menos un ID de copla para borrar.")

    ids: list[int] = []
    for raw_id in copla_ids:
        if not isinstance(raw_id, int):
            raise ValueError(f"ID de copla non válido: {raw_id!r}.")
        ids.append(raw_id)

    known_copla_ids = load_known_coplas(conn)
    missing = [copla_id for copla_id in ids if copla_id not in known_copla_ids]
    if missing:
        raise ValueError(f"Non existe ningunha copla con estes IDs: {missing}.")

    for copla_id in ids:
        conn.execute(
            "DELETE FROM media_links WHERE entity_type = 'copla' AND entity_id = ?",
            (str(copla_id),),
        )
        conn.execute("DELETE FROM coplas WHERE id = ?", (copla_id,))

    return ids


def delete_media(conn: sqlite3.Connection, media_ids) -> list[int]:
    if not isinstance(media_ids, list) or not media_ids:
        raise ValueError("Cómpre indicar polo menos un ID de recurso para borrar.")

    ids: list[int] = []
    for raw_id in media_ids:
        if not isinstance(raw_id, int):
            raise ValueError(f"ID de recurso non válido: {raw_id!r}.")
        ids.append(raw_id)

    known_media_ids = load_known_media(conn)
    missing = [media_id for media_id in ids if media_id not in known_media_ids]
    if missing:
        raise ValueError(f"Non existe ningún recurso con estes IDs: {missing}.")

    for media_id in ids:
        # media_links.media_id ten ON DELETE CASCADE real (a diferenza da
        # relación polimórfica dende coplas), así que abonda con isto.
        conn.execute("DELETE FROM media WHERE id = ?", (media_id,))

    return ids


def import_media(conn: sqlite3.Connection, payload) -> list[int]:
    errors = validate_media_payload(conn, payload)
    if errors:
        raise ValueError("\n".join(errors))

    imported_ids: list[int] = []
    for media in payload["media"]:
        media_id = media.get("id")
        if isinstance(media_id, int):
            conn.execute(
                """
                UPDATE media
                SET
                  provider = ?,
                  media_kind = ?,
                  title = ?,
                  url = ?,
                  description = ?,
                  author_or_source = ?,
                  thumbnail_url = ?,
                  status = ?,
                  updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    media["provider"].strip(),
                    media["media_kind"].strip(),
                    media["title"].strip(),
                    media["url"].strip(),
                    media.get("description"),
                    media.get("author_or_source"),
                    media.get("thumbnail_url"),
                    media.get("status", "published"),
                    media_id,
                ),
            )
            conn.execute("DELETE FROM media_links WHERE media_id = ?", (media_id,))
        else:
            cur = conn.execute(
                """
                INSERT INTO media (
                  provider,
                  media_kind,
                  title,
                  url,
                  description,
                  author_or_source,
                  thumbnail_url,
                  status,
                  updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    media["provider"].strip(),
                    media["media_kind"].strip(),
                    media["title"].strip(),
                    media["url"].strip(),
                    media.get("description"),
                    media.get("author_or_source"),
                    media.get("thumbnail_url"),
                    media.get("status", "published"),
                ),
            )
            media_id = cur.lastrowid
        imported_ids.append(media_id)

        for link in media["links"]:
            conn.execute(
                """
                INSERT INTO media_links (
                  media_id,
                  entity_type,
                  entity_id,
                  relation_type
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    media_id,
                    link["entity_type"],
                    str(link["entity_id"]),
                    link.get("relation_type", "direct"),
                ),
            )

    return imported_ids


MAX_RHYTHM_LENGTH = 60

# Repertorio PECHADO de ritmos (o mesmo que MELODY_RHYTHMS no Worker e RHYTHMS no frontend).
# Só valen estes e os que xa teñan melodías no inventario.
MELODY_RHYTHMS = [
    "Cantar popular", "Canto", "Carballesa", "Charrasquiño", "Chiqui-chiqui", "Danza", "Dous pasos", "Esparabán",
    "Fandango", "Maneo", "Mazurca", "Muiñeira", "Muiñeira corrida", "Pandeirada", "Pasodobre", "Polca",
    "Ribeirana", "Rumba", "Valse", "Xota",
]


def allowed_rhythm_keys(conn: sqlite3.Connection) -> set[str]:
    keys = {normalize_text(item) for item in MELODY_RHYTHMS}
    keys.update(row["rhythm_key"] for row in conn.execute("SELECT DISTINCT rhythm_key FROM melodies").fetchall())
    return keys


def load_known_melodies(conn: sqlite3.Connection) -> set[int]:
    rows = conn.execute("SELECT id FROM melodies").fetchall()
    return {row["id"] for row in rows}


def canonical_rhythm(conn: sqlite3.Connection, rhythm: str, rhythm_key: str) -> str:
    """Mesma grafía para o mesmo ritmo en todo o inventario.

    Se xa hai melodías con ese ritmo (sen contar maiúsculas nin acentos),
    reutilízase a súa grafía; se non, ponse a primeira letra en maiúscula.
    """
    row = conn.execute(
        "SELECT rhythm FROM melodies WHERE rhythm_key = ? ORDER BY id LIMIT 1",
        (rhythm_key,),
    ).fetchone()
    if row:
        return row["rhythm"]
    for item in MELODY_RHYTHMS:
        if normalize_text(item) == rhythm_key:
            return item
    return rhythm[:1].upper() + rhythm[1:]


def next_melody_number(conn: sqlite3.Connection, territory_id: str, rhythm_key: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(number), 0) + 1 AS next FROM melodies WHERE territory_id = ? AND rhythm_key = ?",
        (territory_id, rhythm_key),
    ).fetchone()
    return int(row["next"])


def validate_melodies_payload(conn: sqlite3.Connection, payload) -> list[str]:
    if not isinstance(payload, dict) or not isinstance(payload.get("melodies"), list):
        return ["O JSON debe ser un obxecto con clave 'melodies' en forma de lista."]
    known_territories = load_known_territories(conn)
    known_melodies = load_known_melodies(conn)
    allowed_rhythms = allowed_rhythm_keys(conn)
    errors: list[str] = []
    for index, melody in enumerate(payload["melodies"], start=1):
        if not isinstance(melody, dict):
            errors.append(f"Melodía #{index}: debe ser un obxecto.")
            continue
        melody_id = melody.get("id")
        if melody_id is not None:
            if not isinstance(melody_id, int) or isinstance(melody_id, bool):
                errors.append(f"Melodía #{index}: 'id' debe ser enteiro cando existe.")
                continue
            if melody_id not in known_melodies:
                errors.append(f"Melodía #{index}: non existe unha melodía co id {melody_id}.")
                continue
        if melody.get("_delete"):
            if melody_id is None:
                errors.append(f"Melodía #{index}: falta 'id' para borrar.")
            continue
        territory_id = melody.get("territory_id")
        if not isinstance(territory_id, str) or territory_id not in known_territories:
            errors.append(f"Melodía #{index}: territorio descoñecido: {territory_id}")
        rhythm = melody.get("rhythm")
        if not isinstance(rhythm, str) or not rhythm.strip():
            errors.append(f"Melodía #{index}: falta 'rhythm' ou está baleiro.")
        elif len(rhythm.strip()) > MAX_RHYTHM_LENGTH:
            errors.append(f"Melodía #{index}: o ritmo é demasiado longo.")
        elif normalize_text(rhythm) not in allowed_rhythms:
            errors.append(f"Melodía #{index}: ritmo non permitido: «{rhythm.strip()}». Escolle un dos ritmos da plataforma.")
        number = melody.get("number")
        if number is not None and (not isinstance(number, int) or isinstance(number, bool) or number < 1):
            errors.append(f"Melodía #{index}: 'number' debe ser un enteiro maior ca 0.")
        notes = melody.get("notes")
        if notes is not None and not isinstance(notes, str):
            errors.append(f"Melodía #{index}: 'notes' debe ser texto.")
    return errors


def delete_melody_rows(conn: sqlite3.Connection, melody_id: int) -> None:
    """Borra unha melodía e as súas ligazóns con media.

    media_links é polimórfica (sen FK cara a melodies), así que hai que limpala
    á man. Se algún recurso quedase sen ningunha ligazón, ábrelle unha cara ao
    territorio da melodía para que non quede orfo e invisible.
    """
    melody = conn.execute(
        "SELECT territory_id FROM melodies WHERE id = ?", (melody_id,)
    ).fetchone()
    links = conn.execute(
        "SELECT media_id, relation_type FROM media_links WHERE entity_type = 'melody' AND entity_id = ?",
        (str(melody_id),),
    ).fetchall()
    conn.execute(
        "DELETE FROM media_links WHERE entity_type = 'melody' AND entity_id = ?",
        (str(melody_id),),
    )
    for link in links:
        remaining = conn.execute(
            "SELECT COUNT(*) AS total FROM media_links WHERE media_id = ?",
            (link["media_id"],),
        ).fetchone()["total"]
        if remaining == 0 and melody:
            conn.execute(
                """
                INSERT OR IGNORE INTO media_links (media_id, entity_type, entity_id, relation_type)
                VALUES (?, 'territory', ?, ?)
                """,
                (link["media_id"], melody["territory_id"], link["relation_type"] or "direct"),
            )
    conn.execute("DELETE FROM melodies WHERE id = ?", (melody_id,))


def import_melodies(conn: sqlite3.Connection, payload) -> list[int]:
    errors = validate_melodies_payload(conn, payload)
    if errors:
        raise ValueError("\n".join(errors))

    affected_ids: list[int] = []
    for melody in payload["melodies"]:
        melody_id = melody.get("id")

        if melody.get("_delete"):
            delete_melody_rows(conn, melody_id)
            affected_ids.append(melody_id)
            continue

        territory_id = melody["territory_id"]
        rhythm = " ".join(melody["rhythm"].split())
        rhythm_key = normalize_text(rhythm)
        rhythm = canonical_rhythm(conn, rhythm, rhythm_key)
        notes = (melody.get("notes") or "").strip() or None
        number = melody.get("number")

        current = None
        if isinstance(melody_id, int):
            current = conn.execute(
                "SELECT territory_id, rhythm_key, number FROM melodies WHERE id = ?",
                (melody_id,),
            ).fetchone()
            same_group = (
                current["territory_id"] == territory_id and current["rhythm_key"] == rhythm_key
            )
            if number is None:
                number = current["number"] if same_group else next_melody_number(conn, territory_id, rhythm_key)
        elif number is None:
            number = next_melody_number(conn, territory_id, rhythm_key)

        clash = conn.execute(
            """
            SELECT id FROM melodies
            WHERE territory_id = ? AND rhythm_key = ? AND number = ? AND id IS NOT ?
            """,
            (territory_id, rhythm_key, number, melody_id),
        ).fetchone()
        if clash:
            raise ValueError(
                f"Xa existe a melodía {rhythm} #{number} neste territorio."
            )

        if current is not None:
            conn.execute(
                """
                UPDATE melodies
                SET territory_id = ?, rhythm = ?, rhythm_key = ?, number = ?, notes = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (territory_id, rhythm, rhythm_key, number, notes, melody_id),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO melodies (territory_id, rhythm, rhythm_key, number, notes, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (territory_id, rhythm, rhythm_key, number, notes),
            )
            melody_id = cur.lastrowid
        affected_ids.append(melody_id)

    return affected_ids


def delete_melodies(conn: sqlite3.Connection, melody_ids) -> list[int]:
    if not isinstance(melody_ids, list) or not melody_ids:
        raise ValueError("Cómpre indicar polo menos un ID de melodía para borrar.")
    known = load_known_melodies(conn)
    for raw_id in melody_ids:
        if not isinstance(raw_id, int) or isinstance(raw_id, bool):
            raise ValueError(f"ID de melodía non válido: {raw_id!r}.")
    missing = [melody_id for melody_id in melody_ids if melody_id not in known]
    if missing:
        raise ValueError(f"Non existe ningunha melodía con estes IDs: {missing}.")
    for melody_id in melody_ids:
        delete_melody_rows(conn, melody_id)
    return melody_ids


def import_territories(conn: sqlite3.Connection, payload) -> int:
    if not isinstance(payload, list):
        raise ValueError("O ficheiro de territorios debe conter unha lista.")

    conn.execute("DELETE FROM territories")
    for item in payload:
        tipo = item["tipo"]
        prov_cod = item.get("prov")
        com_cod = item.get("com")
        con_cod = item.get("con")
        parent_id = None
        if tipo == "com" and prov_cod:
            parent_id = f"prov:{prov_cod}"
        elif tipo == "con" and com_cod:
            parent_id = f"com:{com_cod}"
        elif tipo == "par" and con_cod:
            parent_id = f"con:{con_cod}"

        conn.execute(
            """
            INSERT INTO territories (
              id,
              tipo,
              cod,
              nome,
              slug,
              search,
              prov_cod,
              com_cod,
              con_cod,
              parent_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item["id"],
                item["tipo"],
                item["cod"],
                item["nome"],
                item["slug"],
                item["search"],
                prov_cod,
                com_cod,
                con_cod,
                parent_id,
            ),
        )

    return len(payload)
