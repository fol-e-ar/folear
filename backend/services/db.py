import sqlite3
from pathlib import Path

from .db_paths import DB_PATH, SCHEMA_DIR


MIGRATION_001 = "001_init.sql"
MIGRATION_002 = "002_curation"
MIGRATION_003 = "003_territory_state"
MIGRATION_004 = "004_copla_versions"
MIGRATION_005 = "005_copla_version_territories"
MIGRATION_006 = "006_piece_inline_text"
MIGRATION_007 = "007_copla_volta_and_traits"
MIGRATION_008 = "008_melodies"
MIGRATION_009 = "009_lugar"


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def ensure_parent_dir(db_path: Path = DB_PATH) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)


def ensure_migrations_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def list_applied_migrations(conn: sqlite3.Connection) -> set[str]:
    ensure_migrations_table(conn)
    rows = conn.execute("SELECT name FROM schema_migrations").fetchall()
    return {row["name"] for row in rows}


def mark_migration(conn: sqlite3.Connection, name: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)",
        (name,),
    )


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        """,
        (name,),
    ).fetchone()
    return row is not None


def table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    if not table_exists(conn, name):
        return set()
    rows = conn.execute(f"PRAGMA table_info({name})").fetchall()
    return {row["name"] for row in rows}


def execute_sql_file(conn: sqlite3.Connection, path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    conn.executescript(sql)


def apply_001_init(conn: sqlite3.Connection) -> None:
    execute_sql_file(conn, SCHEMA_DIR / MIGRATION_001)


def rebuild_pieces_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        ALTER TABLE pieces RENAME TO pieces_old;

        CREATE TABLE pieces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          author TEXT NOT NULL DEFAULT '',
          context_territory_id TEXT,
          description TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (context_territory_id) REFERENCES territories(id)
        );

        INSERT INTO pieces (
          id,
          title,
          slug,
          author,
          context_territory_id,
          description,
          notes,
          status,
          created_at,
          updated_at
        )
        SELECT
          id,
          title,
          slug,
          '',
          NULL,
          description,
          NULL,
          'draft',
          created_at,
          CURRENT_TIMESTAMP
        FROM pieces_old;

        DROP TABLE pieces_old;
        """
    )


