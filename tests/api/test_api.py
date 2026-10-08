"""Probas de API contra o Worker real (wrangler dev): permisos, orixe, privacidade, PDF, erros."""
import sys, pathlib, json
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

# --- SEO básico (gratis): robots, sitemap, metadatos, datos estruturados e imaxe social
import re
c, raw, hd = anon.call("GET", "/robots.txt", raw=True)
ok("robots.txt: permite o sitio, pecha só /api/ e apunta ao sitemap", c == 200 and b"Sitemap: https://folear.gal/sitemap.xml" in raw and b"Disallow: /api/" in raw and b"Disallow: /data" not in raw, (c, raw[:80]))
c, raw, hd = anon.call("GET", "/sitemap.xml", raw=True)
ok("sitemap.xml: ten a portada", c == 200 and b"<loc>https://folear.gal/</loc>" in raw, (c, raw[:80]))
c, raw, hd = anon.call("GET", "/", raw=True)
html = raw.decode("utf-8", "replace")
ok("portada: title, description, canonical e Open Graph", "<title>Fol e ar - Arquivo de coplas galegas</title>" in html and 'rel="canonical" href="https://folear.gal/"' in html and 'property="og:image"' in html and 'name="twitter:card"' in html and 'name="description"' in html)
ld = re.search(r'<script type="application/ld\+json">(.*?)</script>', html, re.S)
ok("portada: JSON-LD válido (WebSite, nome alternativo «folear»)", ld and json.loads(ld.group(1))["@type"] == "WebSite" and "folear" in json.loads(ld.group(1))["alternateName"], ld and ld.group(1)[:80])
c, raw, hd = anon.call("GET", "/assets/marca/og-image.png", raw=True)
ok("imaxe social 1200x630 servida", c == 200 and raw[:8] == b"\x89PNG\r\n\x1a\n" and int.from_bytes(raw[16:20], "big") == 1200 and int.from_bytes(raw[20:24], "big") == 630, (c, len(raw)))

# --- quen me segue (só se ve no meu espazo)
c, j = ana.call("POST", "/api/me/profile", {"display_name": "Ana da Ulloa", "handle": "ana-ulloa", "is_public": True})
ok("ana: perfil público co seu username", c == 200, (c, j))
c, j = bru.call("POST", "/api/me/profile", {"display_name": "Bruno do Sar", "handle": "bruno-sar", "is_public": True})
c, j = bru.call("POST", "/api/me/follows", {"handle": "ana-ulloa", "on": True})
ok("bruno segue a ana", c == 200, (c, j))
c, j = ana.call("GET", "/api/me/followers")
ok("ana ve quen a segue (nome e @username)", c == 200 and j["total"] == 1 and j["followers"][0]["handle"] == "bruno-sar" and j["followers"][0]["display_name"] == "Bruno do Sar" and j["followers"][0]["i_follow"] is False, (c, j))
c, j = ana.call("POST", "/api/me/follows", {"handle": "bruno-sar", "on": True})
c, j = ana.call("GET", "/api/me/followers")
ok("…e se ela tamén o segue, indícase", c == 200 and j["followers"][0]["i_follow"] is True, j)
c, j = anon.call("GET", "/api/me/followers")
ok("anónimo non ve seguidoras (401)", c == 401, (c, j))
c, j = anon.call("GET", "/api/people/ana-ulloa")
ok("o perfil público non amosa cantas seguidoras ten", c == 200 and "follower" not in json.dumps(j) and "seguidor" not in json.dumps(j), j)
c, j = anon.call("GET", "/api/people")
ok("directorio: leva o username", c == 200 and any(p["handle"] == "ana-ulloa" for p in j["people"]), j)
sql("delete from follows")

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

# --- recursos duplicados: unha mesma ligazón non se crea dúas veces
sql("delete from media where url like 'https://dup.example%'")
c, j = gui.call("POST", "/api/media", {"media": [{"title": "Orixinal", "url": "https://www.dup.example/ver?id=7&utm_source=x", "provider": "web", "media_kind": "web",
    "links": [{"entity_type": "territory", "entity_id": PAR, "relation_type": "documental"}]}]})
