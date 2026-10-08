"""E2E: lista de pezas aliñada en columnas e navegación con frechas na ficha da peza."""
import sys, pathlib, urllib.request
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, sql, Client, restore_coplas
MAX_COPLA_ID = sql("select coalesce(max(id),0) from coplas")[0][0]
from playwright.sync_api import sync_playwright
import shoot_lib as S
sql("delete from media_links where media_id in (select id from media where piece_id is not null)")
sql("delete from media where piece_id is not null")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null")
for t in ("follows","favorites","profiles","sessions","users"): sql(f"delete from {t}")
ana=Client("g-ana","ana@example.com","Ana")
sql("update users set role='guia' where email=?","ana@example.com")
def mk(title,author,terr=None,lugar=""):
    d={"title":title,"author":author,"visibility":"public","links":[],"coplas":[{"copla_id":None,"text":f"Verso de {title}","position":1}]}
    if terr: d["context_territory_id"]=terr
    if lugar: d["lugar"]=lugar
    return d
print(ana.call("POST","/api/pieces",{"pieces":[
 mk("Peza Alfa","Pandereteiras Soalleira","par:1502004","Laxoso"),
 mk("Peza Beta con título bastante longo para comprobar o corte","Ana"),
 mk("Peza Gamma","María, María e Hermelinda","par:1502004"),
 mk("Peza Delta","")]}))
def handler(route):
    if route.request.url.startswith(APP): return route.continue_()
    return S.base_handle(route)
FAILS=[]
def ok(l,c,x=""):
    print(("PASS " if c else "FAIL ")+l,x)
    if not c: FAILS.append(l)
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    for vp in ({"width":1440,"height":900},{"width":390,"height":844}):
        tag=f"{vp['width']}: "
        ctx=b.new_context(viewport=vp); pg=ctx.new_page()
        pg.on("pageerror",lambda e:errs.append(str(e))); pg.route("**/*",handler)
        urllib.request.urlopen("http://127.0.0.1:9911/set?sub=g-ana&email=ana@example.com&name=Ana").read()
        pg.goto(APP+"/api/auth/google?next=/"); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
        nav=lambda v: pg.evaluate("v=>document.querySelector('.sidebar [data-view=\"'+v+'\"]').click()",v)
        nav("pieces"); pg.wait_for_timeout(500); pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
        # vista de lista
        pg.locator('#view-pieces [data-piece-view="rows"]').first.click() if pg.locator("#pieceRepositoryList.piece-rows").count()==0 else None
        pg.wait_for_timeout(400)
        ok(tag+"vista de filas activa", pg.locator("#pieceRepositoryList.piece-rows").count()==1)
        rows=pg.locator("#pieceRepositoryList .piece-row")
        N=rows.count()
        ok(tag+"polo menos 4 pezas", N>=4, N)
        if vp["width"]>920:
            xs=pg.evaluate("""()=>{const r=[...document.querySelectorAll('#pieceRepositoryList .piece-row')];
              const f=(sel)=>r.map(x=>{const e=x.querySelector(sel);const t=e&&e.firstElementChild;return t?Math.round(t.getBoundingClientRect().left):null}).filter(v=>v!==null);
              return {author:f('.row-author'),place:f('.row-place'),tags:f('.row-tags'),count:r.map(x=>Math.round(x.querySelector('.row-count').getBoundingClientRect().left))}}""")
            ok(tag+"columnas aliñadas (autoría, lugar, creador, contador)", all(len(set(v))==1 for v in xs.values() if v), xs)
            ok(tag+"filas sen desbordar", pg.evaluate("[...document.querySelectorAll('#pieceRepositoryList .piece-row')].every(r=>r.scrollWidth<=r.clientWidth+1)"))
        pg.screenshot(path=str(OUT/f"piece-rows-{vp['width']}.png"))
        # navegación
        rows.nth(0).click(position={"x":12,"y":12}); pg.wait_for_selector("#pieceDrawer:not([hidden]) .piece-sheet",timeout=8000); pg.wait_for_timeout(300)
        t0=pg.locator("#pieceDrawer h2").inner_text()
        ok(tag+"paxinador 1 / N", f"1 / {N}" in pg.locator("#pieceDrawer .drawer-pager").inner_text(), pg.locator("#pieceDrawer .drawer-pager").inner_text())
        ok(tag+"«anterior» desactivado na primeira", pg.locator('#pieceDrawer [data-piece-step="-1"]').is_disabled())
        pg.click('#pieceDrawer [data-piece-step="1"]'); pg.wait_for_timeout(300)
        t1=pg.locator("#pieceDrawer h2").inner_text()
        ok(tag+"botón seguinte cambia de peza", t1!=t0 and f"2 / {N}" in pg.locator("#pieceDrawer .drawer-pager").inner_text(), (t0,t1))
        pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(300)
        t2=pg.locator("#pieceDrawer h2").inner_text()
        ok(tag+"→ avanza", t2 not in (t0,t1) and f"3 / {N}" in pg.locator("#pieceDrawer .drawer-pager").inner_text(), t2)
        pg.keyboard.press("ArrowLeft"); pg.wait_for_timeout(300)
        ok(tag+"← retrocede", pg.locator("#pieceDrawer h2").inner_text()==t1)
        for _ in range(N+1): pg.keyboard.press("ArrowRight"); pg.wait_for_timeout(150)
        pg.wait_for_timeout(300)
        ok(tag+"na última non pasa da última", f"{N} / {N}" in pg.locator("#pieceDrawer .drawer-pager").inner_text() and pg.locator('#pieceDrawer [data-piece-step="1"]').is_disabled())
        ok(tag+"a barra non desborda", pg.evaluate("(()=>{const b=document.querySelector('#pieceDrawer .drawer-bar');return b.scrollWidth<=b.clientWidth+1})()"))
        pg.screenshot(path=str(OUT/f"piece-nav-{vp['width']}.png"))
        pg.click("#pieceDrawer .card-close[data-close-piece-drawer]"); pg.wait_for_timeout(300)
        ok(tag+"pecha coa ×", pg.locator("#pieceDrawer:not([hidden])").count()==0)
        pg.keyboard.press("ArrowRight")
        ok(tag+"pechada, as frechas non fan nada", pg.locator("#pieceDrawer:not([hidden])").count()==0)
        # ficha aberta desde outro sitio (sen listaxe): sen paxinador se só hai unha
        ctx.close()
    b.close()
restore_coplas(MAX_COPLA_ID)
print("ERRS",errs); print("FAILS",FAILS)
sys.exit(1 if FAILS else 0)
