"""E2E: botón Atrás/Adiante do navegador (vistas e rutas #/...), foco en capas modais, skip link."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


def view(pg):
    return pg.evaluate("document.querySelector('.view.active')?.id")


def wait(pg, ms=500):
    pg.wait_for_timeout(ms)


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.route("**/*", handler)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(APP + "/")
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000)
    wait(pg, 1500)

    # --- vistas
    pg.click('.sidebar [data-view="coplas"]'); wait(pg)
    pg.click('.sidebar [data-view="pieces"]'); wait(pg)
    pg.click('.sidebar [data-view="media"]'); wait(pg)
    ok("tres vistas navegadas", view(pg) == "view-media", view(pg))
    pg.go_back(); wait(pg)
    ok("Atrás -> pezas", view(pg) == "view-pieces", view(pg))
    pg.go_back(); wait(pg)
    ok("Atrás -> coplas", view(pg) == "view-coplas", view(pg))
    pg.go_back(); wait(pg)
    ok("Atrás -> mapa", view(pg) == "view-map", view(pg))
    pg.go_forward(); wait(pg)
    ok("Adiante -> coplas", view(pg) == "view-coplas", view(pg))
    ok("o menú marca a vista activa", pg.evaluate("document.querySelector('.sidebar [data-view=coplas]').classList.contains('active')"))

    # --- drawer pechado ao navegar
    pg.locator("#view-coplas .gallery-card, #view-coplas [data-open-copla]").first.click(); wait(pg, 600)
    ok("drawer aberto", not pg.evaluate("document.getElementById('coplaDrawer').hidden"))
    pg.go_back(); wait(pg)
    ok("Atrás pecha o drawer e vai ao mapa", pg.evaluate("document.getElementById('coplaDrawer').hidden") and view(pg) == "view-map", view(pg))

    # --- privacidade
    pg.click('.sidebar [data-view="about"]'); wait(pg)
    pg.click("[data-privacy-link]"); wait(pg, 800)
    ok("privacidade aberta con hash", pg.evaluate("location.hash") == "#/privacidade" and pg.locator(".privacy-doc").count() == 1)
    pg.go_back(); wait(pg)
    ok("Atrás sae da privacidade e queda en Sobre", pg.locator(".privacy-doc").count() == 0 and view(pg) == "view-about" and pg.evaluate("location.hash") == "", pg.evaluate("location.hash"))
    pg.go_forward(); wait(pg, 800)
    ok("Adiante volve á privacidade", pg.locator(".privacy-doc").count() == 1 and pg.evaluate("location.hash") == "#/privacidade")
    pg.click("[data-privacy-back]"); wait(pg)
    ok("«Sobre o arquivo» pecha a privacidade", pg.locator(".privacy-doc").count() == 0 and pg.evaluate("location.hash") == "")
    pg.go_back(); wait(pg, 800)
    ok("Atrás despois de pechar volve á privacidade", pg.locator(".privacy-doc").count() == 1)

    # --- autoría
    pg.click('.sidebar [data-view="pieces"]'); wait(pg)
    pg.evaluate("window.folearApp.openAuthor('Pandereteiras Soalleira')"); wait(pg, 700)
    ok("ficha de autoría con hash", pg.evaluate("location.hash").startswith("#/autoria/") and pg.locator(".author-ficha, [data-author-back]").count() > 0, pg.evaluate("location.hash"))
    pg.go_back(); wait(pg, 700)
    ok("Atrás sae da ficha (hash baleiro, vista pezas)", pg.evaluate("location.hash") == "" and view(pg) == "view-pieces" and pg.locator(".author-ficha").count() == 0, (pg.evaluate("location.hash"), view(pg)))
    pg.go_forward(); wait(pg, 700)
    ok("Adiante volve á ficha", pg.evaluate("location.hash").startswith("#/autoria/"))

    # --- ligazón directa e recarga
    pg.goto(APP + "/#/privacidade"); pg.wait_for_selector("#global-loading[hidden]", state="attached"); wait(pg, 1500)
    ok("ligazón directa a privacidade", pg.locator(".privacy-doc").count() == 1)
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]", state="attached"); wait(pg, 1500)
    ok("recarga mantén a privacidade", pg.locator(".privacy-doc").count() == 1)
    ok("sen erros de JS", not errs, errs[:3])

    # --- skip link e foco
    pg.goto(APP + "/"); pg.wait_for_selector("#global-loading[hidden]", state="attached"); wait(pg, 1500)
    pg.keyboard.press("Tab")
    ok("skip link é o primeiro foco", pg.evaluate("document.activeElement.className") == "skip-link")
    pg.keyboard.press("Enter"); wait(pg, 200)
    ok("skip link leva a <main> sen cambiar a URL", pg.evaluate("document.activeElement.id") == "main" and pg.evaluate("location.hash") == "")

    pg.click('.sidebar [data-view="coplas"]'); wait(pg, 800)
    card = pg.locator("#view-coplas .gallery-card, #view-coplas [data-open-copla]").first
    card.click(); pg.wait_for_selector("#coplaDrawer:not([hidden]) [role=dialog]"); wait(pg, 400)
    inside = "document.querySelector('#coplaDrawer [role=dialog]').contains(document.activeElement)"
    ok("o drawer colle o foco", pg.evaluate(inside))
    for _ in range(40):
        pg.keyboard.press("Tab")
    ok("Tab non sae do drawer", pg.evaluate(inside))
    for _ in range(40):
        pg.keyboard.press("Shift+Tab")
    ok("Maiús+Tab non sae do drawer", pg.evaluate(inside))
    pg.keyboard.press("Escape"); wait(pg, 400)
    ok("Esc pecha o drawer", pg.evaluate("document.getElementById('coplaDrawer').hidden"))
    ok("o foco volve á vista de coplas", pg.evaluate("document.activeElement.closest('#view-coplas') !== null"))

    # --- ficha da copla: texto central, pregos e navegación anterior/seguinte
    sheet = "document.querySelector('#coplaDrawer [data-sheet-copla]')"
    card.click(); pg.wait_for_selector("#coplaDrawer .copla-sheet"); wait(pg, 400)
    ok("ficha: a copla é o centro (texto completo)", pg.locator("#coplaDrawer .copla-hero-text").inner_text().strip().count("\n") >= 1)
    ok("ficha: sen seccións baleiras 'Sen ...'", "sen variantes" not in pg.locator("#coplaDrawer").inner_text().lower() and "sen recursos" not in pg.locator("#coplaDrawer").inner_text().lower())
    ok("ficha: os detalles son pregos pechados", pg.locator("#coplaDrawer details[open]").count() == 0)
    ok("ficha: o + é pequeno e non está nas accións", pg.locator("#coplaDrawer .drawer-actions [data-add-copla]").count() == 0 and pg.locator("#coplaDrawer .drawer-tools [data-add-copla]").count() == 1)
    ok("ficha: 1 / N", pg.locator("#coplaDrawer .drawer-pager span").inner_text().startswith("1 / "), pg.locator("#coplaDrawer .drawer-pager span").inner_text())
    pg.screenshot(path=str(OUT / "copla_sheet.png"))
    first_id = pg.evaluate(sheet + ".dataset.sheetCopla")
    first_text = pg.locator("#coplaDrawer .copla-hero-text").inner_text()
    pg.keyboard.press("ArrowRight"); wait(pg, 350)
    ok("→ pasa á seguinte", pg.locator("#coplaDrawer .drawer-pager span").inner_text().startswith("2 / ") and pg.evaluate(sheet + ".dataset.sheetCopla") != first_id)
    ok("o foco segue dentro da ficha", pg.evaluate(inside))
    ok("o texto cambia", pg.locator("#coplaDrawer .copla-hero-text").inner_text() != first_text)
    pg.keyboard.press("ArrowLeft"); wait(pg, 350)
    ok("← volve á anterior", pg.evaluate(sheet + ".dataset.sheetCopla") == first_id and pg.locator("#coplaDrawer [data-copla-step='-1']").is_disabled())
    pg.keyboard.press("ArrowLeft"); wait(pg, 200)
    ok("← na primeira non fai nada", pg.evaluate(sheet + ".dataset.sheetCopla") == first_id)
    # deslizamento táctil (esquerda = seguinte, dereita = anterior)
    swipe = """dx => { const el = document.querySelector('#coplaDrawer .copla-hero-text');
      const mk = (t, x) => new Touch({identifier: 1, target: el, clientX: x, clientY: 300});
      el.dispatchEvent(new TouchEvent('touchstart', {bubbles: true, cancelable: true, touches: [mk(0, 300)], targetTouches: [mk(0, 300)], changedTouches: [mk(0, 300)]}));
      el.dispatchEvent(new TouchEvent('touchend', {bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [mk(0, 300 + dx)]})); }"""
    pg.evaluate(swipe, -140); wait(pg, 350)
    ok("deslizar á esquerda: seguinte", pg.evaluate(sheet + ".dataset.sheetCopla") != first_id)
    pg.evaluate(swipe, 140); wait(pg, 350)
    ok("deslizar á dereita: anterior", pg.evaluate(sheet + ".dataset.sheetCopla") == first_id)
    pg.evaluate(swipe, 20); wait(pg, 250)
    ok("un toque curto non cambia de copla", pg.evaluate(sheet + ".dataset.sheetCopla") == first_id)
    pg.keyboard.press("Escape"); wait(pg, 400)
    ok("Esc pecha a ficha navegada", pg.evaluate("document.getElementById('coplaDrawer').hidden"))
    card.click(); pg.wait_for_selector("#coplaDrawer .copla-sheet"); wait(pg, 400)

    # --- contraste do texto dos niveis (parroquia/concello/comarca/provincia) >= 4.5:1 sobre o papel
    pg.goto(APP + "/"); pg.wait_for_selector("#global-loading[hidden]", state="attached"); wait(pg, 1200)
    pg.click('.sidebar [data-view="coplas"]'); wait(pg, 900)
    worst = pg.evaluate("""()=>{
      const lum=c=>{const [r,g,b]=c.match(/\\d+(\\.\\d+)?/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*r+0.7152*g+0.0722*b};
      const bg=lum('rgb(247,247,242)');let min=99;
      document.querySelectorAll('.level-text, [class*="level-"]').forEach(e=>{const c=getComputedStyle(e).color;const l=lum(c);const r=(Math.max(l,bg)+0.05)/(Math.min(l,bg)+0.05);if(r<min)min=r});
      return min}""")
    ok("contraste do texto dos niveis >= 4.5", worst >= 4.5, round(worst, 2))

finish()