ok("Media: crear un recurso novo", c == 200, (c, j)); dup_media = j["ids"][0]
c, j = gui.call("POST", "/api/media", {"media": [{"title": "Copia", "url": "https://dup.example/ver/?id=7", "provider": "web", "media_kind": "web",
    "links": [{"entity_type": "territory", "entity_id": PAR, "relation_type": "documental"}]}]})
ok("Media: a mesma ligazón (www/utm/barra) avisa e non se crea (409)", c == 409 and j.get("duplicate", {}).get("id") == dup_media and "xa está en Media" in j.get("error", ""), (c, j))
ok("…e non se duplicou", sql("select count(*) from media where url like 'https://%dup.example%'")[0][0] == 1)
c, j = gui.call("POST", "/api/media", {"media": [{"title": "YT", "url": "https://www.youtube.com/watch?v=dupYT0001", "provider": "youtube", "media_kind": "youtube",
    "links": [{"entity_type": "territory", "entity_id": PAR, "relation_type": "documental"}]}]})
yt_media = j["ids"][0]
c, j = gui.call("POST", "/api/media", {"media": [{"title": "YT curto", "url": "https://youtu.be/dupYT0001?si=abc", "provider": "youtube", "media_kind": "youtube",
    "links": [{"entity_type": "territory", "entity_id": PAR, "relation_type": "documental"}]}]})
ok("YouTube: youtu.be e watch?v= contan como a mesma", c == 409 and j["duplicate"]["id"] == yt_media, (c, j))
c, j = gui.call("POST", "/api/media", {"media": [{"id": yt_media, "title": "YT editado", "url": "https://www.youtube.com/watch?v=dupYT0001", "provider": "youtube", "media_kind": "youtube",
    "links": [{"entity_type": "territory", "entity_id": PAR, "relation_type": "documental"}]}]})
ok("editar un recurso sen cambiar a súa ligazón non avisa", c == 200, (c, j))
# unha peza pode ligar un recurso que xa está en Media (sen duplicalo)
c, j = gui.call("POST", "/api/pieces", piece("public", "Peza con ligazón repetida", links=[resource("https://dup.example/ver?id=7", "Copia")]))
ok("peza: ligazón nova que xa está en Media (409)", c == 409 and j.get("duplicate", {}).get("id") == dup_media, (c, j))
c, j = gui.call("POST", "/api/pieces", piece("public", "Peza que usa un recurso existente", links=[dict(resource("https://dup.example/ver?id=7", "Existente"), media_id=dup_media)]))
ok("peza: ligar o recurso existente polo seu id", c == 200, (c, j)); shared_piece = j["ids"][0]
ok("…sen crear copia", sql("select count(*) from media where url like 'https://%dup.example%'")[0][0] == 1)
ok("…e ligado á peza", sql("select count(*) from media_links where media_id=? and entity_type='piece' and entity_id=?", dup_media, str(shared_piece))[0][0] == 1)
c, pj = anon.call("GET", "/data/exports/pezas/pezas.json")
sp = next((p for p in pj if p["id"] == shared_piece), {})
ok("a peza amosa o recurso compartido (shared)", any(l.get("shared") and l.get("media_id") == dup_media for l in sp.get("links", [])), sp.get("links"))
c, j = gui.call("POST", "/api/pieces/resources", {"id": shared_piece, "links": []})
ok("quitalo da peza só o desliga: segue en Media", c == 200 and sql("select count(*) from media where id=?", dup_media)[0][0] == 1
   and sql("select count(*) from media_links where media_id=? and entity_type='piece'", dup_media)[0][0] == 0, (c, j))
