"""E2E: cancelar a edición dunha copla devolve a onde estabamos (vista, territorio e ficha), non a «Nova copla»."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, sql, Client, fake_login_as, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S

for t in ("follows", "favorites", "profiles", "sessions", "users"):
    sql(f"delete from {t}")
errs = []
Client("g-c1", "g-c1@example.com", "GuiaC").call("GET", "/api/auth/me")
sql("update users set role = 'guia' where email = 'g-c1@example.com'")


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


def wait(pg, ms=1200):
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(ms)


with sync_playwright() as p:
    b = p.chromium.launch()
    fake_login_as("g-c1", "g-c1@example.com", "GuiaC")
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.route("**/*", handler)
    pg.goto(APP + "/api/auth/google?next=/"); wait(pg, 1500)

    # A) desde un territorio, coa ficha da copla aberta
    pg.goto(APP + "/?territory_id=prov:15&view=territory"); wait(pg)
    pg.wait_for_selector("#territoryCoplaList [data-open-copla]")
    first = pg.locator("#territoryCoplaList [data-open-copla]").first
    cid = first.get_attribute("data-open-copla"); first.click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    pg.click("#coplaDrawer [data-edit-copla]"); pg.wait_for_selector("#cancelEdit")
    ok("editar abre o formulario con «Cancelar edición»", pg.locator("#view-submit.active").count() == 1)
    pg.click("#cancelEdit"); pg.wait_for_timeout(900)
    ok("cancelar volve ao territorio onde estabamos (non a «Nova copla»)", pg.locator("#view-territory.active").count() == 1 and pg.locator("#view-submit.active").count() == 0, pg.evaluate("document.querySelector('.view.active, [id^=view-].active')?.id"))
    ok("…co mesmo territorio seleccionado", "A Coruña" in pg.inner_text("#view-territory"))
    ok("…e a ficha da mesma copla aberta outra vez", not pg.evaluate("document.querySelector('#coplaDrawer').hidden") and pg.locator(f'#coplaDrawer [data-edit-copla="{cid}"]').count() == 1, (cid, pg.locator("#coplaDrawer [data-edit-copla]").first.get_attribute("data-edit-copla")))
    pg.goto(APP + "/?view=coplas"); wait(pg)
    pg.click('#view-coplas [data-view="submit"]'); pg.wait_for_timeout(600)
    ok("despois, «+ Nova copla» abre o formulario limpo, sen «Cancelar edición»", pg.locator("#view-submit.active").count() == 1 and pg.locator("#cancelEdit").count() == 0)

    # B) desde a lista de coplas, sen ficha
    pg.goto(APP + "/?view=coplas"); wait(pg)
    pg.wait_for_selector("#view-coplas [data-open-copla]")
    pg.locator("#view-coplas [data-open-copla]").first.click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) [data-edit-copla]"); pg.click("#coplaDrawer [data-edit-copla]")
    pg.wait_for_selector("#cancelEdit"); pg.click("#cancelEdit"); pg.wait_for_timeout(900)
    ok("desde Coplas: cancelar volve a Coplas", pg.locator("#view-coplas.active").count() == 1 and pg.locator("#view-submit.active").count() == 0)
    ctx.close(); b.close()

ok("sen erros de JS", not errs, errs[:3])
finish()
