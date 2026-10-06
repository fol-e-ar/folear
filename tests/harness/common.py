"""Utilidades comúns das probas: cliente HTTP con cookies, acceso á D1 de proba e pequenos asserts.

A orixe de tudo é o contorno que levanta `tests/run.sh` (Worker en `wrangler dev`
+ Google falso). As rutas poden cambiarse con FOLEAR_APP, FOLEAR_FAKE_GOOGLE e FOLEAR_DB.
"""
import glob
import http.cookiejar
import json
import os
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path

TESTS = Path(__file__).resolve().parents[1]
ROOT = TESTS.parent
APP = os.environ.get("FOLEAR_APP", "http://localhost:8799")
FAKE = os.environ.get("FOLEAR_FAKE_GOOGLE", "http://127.0.0.1:9911")
OUT = TESTS / "out"
OUT.mkdir(exist_ok=True)
SAMPLE_PDF = TESTS / "fixtures" / "sample.pdf"


def _find_db():
    if os.environ.get("FOLEAR_DB"):
        return os.environ["FOLEAR_DB"]
    state = TESTS / ".tmp" / "state"
    hits = [p for p in glob.glob(str(state / "v3/d1/miniflare-D1DatabaseObject/*.sqlite")) if not p.endswith("metadata.sqlite")]
    if not hits:
        raise SystemExit("Non atopo a D1 de proba: arranca as probas con tests/run.sh")
    return hits[0]


DB = _find_db()


def sql(q, *args):
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute(q, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def restore_coplas(max_id):
    """Borra as coplas dadas de alta polas probas (id > max_id) e invalida a caché dos exportes,
    para que as probas seguintes vexan o arquivo orixinal (156 coplas)."""
    for q in ("delete from piece_coplas where copla_id > ?",
              "delete from copla_territories where copla_id > ?",
              "delete from copla_tags where copla_id > ?",
              "delete from copla_version_territories where version_id in (select id from copla_versions where copla_id > ?)",
              "delete from copla_versions where copla_id > ?",
              "delete from media_links where entity_type = 'copla' and cast(entity_id as integer) > ?",
              "delete from coplas where id > ?"):
        sql(q, max_id)
    sql("update site_meta set value = cast(cast(value as integer) + 1 as text) where key = 'data_version'")


def fake_login_as(sub, email, name="X"):
    urllib.request.urlopen(f"{FAKE}/set?sub={sub}&email={email}&name={name}").read()


class Client:
    """Cliente HTTP (urllib) con cookies. Sen `sub` é anónimo; con `sub` entra co Google falso."""

    def __init__(self, sub=None, email=None, name="X"):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        if sub:
            fake_login_as(sub, email, name)
            self.op.open(APP + "/api/auth/google?next=/").read()

    def call(self, method, path, body=None, origin=True, headers=None, raw=False):
        h = {"Content-Type": "application/json"}
        if origin and method != "GET":
            h["Origin"] = APP
        if headers:
            h.update(headers)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(APP + path, data=data, method=method, headers=h)
        try:
            r = self.op.open(req)
            code, payload, hd = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            code, payload, hd = e.code, e.read(), e.headers
        if raw:
            return code, payload, hd
        try:
            return code, json.loads(payload)
        except Exception:
            return code, payload[:80]


FAILS = []


def ok(label, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + label, extra)
    if not cond:
        FAILS.append(label)


def finish():
    print("FAILS:", FAILS)
    raise SystemExit(1 if FAILS else 0)