c, j = ana.call("POST", "/api/pieces", piece("private", "Peza privada de Ana", links=[dict(resource("https://dup.example/ver?id=7", "Existente"), media_id=dup_media)]))
ok("unha foleante tamén pode ligar un recurso público existente", c == 200, (c, j)); ana_shared = j["ids"][0]
c, j = ana.call("POST", "/api/media", {"media": [{"id": sql("select id from media where piece_id=? ", ana_shared)[0][0] if sql("select id from media where piece_id=?", ana_shared) else -1, "title": "x", "url": "https://dup.example/ver?id=7"}]})
ok("a dona non pode cambiar o seu recurso á ligazón doutro (403/409)", c in (403, 409), (c, j))
# recurso privado doutra persoa: non se pode ligar por id
c, j = ana.call("POST", "/api/pieces", piece("private", "Con recurso privado", links=[resource("https://dup.example/privado-ana", "Privado de Ana")]))
ana_priv_media = sql("select id from media where url='https://dup.example/privado-ana'")[0][0]
c, j = bru.call("POST", "/api/pieces", piece("private", "Intento", links=[dict(resource("https://dup.example/privado-ana", "Roubo"), media_id=ana_priv_media)]))
ok("non se liga por id un recurso privado alleo (403)", c == 403, (c, j))
c, j = bru.call("POST", "/api/pieces", piece("private", "Intento 2", links=[resource("https://dup.example/privado-ana", "Mesma URL")]))
ok("a ligazón privada doutra persoa non conta como duplicada", c == 200, (c, j)); bru_piece2 = j["ids"][0] if c == 200 else None
# endpoint /api/media/link
c, j = gui.call("POST", "/api/media/link", {"media_id": dup_media, "links": [{"entity_type": "piece", "entity_id": shared_piece, "relation_type": "melody"}, {"entity_type": "territory", "entity_id": PAR}]})
ok("/api/media/link engade só o que falta", c == 200 and j.get("added") == 1, (c, j))
c, j = ana.call("POST", "/api/media/link", {"media_id": dup_media, "links": [{"entity_type": "piece", "entity_id": ana_shared}]})
ok("/api/media/link: foleante (403)", c == 403, (c, j))
c, j = gui.call("POST", "/api/media/link", {"media_id": 99999999, "links": [{"entity_type": "piece", "entity_id": shared_piece}]})
ok("/api/media/link: recurso inexistente (404)", c == 404, (c, j))
c, j = gui.call("POST", "/api/media/link", {"media_id": dup_media, "links": [{"entity_type": "copla", "entity_id": 99999999}]})
ok("/api/media/link: elemento inexistente (400)", c == 400, (c, j))
for pid in (shared_piece,): gui.call("DELETE", "/api/pieces", {"id": pid})
ana.call("DELETE", "/api/pieces", {"id": ana_shared}); ana.call("DELETE", "/api/pieces", {"id": sql("select id from pieces where title='Con recurso privado' and owner_user_id is not null order by id desc")[0][0]})
if bru_piece2: bru.call("DELETE", "/api/pieces", {"id": bru_piece2})
sql("delete from media_links where media_id in (select id from media where url like 'https://%dup.example%')"); sql("delete from media where url like 'https://%dup.example%'")

# --- ritmos pechados
c, j = gui.call("POST", "/api/melodies", {"melodies": [{"territory_id": PAR, "rhythm": "Ritmo inventado"}]})
ok("melodía con ritmo inventado: rexeitada (400)", c == 400 and "ritmo non permitido" in json.dumps(j, ensure_ascii=False).lower(), (c, j))
for nome in ("Canto", "cantar popular"):
    c, j = gui.call("POST", "/api/melodies", {"melodies": [{"territory_id": PAR, "rhythm": nome}]})
    ok(f"ritmo «{nome}» aceptado e con grafía canónica", c == 200 and sql("select rhythm from melodies where id=?", j["ids"][0])[0][0] == ("Canto" if nome == "Canto" else "Cantar popular"), (c, j))
    gui.call("POST", "/api/melodies", {"melodies": [{"id": j["ids"][0], "_delete": True}]}) if c == 200 else None
