import json, base64, time, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
IDENT={"sub":"g-admin","email":"folear3@gmail.com","name":"Folear Admin","picture":None,"email_verified":True}
CODES={}
def b64(d): return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query)
        if u.path=="/set":
            IDENT.clear(); IDENT.update({"sub":q["sub"][0],"email":q["email"][0],"name":q.get("name",[q["email"][0]])[0],"picture":None,"email_verified":q.get("verified",["1"])[0]=="1"})
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return
        if u.path=="/deny":
            self.send_response(302); self.send_header("Location", q["redirect_uri"][0]+"?error=access_denied&state="+q["state"][0]); self.end_headers(); return
        if u.path=="/auth":
            code="code"+str(len(CODES)+1); CODES[code]=(dict(IDENT), q["nonce"][0])
            self.send_response(302); self.send_header("Location", q["redirect_uri"][0]+"?code="+code+"&state="+q["state"][0]); self.end_headers(); return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0")); body=parse_qs(self.rfile.read(n).decode())
        code=body.get("code",[""])[0]
        if code not in CODES or body.get("client_secret",[""])[0]!="test-secret":
            self.send_response(400); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(b'{"error":"invalid_grant"}'); return
        ident,nonce=CODES.pop(code)
        payload={"iss":"https://accounts.google.com","aud":body["client_id"][0],"exp":int(time.time())+3600,"nonce":nonce,**ident}
        tok=b64({"alg":"none"})+"."+b64(payload)+".sig"
        out=json.dumps({"id_token":tok,"access_token":"x"}).encode()
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(out)
HTTPServer(("127.0.0.1",9911),H).serve_forever()
