"""Probas de API contra o Worker real (wrangler dev): permisos, orixe, privacidade, PDF, erros."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, sql, Client, ok, finish, restore_coplas
MAX_COPLA_ID = sql("select coalesce(max(id),0) from coplas")[0][0]

for t in ("favorites", "profiles", "sessions", "follows", "pdf_usage", "piece_links"):
    sql(f"delete from {t}")
sql("delete from media_links where media_id in (select id from media where piece_id is not null)")
sql("delete from media where piece_id is not null")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null")
sql("delete from users")

anon = Client()
admin = Client("g-admin", "folear3@gmail.com", "Admin")
ana = Client("g-ana", "ana@example.com", "Ana")
bru = Client("g-bru", "bruno@example.com", "Bruno")
gui = Client("g-gui", "guia@example.com", "Guia")

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
c, j = admin.call("GET", "/api/users")
gui_id = [u["id"] for u in j["users"] if u["email"] == "guia@example.com"][0]
c, j = admin.call("POST", "/api/users/role", {"id": gui_id, "role": "guia"})
ok("admin promove outra guía (propietaria de pezas públicas nas probas)", c == 200, (c, j))
c, j = ana.call("POST", "/api/coplas", copla, headers={"Origin": "https://evil.example"})
ok("orixe allea rexeitada", c == 403, (c, j))

# --- pezas: privacidade
coplas = [{"copla_id": None, "text": "Texto solto\nde proba", "position": 1, "section_label": "Canto", "role": "copla"}]
def piece(vis="private", title="A miña peza", **kw):
    d = {"title": title, "author": "Ana", "visibility": vis, "coplas": coplas}
    d.update(kw)
    return {"pieces": [d]}
# publicar é cousa de guías/admin: unha foleante só garda pezas privadas
c, j = ana.call("POST", "/api/pieces", piece("public", "Intento público de Ana"))
ok("foleante NON publica pezas (403)", c == 403, (c, j))
c, j = anon.call("POST", "/api/pieces", piece())
ok("anon non garda pezas (401)", c == 401, (c, j))
c, j = ana.call("POST", "/api/pieces", piece(), headers={"Origin": "https://evil.example"})
ok("gardar peza con orixe allea (403)", c == 403, c)
c, j = ana.call("POST", "/api/pieces", piece("private"))
ok("ana garda peza privada", c == 200 and j["ids"], (c, j)); private_id = j["ids"][0]
c, j = gui.call("POST", "/api/pieces", piece("public", "Peza pública da guía"))
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
c, j = gui.call("POST", "/api/pieces", piece("public", "Con ligazóns", links=[{"title": "Vídeo", "url": "https://youtu.be/abc"}]))
ok("peza con ligazón válida", c == 200, (c, j))
c, j = gui.call("POST", "/api/pieces", piece("public", "Ligazón mala", links=[{"title": "x", "url": "javascript:alert(1)"}]))
ok("ligazón javascript: rexeitada", c == 400, (c, j))

# --- recursos de peza: van a Media (públicos ou privados segundo a peza)
def resource(url, title="Gravación", **kw):
    d = {"title": title, "url": url, "media_kind": "youtube", "role": "melody", "author_or_source": "Canle X",
         "description": "Unha gravación", "thumbnail_url": "https://img.example.org/a.jpg"}
    d.update(kw)
    return d
def media_list(client, path="/data/exports/media/media.json"):
    c, j = client.call("GET", path)
    return c, (j if isinstance(j, list) else j.get("media", []))
c, j = gui.call("POST", "/api/pieces", piece("public", "Con recurso público", links=[resource("https://youtu.be/pub1")]))
ok("peza pública con recurso", c == 200, (c, j)); pub_piece = j["ids"][0]
c, j = gui.call("POST", "/api/pieces", piece("private", "Con recurso privado", links=[resource("https://youtu.be/priv1", "Privado")]))
priv_piece = j["ids"][0]
c, items = media_list(anon)
urls = [m["url"] for m in items]
ok("Media pública: recurso da peza pública", "https://youtu.be/pub1" in urls, urls[-4:])
ok("Media pública: NON sae o da peza privada", "https://youtu.be/priv1" not in urls)
pub_media = next((m for m in items if m["url"] == "https://youtu.be/pub1"), {})
ok("recurso: datos completos e ligado á peza", pub_media.get("media_kind") == "youtube" and pub_media.get("author_or_source") == "Canle X"
   and pub_media.get("thumbnail_url") == "https://img.example.org/a.jpg" and str(pub_media.get("piece_id")) == str(pub_piece)
   and any(l["entity_type"] == "piece" and str(l["entity_id"]) == str(pub_piece) and l["relation_type"] == "melody" for l in pub_media.get("links", [])), pub_media)
c, mine = media_list(gui, "/api/me/media")
ok("/api/me/media: o privado da dona", c == 200 and [m["url"] for m in mine] == ["https://youtu.be/priv1"], [m["url"] for m in mine])
c, other = media_list(bru, "/api/me/media")
ok("/api/me/media: outra persoa non o ve", c == 200 and not other, other)
c, _ = anon.call("GET", "/api/me/media")
ok("/api/me/media sen sesión (401)", c == 401, c)
c, j = gui.call("GET", "/api/me/pieces")
mine_piece = next((p for p in j.get("pieces", []) if p["id"] == priv_piece), {})
ok("a peza devolve o recurso con datos", mine_piece.get("links") and mine_piece["links"][0]["media_kind"] == "youtube" and mine_piece["links"][0]["role"] == "melody", mine_piece.get("links"))
# visibilidade: o recurso segue a peza
c, j = gui.call("POST", "/api/pieces/visibility", {"id": priv_piece, "visibility": "public"})
c, items = media_list(anon)
ok("publicar a peza publica o recurso", "https://youtu.be/priv1" in [m["url"] for m in items])
c, mine = media_list(gui, "/api/me/media")
ok("…e xa non é privado", not mine, mine)
c, j = gui.call("POST", "/api/pieces/visibility", {"id": priv_piece, "visibility": "private"})
c, items = media_list(anon)
ok("facer privada a peza retira o recurso de Media", "https://youtu.be/priv1" not in [m["url"] for m in items])
# endpoint de recursos
pub_id = pub_media["id"]
c, j = gui.call("POST", "/api/pieces/resources", {"id": pub_piece, "links": [resource("https://youtu.be/pub1", "Novo título"), resource("https://example.org/a.pdf", "Partitura", media_kind="pdf", role="documental")]})
ok("engadir recurso a unha peza", c == 200 and j.get("count") == 2, (c, j))
c, items = media_list(anon)
mine_items = [m for m in items if str(m.get("piece_id")) == str(pub_piece)]
ok("dous recursos na peza, o primeiro conserva o id", len(mine_items) == 2 and any(m["id"] == pub_id and m["title"] == "Novo título" for m in mine_items), [(m["id"], m["title"]) for m in mine_items])
c, j = bru.call("POST", "/api/pieces/resources", {"id": pub_piece, "links": []})
ok("outra persoa non cambia recursos alleos", c in (403, 404), (c, j))
c, j = anon.call("POST", "/api/pieces/resources", {"id": pub_piece, "links": []})
ok("recursos sen sesión (401)", c == 401, c)
c, j = gui.call("POST", "/api/pieces/resources", {"id": pub_piece, "links": [{"title": "x", "url": "javascript:alert(1)"}]})
ok("recurso con URL perigosa rexeitado", c == 400, (c, j))
c, j = gui.call("POST", "/api/pieces/resources", {"id": pub_piece, "links": [resource("https://example.org/a.pdf", "Partitura", media_kind="pdf", role="documental")]})
c, items = media_list(anon)
ok("quitar un recurso bórrao de Media", [m["url"] for m in items if str(m.get("piece_id")) == str(pub_piece)] == ["https://example.org/a.pdf"])
ok("…e non quedan ligazóns orfas", sql("select count(*) from media_links where entity_type='piece' and entity_id=? and media_id not in (select id from media)", str(pub_piece))[0][0] == 0)
# «Obter datos» ábrese a calquera conta (antes só guías/admin)
c, j = bru.call("GET", "/api/link-preview?url=http%3A%2F%2F127.0.0.1%2Fa")
ok("link-preview: dispoñible con sesión (rexeita só hosts internos)", c == 403, (c, j))
c, j = anon.call("GET", "/api/link-preview?url=https%3A%2F%2Fexample.org%2F")
ok("link-preview sen sesión (401)", c == 401, c)
# borrar a peza leva os seus recursos
c, j = gui.call("DELETE", "/api/pieces", {"id": pub_piece})
c, items = media_list(anon)
ok("borrar a peza borra os seus recursos de Media", not [m for m in items if str(m.get("piece_id")) == str(pub_piece)])
c, j = gui.call("DELETE", "/api/pieces", {"id": priv_piece})

# --- «lugar» e alta automática das coplas soltas (só guías/admin)
PAR = "par:1502004"  # Lira (Santa María)
def count_coplas(): return sql("select count(*) from coplas")[0][0]
before = count_coplas()
loose = [{"copla_id": None, "text": "Laxoso ten unha fonte\nque dá auga fresquiña", "position": 1, "section_label": "Canto", "role": "copla"},
         {"copla_id": None, "text": "Volta de Laxoso\ne a outra metade", "position": 2, "section_label": "Canto", "role": "retrouso"}]
c, j = gui.call("POST", "/api/pieces", {"pieces": [{"title": "Cantos de Laxoso", "author": "Guía", "visibility": "public", "context_territory_id": PAR, "lugar": "Laxoso", "coplas": loose}]})
ok("guía garda peza con coplas soltas", c == 200 and j.get("registered_coplas") == 2, (c, j)); laxoso_piece = j["ids"][0]
ok("as coplas soltas pasaron ao arquivo", count_coplas() == before + 2, (before, count_coplas()))
c, items = anon.call("GET", "/data/exports/coplas/coplas.json")
mine = [x for x in items if x["text"].startswith("Laxoso ten unha fonte")]
ok("copla nova: territorio da peza, lugar e estado", mine and mine[0]["territory_state"] == "assigned" and [t["id"] for t in mine[0]["territories"]] == [PAR] and mine[0]["lugar"] == "Laxoso", mine[:1])
volta = [x for x in items if x["text"].startswith("Volta de Laxoso")]
ok("a volta quedou como volta", volta and volta[0]["is_volta"] is True)
c, pj = anon.call("GET", "/data/exports/pezas/pezas.json")
lp = next(p for p in pj if p["id"] == laxoso_piece)
ok("a peza apunta ás coplas (sen texto solto) e garda o lugar", lp["lugar"] == "Laxoso" and all(x["id"] is not None for x in lp["coplas"]), lp["coplas"])
c, j = gui.call("POST", "/api/pieces", {"pieces": [{"id": laxoso_piece, "title": "Cantos de Laxoso", "visibility": "public", "context_territory_id": PAR, "lugar": "Laxoso", "coplas": loose}]})
ok("regardar non duplica as coplas", c == 200 and count_coplas() == before + 2, (c, count_coplas()))
# a mesma copla noutro territorio: non se duplica, engádeselle o territorio
OTHER = "par:3605008"
c, j = gui.call("POST", "/api/pieces", {"pieces": [{"title": "Outra", "visibility": "private", "context_territory_id": OTHER, "coplas": [loose[0]]}]})
ok("copla existente: reutilízase", c == 200 and count_coplas() == before + 2, (c, j))
c, items = anon.call("GET", "/data/exports/coplas/coplas.json")
mine = [x for x in items if x["text"].startswith("Laxoso ten unha fonte")][0]
ok("…e figura tamén no novo territorio", sorted(t["id"] for t in mine["territories"]) == sorted([PAR, OTHER]), mine["territories"])
# foleante: peza privada con coplas soltas NON toca o arquivo
c, j = ana.call("POST", "/api/pieces", {"pieces": [{"title": "Privada con soltas", "visibility": "private", "context_territory_id": PAR, "coplas": [{"copla_id": None, "text": "Copla solta de Ana\nsó na súa peza", "position": 1}]}]})
ok("foleante garda privada con copla solta", c == 200 and j.get("registered_coplas") == 0, (c, j)); ana_loose = j["ids"][0]
ok("…e o arquivo non cambia", count_coplas() == before + 2)
c, j = ana.call("POST", "/api/pieces/register-coplas", {"id": ana_loose})
ok("foleante non dá de alta coplas no arquivo (403)", c == 403, (c, j))
c, j = admin.call("POST", "/api/pieces/register-coplas", {"id": ana_loose})
ok("admin dá de alta as coplas dunha peza xa gardada", c == 200 and j.get("registered") == 1 and count_coplas() == before + 3, (c, j))
ok("…a peza queda apuntando á copla", sql("select copla_id is not null, inline_text from piece_coplas where piece_id=?", ana_loose)[0] == (1, None))
c, j = ana.call("POST", "/api/pieces/visibility", {"id": ana_loose, "visibility": "public"})
ok("foleante NON publica (cambio de visibilidade, 403)", c == 403, (c, j))
c, j = gui.call("POST", "/api/pieces/visibility", {"id": laxoso_piece, "visibility": "private"})
ok("guía si cambia a visibilidade", c == 200, (c, j))
c, j = gui.call("POST", "/api/pieces", {"pieces": [{"id": laxoso_piece, "title": "Cantos de Laxoso", "visibility": "public", "context_territory_id": PAR, "lugar": "Laxoso", "coplas": loose}]})
c, j = gui.call("DELETE", "/api/pieces", {"id": laxoso_piece})
ok("as coplas dadas de alta quedan ao borrar a peza", count_coplas() == before + 3)

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

# --- recursos das pezas: ligados ao territorio e ás coplas da peza; edición e borrado desde Media
c, j = gui.call("POST", "/api/pieces", {"pieces": [{"title": "Con recursos ligados", "author": "Guía", "visibility": "public", "context_territory_id": PAR,
    "coplas": [{"copla_id": None, "text": "Copla ligada ao recurso\nsegundo verso", "position": 1, "section_label": "Canto", "role": "copla"}],
    "links": [resource("https://exemplo.gal/web-ligada", "Web ligada", media_kind="web", role="documental")]}]})
ok("peza con recurso web", c == 200, (c, j)); lk_piece = j["ids"][0]
lk_media = sql("select id from media where piece_id=?", lk_piece)[0][0]
lk_links = sql("select entity_type, entity_id, relation_type from media_links where media_id=? order by entity_type", lk_media)
copla_ids = [r[0] for r in sql("select copla_id from piece_coplas where piece_id=? and copla_id is not null", lk_piece)]
ok("o recurso queda ligado á peza, ao territorio e ás coplas da peza",
   ("piece", str(lk_piece), "documental") in lk_links and ("territory", PAR, "piece") in lk_links
   and all(("copla", str(cid), "piece") in lk_links for cid in copla_ids) and len(copla_ids) == 1, lk_links)
c, j = gui.call("POST", "/api/pieces", {"pieces": [{"id": lk_piece, "title": "Con recursos ligados", "visibility": "public", "context_territory_id": "par:1502001",
    "coplas": [{"copla_id": copla_ids[0], "position": 1, "section_label": "Canto", "role": "copla"}]}]})
lk_links = sql("select entity_type, entity_id from media_links where media_id=?", lk_media)
ok("ao cambiar o territorio da peza, o recurso segue", ("territory", "par:1502001") in lk_links and ("territory", PAR) not in lk_links, lk_links)
# a dona (foleante) edita e borra os seus recursos desde Media; ninguén máis
c, j = ana.call("POST", "/api/pieces", {"pieces": [{"title": "Peza de Ana con recurso", "author": "Ana", "visibility": "private", "context_territory_id": PAR,
    "coplas": coplas, "links": [resource("https://exemplo.gal/ana-web", "Web de Ana", media_kind="web", role="documental")]}]})
ana_piece = j["ids"][0]
ana_media = sql("select id from media where piece_id=?", ana_piece)[0][0]
edit = {"media": [{"id": ana_media, "title": "Web de Ana (editada)", "url": "https://exemplo.gal/ana-web2", "media_kind": "web", "role": "documental", "description": "Nova"}]}
c, j = bru.call("POST", "/api/media", edit)
ok("outra guía NON toca un recurso privado alleo (403)", c == 403, (c, j))
c, j = anon.call("POST", "/api/media", edit)
ok("media sen sesión (401)", c == 401, c)
c, j = ana.call("POST", "/api/media", edit)
ok("a dona edita o seu recurso desde Media", c == 200 and sql("select title, url from media where id=?", ana_media)[0] == ("Web de Ana (editada)", "https://exemplo.gal/ana-web2"), (c, j))
ok("…e conserva as ligazóns á peza e ao territorio", {r[0] for r in sql("select entity_type from media_links where media_id=?", ana_media)} >= {"piece", "territory"})
c, j = ana.call("POST", "/api/media", {"media": [{"title": "Novo solto", "url": "https://exemplo.gal/solto", "media_kind": "web"}]})
ok("unha foleante non crea Media nova (403)", c == 403, (c, j))
c, j = ana.call("POST", "/api/media", {"media": [{"id": lk_media, "title": "Roubado", "url": "https://exemplo.gal/roubo", "media_kind": "web"}]})
ok("nin edita recursos de pezas alleas (403)", c == 403 and sql("select title from media where id=?", lk_media)[0][0] != "Roubado", (c, j))
c, j = ana.call("POST", "/api/media", {"media": [{"id": ana_media, "title": "x", "url": "javascript:alert(1)"}]})
ok("URL perigosa rexeitada ao editar (400)", c == 400, (c, j))
c, j = ana.call("DELETE", "/api/media", {"ids": [lk_media]})
ok("nin borra recursos alleos (403)", c == 403 and sql("select count(*) from media where id=?", lk_media)[0][0] == 1, (c, j))
c, j = ana.call("DELETE", "/api/media", {"ids": [ana_media]})
ok("a dona borra o seu recurso desde Media", c == 200 and sql("select count(*) from media where id=?", ana_media)[0][0] == 0, (c, j))
ok("…que se desvincula de todo (sen ligazóns orfas)", sql("select count(*) from media_links where media_id=?", ana_media)[0][0] == 0)
c, j = ana.call("GET", "/api/me/pieces")
ok("…e xa non sae na peza", not next(p for p in j["pieces"] if p["id"] == ana_piece).get("links"), c)
c, j = gui.call("DELETE", "/api/media", {"ids": [lk_media]})
ok("a guía borra un recurso web público desde Media", c == 200 and sql("select count(*) from media where id=?", lk_media)[0][0] == 0, (c, j))
c, pj = anon.call("GET", "/data/exports/pezas/pezas.json")
ok("…e a peza pública deixa de listalo", not next(p for p in pj if p["id"] == lk_piece).get("links"))
gui.call("DELETE", "/api/pieces", {"id": lk_piece}); ana.call("DELETE", "/api/pieces", {"id": ana_piece})

restore_coplas(MAX_COPLA_ID)
finish()