ok("…e limpas", sql("select count(*) from melodies where rhythm_key in ('canto','cantar popular')")[0][0] == 0)
# --- nome das melodías: sen o santo da parroquia e co artigo contraído
c, j = gui.call("POST", "/api/melodies", {"melodies": [{"territory_id": "par:3203601", "rhythm": "Canto"}, {"territory_id": PAR, "rhythm": "Canto"}, {"territory_id": "con:32003", "rhythm": "Canto"}]})
mel_ids = j.get("ids", []) if c == 200 else []
c2, lst = gui.call("GET", "/data/exports/melodias/melodias.json")
names = {m["id"]: m["name"] for m in (lst if isinstance(lst, list) else lst.get("melodies", lst.get("items", [])))}
got = [names.get(i, "") for i in mel_ids]
ok("nome da melodía: «Canto #1 da Abeleda» (sen santo, de + A = da)", len(got) == 3 and got[0] == "Canto #1 da Abeleda", got)
ok("…sen artigo: «Canto #1 de Lira»", len(got) == 3 and got[1] == "Canto #1 de Lira", got)
ok("…concello con artigo: «Canto #1 da Arnoia»", len(got) == 3 and got[2] == "Canto #1 da Arnoia", got)
for i in mel_ids:
    gui.call("POST", "/api/melodies", {"melodies": [{"id": i, "_delete": True}]})
c, j = ana.call("POST", "/api/melodies", {"melodies": [{"territory_id": PAR, "rhythm": "Canto"}]})
ok("foleante non crea melodías (403)", c == 403, (c, j))

# --- unha variante noutro territorio é outra copla
OIT = "par:3203601"  # A Abeleda (San Vicente): faise de «Oitavén» no exemplo real
def coplas_json():
    c, items = anon.call("GET", "/data/exports/coplas/coplas.json")
    return items if isinstance(items, list) else items.get("coplas", [])
base = {"text": "Aldeíña de Ferreiros,\naldea que me namora,\naínda mas ha de pagar\nquen dela me bote fóra.", "status": "published", "territory_state": "assigned",
        "territories": [{"id": PAR}], "tags": ["aldea"], "is_volta": False,
        "versions": [{"label": "Variante 1", "text": "Aldea de San Vicente,\naldea que me namora,\naínda mas ha de pagar\nquen dela me bote fóra.", "territories": [{"id": OIT}]},
                     {"label": "Variante 2", "text": "Aldeíña de Ferreiros (outra),\naldea que me namora", "territories": [{"id": PAR}]},
                     {"label": "Variante 3", "text": "Aldeíña de Ferreiros (herdada),\naldea que me namora", "territories": []}]}
c, j = gui.call("POST", "/api/coplas", {"coplas": [base]})
ok("variantes: garda a copla con variantes", c == 200 and j.get("ids"), (c, j)); pid = j["ids"][0]
allc = coplas_json()
kids = [x for x in allc if x.get("variant_of") == pid]
ok("variante noutro territorio: xérase unha copla propia (e só esa)", len(kids) == 1 and [t["id"] for t in kids[0]["territories"]] == [OIT], kids)
ok("…co texto da variante, as etiquetas da principal e sen variantes propias", kids and kids[0]["text"].startswith("Aldea de San Vicente") and kids[0]["tags"] == ["aldea"] and kids[0]["versions"] == [], kids and kids[0])
ok("variante no mesmo territorio ou sen territorio: non se duplica", sum(1 for x in allc if "outra)" in x["text"] or "herdada" in x["text"]) == 0, [x["text"][:20] for x in allc if "Aldeíña de Ferreiros" in x["text"]])
ok("a copla principal non cambia os seus territorios", [t["id"] for t in next(x for x in allc if x["id"] == pid)["territories"]] == [PAR])
kid_id = kids[0]["id"]
c, j = gui.call("POST", "/api/coplas", {"coplas": [{**base, "id": pid, "notes": "revisada"}]})
kids2 = [x for x in coplas_json() if x.get("variant_of") == pid]
ok("ao regardar a principal, a filla conserva o seu id", c == 200 and [k["id"] for k in kids2] == [kid_id], (c, kids2))
c, j = gui.call("POST", "/api/coplas", {"coplas": [{"id": kid_id, "text": "Outro texto", "territory_state": "unassigned", "territories": [], "tags": [], "versions": []}]})
ok("unha copla-variante non se edita directamente (400)", c == 400 and "principal" in json.dumps(j, ensure_ascii=False), (c, j))
c, j = gui.call("DELETE", "/api/coplas", {"ids": [kid_id]})
ok("…nin se borra soa (400)", c == 400, (c, j))
two = json.loads(json.dumps(base)); two["id"] = pid; two["versions"][0]["territories"] = [{"id": OIT}, {"id": "con:32003"}]
c, j = gui.call("POST", "/api/coplas", {"coplas": [two]})
kids3 = [x for x in coplas_json() if x.get("variant_of") == pid]
ok("a variante en dous territorios: unha soa filla con ambos", len(kids3) == 1 and kids3[0]["id"] == kid_id and sorted(t["id"] for t in kids3[0]["territories"]) == sorted([OIT, "con:32003"]), kids3)
three = json.loads(json.dumps(base)); three["id"] = pid; three["territories"] = [{"id": PAR}, {"id": OIT}]
c, j = gui.call("POST", "/api/coplas", {"coplas": [three]})
ok("se a principal pasa a ter o territorio da variante, xa non se duplica (filla borrada)", not [x for x in coplas_json() if x.get("variant_of") == pid], c)
c, j = gui.call("POST", "/api/coplas", {"coplas": [{**base, "id": pid}]})
c, j = gui.call("DELETE", "/api/coplas", {"ids": [pid]})
ok("borrar a principal borra as súas variantes-copla", c == 200 and not [x for x in coplas_json() if x["id"] == pid or x.get("variant_of") == pid], (c, j))

