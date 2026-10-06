"""E2E: sen terceiros, CSP, PDF só con sesión, tope diario, erro xenérico."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, DB, OUT, sql, Client, SAMPLE_PDF
import urllib.request, json, sqlite3
from playwright.sync_api import sync_playwright
FAILS=[]
def ok(l,c,x=""):
    print(("PASS " if c else "FAIL ")+l,x)
    if not c: FAILS.append(l)
pdf=SAMPLE_PDF.read_bytes()
sql("delete from sessions"); sql("delete from users"); sql("delete from pdf_usage")
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={"width":1440,"height":900}); pg=ctx.new_page()
    ext=[]; errs=[]
    pg.on("request",lambda r: ext.append(r.url) if not r.url.startswith((APP,"data:","blob:","http://localhost:9911")) and r.resource_type!="image" else None)
    pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.on("console",lambda m: errs.append(m.text) if m.type in("error","warning") else None)
    def h(route):
        u=route.request.url
        if "/api/pdf-proxy" in u: return route.fulfill(body=pdf,content_type="application/pdf")
        return route.continue_()
    pg.route("**/*",h)
    pg.goto(APP+"/"); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(2500)
    ok("no third-party requests", not ext, ext)
    ok("leaflet+topojson local", pg.evaluate("typeof L!=='undefined' && typeof topojson!=='undefined'"))
    pg.click('.sidebar [data-view="map"]') if pg.locator('.sidebar [data-view="map"]').count() else None
    pg.wait_for_timeout(1500)
    ok("map panes render", pg.locator(".leaflet-pane").count()>0)
    ok("fonts loaded locally", pg.evaluate("document.fonts.check('16px Inter') && [...document.fonts].some(f=>f.family.includes('Inter')&&f.status==='loaded')"))
    # PDF thumbs under CSP
    pg.click('.sidebar [data-view="media"]'); pg.wait_for_timeout(3500)
    n=pg.locator("[data-pdf-thumb]").count()
    done=pg.locator('[data-pdf-state="done"], [data-pdf-thumb] img').count()
    ok("pdf thumbs rendered by local pdf.js", n>0 and done>0, (n,done,pg.evaluate("[...document.querySelectorAll('[data-pdf-thumb]')].map(e=>e.dataset.pdfState)")))
    # visitor
    r=pg.evaluate("fetch('/api/pdf/piece-draft',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>[r.status,(await r.json()).error])")
    ok("anon piece-draft 401",r[0]==401,r)
    r=pg.evaluate("fetch('/api/territories/x/pdf').then(async r=>[r.status,(await r.json()).error])"); ok("anon territory pdf 401",r[0]==401,r)
    pg.evaluate("window.folearApp.openPiece(2)"); pg.wait_for_timeout(600)
    ok("visitor drawer: login link instead of button", pg.locator("#pieceDrawer a:has-text('Entra para descargar')").count()==1 and pg.locator("[data-download-piece-pdf]").count()==0)
    pg.evaluate("localStorage.setItem('fol-e-ar-piece-cart-v2', JSON.stringify({title:'t',author:'',notes:'',status:'draft',territoryId:'',sections:[{id:'p',label:'X',coplas:[{uid:'u',id:null,incipit:'a',text:'a b',territory:'',role:'copla',notes:''}]}]}))")
    pg.reload(); pg.wait_for_selector("#global-loading[hidden]",state="attached"); pg.wait_for_timeout(1500)
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(600); pg.click('[data-piece-tab="workshop"]'); pg.wait_for_timeout(400)
    reqs=[]; pg.on("request",lambda r: reqs.append(r.url) if "/pdf" in r.url else None)
    pg.click("#openA4"); pg.wait_for_timeout(500)
    t=pg.locator("#pieceExportStatus").inner_text()
    ok("visitor export: login message, no request", "entrar con google" in t.lower() and not reqs, (t,reqs))
    # logged in
    urllib.request.urlopen("http://127.0.0.1:9911/set?sub=g-pdf&email=pdf@example.com&name=Pdf").read()
    pg.goto(APP+"/api/auth/google"); pg.wait_for_url(APP+"/**"); pg.wait_for_selector("#global-loading[hidden]",state="attached",timeout=30000); pg.wait_for_timeout(1500)
    r=pg.evaluate("fetch('/api/pdf/piece-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'t',sections:[]})}).then(async r=>[r.status,(await r.json()).error])")
    ok("logged-in passes auth gate (fails later: no Browser Run in test)", r[0]!=401, r)
    for i in range(16): pg.evaluate("fetch('/api/pdf/piece-draft',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})")
    pg.wait_for_timeout(1500)
    r=pg.evaluate("fetch('/api/pdf/piece-draft',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>[r.status,(await r.json()).error])")
    ok("daily limit 429",r[0]==429,r)
    # error message in UI is the server one
    sql("delete from pdf_usage")
    pg.click('.sidebar [data-view="pieces"]'); pg.wait_for_timeout(500); pg.click('[data-piece-tab="workshop"]'); pg.wait_for_timeout(400)
    pg.click("#openA4"); pg.wait_for_timeout(2000)
    ok("UI shows readable server error", len(pg.locator("#pieceExportStatus").inner_text())>10, pg.locator("#pieceExportStatus").inner_text())
    # generic DB error
    sql("alter table media rename to media_x")
    try:
        import urllib.error
        try: urllib.request.urlopen(APP+"/api/pdf-proxy?url=https%3A%2F%2Fexample.org%2Fa.pdf"); r=[200,""]
        except urllib.error.HTTPError as e: r=[e.code,json.loads(e.read())["error"]]
    finally:
        sql("alter table media_x rename to media")
    ok("DB error is generic", r[0]==500 and "media" not in r[1] and "Erro interno" in r[1], r)
    ok("no CSP/page errors", not [e for e in errs if "Failed to load resource" not in e and "Refused" in e or "Content Security" in e], errs[:5])
    ok("no third-party requests at end", not [u for u in ext], ext[:5])
print("FAILS",FAILS)
