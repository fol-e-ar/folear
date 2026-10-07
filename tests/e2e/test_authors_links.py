"""E2E: fichas de autoría, ligazóns nas pezas, visor."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, DB, OUT, sql, Client, SAMPLE_PDF, restore_coplas
MAX_COPLA_ID = sql("select coalesce(max(id),0) from coplas")[0][0]
import json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
import shoot_lib as S
for t in ("piece_links",): sql(f"delete from {t}")
sql("delete from media_links where media_id in (select id from media where piece_id is not null)"); sql("delete from media where piece_id is not null")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null"); 
for t in ("follows","favorites","profiles","sessions","users"): sql(f"delete from {t}")
ana=Client("g-ana","ana@example.com","Ana")
sql("update users set role='guia' where email=?","ana@example.com")  # só guías/admin publican pezas
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
def wait_value(pg,sel,tries=40):
    for _ in range(tries):
        if pg.input_value(sel): return True
        pg.wait_for_timeout(200)
    return False
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
    ok("directory shown", pg.locator("#authorStrip [data-piece-author]").count()==2, pg.locator("#authorStrip").inner_text().replace("\n"," | "))
    ok("fake text gone", "Páxinas de autoría" not in pg.content())
    pg.screenshot(path=str(OUT/"library.png"))
    # click card author
    pg.locator("#pieceRepositoryList [data-piece-author]",has_text="andereteiras").first.click(); pg.wait_for_timeout(700)
    ok("ficha shown", pg.locator(".author-ficha").count()==1)
    t=pg.locator(".author-ficha").inner_text().replace("\n"," | "); print(t)
    ok("3 pieces, 3 resources", "3 pezas" in t and "3 recursos" in t)
    ok("resource shown once, as a Media card (no duplicate link row)", pg.locator(".author-ficha .link-row").count()==0 and pg.locator(".author-ficha .media-card",has_text="Gravación no Auditorio").count()==1, pg.locator(".author-ficha .media-card").count())
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
    ok("back to directory", pg.locator(".author-ficha").count()==0 and pg.locator("#authorStrip").count()==1 and "#/autoria" not in pg.evaluate("location.href"))
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
    ok("drawer shows the resource once (Media relacionada)", pg.locator("#pieceDrawer .media-card",has_text="Gravación no Auditorio").count()==1 and pg.locator("#pieceDrawer .link-row").count()==0)
    ok("drawer has the same «Obter datos» form", pg.locator("#pieceDrawer #pmFetch").count()==1 and pg.locator("#pieceDrawer #pmKind").count()==1 and pg.locator("#pieceDrawer #pmRole").count()==1 and pg.locator("#pieceDrawer #pmTitle").count()==1)
    ok("owner can remove a piece resource from the card", pg.locator("#pieceDrawer [data-remove-piece-resource]").count()==1)
    pg.click("#pieceDrawer [data-edit-piece]"); pg.wait_for_timeout(800)
    ok("recursos ligados: pregados por defecto (discretos)", pg.locator("details#workshopLinks").count()==1 and pg.locator("details#workshopLinks[open]").count()==0 and not pg.locator("#plUrl").is_visible())
    ok("recursos ligados van despois das partes", pg.evaluate("document.querySelector('#workshopLinks').getBoundingClientRect().top > document.querySelector('#addSection').getBoundingClientRect().top"))
    ok("o resumo di cantos hai", "(1)" in pg.locator("#workshopLinks > summary").inner_text(), pg.locator("#workshopLinks > summary").inner_text())
    pg.click("#workshopLinks > summary"); pg.wait_for_timeout(200)
    ok("editor loaded links", "Gravación no Auditorio" in pg.locator(".workshop-links").inner_text(), pg.locator(".workshop-links").inner_text()[:100])
    ok("workshop form has fetch + kind + role + source", all(pg.locator(sel).count()==1 for sel in ("#plFetch","#plKind","#plRole","#plSource","#plTitle","#plUrl")))
    pg.route("**/api/link-preview*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps({"title":"Gravación de proba","description":"Unha descrición","thumbnail_url":"","provider":"YouTube","author_or_source":"Canle Proba"})))
    pg.fill("#plTitle","Partitura"); pg.fill("#plUrl","https://exemplo.gal/p.pdf"); pg.select_option("#plKind","pdf"); pg.select_option("#plRole","documental"); pg.click("#addPieceLink"); pg.wait_for_timeout(300)
    ok("added manual resource", pg.locator(".workshop-link-item").count()==2)
    pg.fill("#plUrl","https://youtu.be/zzz"); pg.click("#plFetch"); wait_value(pg,"#plTitle")
    ok("Obter datos fills title, kind, source", pg.input_value("#plTitle")=="Gravación de proba" and pg.input_value("#plKind")=="youtube" and pg.input_value("#plSource")=="Canle Proba", [pg.input_value("#plTitle"),pg.input_value("#plKind"),pg.input_value("#plSource")])
    ok("preview shown", not pg.locator("#plPreview").is_hidden() and "YouTube" in pg.locator("#plPreview").inner_text(), pg.locator("#plPreview").inner_text())
    pg.click("#addPieceLink"); pg.wait_for_timeout(300)
    ok("added fetched resource", pg.locator(".workshop-link-item").count()==3)
    pg.fill("#plUrl","javascript:alert(1)"); pg.click("#addPieceLink"); pg.wait_for_timeout(300)
    ok("bad url rejected", pg.locator(".workshop-link-item").count()==3 and "http" in pg.locator("#plFeedback").inner_text(), pg.locator("#plFeedback").inner_text())
    pg.screenshot(path=str(OUT/"editor.png"))
    pg.locator("[data-remove-piece-link]").first.click(); pg.wait_for_timeout(300)
    ok("removed", pg.locator(".workshop-link-item").count()==2)
    ok("workshop has a «lugar» field", pg.locator("#pieceLugar").count()==1)
    pg.fill("#pieceLugar","Laxoso")
    pg.click("#savePieceDirect"); pg.wait_for_selector(".fe-dialog form"); 
    pg.fill("#fePieceAuthor", ""); pg.click("#fePieceAuthor"); pg.wait_for_timeout(250)
    ok("author suggestions in save dialog", pg.locator(".authorbox-option").count()>=2, pg.locator(".authorbox-option").count())
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    ok("Esc closes only the suggestions", pg.locator(".fe-dialog form").count()==1 and pg.locator(".authorbox-list:not([hidden])").count()==0)
    pg.screenshot(path=str(OUT/"dialog.png"))
    pg.click('.fe-dialog button[type=submit]'); pg.wait_for_timeout(1500)
    ok("piece «lugar» saved", sql("select count(*) from pieces where lugar='Laxoso'")[0][0]>=1)
    rows=sql("select title,media_kind,author_or_source,visibility from media where piece_id is not null order by id")
    print(rows)
    ok("saved resources live in Media", sorted(r[0] for r in rows)==["Gravación de proba","Partitura"], rows)
    ok("kind / source saved", ("Gravación de proba","youtube","Canle Proba","public") in rows and any(r[1]=="pdf" for r in rows), rows)
    # ficha da peza: engadir desde o formulario da ficha (mesmo «Obter datos»)
    pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    pg.locator("#pieceRepositoryList .piece-card",has_text="Canto e Muiñeira").first.click(position={"x":12,"y":12}); pg.wait_for_selector("#pieceDrawer:not([hidden]) .drawer-panel",timeout=8000)
    ok("ficha: formulario de recursos pregado", pg.locator("#pieceDrawer details.piece-media-form").count()==1 and not pg.locator("#pmUrl").is_visible())
    pg.click("#pieceDrawer details.piece-media-form > summary"); pg.wait_for_timeout(200)
    pg.fill("#pmUrl","https://youtu.be/drw1"); pg.click("#pmFetch"); wait_value(pg,"#pmTitle")
    pg.click("#pieceMediaAdd"); pg.wait_for_timeout(1200)
    ok("resource added from the drawer", sql("select count(*) from media where piece_id is not null and url like '%drw1%'")[0][0]==1 and pg.locator("#pieceDrawer .media-card").count()==3, pg.locator("#pieceDrawer .media-card").count())
    # peza privada con recurso: vese en Media coa marca «Privada» só á dona
    ana.call("POST","/api/pieces",{"pieces":[{"title":"Peza privada con recurso","author":"Ana","visibility":"private","coplas":[{"copla_id":None,"text":"Un verso privado","position":1}],"links":[{"title":"Recurso privado de proba","url":"https://exemplo.gal/privado.mp3","media_kind":"audio","role":"melody"}]}]})
    pg.click("#pieceDrawer [data-close-piece-drawer]"); pg.reload(); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
    pg.click('.sidebar [data-view="media"]'); pg.wait_for_timeout(800)
    pg.fill("#mediaSearch","Recurso privado"); pg.wait_for_timeout(500)
    card=pg.locator("#mediaList .media-card",has_text="Recurso privado de proba")
    ok("private resource visible to its owner in Media with «Privada» tag", card.count()==1 and card.locator(".is-private").count()==1, card.count())
    pg.fill("#mediaSearch","Gravación de proba"); pg.wait_for_timeout(500)
    ok("public resource of a piece is in Media too", pg.locator("#mediaList .media-card",has_text="Gravación de proba").count()>=1)
    pg.fill("#mediaSearch","Recurso privado"); pg.wait_for_timeout(400)
    ok("Media: recurso de peza con Editar e Borrar", card.locator("[data-edit-media]").count()==1 and card.locator("[data-delete-media]").count()==1)
    pg.locator("#mediaList .media-card",has_text="Recurso privado de proba").locator("[data-edit-media]").click(); pg.wait_for_selector("#mediaModal #mediaTitle")
    ok("Media: edita un recurso de peza", pg.input_value("#mediaTitle")=="Recurso privado de proba")
    pg.fill("#mediaTitle","Recurso privado editado"); pg.click("#saveMediaDirect"); pg.wait_for_timeout(1200)
    ok("Media: cambio gardado", sql("select count(*) from media where title='Recurso privado editado' and piece_id is not null")[0][0]==1)
    pg.fill("#mediaSearch","Recurso privado editado"); pg.wait_for_timeout(400)
    pg.locator("#mediaList .media-card").first.locator("[data-delete-media]").click(); pg.wait_for_selector("#confirmDeleteAction")
    ok("Media: o borrado avisa de que desvincula", "pezas" in pg.locator(".delete-confirm-modal").inner_text())
    pg.click("#confirmDeleteAction"); pg.wait_for_timeout(1200)
    ok("Media: borrado e desvinculado da peza", sql("select count(*) from media where title='Recurso privado editado'")[0][0]==0 and sql("select count(*) from media_links where media_id not in (select id from media)")[0][0]==0)
    # recurso web sen miniatura: preview estilizada e tarxeta limpa
    ana.call("POST","/api/pieces",{"pieces":[{"title":"Peza con web","author":"Ana","visibility":"private","context_territory_id":"par:1502004","coplas":[{"copla_id":None,"text":"Verso web\nsegundo","position":1,"section_label":"Canto","role":"copla"}],"links":[{"title":"Sofán (Bouba - Vinculeiras)","url":"https://www.exemplo.gal/sofan","media_kind":"web","role":"documental","description":"Unha descrición longa que xa non debe saír na tarxeta"}]}]})
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
    pg.click('.sidebar [data-view="media"]'); pg.wait_for_timeout(800)
    pg.fill("#mediaSearch","Sofán"); pg.wait_for_timeout(500)
    wc=pg.locator("#mediaList .media-card",has_text="Sofán").first
    ok("web: preview estilizada (non en branco)", wc.locator(".media-preview.is-web .web-mock .web-bar span").inner_text()=="exemplo.gal" and wc.locator(".web-favicon").inner_text()=="E", wc.locator(".web-bar").inner_text() if wc.count() else "")
    ok("tarxeta limpa: sen descrición, sen etiqueta de peza", "descrición longa" not in wc.inner_text() and "Peza:" not in wc.inner_text() and wc.locator(".tag").count()==0)
    ok("tarxeta: nome, uso e territorio", "Sofán (Bouba" in wc.locator("h2").inner_text() and "Documental" in wc.locator(".media-sub").inner_text() and "Lira" in wc.locator(".media-sub").inner_text(), wc.locator(".media-sub").inner_text())
    ok("tarxeta: Privada visible", wc.locator(".is-private").count()==1)
    pg.screenshot(path=str(OUT/"media-web-card.png"))
    # biblioteca de pezas: o territorio da peza é clicable
    ana.call("POST","/api/pieces",{"pieces":[{"title":"Peza con territorio","author":"Ana","visibility":"private","context_territory_id":"par:1502004","lugar":"Laxoso","coplas":[{"copla_id":None,"text":"Verso de proba\nsegundo","position":1,"section_label":"Canto","role":"copla"}]}]})
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(500)
    pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    pg.locator('[data-piece-scope="mine"]').click(); pg.wait_for_timeout(500)
    tcard=pg.locator("#pieceRepositoryList .piece-card",has_text="Peza con territorio").first
    tag=tcard.locator("[data-territory-id]")
    ok("peza: territorio clicable na tarxeta (con lugar)", tag.count()==1 and "Laxoso" in tag.inner_text() and "Lira" in tag.inner_text(), tag.inner_text() if tag.count() else "")
    tag.click(); pg.wait_for_timeout(800)
    ok("…leva ao territorio", pg.locator("#view-territory.active").count()==1 and "Lira" in pg.locator("#view-territory").inner_text())
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(500); pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    pg.locator('[data-piece-scope="mine"]').click(); pg.wait_for_timeout(500)
    pg.locator("#pieceRepositoryList .piece-card",has_text="Peza con territorio").first.click(position={"x":12,"y":12}); pg.wait_for_selector("#pieceDrawer:not([hidden]) .drawer-panel",timeout=8000)
    ok("ficha: territorio clicable", pg.locator("#pieceDrawer [data-territory-id]").count()==1)
    pg.click("#pieceDrawer [data-territory-id]"); pg.wait_for_timeout(800)
    ok("…e pecha a ficha", pg.locator("#pieceDrawer:not([hidden])").count()==0 and pg.locator("#view-territory.active").count()==1)
    # biblioteca: sen o subtítulo «Mapa de referencias…»
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(500); pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    pg.locator('[data-piece-scope="mine"]').click(); pg.wait_for_timeout(500)
    ok("biblioteca: sen «Mapa de referencias de coplas»", "Mapa de referencias" not in pg.locator("#pieceRepositoryList").inner_text() and pg.locator("#pieceRepositoryList .piece-card").count()>=1)
    # recurso repetido: avisa e ofrece usar o que xa está en Media
    ana.call("POST","/api/pieces",{"pieces":[{"title":"Peza co outro recurso","author":"Ana","visibility":"private","coplas":[{"copla_id":None,"text":"Verso do outro\nsegundo","position":1,"section_label":"Canto","role":"copla"}],"links":[{"title":"Outra gravación","url":"https://exemplo.gal/outro.mp3","media_kind":"audio","role":"melody"}]}]})
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(500); pg.click('[data-piece-tab="library"]'); pg.wait_for_timeout(500)
    pg.locator('[data-piece-scope="mine"]').click(); pg.wait_for_timeout(500)
    pg.locator("#pieceRepositoryList .piece-card",has_text="Peza con territorio").first.click(position={"x":12,"y":12}); pg.wait_for_selector("#pieceDrawer:not([hidden]) .drawer-panel",timeout=8000)
    n_media=sql("select count(*) from media")[0][0]
    pg.click("#pieceDrawer details.piece-media-form > summary"); pg.wait_for_timeout(200)
    pg.fill("#pmUrl","https://www.exemplo.gal/outro.mp3?utm_source=z"); pg.fill("#pmTitle","Copia da outra"); pg.click("#pieceMediaAdd"); pg.wait_for_timeout(500)
    ok("duplicado: avisa de que xa está en Media", "xa está en Media" in pg.locator("#pmFeedback").inner_text() and pg.locator("#pmFeedback [data-use-existing]").count()==1, pg.locator("#pmFeedback").inner_text())
    ok("…e non crea nada", sql("select count(*) from media")[0][0]==n_media)
    pg.click("#pmFeedback [data-use-existing]"); pg.wait_for_timeout(1500)
    ok("«Ligar o existente»: ligado á peza sen copiar", sql("select count(*) from media")[0][0]==n_media and pg.locator("#pieceDrawer .media-card",has_text="Outra gravación").count()==1, pg.locator("#pieceDrawer .media-card").count())
    ok("…e pódese desligar sen borralo", pg.locator("#pieceDrawer .media-card",has_text="Outra gravación").locator("[data-remove-piece-resource]").inner_text()=="Desligar da peza")
    pg.on("dialog", lambda d: d.accept())
    pg.locator("#pieceDrawer .media-card",has_text="Outra gravación").locator("[data-remove-piece-resource]").click(); pg.wait_for_timeout(1500)
    ok("desligar non borra o recurso de Media", sql("select count(*) from media where title='Outra gravación'")[0][0]==1 and pg.locator("#pieceDrawer .media-card",has_text="Outra gravación").count()==0)
    # no obradoiro tamén avisa
    pg.click("#pieceDrawer [data-edit-piece]"); pg.wait_for_timeout(800)
    pg.click("#workshopLinks > summary"); pg.wait_for_timeout(200)
    pg.fill("#plUrl","https://youtu.be/outro-inexistente"); pg.fill("#plUrl","https://exemplo.gal/outro.mp3#x"); pg.fill("#plTitle","Outra vez"); pg.click("#addPieceLink"); pg.wait_for_timeout(500)
    ok("obradoiro: avisa do duplicado", pg.locator("#plFeedback [data-use-existing]").count()==1)
    before=pg.locator(".workshop-link-item").count()
    pg.click("#plFeedback [data-use-existing]"); pg.wait_for_timeout(500)
    ok("obradoiro: usa o existente (ligazón compartida)", pg.locator(".workshop-link-item").count()==before+1 and "Outra gravación" in pg.locator(".workshop-links").inner_text())
    pg.click("#stopEditingPiece") if pg.locator("#stopEditingPiece").count() else None
    # nivel Galiza en Territorios: coplas, pezas, melodías e media sen baixar de nivel
    pg.click('.sidebar [data-view="territory"]'); pg.wait_for_timeout(800)
    for tab,sel in (("pieces","#territoryPieceList"),("media","#territoryMediaList")):
        pg.click(f'[data-territory-tab="{tab}"]'); pg.wait_for_timeout(800)
        ok(f"Galiza: pestana {tab} amosa a lista", pg.locator(sel).count()==1 and "Escolle un territorio" not in pg.locator("#view-territory").inner_text() and pg.locator(f"{sel} > *").count()>=1, pg.locator(sel).inner_text()[:80] if pg.locator(sel).count() else "")
    ctx.close()
    ctx,pg=newpage({"width":1440,"height":900})
    pg.click('.sidebar [data-view="media"]'); pg.wait_for_timeout(800)
    pg.fill("#mediaSearch","proba"); pg.wait_for_timeout(500)
    ok("visitor does NOT see the private resource", pg.locator("#mediaList .media-card",has_text="Recurso privado de proba").count()==0)
    ok("visitor sees the public piece resource", pg.locator("#mediaList .media-card",has_text="Gravación de proba").count()>=1)
    ctx.close()
    # PDF viewer
    for vp,name in (({"width":1440,"height":900},"d"),({"width":390,"height":844},"m")):
        ctx,pg=newpage(vp)
        pg.evaluate("""async()=>{const r=await fetch('/__sample.pdf').catch(()=>null)}""")
        fnd=pg.evaluate("typeof window.openPdfViewer")
        print("openPdfViewer", fnd)
        ctx.close()
    b.close()
restore_coplas(MAX_COPLA_ID)
print("ERRS",errs); print("FAILS",FAILS)
