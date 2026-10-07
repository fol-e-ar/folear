"""E2E: visor de PDF por riba da interface (escritorio e móbil), con login."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, DB, OUT, sql, Client, SAMPLE_PDF
from playwright.sync_api import sync_playwright
import shoot_lib as S
pdf=SAMPLE_PDF.read_bytes()
def handler(route):
    u=route.request.url
    if "/api/pieces/" in u and u.endswith("/pdf"): return route.fulfill(body=pdf,content_type="application/pdf",headers={"content-disposition":'attachment; filename="peza-proba.pdf"'})
    return route.continue_() if u.startswith((APP,"http://localhost:9911")) else S.base_handle(route)
with sync_playwright() as p:
    b=p.chromium.launch()
    for name,vp in (("d",{"width":1440,"height":900}),("m",{"width":390,"height":844})):
        pg=b.new_page(viewport=vp); pg.route("**/*",handler)
        pg.on("pageerror",lambda e:print("ERR",e)); pg.on("console",lambda m: print("CONSOLE",m.text) if "Refused" in m.text or "Content Security" in m.text else None)
        import urllib.request; urllib.request.urlopen("http://127.0.0.1:9911/set?sub=g-v&email=v@example.com&name=V").read()
        pg.goto(APP+"/api/auth/google"); pg.wait_for_url(APP+"/**"); pg.wait_for_selector("#global-loading[hidden]",state="attached"); pg.wait_for_timeout(2500)
        pg.evaluate("window.folearApp.openPiece(2)"); pg.wait_for_timeout(500)
        pg.locator("#pieceDrawer button:has-text('Descargar PDF'), #pieceDrawer a:has-text('Descargar PDF')").first.click(); pg.wait_for_timeout(1500)
        res = (pg.evaluate("""()=>{const v=document.getElementById('pdfViewer');const cs=getComputedStyle(v);const pts=[[10,10],[10,400],[vp=innerWidth-10,10]].map(([x,y])=>{const e=document.elementFromPoint(x,y);return e&&(e.className||e.tagName)});return [v.hidden,cs.position,cs.zIndex,v.parentElement.tagName,pts,document.documentElement.scrollWidth]}"""))
        hidden, position, z, parent, pts, sw = res
        ok_ = (not hidden) and position == 'fixed' and int(z) >= 3000 and parent == 'BODY' and all(str(x).startswith('pdf-') for x in pts) and sw <= vp['width']
        print(('PASS ' if ok_ else 'FAIL ') + f'pdf viewer on top ({name})', res)
        pg.screenshot(path=str(OUT/f"pdf-{name}.png")); pg.close()
    # Safari / iOS: o visor debuxa as páxinas con pdf.js (un <object> non amosa o PDF)
    SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
    ctx=b.new_context(viewport={"width":390,"height":844}, user_agent=SAFARI); pg=ctx.new_page(); pg.route("**/*",handler)
    errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    import urllib.request; urllib.request.urlopen("http://127.0.0.1:9911/set?sub=g-v&email=v@example.com&name=V").read()
    pg.goto(APP+"/api/auth/google"); pg.wait_for_url(APP+"/**"); pg.wait_for_selector("#global-loading[hidden]",state="attached"); pg.wait_for_timeout(2500)
    pg.evaluate("window.folearApp.openPiece(2)"); pg.wait_for_timeout(500)
    pg.locator("#pieceDrawer button:has-text('Descargar PDF'), #pieceDrawer a:has-text('Descargar PDF')").first.click(); pg.wait_for_timeout(4000)
    r=pg.evaluate("()=>({obj:document.querySelectorAll('#pdfViewer object').length, canvases:document.querySelectorAll('#pdfCanvasFrame canvas').length, w:document.querySelector('#pdfCanvasFrame canvas')?.getBoundingClientRect().width, vw:innerWidth, painted:(()=>{const c=document.querySelector('#pdfCanvasFrame canvas'); if(!c) return false; const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let dark=0; for(let i=0;i<d.length;i+=4){ if(d[i]<200) dark++; } return dark>0})()})")
    print(('PASS ' if r['obj']==0 and r['canvases']>=1 and r['w']<=r['vw'] and r['painted'] else 'FAIL ')+'pdf viewer con pdf.js (Safari/iOS)', r, errs[:2])
    pg.screenshot(path=str(OUT/"pdf-safari.png")); ctx.close()
