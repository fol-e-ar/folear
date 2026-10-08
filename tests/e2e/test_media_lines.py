"""E2E: recursos de apoio (pezas, melodías, autoría) en liñas compactas; Media segue con tarxetas."""
import sys, pathlib, urllib.request
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, OUT, sql, Client, restore_coplas
MAX_COPLA_ID = sql("select coalesce(max(id),0) from coplas")[0][0]
from playwright.sync_api import sync_playwright
import shoot_lib as S
sql("delete from media_links where media_id in (select id from media where piece_id is not null or title like 'ML %')")
sql("delete from media where piece_id is not null or title like 'ML %'")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null")
for t in ("follows","favorites","profiles","sessions","users"): sql(f"delete from {t}")
ana=Client("g-ana","ana@example.com","Ana")
sql("update users set role='guia' where email=?","ana@example.com")
r=ana.call("POST","/api/pieces",{"pieces":[{"title":"Peza de liñas","author":"Ana","visibility":"public","coplas":[{"copla_id":None,"text":"Un verso","position":1}],"links":[
 {"title":"ML Vídeo","url":"https://www.youtube.com/watch?v=abc123","media_kind":"youtube","role":"melody"},
 {"title":"ML Audio","url":"https://open.spotify.com/track/xyz","media_kind":"spotify","role":"melody"},
 {"title":"ML Web","url":"https://exemplo.gal/web","media_kind":"web","role":"documental"}]}]})
print(r)
mid=sql("select id from media where title='ML Audio'")[0][0]
sql("insert into media_links(media_id,entity_type,entity_id) values (?,?,?)",mid,"melody","2")
sql("update site_meta set value = cast(cast(value as integer) + 1 as text) where key = 'data_version'")
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
        nav=lambda v: pg.evaluate("v=>document.querySelector('.sidebar [data-view=\"'+v+'\"]').click()",v)
        urllib.request.urlopen("http://127.0.0.1:9911/set?sub=g-ana&email=ana@example.com&name=Ana").read()
        pg.goto(APP+"/api/auth/google?next=/"); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
        nav("pieces")
        pg.wait_for_timeout(500); pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
        pg.locator('[data-piece-scope="mine"]').click(); pg.wait_for_timeout(500)
        pg.locator("#pieceRepositoryList .piece-card",has_text="Peza de liñas").first.click(position={"x":12,"y":12})
        pg.wait_for_selector("#pieceDrawer:not([hidden]) .piece-manage",timeout=8000); pg.wait_for_timeout(400)
        lines=pg.locator("#pieceDrawer .media-line")
        ok(tag+"piece drawer: 3 resources stacked as lines", lines.count()==3, lines.count())
        ok(tag+"no thumbnails/cards in the drawer", pg.locator("#pieceDrawer img.media-preview, #pieceDrawer .media-card").count()==0)
        ok(tag+"icon class per kind", pg.locator("#pieceDrawer .media-line-icon.is-youtube").count()==1 and pg.locator("#pieceDrawer .media-line-icon.is-spotify").count()==1, pg.locator("#pieceDrawer .media-line-icon").evaluate_all("e=>e.map(x=>x.className)"))
        hs=lines.evaluate_all("e=>e.map(x=>Math.round(x.getBoundingClientRect().height))")
        ok(tag+"lines are compact (<=80px)", all(h<=80 for h in hs), hs)
        ok(tag+"title and type shown", "ML Vídeo" in lines.nth(0).inner_text() or any("ML Vídeo" in lines.nth(i).inner_text() for i in range(3)))
        ok(tag+"no horizontal overflow", pg.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
        ok(tag+"unlink buttons present", pg.locator("#pieceDrawer [data-remove-piece-resource]").count()==3)
        pg.screenshot(path=str(OUT/f"media-lines-piece-{vp['width']}.png"))
        pg.click("#pieceDrawer .card-close[data-close-piece-drawer]"); pg.wait_for_timeout(300)
        # melody drawer
        nav("melodies")
        pg.wait_for_selector(".melody-card",timeout=10000); pg.wait_for_timeout(500)
        card=pg.locator('[data-open-melody="2"]').first
        card.click(position={"x":10,"y":10})
        pg.wait_for_selector("#melodyDrawer:not([hidden]) .media-lines",timeout=8000); pg.wait_for_timeout(300)
        ml=pg.locator("#melodyDrawer .media-line",has_text="ML Audio")
        ok(tag+"melody drawer: resource as a line", ml.count()==1 and pg.locator("#melodyDrawer img.media-preview, #melodyDrawer .media-card").count()==0, ml.count())
        ok(tag+"melody drawer: spotify icon + Desvincular", ml.locator(".media-line-icon.is-spotify").count()==1 and ml.locator("[data-unlink-melody-media]").inner_text()=="Desvincular")
        pg.screenshot(path=str(OUT/f"media-lines-melody-{vp['width']}.png"))
        ml.locator("[data-unlink-melody-media]").click(); pg.wait_for_timeout(1500)
        ok(tag+"unlink works (link removed, resource kept)", sql("select count(*) from media_links where media_id=? and entity_type='melody'",mid)[0][0]==0 and sql("select count(*) from media where id=?",mid)[0][0]==1)
        sql("insert or ignore into media_links(media_id,entity_type,entity_id) values (?,?,?)",mid,"melody","2")
        sql("update site_meta set value = cast(cast(value as integer) + 1 as text) where key = 'data_version'")
        # Media: sigue a vista de tarxeta/fila protagonista
        pg.reload(); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1200)
        nav("media")
        pg.wait_for_timeout(600)
        ok(tag+"Media view keeps its own cards/rows (no media-line)", pg.locator("#view-media .media-line").count()==0 and pg.locator("#mediaList .media-card, #mediaList .media-row").count()>=1, pg.locator("#mediaList .media-card, #mediaList .media-row").count())
        ctx.close()
    b.close()
restore_coplas(MAX_COPLA_ID)
print("ERRS",errs); print("FAILS",FAILS)
sys.exit(1 if FAILS else 0)
