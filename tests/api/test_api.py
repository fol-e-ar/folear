"""Probas de API contra o Worker real (wrangler dev): permisos, orixe, privacidade, PDF, erros."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, sql, Client, ok, finish

for t in ("favorites", "profiles", "sessions", "follows", "pdf_usage", "piece_links"):
    sql(f"delete from {t}")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null")
sql("delete from users")

anon = Client()
admin = Client("g-admin", "folear3@gmail.com", "Admin")
ana = Client("g-ana", "ana@example.com", "Ana")
bru = Client("g-bru", "bruno@example.com", "Bruno")

# --- sesión e modo
c, j = anon.call("GET", "/api/auth/me")
ok("anon: mode google, sen usuaria", c == 200 and j["mode"] == "google" and j["user"] is None, j)
c, j = admin.call("GET", "/api/auth/me")
ok("ADMIN_EMAILS entra como admin", j["user"]["role"] == "admin", j["user"] and j["user"]["role"])
c, j = ana.call("GET", "/api/auth/me")
ok("persoa nova entra como foleante", j["user"]["role"] == "foleante")

# --- cabeceiras de seguridade
code, _, hd = anon.call("GET", "/", raw=True)
csp = hd.get("content-security-policy", "")
ok("estático: CSP sen unsafe-inline en scripts", "script-src 'self'" in csp and "script-src 'self' 'unsafe" not in csp, csp[:80])
ok("estático: nosniff", hd.get("x-content-type-options") == "nosniff")
code, _, hd = anon.call("GET", "/api/auth/me", raw=True)
ok("API: nosniff", hd.get("x-content-type-options") == "nosniff")

# --- escritura do arquivo
copla = {"coplas": [{"text": "Copla de proba\nsegundo verso", "territories": []}]}
c, j = anon.call("POST", "/api/coplas", copla)
ok("anon non escribe coplas (401)", c == 401, (c, j))
c, j = ana.call("POST", "/api/coplas", copla)
ok("foleante non escribe coplas (403)", c == 403, (c, j))
c, j = ana.call("POST", "/api/users/role", {"id": 1, "role": "admin"})
ok("foleante non cambia roles", c == 403, (c, j))
c, j = admin.call("GET", "/api/users")
ok("admin ve as persoas", c == 200, c)
bruno_id = [u["id"] for u in j["users"] if u["email"] == "bruno@example.com"][0] if c == 200 else None
c, j = admin.call("POST", "/api/users/role", {"id": bruno_id, "role": "guia"})
ok("admin promove a guía", c == 200, (c, j))
c, j = bru.call("GET", "/api/users")
ok("guía non ve a lista de persoas", c == 403, c)
c, j = ana.call("POST", "/api/coplas", copla, headers={"Origin": "https://evil.example"})
ok("orixe allea rexeitada", c == 403, (c, j))

# --- pezas: privacidade
coplas = [{"copla_id": None, "text": "Texto solto\nde proba", "position": 1, "section_label": "Canto", "role": "copla"}]
def piece(vis="private", title="A miña peza", **kw):
    d = {"title": title, "author": "Ana", "visibility": vis, "coplas": coplas}
    d.update(kw)
    return {"pieces": [d]}
c, j = anon.call("POST", "/api/pieces", piece())
ok("anon non garda pezas (401)", c == 401, (c, j))
c, j = ana.call("POST", "/api/pieces", piece(), headers={"Origin": "https://evil.example"})
ok("gardar peza con orixe allea (403)", c == 403, c)
c, j = ana.call("POST", "/api/pieces", piece("private"))
ok("ana garda peza privada", c == 200 and j["ids"], (c, j)); private_id = j["ids"][0]
c, j = ana.call("POST", "/api/pieces", piece("public", "Peza pública de Ana"))
public_id = j["ids"][0]
c, j = anon.call("GET", "/data/exports/pezas/pezas.json")
ids = [p["id"] for p in (j if isinstance(j, list) else j.get("pieces", []))]
ok("export público: ten a pública e non a privada", public_id in ids and private_id not in ids, ids)
c, j = bru.call("GET", "/data/exports/pezas/pezas.json")
ids_b = [p["id"] for p in (j if isinstance(j, list) else j.get("pieces", []))]
ok("outra persoa non ve a privada", private_id not in ids_b)
c, j = bru.call("POST", "/api/pieces", {"pieces": [{"id": private_id, "title": "roubo", "coplas": coplas}]})
ok("outra persoa non edita peza allea", c in (403, 404), (c, j))
c, j = bru.call("DELETE", "/api/pieces", {"id": private_id})
ok("outra persoa (ata guía) non borra peza privada allea", c in (403, 404), (c, j))
ok("a peza privada segue na base", sql("select count(*) from pieces where id=?", private_id)[0][0] == 1)

# --- ligazóns de peza
c, j = ana.call("POST", "/api/pieces", piece("public", "Con ligazóns", links=[{"title": "Vídeo", "url": "https://youtu.be/abc"}]))
ok("peza con ligazón válida", c == 200, (c, j))
c, j = ana.call("POST", "/api/pieces", piece("public", "Ligazón mala", links=[{"title": "x", "url": "javascript:alert(1)"}]))
ok("ligazón javascript: rexeitada", c == 400, (c, j))

# --- PDF só con sesión
for method, path, body in (("POST", "/api/pdf/piece-draft", {"title": "t", "sections": []}),
                           ("GET", f"/api/pieces/{public_id}/pdf", None),
                           ("GET", "/api/territories/par:1/pdf", None)):
    c, j = anon.call(method, path, body)
    ok(f"PDF anon 401: {path}", c == 401, (c, j))
c, j = ana.call("POST", "/api/pdf/piece-draft", {"title": "t", "sections": []})
ok("PDF con sesión supera o control de acceso", c != 401 and c != 429, (c, j))
for _ in range(16):
    ana.call("POST", "/api/pdf/piece-draft", {"title": "t", "sections": []})
c, j = ana.call("POST", "/api/pdf/piece-draft", {"title": "t", "sections": []})
ok("PDF: tope diario (429)", c == 429, (c, j))
for _ in range(18):
    admin.call("POST", "/api/pdf/piece-draft", {"title": "t", "sections": []})
c, j = admin.call("POST", "/api/pdf/piece-draft", {"title": "t", "sections": []})
ok("PDF: admin sen tope", c != 429, (c, j))

# --- proxy de PDF
c, j = anon.call("GET", "/api/pdf-proxy?url=https%3A%2F%2Fexample.org%2Fnon-rexistrado.pdf")
ok("pdf-proxy: só URLs rexistradas", c == 403, (c, j))
c, j = anon.call("GET", "/api/pdf-proxy?url=http%3A%2F%2F127.0.0.1%2Fa.pdf")
ok("pdf-proxy: hosts internos vedados", c == 403, (c, j))

# --- erros internos non se filtran
sql("alter table media rename to media_x")
try:
    c, j = anon.call("GET", "/api/pdf-proxy?url=https%3A%2F%2Fexample.org%2Fa.pdf")
finally:
    sql("alter table media_x rename to media")
ok("erro de base de datos: mensaxe xenérica", c == 500 and "media" not in str(j) and "Erro interno" in str(j), (c, j))

# --- exports públicos non levan datos persoais
c, raw, _ = anon.call("GET", "/data/exports/coplas/coplas.json", raw=True)
ok("export de coplas sen correos", b"@" not in raw or b"example.com" not in raw)
c, j = anon.call("GET", "/api/people")
ok("directorio de persoas só perfís públicos", c == 200 and "email" not in str(j), (c, str(j)[:80]))

finish()