def rebuild_piece_coplas_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        ALTER TABLE piece_coplas RENAME TO piece_coplas_old;

        CREATE TABLE piece_coplas (
          piece_id INTEGER NOT NULL,
          copla_id INTEGER NOT NULL,
          position INTEGER NOT NULL,
          section_label TEXT,
          notes TEXT,
          PRIMARY KEY (piece_id, position),
          FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
          FOREIGN KEY (copla_id) REFERENCES coplas(id) ON DELETE CASCADE
        );

        INSERT INTO piece_coplas (
          piece_id,
          copla_id,
          position,
          section_label,
          notes
        )
        SELECT
          piece_id,
          copla_id,
          position,
          NULL,
          NULL
        FROM piece_coplas_old;

        DROP TABLE piece_coplas_old;
        """
    )


def rebuild_media_table(conn: sqlite3.Connection) -> None:
    media_columns = table_columns(conn, "media")
    source_kind = "type" if "type" in media_columns else None

    conn.execute("ALTER TABLE media RENAME TO media_old")
    conn.execute(
        """
        CREATE TABLE media (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL DEFAULT 'other',
          media_kind TEXT NOT NULL DEFAULT 'external',
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          description TEXT,
          author_or_source TEXT,
          thumbnail_url TEXT,
          status TEXT NOT NULL DEFAULT 'published',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    if source_kind:
        conn.execute(
            f"""
            INSERT INTO media (
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
            )
            SELECT
              id,
              'other',
              COALESCE({source_kind}, 'external'),
              title,
              url,
              description,
              NULL,
              NULL,
              'published',
              CURRENT_TIMESTAMP,
              CURRENT_TIMESTAMP
            FROM media_old
            """
        )
    else:
        conn.execute(
            """
            INSERT INTO media (
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
            )
            SELECT
              id,
              COALESCE(provider, 'other'),
              COALESCE(media_kind, 'external'),
              title,
              url,
              description,
              author_or_source,
              thumbnail_url,
              COALESCE(status, 'published'),
              COALESCE(created_at, CURRENT_TIMESTAMP),
              COALESCE(updated_at, CURRENT_TIMESTAMP)
            FROM media_old
            """
        )

    conn.execute("DROP TABLE media_old")


def rebuild_media_links_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        ALTER TABLE media_links RENAME TO media_links_old;

        CREATE TABLE media_links (
          media_id INTEGER NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          relation_type TEXT NOT NULL DEFAULT 'direct',
          PRIMARY KEY (media_id, entity_type, entity_id),
          FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
        );

        INSERT INTO media_links (
          media_id,
          entity_type,
          entity_id,
          relation_type
        )
        SELECT
          media_id,
          entity_type,
          entity_id,
          'direct'
        FROM media_links_old;

        DROP TABLE media_links_old;
        """
    )


def apply_002_curation(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = OFF")

    copla_columns = table_columns(conn, "coplas")
    if "status" not in copla_columns:
        conn.execute(
            "ALTER TABLE coplas ADD COLUMN status TEXT NOT NULL DEFAULT 'published'"
        )
    if "updated_at" not in copla_columns:
        conn.execute("ALTER TABLE coplas ADD COLUMN updated_at TEXT")
        conn.execute(
            "UPDATE coplas SET updated_at = created_at WHERE updated_at IS NULL"
        )

    piece_columns = table_columns(conn, "pieces")
    expected_piece_columns = {
        "id",
        "title",
        "slug",
        "author",
        "context_territory_id",
        "description",
        "notes",
        "status",
        "created_at",
        "updated_at",
    }
    if piece_columns and piece_columns != expected_piece_columns:
        rebuild_pieces_table(conn)

    piece_coplas_columns = table_columns(conn, "piece_coplas")
    if "section_label" not in piece_coplas_columns or "notes" not in piece_coplas_columns:
        rebuild_piece_coplas_table(conn)

    media_columns = table_columns(conn, "media")
    required_media_columns = {
        "id",
        "provider",
        "media_kind",
        "title",
        "url",
        "description",
        "author_or_source",
        "thumbnail_url",
        "status",
        "created_at",
        "updated_at",
    }
    if media_columns and media_columns != required_media_columns:
        rebuild_media_table(conn)

    media_link_columns = table_columns(conn, "media_links")
    if "relation_type" not in media_link_columns:
        rebuild_media_links_table(conn)
    conn.execute("PRAGMA foreign_keys = ON")


def apply_003_territory_state(conn: sqlite3.Connection) -> None:
    copla_columns = table_columns(conn, "coplas")
    if "territory_state" not in copla_columns:
        conn.execute(
            "ALTER TABLE coplas ADD COLUMN territory_state TEXT NOT NULL DEFAULT 'assigned'"
        )


def apply_004_copla_versions(conn: sqlite3.Connection) -> None:
    execute_sql_file(conn, SCHEMA_DIR / "004_copla_versions.sql")


def apply_005_copla_version_territories(conn: sqlite3.Connection) -> None:
    execute_sql_file(conn, SCHEMA_DIR / "005_copla_version_territories.sql")


def apply_006_piece_inline_text(conn: sqlite3.Connection) -> None:
    execute_sql_file(conn, SCHEMA_DIR / "006_piece_inline_text.sql")


def apply_007_copla_volta_and_traits(conn: sqlite3.Connection) -> None:
    copla_columns = table_columns(conn, "coplas")
    if "is_volta" not in copla_columns:
        conn.execute(
            "ALTER TABLE coplas ADD COLUMN is_volta INTEGER NOT NULL DEFAULT 0"
        )
    execute_sql_file(conn, SCHEMA_DIR / "007_copla_volta_and_traits.sql")


def apply_008_melodies(conn: sqlite3.Connection) -> None:
    execute_sql_file(conn, SCHEMA_DIR / "008_melodies.sql")


def apply_009_lugar(conn: sqlite3.Connection) -> None:
    """«Lugar»: subdivisión dunha parroquia como texto libre (aditivo; só engade columnas nulas)."""
    for table in ("coplas", "pieces"):
        if table_exists(conn, table) and "lugar" not in table_columns(conn, table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN lugar TEXT")


def migrate(db_path: Path = DB_PATH) -> list[str]:
    ensure_parent_dir(db_path)

    applied_now: list[str] = []
    conn = connect(db_path)
    try:
        applied = list_applied_migrations(conn)

        if MIGRATION_001 not in applied:
            apply_001_init(conn)
            mark_migration(conn, MIGRATION_001)
            applied_now.append(MIGRATION_001)

        if MIGRATION_002 not in applied:
            apply_002_curation(conn)
            mark_migration(conn, MIGRATION_002)
            applied_now.append(MIGRATION_002)

        if MIGRATION_003 not in applied:
            apply_003_territory_state(conn)
            mark_migration(conn, MIGRATION_003)
            applied_now.append(MIGRATION_003)

        if MIGRATION_004 not in applied:
            apply_004_copla_versions(conn)
            mark_migration(conn, MIGRATION_004)
            applied_now.append(MIGRATION_004)

        if MIGRATION_005 not in applied:
            apply_005_copla_version_territories(conn)
            mark_migration(conn, MIGRATION_005)
            applied_now.append(MIGRATION_005)

        if MIGRATION_006 not in applied:
            apply_006_piece_inline_text(conn)
            mark_migration(conn, MIGRATION_006)
            applied_now.append(MIGRATION_006)

        if MIGRATION_007 not in applied:
            apply_007_copla_volta_and_traits(conn)
            mark_migration(conn, MIGRATION_007)
            applied_now.append(MIGRATION_007)

        if MIGRATION_008 not in applied:
            apply_008_melodies(conn)
            mark_migration(conn, MIGRATION_008)
            applied_now.append(MIGRATION_008)

        if MIGRATION_009 not in applied:
            apply_009_lugar(conn)
            mark_migration(conn, MIGRATION_009)
            applied_now.append(MIGRATION_009)

        conn.commit()
    finally:
        conn.close()

    return applied_now
