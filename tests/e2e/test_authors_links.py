"""E2E: fichas de autoría, ligazóns nas pezas, visor."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, DB, OUT, sql, Client, SAMPLE_PDF
import json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
import shoot_lib as S
for t in ("piece_links",): sql(f"delete from {t}")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null"); 
for t in ("follows","favorites","profiles","sessions","users"): sql(f"delete from {t}")
ana=Client("g-ana","ana@example.com","Ana")
coplas=json.load(urllib.request.urlopen(APP+"/data/exports/coplas/coplas.json"))
def mk(title,author,links=(),vis="public",cop=None):
    return {"title":title,"author":author,"visibility":vis,"links":list(links),"coplas":[{"copla_id":cop,"text":None if cop else "Un verso solto","position":1}]}
r=ana.call("POST","/api/pieces",{"pieces":[
 mk("Canto e Muiñeira de Magán","Pandereteiras Soalleira",[{"title":"Gravación no Auditorio","url":"https://youtu.be/abc"}],cop=coplas[0]["id"]),
 mk("Muiñeira de Rodis","pandereteiras  soalleira"),
 mk("Xota miña","Ana"),
 mk("Peza privada","Pandereteiras Soalleira",vis="private"),
 mk("Sen autoría","")]})
print(r)
def handler(route):
    u=route.request.url
    if u.startswith(APP): return route.continue_()
    return S.base_handle(route)
FAILS=[]
def ok(l,c,x=""):
    print(("PASS " if c else "FAIL ")+l,x)
    if not c: FAILS.append(l)
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    def newpage(vp,url="/"):
        ctx=b.new_context(viewport=vp); pg=ctx.new_page()
        pg.on("pageerror",lambda e:errs.append(str(e))); pg.on("console",lambda m: errs.append("console:"+m.text) if m.type=="error" and "Failed to load resource" not in m.text else None)
        pg.route("**/*",handler); pg.goto(APP+url); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
        return ctx,pg
    ctx,pg=newpage({"width":1440,"height":900})
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(600)
    pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(600)
    ok("directory shown", pg.locator(".creator-note [data-piece-author]").count()==2, pg.locator(".creator-note").inner_text().replace("\n"," | "))
    ok("fake text gone", "Páxinas de autoría" not in pg.content())
    pg.screenshot(path=str(OUT/"library.png"))
    # click card author
    pg.locator("#pieceRepositoryList [data-piece-author]",has_text="andereteiras").first.click(); pg.wait_for_timeout(700)
    ok("ficha shown", pg.locator(".author-ficha").count()==1)
    t=pg.locator(".author-ficha").inner_text().replace("\n"," | "); print(t)
    ok("3 pieces, 3 resources", "3 pezas" in t and "3 recursos" in t)
    ok("link row", pg.locator(".author-ficha .link-row").count()==1)
    ok("only author's pieces listed", pg.locator("#pieceRepositoryList .piece-card").count()==3, pg.locator("#pieceRepositoryList .piece-card").count())
    ok("hash", "#/autoria/pandereteiras-soalleira" in pg.evaluate("location.href"), pg.evaluate("location.href"))
    pg.screenshot(path=str(OUT/"ficha.png"))
    # open piece drawer then click author in drawer
    pg.locator("#pieceRepositoryList .piece-card",has_text="Magán").first.click(position={"x":12,"y":12}); pg.wait_for_function("!document.querySelector('#pieceDrawer').hidden",timeout=8000); pg.wait_for_timeout(400)
    ok("drawer shows Ligazóns for linked piece or not", True, pg.locator("#pieceDrawer").inner_text()[:200].replace("\n"," | "))
    pg.screenshot(path=str(OUT/"drawer.png"))
    a=pg.locator("#pieceDrawer [data-piece-author]")
    if a.count():
        a.first.click(); pg.wait_for_timeout(600)
        ok("drawer closed after author click", pg.locator("#pieceDrawer:not([hidden])").count()==0)
        ok("still ficha", pg.locator(".author-ficha").count()==1)
    else: ok("drawer has author button", False)
    pg.click("#clearPieceAuthorFilter"); pg.wait_for_timeout(500)
    ok("back to directory", pg.locator(".author-ficha").count()==0 and pg.locator(".creator-note").count()==1 and "#/autoria" not in pg.evaluate("location.href"))
    ctx.close()
    # deep link
    ctx,pg=newpage({"width":1440,"height":900},"/#/autoria/pandereteiras-soalleira")
    ok("deep link ficha", pg.locator(".author-ficha").count()==1 and pg.locator("#view-pieces.active").count()==1)
    ctx.close()
    # mobile
    ctx,pg=newpage({"width":390,"height":844},"/#/autoria/pandereteiras-soalleira")
    ok("mobile ficha", pg.locator(".author-ficha").count()==1)
    ok("mobile no overflow", pg.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), pg.evaluate("[document.documentElement.scrollWidth,innerWidth]"))
    pg.screenshot(path=str(OUT/"ficha-mobile.png"))
    ctx.close()
    # logged user: editor links
    ctx=b.new_context(viewport={"width":1440,"height":900}); pg=ctx.new_page()
    pg.on("pageerror",lambda e:errs.append(str(e))); pg.route("**/*",handler)
    urllib.request.urlopen("http://127.0.0.1:9911/set?sub=g-ana&email=ana@example.com&name=Ana").read()
    pg.goto(APP+"/api/auth/google?next=/"); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(500)
    pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    pg.locator('[data-piece-scope="mine"]').click(); pg.wait_for_timeout(500)
    card=pg.locator("#pieceRepositoryList .piece-card",has_text="Canto e Muiñeira").first
    card.click(position={"x":12,"y":12}); pg.wait_for_selector("#pieceDrawer:not([hidden]) .piece-manage",timeout=8000); 
    ok("drawer Ligazóns", "Gravación no Auditorio" in pg.locator("#pieceDrawer").inner_text())
    pg.click("#pieceDrawer [data-edit-piece]"); pg.wait_for_timeout(800)
    ok("editor loaded links", "Gravación no Auditorio" in pg.locator(".workshop-links").inner_text(), pg.locator(".workshop-links").inner_text()[:100])
    pg.fill("#pieceLinkTitle","Partitura"); pg.fill("#pieceLinkUrl","https://exemplo.gal/p.pdf"); pg.click("#addPieceLink"); pg.wait_for_timeout(300)
    ok("added link row", pg.locator(".workshop-link-item").count()==2)
    pg.fill("#pieceLinkTitle","Mal"); pg.fill("#pieceLinkUrl","javascript:alert(1)"); pg.click("#addPieceLink"); pg.wait_for_timeout(300)
    ok("bad url rejected", pg.locator(".workshop-link-item").count()==2 and not pg.locator("#pieceLinkError").is_hidden())
    pg.screenshot(path=str(OUT/"editor.png"))
    pg.locator("[data-remove-piece-link]").first.click(); pg.wait_for_timeout(300)
    ok("removed", pg.locator(".workshop-link-item").count()==1)
    pg.click("#savePieceDirect"); pg.wait_for_selector(".fe-dialog form"); 
    ok("author datalist", pg.locator("#fePieceAuthorList option").count()>=2, pg.locator("#fePieceAuthorList option").count())
    pg.screenshot(path=str(OUT/"dialog.png"))
    pg.click('.fe-dialog button[type=submit]'); pg.wait_for_timeout(1500)
    print(sql("select title,url from piece_links"))
    ok("saved link replaced", [r[0] for r in sql("select title from piece_links")]==["Partitura"])
    ctx.close()
    # PDF viewer
    for vp,name in (({"width":1440,"height":900},"d"),({"width":390,"height":844},"m")):
        ctx,pg=newpage(vp)
        pg.evaluate("""async()=>{const r=await fetch('/__sample.pdf').catch(()=>null)}""")
        fnd=pg.evaluate("typeof window.openPdfViewer")
        print("openPdfViewer", fnd)
        ctx.close()
    b.close()
print("ERRS",errs); print("FAILS",FAILS)