# --- lotes grandes: o Worker garda N coplas en poucas consultas (límite de 50 por petición no plan gratuíto)
big = [{"text": f"Copla de lote {i}\nsegundo verso {i}", "territories": [{"id": PAR}], "tags": ["lote", f"serie{i % 3}", "lote"],
        "territory_state": "assigned", "is_volta": i % 7 == 0, "lugar": "A Eira" if i % 2 else "", "versions": []} for i in range(40)]
big[5]["versions"] = [{"label": "V", "text": "Versión do lote cinco\nsegundo", "territories": [{"id": OIT}, {"id": OIT}]}]
c, j = gui.call("POST", "/api/coplas", {"coplas": big})
ok("lote de 40 coplas nunha petición (200, 40 ids distintos)", c == 200 and len(set(j.get("ids", []))) == 40, (c, str(j)[:200]))
bigids = j["ids"]
rows = {x["id"]: x for x in coplas_json()}
ok("lote: cada copla garda o seu texto, territorio, etiquetas (sen repetir) e lugar", all(rows[i]["text"].startswith(f"Copla de lote {n}") and [t["id"] for t in rows[i]["territories"]] == [PAR] and sorted(rows[i]["tags"]) == sorted({"lote", f"serie{n % 3}"}) for n, i in enumerate(bigids)), [rows[i] for i in bigids[:2]])
ok("lote: as voltas e o lugar van coa copla correcta", rows[bigids[7]]["is_volta"] and not rows[bigids[8]]["is_volta"] and rows[bigids[1]].get("lugar") == "A Eira" and not rows[bigids[2]].get("lugar"), (rows[bigids[7]], rows[bigids[1]]))
ok("lote: a versión da copla 5 queda nela e crea a súa variante noutro territorio", len(rows[bigids[5]]["versions"]) == 1 and any(x.get("variant_of") == bigids[5] and [t["id"] for t in x["territories"]] == [OIT] for x in rows.values()), rows[bigids[5]].get("versions"))
edit = [{**big[i], "id": bigids[i], "text": f"Copla de lote {i} editada\nsegundo verso"} for i in (0, 1, 2)] + [{"text": "Copla nova no medio da edición\nverso", "territory_state": "unassigned", "territories": [], "tags": []}]
c, j = gui.call("POST", "/api/coplas", {"coplas": edit})
rows = {x["id"]: x for x in coplas_json()}
ok("lote mixto (3 edicións + 1 nova): conserva ids e engade a nova", c == 200 and j["ids"][:3] == bigids[:3] and j["ids"][3] not in bigids and "editada" in rows[bigids[1]]["text"] and len(rows[bigids[1]]["tags"]) == 2, (c, j))
c, j = gui.call("POST", "/api/coplas", {"coplas": [{"text": "Boa\nverso", "territories": [{"id": PAR}]}, {"text": "Mala\nverso", "territories": [{"id": "par:nonexiste"}]}]})
ok("un lote con unha copla inválida non garda ningunha (400)", c == 400 and not [x for x in coplas_json() if x["text"].startswith("Boa\nverso")], (c, j))
extra = [x["id"] for x in coplas_json() if x["text"].startswith("Copla nova no medio")]
c, j = gui.call("DELETE", "/api/coplas", {"ids": bigids + extra})
ok("lote: borrar as 40 de golpe (e as variantes)", c == 200 and not [x for x in coplas_json() if x["id"] in bigids or x.get("variant_of") in bigids], (c, str(j)[:100]))

