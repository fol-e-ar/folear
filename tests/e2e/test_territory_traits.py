"""E2E: «Identidade e trazos» dun territorio: engadir/editar/eliminar (guía), herdanza cara arriba
clasificada por categoría, filtro, e que unha persoa foleante só os vexa."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, sql, Client, fake_login_as, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S

for t in ("follows", "favorites", "profiles", "sessions", "users"):
    sql(f"delete from {t}")
sql("delete from territory_traits")
errs = []
ARES, ARES_PAR, LUGO_PROV, CORU = "con:15004", None, "prov:27", "prov:15"


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


def login(b, sub, email, name, vp=None):
    fake_login_as(sub, email, name)
    ctx = b.new_context(viewport=vp or {"width": 1440, "height": 900})
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.route("**/*", handler)
    pg.goto(APP + "/api/auth/google?next=/")
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1500)
    return ctx, pg


def open_summary(pg, tid):
    pg.goto(APP + f"/?territory_id={tid}&view=territory"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1200)
    pg.click('[data-territory-tab="summary"]'); pg.wait_for_selector("#territoryIdentity"); pg.wait_for_timeout(300)


Client("g-t1", "g-t1@example.com", "GuiaT").call("GET", "/api/auth/me")
Client("g-t2", "g-t2@example.com", "NovaT").call("GET", "/api/auth/me")
sql("update users set role = 'guia' where email = 'g-t1@example.com'")
# un trazo previo noutro concello da mesma provincia, sen categoría suxerida, para a herdanza
other = sql("select id from territories where tipo = 'con' and prov_cod = '15' and id != ? limit 1", ARES)[0][0]
sql("insert into territory_traits (territory_id, trait, category, notes) values (?, 'Tócase a gaita', 'música e INSTRUMENTOS', 'Dende sempre')", other)
sql("insert into territory_traits (territory_id, trait, category) values (?, 'Fala con gheada', 'Dialecto')", other)
Client("g-t1", "g-t1@example.com", "GuiaT").call("GET", "/data/exports/territorios/territorios.json")  # (quenta o exporte)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx, pg = login(b, "g-t1", "g-t1@example.com", "GuiaT")
    open_summary(pg, ARES)
    ok("guía: ve o botón de engadir e o formulario está pechado", pg.locator("#addTerritoryTrait").is_visible() and pg.locator("#territoryTraitForm").is_hidden())
    pg.click("#addTerritoryTrait")
    ok("o formulario ten trazo, categoría, nota e categorías suxeridas", pg.locator("#territoryTraitInput").is_visible() and pg.locator("#territoryTraitNotes").is_visible() and pg.locator("[data-trait-cat]").count() >= 7, pg.locator("[data-trait-cat]").count())
    pg.click("#saveTerritoryTrait")
    ok("gardar baleiro avisa e non chama ao servidor", "Escribe o trazo" in pg.inner_text("#territoryTraitFeedback"))
    pg.fill("#territoryTraitInput", "Tócase a gaita"); pg.click('[data-trait-cat="Música e instrumentos"]')
    ok("elixir unha categoría suxerida enche o campo", pg.input_value("#territoryTraitCategory") == "Música e instrumentos")
    pg.fill("#territoryTraitNotes", "Sobre todo nas festas patronais."); pg.click("#saveTerritoryTrait"); pg.wait_for_timeout(1500)
    ok("gardar un trazo (sen «Unexpected end of JSON input») amósao baixo a súa categoría",
       pg.locator('.territory-trait-own [data-trait-group="musica e instrumentos"] .trait-row').count() == 1 and "festas patronais" in pg.inner_text(".territory-trait-own"), pg.inner_text("#territoryIdentity")[:300])
    ok("tras engadir, o formulario segue aberto, baleiro e coa categoría posta", pg.locator("#territoryTraitForm").is_visible() and pg.input_value("#territoryTraitInput") == "" and pg.input_value("#territoryTraitCategory") == "Música e instrumentos")
    pg.fill("#territoryTraitInput", "báilase a muiñeira"); pg.fill("#territoryTraitCategory", "Baile"); pg.click("#saveTerritoryTrait"); pg.wait_for_timeout(1500)
    ok("segundo trazo noutra categoría", pg.locator(".territory-trait-own .trait-group").count() == 2, pg.locator(".territory-trait-own .trait-group h4").all_inner_texts())
    pg.fill("#territoryTraitInput", "TÓCASE A GAITA"); pg.click("#saveTerritoryTrait"); pg.wait_for_timeout(600)
    ok("repetir un trazo avisa", "xa está" in pg.inner_text("#territoryTraitFeedback"), pg.inner_text("#territoryTraitFeedback"))
    pg.click("#cancelTerritoryTrait")
    # editar
    pg.locator('[data-trait-group="baile"] [data-edit-trait]').click()
    ok("editar carga o trazo no formulario", pg.input_value("#territoryTraitInput") == "báilase a muiñeira" and pg.inner_text("#territoryTraitFormTitle") == "Editar trazo")
    pg.fill("#territoryTraitInput", "Báilase a muiñeira de Ares"); pg.fill("#territoryTraitNotes", "Con pandeireta."); pg.click("#saveTerritoryTrait"); pg.wait_for_timeout(1500)
    own = pg.inner_text(".territory-trait-own")
    ok("editar actualiza o trazo e a nota (sen duplicar)", "Báilase a muiñeira de Ares" in own and "Con pandeireta" in own and "báilase a muiñeira" not in own.replace("Báilase a muiñeira de Ares", ""), own)
    pg.screenshot(path=str(OUT / "trazos-propios.png"))
    # herdanza: a provincia ve o de Ares e o do outro concello, agrupado por categoría
    open_summary(pg, CORU)
    cats = pg.locator("details.trait-cat summary span:first-child").all_inner_texts()
    ok("provincia: herda e clasifica por categoría (suxeridas primeiro, «Dialecto» despois)", cats == ["Música e instrumentos", "Baile", "Dialecto"], cats)
    row = pg.locator('details[data-trait-cat-group="musica e instrumentos"] .trait-row')
    ok("«Tócase a gaita» (dous concellos, categoría escrita distinto) únese nun só trazo con 2 lugares", row.count() == 1 and "2 lugares" in row.inner_text() and row.locator(".trait-source").count() == 2, row.all_inner_texts())
    ok("provincia: non amosa botóns de editar trazos alleos nin o seu propio listado", pg.locator(".territory-trait-own").count() == 0 or pg.locator("#territoryIdentity [data-edit-trait]").count() == 0)
    pg.locator("#territoryIdentity").screenshot(path=str(OUT / "trazos-herdados.png"))
    pg.locator('details[data-trait-cat-group="baile"] .trait-source').first.click(); pg.wait_for_timeout(1500)
    ok("premer a orixe dun trazo herdado abre ese territorio", pg.locator("#view-territory h1, #view-territory .territory-title").first.inner_text().strip().startswith("Ares") or "Ares" in pg.inner_text("#view-territory")[:400])
    # outra provincia: sen trazos
    open_summary(pg, LUGO_PROV)
    ok("provincia sen trazos: mensaxe baleira", "aínda non teñen trazos" in pg.inner_text("#territoryIdentity"), pg.inner_text("#territoryIdentity")[:200])
    # borrar
    open_summary(pg, ARES)
    pg.locator('[data-trait-group="baile"] [data-remove-trait]').click(); pg.wait_for_timeout(1500)
    ok("eliminar quita o trazo (e a súa categoría)", pg.locator('[data-trait-group="baile"]').count() == 0 and pg.locator(".territory-trait-own .trait-group").count() == 1)
    ctx.close()

    # persoa foleante: ve os trazos pero non os pode editar
    ctx, pg = login(b, "g-t2", "g-t2@example.com", "NovaT")
    open_summary(pg, ARES)
    ok("foleante: ve os trazos de Ares", "Tócase a gaita" in pg.inner_text(".territory-trait-own"))
    ok("foleante: sen botón de engadir, editar nin eliminar", pg.locator("#addTerritoryTrait").is_hidden() and pg.locator("[data-edit-trait]").first.is_hidden() and pg.locator("[data-remove-trait]").first.is_hidden() and pg.locator("#territoryTraitForm").is_hidden())
    # aínda que forzase a petición, o servidor di que non
    r = pg.evaluate("""fetch('/api/territory-traits', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({traits: [{territory_id: 'con:15004', trait: 'colada'}]})}).then(async r => [r.status, (await r.json()).error])""")
    ok("foleante: o servidor rexeita escribir (403 con mensaxe JSON)", r[0] == 403 and r[1], r)
    # Galiza no seu conxunto
    pg.goto(APP + "/?view=territory"); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1200)
    if pg.locator('[data-territory-tab="summary"]').count():
        pg.click('[data-territory-tab="summary"]'); pg.wait_for_timeout(500)
        ok("Galiza: amosa os trazos de todos os territorios", "Trazos de Galiza" in pg.inner_text("#territoryIdentity") and pg.locator("details.trait-cat").count() == 2, pg.inner_text("#territoryIdentity")[:200])
    ctx.close()

    # móbil: o formulario cabe e non desborda
    ctx, pg = login(b, "g-t1", "g-t1@example.com", "GuiaT", {"width": 390, "height": 844})
    open_summary(pg, ARES); pg.click("#addTerritoryTrait"); pg.wait_for_timeout(300)
    over = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    ok("móbil: sen desbordamento horizontal co formulario aberto", over <= 1, over)
    pg.screenshot(path=str(OUT / "trazos-movil.png"))
    ctx.close()
    b.close()

ok("sen erros de JS", not errs, errs[:3])
finish()
