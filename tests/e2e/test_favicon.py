"""Iconas: todas se serven (Google pide /favicon.ico ou un icon de múltiplo de 48 px, rastrexábel)."""
import sys, pathlib, urllib.request, re
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "harness"))
from common import APP, ok, finish
def get(path):
    r=urllib.request.urlopen(APP+path); return r.status, r.headers.get("content-type",""), r.read()
for path,ct in (("/favicon.ico","image"),("/assets/marca/favicon.svg","svg"),("/assets/marca/favicon-48.png","png"),("/assets/marca/favicon-96.png","png"),("/assets/marca/favicon-192.png","png"),("/assets/marca/apple-touch-icon.png","png")):
    st,c,b=get(path); ok(f"{path} serve 200 ({c})", st==200 and ct in c and len(b)>100)
html=get("/")[2].decode()
ok("index declara /favicon.ico e icono de 48 px", 'href="/favicon.ico"' in html and 'sizes="48x48"' in html)
ok("robots non bloquea iconas", "Disallow: /assets" not in get("/robots.txt")[2].decode() and "Disallow: /favicon" not in get("/robots.txt")[2].decode())
ico=get("/favicon.ico")[2]
ok("ico válido con 48, 32 e 16", ico[:4]==b"\x00\x00\x01\x00" and ico[4]==3, ico[:6])
finish()