# --- Identidade e trazos: POST /api/territory-traits (antes non existía no Worker) ---
def territorios_json():
    c, j = anon.call("GET", "/data/exports/territorios/territorios.json")
    return j if c == 200 else []
def traits_of(tid):
    return next((t for t in territorios_json() if t["id"] == tid), {}).get("traits", [])
TC = "con:15004"  # Ares
TP = "par:1502004"
c, _ = ana.call("POST", "/api/territory-traits", {"traits": [{"territory_id": TC, "trait": "x"}]})
ok("trazos: unha persoa foleante non pode gardar (403)", c == 403, c)
c, _ = anon.call("POST", "/api/territory-traits", {"traits": [{"territory_id": TC, "trait": "x"}]})
ok("trazos: sen sesión (401)", c == 401, c)
c, j = gui.call("POST", "/api/territory-traits", {"traits": [{"territory_id": TC, "trait": "Tócase a gaita", "category": "Música e instrumentos", "notes": "Sobre todo en festas\npatronais"}]})
ok("trazos: unha guía garda un trazo e devolve o id (JSON)", c == 200 and j.get("ok") and len(j.get("ids", [])) == 1, (c, j)); tid = j["ids"][0]
got = [t for t in traits_of(TC) if t["id"] == tid]
ok("trazos: o exporte de territorios inclúe categoría e nota", got and got[0]["trait"] == "Tócase a gaita" and got[0]["category"] == "Música e instrumentos" and "patronais" in got[0]["notes"], got)
c, j = gui.call("POST", "/api/territory-traits", {"traits": [{"territory_id": TC, "trait": "tócase A GAITA"}]})
ok("trazos: repetir o trazo no mesmo territorio (sen distinguir maiúsculas) dá 409", c == 409, (c, j))
c, j = gui.call("POST", "/api/territory-traits", {"traits": [{"id": tid, "territory_id": TC, "trait": "Tócase a gaita galega", "category": "Música e instrumentos", "notes": None}]})
got = [t for t in traits_of(TC) if t["id"] == tid]
ok("trazos: editar cambia o texto e quita a nota", c == 200 and got and got[0]["trait"] == "Tócase a gaita galega" and not got[0]["notes"], (c, got))
c, j = gui.call("POST", "/api/territory-traits", {"traits": [{"territory_id": TP, "trait": "Gheada", "category": "Fala e lingua"}]}); tid2 = j["ids"][0]
for bad, label in (({"territory_id": "par:nonexiste", "trait": "a"}, "territorio descoñecido"), ({"territory_id": TC, "trait": "   "}, "trazo baleiro"),
                   ({"territory_id": TC, "trait": "a" * 121}, "trazo longo de máis"), ({"territory_id": TC, "trait": "ok", "notes": "n" * 601}, "nota longa de máis"),
                   ({"id": 999999, "territory_id": TC, "trait": "fantasma"}, "editar un id que non existe")):
    c, j = gui.call("POST", "/api/territory-traits", {"traits": [bad]})
    ok(f"trazos: {label} → erro JSON con mensaxe", c in (400, 404) and isinstance(j, dict) and j.get("error"), (c, j))
c, j = gui.call("POST", "/api/territory-traits", {"nada": 1})
ok("trazos: corpo sen 'traits' → 400 con mensaxe", c == 400 and j.get("error"), (c, j))
c, j = gui.call("POST", "/api/territory-traits", {"traits": [{"id": tid, "_delete": True}, {"id": tid2, "_delete": True}]})
ok("trazos: borrar (en lote)", c == 200 and not [t for t in traits_of(TC) + traits_of(TP) if t["id"] in (tid, tid2)], (c, j))

restore_coplas(MAX_COPLA_ID)
finish()
