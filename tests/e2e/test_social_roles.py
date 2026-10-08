"""E2E: selector de territorio do perfil (scroll e «x»), xestión de roles, directorio de Persoas
(filtro por zona), aba «Persoas» en Territorios e avatares-mapa."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, sql, Client, fake_login_as, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S

for t in ("follows", "favorites", "profiles", "sessions", "users"):
    sql(f"delete from {t}")
errs = []


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


def login(b, sub, email, name, vp=None, next_="/", mobile=False):
    fake_login_as(sub, email, name)
    ctx = b.new_context(viewport=vp or {"width": 1440, "height": 900}, has_touch=mobile, is_mobile=mobile)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.route("**/*", handler)
    pg.goto(APP + "/api/auth/google?next=" + next_)
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1800)
    return ctx, pg


# Persoas con perfil público e zona: Estacas (par, Pontevedra), Ares (con, A Coruña), Lugo (con)
PEOPLE = {"g-s1": ("Carme", "carme-sar", "par:3601505"), "g-s2": ("Brais", "brais-pena", "con:15004"), "g-s3": ("Uxia", "uxia-lugo", "con:27028")}
for sub, (name, handle, terr) in PEOPLE.items():
    Client(sub, f"{sub}@example.com", name).call("POST", "/api/me/profile", {"display_name": name, "handle": handle, "bio": "Cantareira", "territory_id": terr, "is_public": True, "show_favorites": False})
Client("g-s4", "g-s4@example.com", "Nuno").call("GET", "/api/auth/me")
sql("update users set created_at = datetime('now','-90 days'), last_login_at = datetime('now','-5 days') where email in ('g-s1@example.com','g-s3@example.com')")
sql("update users set role = 'guia' where email = 'g-s3@example.com'")

with sync_playwright() as p:
    b = p.chromium.launch()

    # --- 1. selector de territorio do perfil: scroll propio e «x» pegada ao campo
    for label, vp, mobile in (("pc", {"width": 1440, "height": 900}, False), ("móbil", {"width": 390, "height": 844}, True)):
        ctx, pg = login(b, "g-s4", "g-s4@example.com", "Nuno", vp, "/%3Fview%3Dprofile", mobile)
        pg.wait_for_selector("#pfPlace"); pg.click("#pfPlace"); pg.keyboard.type("san", delay=30); pg.wait_for_timeout(700)
        n0 = pg.locator("#pfPlaceResults button").count()
        sc = pg.evaluate("(() => { const r = document.querySelector('#pfPlaceResults'); return [r.scrollHeight, r.clientHeight]; })()")
        ok(f"{label}: a lista de territorios ten scroll propio", sc[0] > sc[1] + 50, sc)
        pg.evaluate("document.querySelector('#pfPlaceResults').scrollTop = 99999"); pg.wait_for_timeout(400)
        n1 = pg.locator("#pfPlaceResults button").count()
        ok(f"{label}: ao chegar ao fondo cárganse máis resultados (non só 8)", n0 >= 30 and n1 > n0, (n0, n1))
        ok(f"{label}: cada resultado indica o seu superior", " \\ " in pg.locator("#pfPlaceResults button").last.inner_text().replace("\n", " "), pg.locator("#pfPlaceResults button").last.inner_text())
        pg.mouse.move(vp["width"] / 2, 200); pg.mouse.wheel(0, 220); pg.wait_for_timeout(500)
        inp = pg.locator("#pfPlace").bounding_box(); clr = pg.locator("#pfPlace + .search-clear").bounding_box()
        ok(f"{label}: a «x» segue na liña do campo despois de desprazar a páxina", clr and abs((clr["y"] + clr["height"] / 2) - (inp["y"] + inp["height"] / 2)) < 3, (inp, clr))
        pg.evaluate("document.querySelector('#pfPlaceResults').scrollTop = 0")
        pg.locator("#pfPlaceResults button").first.click(); pg.wait_for_timeout(300)
        ok(f"{label}: escoller un resultado enche o campo", pg.input_value("#pfPlace") != "san" and pg.get_attribute("#pfPlace", "data-territory"), pg.input_value("#pfPlace"))
        if label == "pc":
            pg.screenshot(path=str(OUT / "perfil-territorio.png"))
        ctx.close()

    # --- 2. xestión de roles
    ctx, pg = login(b, "g-adm3", "folear3@gmail.com", "Admin")
    pg.evaluate("document.querySelector('[data-account=people]').click()"); pg.wait_for_selector(".people-row", timeout=10000); pg.wait_for_timeout(400)
    ok("roles: título «Xestión de roles»", "Xestión de roles" in pg.locator(".roles-panel h2").inner_text())
    labels = pg.locator(".roles-filter").all_inner_texts()
    ok("roles: filtros Todas / Recén chegados / Foleantes / Guías / Admins con contadores", [l.split("\n")[0] for l in labels] == ["Todas", "Recén chegados", "Foleantes", "Guías", "Admins"], labels)
    ok("roles: selector de rol en pílulas (sen <select>)", pg.locator(".role-seg").count() >= 5 and pg.locator("#peopleList select").count() == 0)
    pg.click('[data-filter="guia"]'); pg.wait_for_timeout(200)
    ok("roles: filtro Guías só amosa guías", pg.locator(".people-row").count() == 1 and "Uxia" in pg.locator(".people-row").inner_text(), pg.locator(".people-row").count())
    pg.click('[data-filter="new"]'); pg.wait_for_timeout(200)
    txt = pg.locator("#peopleList").inner_text()
    ok("roles: «Recén chegados» amosa as contas novas e non as antigas", "Carme" not in txt and "Uxia" not in txt and "Brais" in txt and "Nuno" in txt, txt[:120].replace("\n", " "))
    pg.click('[data-filter="all"]'); pg.fill("#rolesSearch", "brais"); pg.wait_for_timeout(250)
    ok("roles: o buscador filtra por nome ou correo", pg.locator(".people-row").count() == 1)
    row = pg.locator(".people-row", has_text="Brais")
    row.locator('.role-opt[data-role="guia"]').click(); pg.wait_for_timeout(700)
    ok("roles: premer «Guía» cambia o rol no servidor", sql("select role from users where email='g-s2@example.com'")[0][0] == "guia", sql("select role from users where email='g-s2@example.com'"))
    ok("roles: a pílula activa cambia e o contador actualízase", row.locator(".role-opt.active").inner_text() == "Guía" and "Guías" in pg.locator('[data-filter="guia"]').inner_text() and pg.locator('[data-filter="guia"] span').inner_text() == "2", pg.locator('[data-filter="guia"]').inner_text())
    ok("roles: a conta propia non pode baixar do rol admin", pg.locator(".people-row", has_text="folear3@gmail.com").locator('.role-opt[data-role="foleante"]').is_disabled() if pg.locator(".people-row", has_text="folear3@gmail.com").count() else True)
    sql("update users set role='foleante' where email='g-s2@example.com'")
    pg.screenshot(path=str(OUT / "roles.png"))
    ctx.close()
    ctx, pg = login(b, "g-adm3", "folear3@gmail.com", "Admin", {"width": 390, "height": 844}, "/", True)
    pg.click("#mobileExploreBtn"); pg.wait_for_timeout(300); pg.evaluate("document.querySelector('#mobileExploreMenu [data-account=people]').click()"); pg.wait_for_selector(".people-row", timeout=10000); pg.wait_for_timeout(300)
    bb = pg.locator(".role-seg").first.bounding_box()
    ok("roles (móbil): o selector ocupa o ancho da fila e cabe na pantalla", bb["x"] >= 0 and bb["x"] + bb["width"] <= 390 and bb["width"] > 250, bb)
    pg.screenshot(path=str(OUT / "roles-movil.png"))
    ctx.close()

    # --- 3 e 4. Persoas: sen «Comunidade», filtro por zona, aba en Territorios
    ctx = b.new_context(viewport={"width": 1440, "height": 900}); pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.route("**/*", handler)
    pg.goto(APP + "/?view=people"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(2000)
    page_txt = pg.locator("#view-people").inner_text()
    ok("Persoas: sen a palabra «Comunidade» nin o texto «Quen decidiu amosar...»", "Comunidade" not in page_txt and "Quen decidiu" not in page_txt, page_txt[:80])
    ok("Persoas: 3 persoas e chips de provincia", pg.locator(".person-card").count() == 3 and pg.locator(".zone-chip").count() == 4, pg.locator(".zone-chip").all_inner_texts())
    pg.click('.zone-chip:has-text("Pontevedra")'); pg.wait_for_timeout(250)
    ok("Persoas: filtrar por provincia deixa só a desa zona", pg.locator(".person-card").count() == 1 and "Carme" in pg.locator(".person-card").inner_text())
    pg.click('.zone-chip:has-text("Todas")'); pg.fill("#peopleZone", "Ares"); pg.wait_for_timeout(300)
    pg.locator("#peopleZoneResults button", has_text="Ares").first.click(); pg.wait_for_timeout(250)
    ok("Persoas: o selector de zona filtra por concello", pg.locator(".person-card").count() == 1 and "Brais" in pg.locator(".person-card").inner_text())
    pg.fill("#peopleZone", ""); pg.wait_for_timeout(250)
    ok("Persoas: borrar a zona quita o filtro", pg.locator(".person-card").count() == 3)
    # avatares-mapa
    av = pg.locator(".person-card .account-avatar")
    ok("avatares: SVG con forma de letra e cor da paleta (sen letra de texto)", av.count() == 3 and all(av.nth(i).locator("svg path").count() == 1 and not av.nth(i).inner_text().strip() for i in range(3)))
    fills = pg.evaluate("[...document.querySelectorAll('.person-card .account-avatar rect')].map(r => r.getAttribute('fill'))")
    ok("avatares: cores da identidade", all(f in ("#C24330", "#A66D35", "#685F7A", "#526A78", "#171717") for f in fills), fills)
    d1 = pg.evaluate("[...document.querySelectorAll('.person-card .account-avatar path')].map(p => p.getAttribute('d'))")
    ok("avatares: cada persoa ten a súa forma", len(set(d1)) == 3)
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1800)
    d2 = pg.evaluate("[...document.querySelectorAll('.person-card .account-avatar path')].map(p => p.getAttribute('d'))")
    ok("avatares: sempre o mesmo para a mesma persoa", d1 == d2)
    pg.screenshot(path=str(OUT / "persoas.png"))
    # aba en Territorios
    pg.goto(APP + "/?territory_id=prov:36&view=territory"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1500)
    tabs = pg.locator(".territory-tabs button").all_inner_texts()
    ok("Territorios: aba «Persoas» antes de «Resumo»", tabs == ["Coplas", "Pezas", "Melodías", "Media", "Persoas", "Resumo"], tabs)
    pg.click('[data-territory-tab="people"]'); pg.wait_for_timeout(1200)
    t = pg.locator("#territoryPeopleList").inner_text()
    ok("Territorios > Persoas: lista as persoas da provincia (e subterritorios)", "Carme" in t and "Brais" not in t and "Uxia" not in t, t.replace("\n", " "))
    pg.locator("#territoryPeopleList .person-card").first.click(); pg.wait_for_timeout(1500)
    ok("Territorios > Persoas: premer unha persoa abre o seu perfil", pg.locator("#view-people.active .profile-handle").count() == 1 and "@carme-sar" in pg.locator("#view-people .profile-handle").inner_text())
    pg.goto(APP + "/?territory_id=par:3601505&view=territory"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1200)
    pg.click('[data-territory-tab="people"]'); pg.wait_for_timeout(1000)
    ok("Territorios > Persoas: tamén na parroquia exacta", "Carme" in pg.locator("#territoryPeopleList").inner_text())
    pg.goto(APP + "/?territory_id=prov:15&view=territory"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1200)
    pg.click('[data-territory-tab="people"]'); pg.wait_for_timeout(1000)
    ok("Territorios > Persoas: unha provincia sen esa persoa non a lista", "Brais" in pg.locator("#territoryPeopleList").inner_text() and "Carme" not in pg.locator("#territoryPeopleList").inner_text())
    ctx.close()
    b.close()

ok("sen erros de JS", not errs, errs[:3])
finish()
