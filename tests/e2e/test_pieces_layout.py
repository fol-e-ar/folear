"""E2E: card do mapa (melodías), pestanas das pezas fixas, vista de lista das pezas, tira de autorías, sen «Descargar estrutura»."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.route("**/*", handler)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(APP + "/")
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000)
    pg.wait_for_timeout(1500)

    # card do mapa: melodías no lugar de territorios
    card = pg.locator(".map-card .stats").inner_text().lower()
    ok("card do mapa: coplas, pezas e melodías", all(t in card for t in ("coplas", "pezas", "melodías")) and "territorios" not in card, card.replace("\n", " "))
    n = pg.evaluate("document.getElementById('mapMelodyCount').textContent")
    ok("card do mapa: nº de melodías numérico", n.isdigit(), n)

    # pezas: pestanas no mesmo sitio
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(600)
    pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(400)
    box = lambda sel: pg.locator(sel).bounding_box()
    lib = box('[data-piece-tab="library"]'); wk = box('[data-piece-tab="workshop"]')
    pg.click('[data-piece-tab="workshop"]'); pg.wait_for_timeout(500)
    lib2 = box('[data-piece-tab="library"]'); wk2 = box('[data-piece-tab="workshop"]')
    ok("pestanas: mesma posición en Biblioteca e Obradoiro", all(abs(lib[k] - lib2[k]) < 1 and abs(wk[k] - wk2[k]) < 1 for k in ("x", "y", "width", "height")), f"{lib} {lib2}")
    ok("obradoiro: sen «Descargar estrutura»", pg.locator("#downloadPiece").count() == 0 and "descargar estrutura" not in pg.locator("#view-pieces").inner_text().lower())
    ok("obradoiro: accións á dereita na mesma liña", abs(pg.locator("#openA4").bounding_box()["y"] - lib2["y"]) < 20)
    pg.screenshot(path=str(OUT / "pieces_workshop.png"))
    pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)

    # biblioteca: tarxetas por defecto, tira de autorías, lista
    ok("biblioteca: tarxetas por defecto", pg.locator("#pieceRepositoryList.piece-grid .piece-card").count() >= 1)
    ok("biblioteca: autorías en tira sobre a listaxe", pg.locator("#authorStrip .chip-link").count() >= 1 and pg.locator(".creator-note").count() == 0)
    strip_y = pg.locator("#authorStrip").bounding_box()["y"]; list_y = pg.locator("#pieceRepositoryList").bounding_box()["y"]
    ok("autorías por riba da listaxe", strip_y < list_y)
    pg.screenshot(path=str(OUT / "pieces_library_cards.png"))
    pg.click('[data-piece-view="rows"]'); pg.wait_for_timeout(400)
    ok("vista de lista das pezas", pg.locator("#pieceRepositoryList.piece-rows .piece-row").count() >= 1 and pg.locator(".piece-card").count() == 0)
    ok("lista: o botón activo cambia", pg.locator('[data-piece-view="rows"].active').count() == 1)
    pg.screenshot(path=str(OUT / "pieces_library_rows.png"))
    pg.locator(".piece-row .row-title").first.click(); pg.wait_for_selector("#pieceDrawer:not([hidden]) .drawer-panel", timeout=5000)
    ok("lista: abre a ficha da peza", True)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(1200)
    pg.click('.sidebar [data-view="pieces"]'); pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    ok("a vista de lista lémbrase", pg.locator("#pieceRepositoryList.piece-rows").count() == 1)
    # autoría desde a tira
    pg.locator("#authorStrip .chip-link").first.click(); pg.wait_for_timeout(500)
    ok("autoría: abre a ficha", pg.locator(".author-ficha").count() == 1 and pg.locator("#authorStrip").count() == 0)
    ok("sen erros de JS", not errs, str(errs[:2]))
    b.close()

finish()
