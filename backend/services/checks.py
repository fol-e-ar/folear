import json
import sqlite3
from urllib.parse import urlparse

from .db_paths import (
    COPLAS_EXPORT_JSON,
    MEDIA_EXPORT_JSON,
    PIECES_EXPORT_JSON,
    TERRITORIES_EXPORT_JSON,
)
from .exporters import export_coplas, export_media, export_pieces, export_territories


def valid_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def run_checks(conn: sqlite3.Connection) -> list[str]:
    issues: list[str] = []

    territory_ids = {row["id"] for row in conn.execute("SELECT id FROM territories").fetchall()}
    copla_ids = {row["id"] for row in conn.execute("SELECT id FROM coplas").fetchall()}
    piece_ids = {row["id"] for row in conn.execute("SELECT id FROM pieces").fetchall()}

    copla_state_rows = conn.execute(
        "SELECT id, territory_state FROM coplas"
    ).fetchall()
    for row in copla_state_rows:
        if row["territory_state"] not in {"assigned", "unassigned", "general"}:
            issues.append(
                f"Copla {row['id']} usa territory_state non soportado: {row['territory_state']}"
            )

    mismatched_states = conn.execute(
        """
        SELECT
          c.id,
          c.territory_state,
          COUNT(ct.territory_id) AS territory_count
        FROM coplas c
        LEFT JOIN copla_territories ct ON ct.copla_id = c.id
        GROUP BY c.id, c.territory_state
        """
    ).fetchall()
    for row in mismatched_states:
        if row["territory_state"] == "assigned" and row["territory_count"] == 0:
            issues.append(f"Copla {row['id']} está como assigned pero non ten territorios.")
        if row["territory_state"] in {"unassigned", "general"} and row["territory_count"] > 0:
            issues.append(f"Copla {row['id']} está como {row['territory_state']} pero conserva territorios.")

    missing_copla_territories = conn.execute(
        """
        SELECT ct.copla_id, ct.territory_id
        FROM copla_territories ct
        LEFT JOIN territories t ON t.id = ct.territory_id
        WHERE t.id IS NULL
        """
    ).fetchall()
    for row in missing_copla_territories:
        issues.append(
            f"Relación copla-territorio rota: copla {row['copla_id']} -> {row['territory_id']}"
        )

    missing_version_territories = conn.execute(
        """
        SELECT cvt.version_id, cvt.territory_id
        FROM copla_version_territories cvt
        LEFT JOIN copla_versions cv ON cv.id = cvt.version_id
        LEFT JOIN territories t ON t.id = cvt.territory_id
        WHERE cv.id IS NULL OR t.id IS NULL
        """
    ).fetchall()
    for row in missing_version_territories:
        issues.append(
            f"Relación variante-territorio rota: variante {row['version_id']} -> {row['territory_id']}"
        )

    orphan_traits = conn.execute(
        """
        SELECT tt.id, tt.territory_id
        FROM territory_traits tt
        LEFT JOIN territories t ON t.id = tt.territory_id
        WHERE t.id IS NULL
        """
    ).fetchall()
    for row in orphan_traits:
        issues.append(
            f"Trazo de territorio {row['id']} referencia territory inexistente: {row['territory_id']}"
        )

    piece_positions = conn.execute(
        """
        SELECT piece_id, position, COUNT(*) AS total
        FROM piece_coplas
        GROUP BY piece_id, position
        HAVING COUNT(*) > 1
        """
    ).fetchall()
    for row in piece_positions:
        issues.append(
            f"Peza {row['piece_id']} ten posición repetida: {row['position']}"
        )

    piece_links = conn.execute(
        "SELECT piece_id, copla_id, inline_text, role FROM piece_coplas"
    ).fetchall()
    for row in piece_links:
        if row["copla_id"] is not None and row["copla_id"] not in copla_ids:
            issues.append(
                f"Peza {row['piece_id']} referencia copla inexistente: {row['copla_id']}"
            )
        if row["copla_id"] is None and not (row["inline_text"] or "").strip():
            issues.append(f"Peza {row['piece_id']} ten unha aparición sen copla nin texto.")
        if row["role"] not in {"copla", "retrouso"}:
            issues.append(f"Peza {row['piece_id']} usa tipo textual non válido: {row['role']}")

    piece_contexts = conn.execute(
        "SELECT id, context_territory_id FROM pieces WHERE context_territory_id IS NOT NULL"
    ).fetchall()
    for row in piece_contexts:
        if row["context_territory_id"] not in territory_ids:
            issues.append(
                f"Peza {row['id']} referencia territory inexistente: {row['context_territory_id']}"
            )

    media_rows = conn.execute("SELECT id, url FROM media").fetchall()
    for row in media_rows:
        if not valid_url(row["url"]):
            issues.append(f"Media {row['id']} ten URL non válida: {row['url']}")

    media_links = conn.execute(
        "SELECT media_id, entity_type, entity_id FROM media_links"
    ).fetchall()
    for row in media_links:
        entity_type = row["entity_type"]
        entity_id = row["entity_id"]
        if entity_type == "territory":
            if entity_id not in territory_ids:
                issues.append(f"Media {row['media_id']} referencia territory inexistente: {entity_id}")
        elif entity_type == "copla":
            try:
                numeric_id = int(entity_id)
            except (TypeError, ValueError):
                issues.append(f"Media {row['media_id']} referencia copla non numérica: {entity_id}")
            else:
                if numeric_id not in copla_ids:
                    issues.append(f"Media {row['media_id']} referencia copla inexistente: {entity_id}")
        elif entity_type == "piece":
            try:
                numeric_id = int(entity_id)
            except (TypeError, ValueError):
                issues.append(f"Media {row['media_id']} referencia peza non numérica: {entity_id}")
            else:
                if numeric_id not in piece_ids:
                    issues.append(f"Media {row['media_id']} referencia peza inexistente: {entity_id}")
        else:
            issues.append(f"Media {row['media_id']} usa entity_type non soportado: {entity_type}")

    slug_rows = conn.execute(
        """
        SELECT slug, COUNT(*) AS total
        FROM pieces
        GROUP BY slug
        HAVING COUNT(*) > 1
        """
    ).fetchall()
    for row in slug_rows:
        issues.append(f"Slug de peza repetido: {row['slug']}")

    expected_payloads = {
        TERRITORIES_EXPORT_JSON: export_territories(conn),
        COPLAS_EXPORT_JSON: export_coplas(conn),
        PIECES_EXPORT_JSON: export_pieces(conn),
        MEDIA_EXPORT_JSON: export_media(conn),
    }
    for path, expected in expected_payloads.items():
        if not path.exists():
            issues.append(f"Falta o export: {path}")
            continue
        current = json.loads(path.read_text(encoding="utf-8"))
        if current != expected:
            issues.append(f"Export desactualizado: {path}")

    return issues
