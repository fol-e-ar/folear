"""E2E: navegación entre coplas en cada ámbito, volver do login á mesma páxina, story para Instagram,
«x» dos buscadores en móbil e ritmos pechados."""
import sys, pathlib, json, urllib.request
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, sql, Client, fake_login_as, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S

for t in ("follows", "favorites", "profiles", "sessions", "users"):
    sql(f"delete from {t}")
PAR = "par:3601505"  # Estacas (San Fiz): 4 coplas
par_ids = [r[0] for r in sql("select copla_id from copla_territories where territory_id=? order by copla_id", PAR)]
fav = Client("g-fav", "fav@example.com", "Fav")
for cid in par_ids[:2]:
    fav.call("POST", "/api/me/favorites", {"kind": "copla", "ref": str(cid), "on": True})
errs = []


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


def pager(pg):
    return pg.locator("#coplaDrawer .drawer-pager span").inner_text().strip()


with sync_playwright() as p:
    b = p.chromium.launch()

    def newpage(url="/", vp=None, **kw):
        ctx = b.new_context(viewport=vp or {"width": 1440, "height": 900}, **kw); pg = ctx.new_page()
        pg.on("pageerror", lambda e: errs.append(str(e) + " | " + (e.stack or "")[:1600].replace("\n", " ") + " @" + pg.url))
        pg.route("**/*", handler); pg.goto(APP + url)
        pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1500)
        return ctx, pg

    # --- navegación só entre as coplas da listaxe que se amosa
    ctx, pg = newpage(f"/?territory_id={PAR}&view=territory")
    n = pg.locator("#territoryCoplaList [data-open-copla]").count()
    ok("territorio: amosa as súas coplas", n == len(par_ids) == 4, (n, len(par_ids)))
    pg.locator("#territoryCoplaList [data-open-copla]").first.click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    ok("Territorios > coplas: a ficha navega só entre as do territorio", pager(pg) == "1 / 4", pager(pg))
    pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(300)
    ok("→ pasa á seguinte", pager(pg) == "2 / 4", pager(pg))
    for _ in range(5): pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(120)
    ok("…e non pasa da última", pager(pg) == "4 / 4", pager(pg))
    ctx.close()

    ctx, pg = newpage("/?view=territory")
    pg.locator("#territoryCoplaList [data-open-copla]").first.click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    ok("nivel Galiza: navega por todas as coplas (non só as cargadas)", pager(pg).startswith("1 / ") and int(pager(pg).split("/")[1]) > 100, pager(pg))
    ctx.close()

    # swipe táctil (móbil) no mesmo ámbito
    ctx, pg = newpage(f"/?territory_id={PAR}&view=territory", {"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg.locator("#territoryCoplaList [data-open-copla]").first.tap(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    pg.evaluate("""() => { const el = document.querySelector('#coplaDrawer .copla-sheet'); const mk = (type, x) => { const t = new Touch({identifier: 1, target: el, clientX: x, clientY: 300}); el.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t]})); }; mk('touchstart', 300); mk('touchend', 120); }""")
    pg.wait_for_timeout(400)
    ok("swipe á esquerda: seguinte copla do territorio", pager(pg) == "2 / 4", pager(pg))
    ctx.close()

    # --- favoritas: navegar só entre as 2 favoritas
    fake_login_as("g-fav", "fav@example.com", "Fav")
    ctx = b.new_context(viewport={"width": 1440, "height": 900}); pg = ctx.new_page(); pg.route("**/*", handler)
    pg.on("pageerror", lambda e: errs.append(str(e) + " | " + (e.stack or "")[:1600].replace("\n", " ") + " @" + pg.url))
    pg.goto(APP + "/api/auth/google?next=/%3Fview%3Dprofile"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(2000)
    ok("perfil: 2 coplas favoritas", pg.locator(".fav-list [data-copla-id]").count() == 2, pg.locator(".fav-list [data-copla-id]").count())
    pg.locator(".fav-list [data-copla-id]").first.click(); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    ok("favoritas: a ficha abre sen saír do perfil e navega entre as 2", pager(pg) == "1 / 2" and pg.locator("#view-profile.active").count() == 1, pager(pg))
    pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(300)
    ok("favoritas: → pasa á segunda", pager(pg) == "2 / 2")
    pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(200)
    ok("favoritas: non hai terceira", pager(pg) == "2 / 2")
    ctx.close()

    # --- volver do login á mesma páxina
    fake_login_as("g-back", "back@example.com", "Back")
    ctx, pg = newpage(f"/?territory_id={PAR}&view=territory")
    pg.click('[data-territory-tab="media"]'); pg.wait_for_timeout(400)
    pg.click('[data-territory-tab="coplas"]'); pg.wait_for_timeout(300)
    pg.locator("#territoryCoplaList [data-open-copla]").nth(1).click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    pg.evaluate("document.querySelector('[data-account=\"login\"]').click()")
    pg.wait_for_url(lambda u: u.startswith(APP) and "api/auth" not in u, timeout=30000)
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(2500)
    me = json.loads(pg.evaluate("fetch('/api/auth/me').then(r=>r.text())"))
    ok("login: entrou", bool(me.get("user")), me)
    ok("login: volve á vista de territorio", pg.locator("#view-territory.active").count() == 1 and "Estacas" in pg.locator("#view-territory").inner_text())
    ok("login: e á mesma ficha de copla aberta", pg.locator("#coplaDrawer:not([hidden]) .copla-sheet").count() == 1, pg.locator("#coplaDrawer").inner_text()[:40] if pg.locator("#coplaDrawer").count() else "")
    ok("login: sen restos na URL", "fe_back" not in pg.evaluate("location.href"), pg.evaluate("location.href"))
    ctx.close()
    # hash de autoría (#/privacidade) e outras vistas
    fake_login_as("g-back", "back@example.com", "Back")
    ctx, pg = newpage("/?view=melodies")
    pg.evaluate("document.querySelector('[data-account=\"login\"]').click()")
    pg.wait_for_url(lambda u: u.startswith(APP) and "api/auth" not in u, timeout=30000)
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(2000)
    ok("login: volve a Melodías", pg.locator("#view-melodies.active").count() == 1)
    ctx.close()

    # --- story (móbil)
    ctx, pg = newpage("/?view=coplas", {"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg.locator("#coplaList [data-open-copla]").first.tap(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    ok("story: botón visible en móbil", pg.locator("[data-share-story]").is_visible())
    pg.locator("[data-share-story]").tap(); pg.wait_for_selector("#storyModal .story-preview img", timeout=15000)
    dims = pg.evaluate("(() => { const i = document.querySelector('#storyModal img'); return [i.naturalWidth, i.naturalHeight]; })()")
    ok("story: imaxe 1080 x 1920", dims == [1080, 1920], dims)
    src1 = pg.evaluate("document.querySelector('#storyModal img').src")
    pg.screenshot(path=str(OUT / "story-modal.png"))
    pg.locator('[data-story-theme="tinta"]').tap(); pg.wait_for_timeout(1800)
    src2 = pg.evaluate("document.querySelector('#storyModal img')?.src")
    ok("story: cambiar de estilo xera outra imaxe", src2 and src2 != src1)
    href = pg.evaluate("document.querySelector('[data-story-download]').href")
    ok("story: descarga dispoñible (blob PNG)", href.startswith("blob:"), href[:20])
    # contido: a imaxe non está en branco (hai píxeles escuros e claros)
    stats = pg.evaluate("""async () => { const i = document.querySelector('#storyModal img'); const c = document.createElement('canvas'); c.width = 108; c.height = 192; const x = c.getContext('2d'); x.drawImage(i, 0, 0, 108, 192); const d = x.getImageData(0, 0, 108, 192).data; const set = new Set(); for (let k = 0; k < d.length; k += 4) set.add((d[k] >> 5) + ',' + (d[k+1] >> 5) + ',' + (d[k+2] >> 5)); return set.size; }""")
    ok("story: a imaxe ten contido (non é lisa)", stats >= 3, stats)
    import base64
    for theme in ("papel", "tinta", "ar"):
        pg.locator(f'[data-story-theme="{theme}"]').tap(); pg.wait_for_timeout(1500)
        data = pg.evaluate("""() => { const i = document.querySelector('#storyModal img'); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/png').split(',')[1]; }""")
        (OUT / f"story-{theme}.png").write_bytes(base64.b64decode(data))
    # caso esixente: copla longa, tres territorios (un con nome moi longo) e etiqueta «Volta»
    long_text = "\n".join(["Eu non sei que lle pasa ao meu corazón cando ve pasar a rapaza do muíño,"] * 4 + ["", "e polo camiño da ribeira vai cantando a ledicia que lle deixou o vento do sur,"] * 3)
    res = pg.evaluate("""async (text) => { const m = await import('/js/story.js'); const blob = await m.renderCoplaStory({ text, volta: true, themeId: 'tinta', lugar: 'Feira de Santa Marta de Ortigueira, pola noite', places: [{ label: 'Moscoso (San Paio)', tipo: 'par' }, { label: 'Concello de Santa Comba da Pontevea do Alén e Alén', tipo: 'con' }, { label: 'Galiza', tipo: 'prov' }] }); const u = URL.createObjectURL(blob); const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; c.getContext('2d').drawImage(i, 0, 0); return c.toDataURL('image/png').split(',')[1]; }""", long_text)
    (OUT / "story-longa.png").write_bytes(base64.b64decode(res))
    ok("story: copla longa con 3 territorios e Volta xérase", len(res) > 20000, len(res))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    ok("story: Esc pecha só o modal", pg.locator("#storyModal").count() == 0 and pg.locator("#coplaDrawer:not([hidden])").count() == 1)
    ctx.close()
    ctx, pg = newpage("/?view=coplas")
    pg.locator("#coplaList [data-open-copla]").first.click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    ok("story: agochado en escritorio", not pg.locator("[data-share-story]").is_visible())
    ctx.close()

    # --- «x» dos buscadores (móbil)
    ctx, pg = newpage("/?view=coplas", {"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    box = pg.locator("#coplaSearch")
    total = pg.locator("#coplaResultCount").inner_text()
    ok("«x»: oculta sen texto", pg.locator(".search-clear:visible").count() == 0)
    box.fill("zzzqq"); pg.wait_for_timeout(500)
    ok("«x»: aparece con texto", pg.locator("#coplaSearch + .search-clear:visible").count() == 1)
    bb = box.bounding_box(); xb = pg.locator("#coplaSearch + .search-clear").bounding_box()
    ok("«x»: dentro do campo, á dereita", bb["x"] < xb["x"] and xb["x"] + xb["width"] <= bb["x"] + bb["width"] + 1 and abs((xb["y"] + xb["height"] / 2) - (bb["y"] + bb["height"] / 2)) < 6, (bb, xb))
    ok("«x»: zona táctil >= 40px e círculo visible de 20px", xb["width"] >= 40 and xb["height"] >= 36 and pg.evaluate("getComputedStyle(document.querySelector('#coplaSearch + .search-clear'), '::before').width") == "20px", xb)
    pg.screenshot(path=str(OUT / "x-buscador.png"), clip={"x": 0, "y": max(0, bb["y"] - 20), "width": 390, "height": bb["height"] + 40})
    ok("«x»: contraste (círculo escuro, aspa clara)", pg.evaluate("getComputedStyle(document.querySelector('#coplaSearch + .search-clear'), '::before').backgroundColor") == "rgb(107, 107, 100)")
    pg.locator("#coplaSearch + .search-clear").tap(); pg.wait_for_timeout(600)
    ok("«x»: borra a busca e refai a lista", box.input_value() == "" and pg.locator("#coplaResultCount").inner_text() == total, (box.input_value(), pg.locator("#coplaResultCount").inner_text(), total))
    ok("«x»: mantén o foco no campo", pg.evaluate("document.activeElement.id") == "coplaSearch")
    pg.click('.mobile-nav [data-view="map"]'); pg.wait_for_timeout(500)
    pg.fill("#mapSearch", "Lira"); pg.wait_for_timeout(500)
    ok("«x» tamén no buscador do mapa", pg.locator("#mapSearch + .search-clear:visible").count() == 1)
    pg.locator("#mapSearch + .search-clear").tap(); pg.wait_for_timeout(400)
    ok("…e limpa os resultados do mapa", pg.input_value("#mapSearch") == "" and not pg.locator("#mapResults").inner_text().strip())
    ctx.close()

    # --- sen zoom en iPhone: viewport fixo, campos a 16px, xestos de pinch cancelados
    ctx, pg = newpage("/?view=coplas", {"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    meta = pg.evaluate("document.querySelector('meta[name=viewport]').content")
    ok("zoom: viewport sen escala (maximum-scale=1, user-scalable=no)", "maximum-scale=1" in meta and "user-scalable=no" in meta, meta)
    small = pg.evaluate("""() => [...document.querySelectorAll('input, select, textarea')].filter(e => !['checkbox','radio','range','file','color','button','submit','hidden'].includes(e.type)).filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.className || e.tagName)""")
    ok("zoom: ningún campo visíbel < 16px en táctil (vista Coplas)", not small, small)
    pg.click('.mobile-nav [data-view="map"]'); pg.wait_for_timeout(500)
    small = pg.evaluate("""() => [...document.querySelectorAll('input, select, textarea')].filter(e => !['checkbox','radio','range','file','color','button','submit','hidden'].includes(e.type)).filter(e => parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id || e.className || e.tagName)""")
    ok("zoom: ningún campo < 16px (vista Mapa)", not small, small)
    prevented = pg.evaluate("""() => { const e = new Event('gesturestart', { cancelable: true, bubbles: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }""")
    ok("zoom: gesturestart (pinch de Safari) cancelado", prevented)
    ta = pg.evaluate("getComputedStyle(document.body).touchAction")
    ok("zoom: touch-action manipulation (sen dobre toque)", ta == "manipulation", ta)
    ctx.close()

    # --- nomes curtos de parroquia en Melodías (sen o santo, con artigo contraído); Coplas, completo
    adm = Client("g-adm4", "folear3@gmail.com", "Admin")
    c, j = adm.call("POST", "/api/melodies", {"melodies": [{"territory_id": "par:3203601", "rhythm": "Xota"}, {"territory_id": PAR, "rhythm": "Xota"}]})
    mel_ids = j.get("ids", []) if c == 200 else []
    ctx, pg = newpage("/?view=melodies")
    pg.fill("#melodiesSearch", "Xota"); pg.wait_for_timeout(600)
    cards = pg.locator("#view-melodies .melody-card h3").all_inner_texts()
    ok("melodías (tarxetas): «Xota #1 da Abeleda» e «Xota #1 de Estacas»", any(t.strip() == "Xota #1 da Abeleda" for t in cards) and any(t.strip().startswith("Xota #1 de Estacas") for t in cards) and not any("(" in t for t in cards), cards[:6])
    ok("melodías: sen «número»", not any("número" in t for t in cards))
    pg.click('[data-melody-view="rows"]'); pg.wait_for_timeout(600)
    places = pg.locator("#view-melodies .melody-row .row-place").all_inner_texts()
    ok("melodías (filas): lugar sen o santo entre parénteses", places and not any("(" in t for t in places) and any(t.strip() == "A Abeleda" for t in places), places[:6])
    ctx.close()
    ctx, pg = newpage(f"/?territory_id={PAR}&view=territory")
    pl = pg.locator("#territoryCoplaList .gallery-place, #territoryCoplaList .incipit-place").first.inner_text() if pg.locator("#territoryCoplaList .gallery-place, #territoryCoplaList .incipit-place").count() else ""
    ok("coplas: o territorio segue co nome completo (con parénteses)", "(" in pl, pl)
    ctx.close()
    for i in mel_ids:
        adm.call("POST", "/api/melodies", {"melodies": [{"id": i, "_delete": True}]})

    # --- ritmos pechados (guía/admin)
    fake_login_as("g-adm2", "folear3@gmail.com", "Admin")
    ctx = b.new_context(viewport={"width": 1440, "height": 900}); pg = ctx.new_page(); pg.route("**/*", handler)
    pg.goto(APP + "/api/auth/google?next=/%3Fview%3Dmelodies"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(2000)
    pg.click('[data-new-melody=""]'); pg.wait_for_selector("#melodyRhythm")
    tag = pg.evaluate("document.querySelector('#melodyRhythm').tagName")
    opts = pg.evaluate("[...document.querySelectorAll('#melodyRhythm option')].map(o => o.value)")
    ok("melodía: o ritmo é un desplegábel pechado (sen texto libre)", tag == "SELECT" and not pg.locator("input#melodyRhythm").count())
    ok("…con «Cantar popular» e «Canto»", "Canto" in opts and "Cantar popular" in opts and "Xota" in opts and "Muiñeira" in opts, opts)
    pg.click("#saveMelody"); pg.wait_for_timeout(300)
    ok("…e sen ritmo escollido non garda", "Escolle un ritmo" in pg.locator("#melodyFeedback").inner_text(), pg.locator("#melodyFeedback").inner_text())
    ctx.close()
    b.close()

ok("sen erros de JS", not errs, errs[:3])
finish()
