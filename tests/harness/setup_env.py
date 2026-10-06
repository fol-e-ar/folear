#!/usr/bin/env python3
"""Prepara o contorno de proba: wrangler.toml temporal, D1 local con migracións + seed + extras.

Non toca `data/db/coplas.sqlite` nin ningunha D1 real: todo vive en tests/.tmp/.
"""
import glob
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1]
ROOT = TESTS.parent
CF = ROOT / "infra" / "cloudflare"
TMP = TESTS / ".tmp"
STATE = TMP / "state"
WRANGLER = sys.argv[1] if len(sys.argv) > 1 else "npx wrangler"


def main():
    if TMP.exists():
        shutil.rmtree(TMP)
    TMP.mkdir()
    (TMP / "wrangler.toml").write_text(f'''name = "folear-test"
main = "{CF / "src" / "worker.js"}"
compatibility_date = "2025-09-01"

[assets]
directory = "{ROOT / "frontend"}"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "fol-test"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "{CF / "migrations"}"
''')
    (TMP / ".dev.vars").write_text(
        "GOOGLE_CLIENT_ID=test-client\nGOOGLE_CLIENT_SECRET=test-secret\nADMIN_EMAILS=folear3@gmail.com\n"
        "GOOGLE_AUTH_URL=http://localhost:9911/auth\nGOOGLE_TOKEN_URL=http://localhost:9911/token\n"
    )
    cmd = f"{WRANGLER} d1 migrations apply fol-test --local --persist-to {STATE}"
    subprocess.run(cmd, shell=True, cwd=TMP, check=True, stdout=subprocess.DEVNULL)
    dbs = [p for p in glob.glob(str(STATE / "v3/d1/miniflare-D1DatabaseObject/*.sqlite")) if not p.endswith("metadata.sqlite")]
    if len(dbs) != 1:
        raise SystemExit(f"Esperaba unha D1 local e atopei {dbs}")
    conn = sqlite3.connect(dbs[0])
    for f in sorted((CF / "seed").glob("*.sql")):
        conn.executescript(f.read_text(encoding="utf-8"))
    conn.executescript((TESTS / "fixtures" / "extra.sql").read_text(encoding="utf-8"))
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM coplas").fetchone()[0]
    conn.close()
    print(f"Contorno listo: {dbs[0]} ({n} coplas)")


if __name__ == "__main__":
    main()
