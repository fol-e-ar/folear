"""E2E (móbil estreito): buscador do mapa (placeholder e selector enteiros), chips de subterritorios
cortados sempre ao final dunha fila completa e sen «etiquetas» na interface."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, ok, finish
from playwright.sync_api import sync_playwright
import shoot_lib as S

errs = []


def handler(route):
    return route.continue_() if route.request.url.startswith((APP, "http://localhost:9911")) else S.base_handle(route)


def wait(pg, ms=1200):
    pg.wait_for_selector("#global-loading[hidden]", state="attached", timeout=30000); pg.wait_for_timeout(ms)


with sync_playwright() as p:
    b = p.chromium.launch()
    for width in (390, 360):
        ctx = b.new_context(viewport={"width": width, "height": 844}, device_scale_factor=3, has_touch=True, is_mobile=True)
        pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e))); pg.route("**/*", handler)
        pg.goto(APP + "/"); wait(pg, 1800)
        info = pg.evaluate("""() => {
          const i = document.querySelector('#mapSearch'), s = document.querySelector('#mapLayer'), btn = document.querySelector('#mapSearchBtn'), box = document.querySelector('.floating-search');
          const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(i, '::placeholder');
          c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const txtW = c.measureText(i.placeholder).width;
          const sc = getComputedStyle(s); c.font = `${sc.fontWeight} ${sc.fontSize} ${sc.fontFamily}`;
          const longest = Math.max(...[...s.options].map(o => c.measureText(o.text).width));
          return { ph: i.placeholder, phW: txtW, inputW: i.clientWidth - 12, selW: s.clientWidth, longest, boxR: box.getBoundingClientRect().right, btnR: btn.getBoundingClientRect().right, vw: innerWidth, over: document.documentElement.scrollWidth - innerWidth };
        }""")
        ok(f"{width}px: o placeholder cabe no campo", info["phW"] <= info["inputW"], info)
        ok(f"{width}px: o selector ten sitio para a palabra máis longa (Parroquias)", info["selW"] >= info["longest"] + 6, info)
        ok(f"{width}px: o buscador non desborda a pantalla", info["btnR"] <= info["boxR"] + 1 and info["boxR"] <= info["vw"] and info["over"] <= 1, info)
        ok(f"{width}px: placeholder sen «etiqueta»", "etiqueta" not in info["ph"].lower(), info["ph"])
        if width == 390:
            pg.locator(".floating-search").screenshot(path=str(OUT / "movil-buscador.png"))
        # chips: Galiza (4 provincias) e unha provincia con moitos concellos
        for target, label in (("/?view=territory", "Galiza"), ("/?territory_id=prov:15&view=territory", "A Coruña")):
            pg.goto(APP + target); wait(pg)
            box = pg.locator("#territoryChildren")
            if not box.count():
                continue
            res = pg.evaluate("""() => {
              const box = document.querySelector('#territoryChildren'), row = box.querySelector('.chip-row'), more = box.querySelector('#toggleTerritoryChildren');
              const lim = row.getBoundingClientRect().bottom;
              const chips = [...row.querySelectorAll('.chip-territory')];
              const cut = chips.filter(c => { const r = c.getBoundingClientRect(); return r.top < lim - 1 && r.bottom > lim + 1; }).length;
              const shown = chips.filter(c => c.getBoundingClientRect().bottom <= lim + 1).length;
              return { collapsed: box.classList.contains('is-collapsed'), cut, shown, total: chips.length, moreHidden: more.hidden, moreText: more.textContent };
            }""")
            ok(f"{width}px {label}: ningún chip queda cortado pola metade", res["cut"] == 0, res)
            if res["collapsed"] and not res["moreHidden"]:
                n = int(res["moreText"].split("\\")[-1])
                ok(f"{width}px {label}: «Ver máis» conta os chips agochados", n == res["total"] - res["shown"] and n > 0, res)
        ctx.close()
    # sen etiquetas na ficha dunha copla
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); pg = ctx.new_page(); pg.route("**/*", handler)
    pg.goto(APP + "/?view=coplas"); wait(pg)
    pg.locator("#view-coplas [data-open-copla]").first.click(position={"x": 12, "y": 12}); pg.wait_for_selector("#coplaDrawer:not([hidden]) .copla-sheet")
    ok("ficha de copla: sen etiquetas", pg.locator("#coplaDrawer [data-tag-name]").count() == 0)
    ctx.close(); b.close()

ok("sen erros de JS", not errs, errs[:3])
finish()
