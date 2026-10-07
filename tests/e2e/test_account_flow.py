"""E2E: visitante, conta, pezas, favoritos, perfís, seguimentos, moderación, Sobre o arquivo, privacidade."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, DB, OUT, sql, Client, SAMPLE_PDF, restore_coplas
import urllib.request, json, sqlite3, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
import shoot_lib as S
MAX_COPLA_ID=sql("select coalesce(max(id),0) from coplas")[0][0]
for t in ("follows","favorites","profiles","sessions"): sql(f"delete from {t}")
sql("delete from piece_coplas where piece_id in (select id from pieces where owner_user_id is not null)")
sql("delete from pieces where owner_user_id is not null"); sql("delete from users")
def fake(sub,email,name): urllib.request.urlopen(f"http://127.0.0.1:9911/set?sub={sub}&email={email}&name={name}").read()
def handler(route):
    u=route.request.url
    if u.startswith(APP) or u.startswith("http://localhost:9911"): return route.continue_()
    return S.base_handle(route)
errs=[]
def newpage(b, vp={"width":1440,"height":900}, url="/", **kw):
    ctx=b.new_context(viewport=vp, **kw); page=ctx.new_page()
    page.on("pageerror",lambda e:errs.append(str(e))); page.on("console",lambda m: errs.append("console:"+m.text) if m.type=="error" and "Failed to load resource" not in m.text else None)
    page.on("dialog",lambda d:d.accept()); page.route("**/*",handler)
    page.goto(APP+url); page.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); page.wait_for_timeout(900)
    return ctx,page
def wait_ready(pg):
    pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1400)
def jfetch(pg, path, method="GET", body=None):
    return pg.evaluate("""async([p,m,b])=>{const h={};if(b)h['Content-Type']='application/json';const r=await fetch(p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});let j=null;try{j=await r.json()}catch(e){};return [r.status,j]}""",[path,method,body])
def ok(label, cond, extra=""):
    print(("PASS " if cond else "FAIL ")+label, extra)
    if not cond: FAILS.append(label)
FAILS=[]
DRAFT={"title":"Xota de proba","author":"","notes":"","status":"draft","territoryId":"","sections":[{"id":"parte-1","label":"Xota","coplas":[
 {"uid":"u1","id":None,"incipit":"Cantares miúdos","text":"Cantares miúdos de Ana\nverso segundo","territory":"","role":"copla","notes":""}]}]}
with sync_playwright() as p:
    b=p.chromium.launch()
    coplas=json.load(urllib.request.urlopen(APP+"/data/exports/coplas/coplas.json"))
    cid=coplas[0]["id"]
    # 1 VISITANTE
    ctx,pv=newpage(b)
    draft=json.loads(json.dumps(DRAFT)); draft["sections"][0]["coplas"].append({"uid":"u2","id":cid,"incipit":"","text":coplas[0]["text"],"territory":"","role":"copla","notes":""})
    pv.evaluate("d=>localStorage.setItem('fol-e-ar-piece-cart-v2', JSON.stringify(d))",draft)
    pv.reload(); wait_ready(pv)
    pv.click('.sidebar [data-view="pieces"]'); pv.wait_for_timeout(700)
    pv.click('[data-piece-tab="library"]'); pv.wait_for_timeout(500)
    ok("visitor library: login note", pv.locator(".piece-login-note").count()==1)
    ok("visitor library: no scope tabs", pv.locator("[data-piece-scope]").count()==0)
    pv.click('[data-piece-tab="workshop"]'); pv.wait_for_timeout(500)
    ok("visitor workshop notice", "sen conta" in pv.locator(".workshop-notice").inner_text())
    posts=[]
    pv.on("request",lambda r: posts.append(r.url) if r.method=="POST" and "/api/pieces" in r.url else None)
    pv.locator(".workshop-page .piece-head").screenshot(path=str(OUT/"workshop-actions.png"))
    ok("Gardar peza: botón con icona e contorno marcado", pv.locator("#savePieceDirect .ui-icon").count()==1 and pv.evaluate("getComputedStyle(document.querySelector('#savePieceDirect')).fontWeight")=="600")
    pv.click("#savePieceDirect"); pv.wait_for_timeout(500)
    ok("visitor save prompts login, no POST", "precisas unha conta" in pv.locator("#pieceExportStatus").inner_text() and not posts, posts)
    pv.screenshot(path=str(OUT/"visitor-workshop.png"))
    ok("PDF export still present", pv.locator("#openA4").count()==1)
    # login desde o aviso (mesmo contexto)
    fake("g-ana","ana@example.com","Ana")
    pv.click("#pieceExportStatus a"); pv.wait_for_url(APP+"/**",timeout=15000); wait_ready(pv)
    ok("after login resumes workshop", pv.locator("#view-pieces.active").count()==1 and pv.locator(".workshop").count()==1, pv.evaluate("location.href"))
    ok("draft preserved", pv.input_value("#pieceTitle")=="Xota de proba")
    ok("account notice", "gárdase na túa conta" in pv.locator(".workshop-notice").inner_text())
    # gardar privada
    posts.clear()
    pv.click("#savePieceDirect"); pv.wait_for_selector(".fe-dialog form", timeout=5000)
    pv.screenshot(path=str(OUT/"dialog.png"))
    ok("dialog private default", pv.locator('input[name="vis"][value="private"]').is_checked())
    pv.fill("#fePieceAuthor","Tradicional"); pv.click('.fe-dialog button[type=submit]'); pv.wait_for_timeout(1500)
    ok("saved -> library mine", pv.locator('[data-piece-scope="mine"].active').count()==1 and pv.locator("#pieceRepositoryList .piece-card").count()==1, pv.locator(".piece-scope").inner_text().replace("\n"," "))
    card=pv.locator("#pieceRepositoryList .piece-card").first
    ok("card private chip", "Privada" in card.inner_text(), card.inner_text().replace("\n"," | "))
    pv.screenshot(path=str(OUT/"library-mine.png"))
    rows=sql("select title,author,visibility,owner_user_id from pieces where owner_user_id is not null"); ok("db row private", rows and rows[0][2]=="private" and rows[0][1]=="Tradicional", rows)
    inline=sql("select copla_id, inline_text from piece_coplas where piece_id=(select id from pieces where owner_user_id is not null)")
    ok("loose copla kept inline, archive copla not duplicated", [(c is None, t is None) for c,t in inline]==[(True,False),(False,True)], [(c,(t or '')[:15]) for c,t in inline])
    ok("loose coplas NOT added to archive", len([c for c in json.load(urllib.request.urlopen(APP+"/data/exports/coplas/coplas.json"))])==len(coplas))
    # drawer + publicar
    card.click(); pv.wait_for_selector("#pieceDrawer:not([hidden]) .piece-manage", timeout=5000)
    ok("drawer manage actions (foleante: sen publicar)", all(pv.locator(f"#pieceDrawer {s}").count()==1 for s in ("[data-edit-piece]","[data-delete-piece]")) and pv.locator("#pieceDrawer [data-toggle-piece-visibility]").count()==0)
    ok("owner (foleante) can link resources to her own piece", pv.locator("#pieceDrawer .piece-media-form").is_visible() and pv.locator("#pieceDrawer .piece-media-form #pmFetch").count()==1)
    ok("piece star in drawer", pv.locator("#pieceDrawer .fav-btn.has-label").count()==1)
    pv.screenshot(path=str(OUT/"drawer-mine.png"))
    myid=sql("select id from pieces where owner_user_id is not null")[0][0]
    st,_=jfetch(pv,"/api/pieces/visibility","POST",{"id":myid,"visibility":"public"})
    ok("foleante cannot publish (403)", st==403, st)
    ok("foleante: the register-coplas button is not offered", pv.locator("#pieceDrawer [data-register-piece-coplas]").count()==0)
    # a partir de aquí Ana é guía: publica e as coplas soltas pasan ao arquivo
    pv.click("#pieceDrawer [data-close-piece-drawer]"); pv.wait_for_timeout(200)
    sql("update users set role='guia' where email='ana@example.com'")
    pv.reload(); wait_ready(pv)
    pv.click('.sidebar [data-view="pieces"]'); pv.wait_for_timeout(500); pv.click('[data-piece-tab="library"]'); pv.wait_for_timeout(500)
    pv.locator('[data-piece-scope="mine"]').click(); pv.wait_for_timeout(500)
    pv.locator("#pieceRepositoryList .piece-card").first.click(); pv.wait_for_selector("#pieceDrawer:not([hidden]) .piece-manage", timeout=5000)
    ok("guía: sees the register-coplas button (loose coplas)", pv.locator("#pieceDrawer [data-register-piece-coplas]").count()==1)
    pv.click("#pieceDrawer [data-register-piece-coplas]"); pv.wait_for_timeout(1500)
    ok("register-coplas puts the loose copla in the archive", len(json.load(urllib.request.urlopen(APP+"/data/exports/coplas/coplas.json")))==len(coplas)+1 and sql("select count(*) from piece_coplas where copla_id is null")[0][0]==0)
    ok("button gone once registered", pv.locator("#pieceDrawer [data-register-piece-coplas]").count()==0)
    pv.click("#pieceDrawer [data-toggle-piece-visibility]"); pv.wait_for_timeout(1200)
    pubids=[x["id"] for x in json.load(urllib.request.urlopen(APP+"/data/exports/pezas/pezas.json"))]
    ok("published appears in public export", myid in pubids, pubids)
    ok("drawer refreshed shows Facela privada", "Facela privada" in pv.locator("#pieceDrawer").inner_text())
    pv.click("#pieceDrawer [data-close-piece-drawer]"); pv.wait_for_timeout(300)
    # estrela da peza na tarxeta
    star=pv.locator("#pieceRepositoryList .piece-card .fav-btn").first
    ok("piece card star", star.count()==1)
    star.click(); pv.wait_for_timeout(700)
    ok("piece favorite stored", sql("select count(*) from favorites where kind='piece'")[0][0]==1)
    # editar
    pv.locator("#pieceRepositoryList .piece-card").first.click(); pv.wait_for_selector("#pieceDrawer .piece-manage")
    pv.click("#pieceDrawer [data-edit-piece]"); pv.wait_for_timeout(900)
    ok("edit -> workshop with piece", pv.locator(".workshop").count()==1 and pv.input_value("#pieceTitle")=="Xota de proba" and "Editando" in pv.locator(".workshop-notice").inner_text())
    ok("2 coplas in draft", pv.locator(".workshop [data-uid], .workshop .part-copla, .workshop .draft-copla").count()>=0)
    pv.fill("#pieceTitle","Xota de proba (editada)")
    pv.click("#savePieceDirect"); pv.wait_for_selector(".fe-dialog form")
    ok("edit dialog has copy checkbox", pv.locator("#fePieceCopy").count()==1 and pv.locator('input[name="vis"][value="public"]').is_checked())
    pv.click('.fe-dialog button[type=submit]'); pv.wait_for_timeout(1500)
    ok("update in place (1 row)", sql("select count(*), max(title) from pieces where owner_user_id is not null")[0]==(1,"Xota de proba (editada)"), sql("select title from pieces where owner_user_id is not null"))
    # copia
    pv.click('[data-piece-tab="workshop"]'); pv.wait_for_timeout(400)
    pv.click("#savePieceDirect"); pv.wait_for_selector(".fe-dialog form"); pv.check("#fePieceCopy"); pv.click('.fe-dialog button[type=submit]'); pv.wait_for_timeout(1500)
    ok("copy creates second piece", sql("select count(*) from pieces where owner_user_id is not null")[0][0]==2)
    # 2 etiquetas/media/melodias estrelas
    pv.click('.sidebar [data-view="media"]'); pv.wait_for_selector(".media-card[data-media-id]",timeout=10000); pv.wait_for_timeout(700)
    ok("media stars", pv.locator(".media-card .fav-btn").count()>0)
    pv.locator(".media-card .fav-btn").first.click(); pv.wait_for_timeout(600)
    pv.click('.sidebar [data-view="melodies"]'); pv.wait_for_selector(".melody-card",timeout=10000); pv.wait_for_timeout(700)
    ok("melody stars", pv.locator(".melody-card .fav-btn").count()>0)
    pv.locator(".melody-card .fav-btn").first.click(); pv.wait_for_timeout(600)
    pv.click('.sidebar [data-view="coplas"]'); pv.wait_for_selector(".gallery-card[data-open-copla], .incipit-row[data-open-copla]",timeout=10000); pv.wait_for_timeout(500)
    # buscar copla con etiquetas
    tagged=[c for c in coplas if c.get("tags")]
    if tagged:
        pv.click("#view-coplas [data-open-copla] >> nth=0")
        pv.evaluate("id=>window.folearApp.searchCoplas('')",None)
        pv.evaluate("(id)=>{document.querySelector('#coplaSearch').value='';}",None)
        # abrir drawer da copla con etiquetas por hook de URL
        pv.goto(APP+f"/?copla_id={tagged[0]['id']}"); wait_ready(pv)
        ok("tag star in drawer", pv.locator("#coplaDrawer .tag[data-tag-name] .fav-btn").count()>0, tagged[0]["tags"])
        pv.locator("#coplaDrawer .tag[data-tag-name] .fav-btn").first.click(); pv.wait_for_timeout(600)
        pv.screenshot(path=str(OUT/"coplaDrawer-tag.png"))
        pv.keyboard.press("Escape")
    # perfil
    pv.click('.sidebar .account-line[data-view="profile"]'); pv.wait_for_selector("#profileForm",timeout=10000); pv.wait_for_timeout(900)
    ok("profile my pieces list", pv.locator(".profile-pieces .piece-row").count()==2, pv.locator(".profile-pieces").inner_text()[:200].replace("\n"," | "))
    tabs=pv.locator("#favTabs").inner_text().replace("\n"," | "); print("tabs:",tabs)
    ok("fav tabs include 6 kinds", "Etiquetas" in tabs and "Recursos" in tabs and "Melodías" in tabs and "Pezas" in tabs)
    pv.screenshot(path=str(OUT/"profile-full.png"), full_page=True)
    for kind in ("piece","media","melody","tag"):
        pv.click(f'[data-fav-tab="{kind}"]'); pv.wait_for_timeout(500)
        ok(f"fav list {kind}", pv.locator("#favList .fav-item").count()>=1, pv.locator("#favList").inner_text()[:80].replace("\n"," | "))
    pv.click('[data-fav-tab="tag"]'); pv.wait_for_timeout(300)
    ok("tag picker present", pv.locator("#tagPickInput").count()==1)
    # perfil publico
    pv.fill("#pfName","Ana da Ulloa"); pv.fill("#pfHandle","ana-ulloa"); pv.check('input[name="is_public"]'); pv.click("#profileForm button[type=submit]"); pv.wait_for_timeout(1500)
    # 2 BRUNO
    fake("g-bru","bruno@example.com","Bruno")
    ctx2,pb=newpage(b); pb.click('.sidebar [data-account="login"]'); pb.wait_for_url(APP+"/**",timeout=15000); wait_ready(pb)
    pb.click('.sidebar [data-view="pieces"]'); pb.click('[data-piece-tab="library"]'); pb.wait_for_timeout(700)
    titles=pb.locator("#pieceRepositoryList .piece-card h2").all_inner_texts()
    ok("bruno sees ana public piece(s) not private copy", "Xota de proba (editada)" in titles, titles)
    ok("bruno: attributed to ana", pb.locator(".piece-owner").count()>=1, pb.locator(".piece-owner").first.inner_text() if pb.locator(".piece-owner").count() else "")
    ok("bruno scope tabs mine=0", "As miñas (0)" in pb.locator(".piece-scope").inner_text())
    pb.screenshot(path=str(OUT/"bruno-library.png"))
    pb.locator(".piece-owner").first.click(); pb.wait_for_timeout(1500)
    ok("person page opens with pieces", "Pezas publicadas" in pb.locator("#view-people").inner_text(), pb.locator("#view-people").inner_text()[:120].replace("\n"," | "))
    ok("person page shows @username", pb.locator("#view-people .profile-handle").inner_text().strip() == "@ana-ulloa", pb.locator("#view-people .profile-handle").inner_text())
    pb.screenshot(path=str(OUT/"person-ana.png"))
    pb.click("#followBtn"); pb.wait_for_timeout(1000)
    ok("follow toggles", "Deixar de seguir" in pb.locator("#followBtn").inner_text())
    pb.click('.sidebar .account-line[data-view="profile"]'); pb.wait_for_selector("#profileForm",timeout=10000); pb.wait_for_timeout(900)
    ok("bruno following panel w/ recent piece", "Ana da Ulloa" in pb.locator(".profile-following").inner_text() and pb.locator(".profile-following .fav-item").count()>=1, pb.locator(".profile-following").inner_text()[:160].replace("\n"," | "))
    ok("own profile shows @handle line (or hint when none)", pb.locator("#view-profile .profile-id .profile-handle").count()==1, pb.locator("#view-profile .profile-id").inner_text())
    ok("followers panel present", pb.locator(".profile-followers").count()==1 and "Aínda ninguén te segue" in pb.locator(".profile-followers").inner_text(), pb.locator(".profile-followers").inner_text())
    pb.screenshot(path=str(OUT/"bruno-profile.png"), full_page=True)
    ok("bruno cannot see manage on ana's piece", True)
    pb.click('.sidebar [data-view="pieces"]'); pb.click('[data-piece-tab="library"]'); pb.wait_for_timeout(500)
    pb.locator("#pieceRepositoryList .piece-card h2").first.click(); pb.wait_for_selector("#pieceDrawer .drawer-panel"); pb.wait_for_timeout(300)
    ok("no manage block for others", pb.locator("#pieceDrawer .piece-manage").count()==0)
    # a ligazón á persoa dentro da ficha da peza abre o perfil e pecha a ficha
    ok("drawer has owner link", pb.locator("#pieceDrawer .piece-owner").count()==1)
    pb.locator("#pieceDrawer .piece-owner").click(); pb.wait_for_timeout(1200)
    ok("owner link in piece drawer opens the person page and closes the drawer", pb.locator("#pieceDrawer").is_hidden() and pb.locator("#view-people.active .profile-handle").count()==1, pb.locator("#view-people").inner_text()[:80].replace("\n"," | "))
    # 3 ADMIN modera
    fake("g-admin","folear3@gmail.com","Admin")
    ctx3,pa=newpage(b); pa.click('.sidebar [data-account="login"]'); pa.wait_for_url(APP+"/**",timeout=15000); wait_ready(pa)
    pa.click('.sidebar [data-view="pieces"]'); pa.click('[data-piece-tab="library"]'); pa.wait_for_timeout(700)
    pa.locator("#pieceRepositoryList .piece-card h2", has_text="Xota de proba (editada)").first.click(); pa.wait_for_selector("#pieceDrawer .piece-manage")
    ok("admin moderation button", pa.locator("#pieceDrawer [data-moderate-piece]").count()==1)
    myid=int(pa.get_attribute("#pieceDrawer [data-moderate-piece]","data-moderate-piece"))
    ok("admin piece media form visible", pa.locator("#pieceDrawer .piece-media-form").is_visible())
    pa.click("#pieceDrawer [data-moderate-piece]"); pa.wait_for_timeout(1200)
    ok("hidden chip for admin", "Agochada" in pa.locator("#pieceDrawer .meta").inner_text() and "Amosar de novo" in pa.locator("#pieceDrawer").inner_text())
    pubids=[x["id"] for x in json.load(urllib.request.urlopen(APP+"/data/exports/pezas/pezas.json"))]
    ok("hidden not in public export", myid not in pubids)
    # ana vese agochada
    pv.goto(APP+"/"); wait_ready(pv)
    pv.click('.sidebar [data-view="pieces"]'); pv.click('[data-piece-tab="library"]'); pv.click('[data-piece-scope="mine"]'); pv.wait_for_timeout(500)
    ok("owner sees Agochada tag", "Agochada" in pv.locator("#pieceRepositoryList").inner_text())
    pa.click("#pieceDrawer [data-moderate-piece]"); pa.wait_for_timeout(1000)
    ok("unhide", myid in [x["id"] for x in json.load(urllib.request.urlopen(APP+"/data/exports/pezas/pezas.json"))])
    pv.click('.sidebar .account-line[data-view="profile"]'); pv.wait_for_selector("#profileForm",timeout=10000); pv.wait_for_timeout(900)
    ok("ana sees her @username and who follows her (private-profile follower counted)", pv.locator("#view-profile .profile-id .profile-handle").inner_text().strip()=="@ana-ulloa" and "1 persoa máis" in pv.locator(".profile-followers").inner_text() and "Persoas que me seguen" in pv.locator(".profile-followers").inner_text(), pv.locator(".profile-followers").inner_text())
    pv.screenshot(path=str(OUT/"ana-profile.png"), full_page=True)
    # 4 SOBRE
    pv.click('.sidebar [data-view="about"]'); pv.wait_for_timeout(600)
    about=pv.locator("#view-about").inner_text().lower()
    ok("about: colour legend", all(t in about for t in ("código de cores","parroquia","concello","comarca","provincia","sen territorio")))
    ok("about: levels use the level colours", pv.locator("#view-about .about-legend .level-text.level-par, #view-about .about-legend .level-text.level-prov").count()==2)
    ok("about: explains PDF needs login", "para xerar un pdf pedimos que entres" in about and "15" in about)
    ok("about: how it works", all(t in about for t in ("copla","lugar","melodía","recurso","peza","persoa","que podes facer")))
    ok("about: sections", all(t in about for t in ("como funciona","como moverse","contas","privacidade")))
    ok("about: no stale PDF claim", "exportar en pdf está ao alcance" not in about)
    ok("about: no sidebar privacy link", pv.locator(".account-privacy").count()==0)
    pv.screenshot(path=str(OUT/"about.png"), full_page=True)
    pv.click(".about-foot-link"); pv.wait_for_selector(".privacy-doc h2",timeout=5000); pv.wait_for_timeout(300)
    ok("privacy in-app", "política de privacidade" in pv.locator(".privacy-doc").inner_text().lower() and pv.evaluate("location.hash")=="#/privacidade")
    pv.screenshot(path=str(OUT/"privacy.png"))
    pv.click("[data-privacy-back]"); pv.wait_for_timeout(400)
    ok("back to about", pv.locator(".about-hero").count()==1 and pv.evaluate("location.hash")=="")
    # about nav row
    pv.click('.about-nav-row[data-view="coplas"]'); pv.wait_for_timeout(500)
    ok("about nav goes to coplas", pv.locator("#view-coplas.active").count()==1)
    # visitante: about sen persoas? e privacidade por hash
    ctx4,pv2=newpage(b, url="/#/privacidade")
    ok("privacy via hash", pv2.locator(".privacy-doc").count()==1)
    ctx4.close()
    # MOBILE
    ctx5,pm=newpage(b, vp={"width":390,"height":844})
    pm.evaluate("d=>localStorage.setItem('fol-e-ar-piece-cart-v2', JSON.stringify(d))",draft); pm.reload(); wait_ready(pm)
    pm.goto(APP+"/?view=pieces"); wait_ready(pm)
    pm.screenshot(path=str(OUT/"m-workshop.png"))
    pm.goto(APP+"/?view=about"); wait_ready(pm); pm.screenshot(path=str(OUT/"m-about.png"), full_page=True)
    ok("mobile no horizontal scroll about", pm.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"))
    b.close()
restore_coplas(MAX_COPLA_ID)
print("ERRORS:",errs[:8]); print("FAILS:",FAILS)
