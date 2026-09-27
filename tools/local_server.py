#!/usr/bin/env python3
import json
import sys
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.db import connect, migrate
from backend.services.db_paths import DB_PATH
from backend.services.exporters import export_web
from backend.services.importers import (
    delete_coplas,
    import_coplas,
    import_media,
    import_pieces,
    import_territory_traits,
)
from backend.services.pdf import (
    PdfRenderError,
    render_piece_draft_pdf,
    render_piece_pdf,
    render_territory_pdf,
)


class PreviewParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.meta: dict[str, str] = {}
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        data = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag == "meta":
            key = data.get("property") or data.get("name")
            value = data.get("content")
            if key and value:
                self.meta[key] = value

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.title:
            self.title = data.strip()


class LocalHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_pdf(self, status: int, body: bytes, filename: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition", f'inline; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path == "/api/pdf/piece-draft":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                conn = connect(DB_PATH)
                try:
                    pdf, filename = render_piece_draft_pdf(conn, payload)
                finally:
                    conn.close()
                self._send_pdf(200, pdf, filename)
            except (ValueError, PdfRenderError) as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if self.path not in {"/api/coplas", "/api/media", "/api/pieces", "/api/territory-traits"}:
            self._send_json(404, {"error": "Endpoint non atopado."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            migrate(DB_PATH)
            conn = connect(DB_PATH)
            try:
                if self.path == "/api/coplas":
                    ids = import_coplas(conn, payload)
                elif self.path == "/api/media":
                    ids = import_media(conn, payload)
                elif self.path == "/api/territory-traits":
                    ids = import_territory_traits(conn, payload)
                else:
                    ids = import_pieces(conn, payload)
                conn.commit()
                counts = export_web(conn)
            finally:
                conn.close()
            self._send_json(200, {"ok": True, "ids": ids, "counts": counts})
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})

    def do_DELETE(self) -> None:
        if self.path != "/api/coplas":
            self._send_json(404, {"error": "Endpoint non atopado."})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            ids = payload.get("ids")
            migrate(DB_PATH)
            conn = connect(DB_PATH)
            try:
                deleted = delete_coplas(conn, ids)
                conn.commit()
                counts = export_web(conn)
            finally:
                conn.close()
            self._send_json(200, {"ok": True, "ids": deleted, "counts": counts})
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/pieces/") and path.endswith("/pdf"):
            piece_id = path.removeprefix("/api/pieces/").removesuffix("/pdf").strip("/")
            try:
                conn = connect(DB_PATH)
                try:
                    pdf, filename = render_piece_pdf(conn, int(piece_id))
                finally:
                    conn.close()
                self._send_pdf(200, pdf, filename)
            except (ValueError, PdfRenderError) as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path.startswith("/api/territories/") and path.endswith("/pdf"):
            territory_id = unquote(path.removeprefix("/api/territories/").removesuffix("/pdf").strip("/"))
            try:
                conn = connect(DB_PATH)
                try:
                    pdf, filename = render_territory_pdf(conn, territory_id)
                finally:
                    conn.close()
                self._send_pdf(200, pdf, filename)
            except (ValueError, PdfRenderError) as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if not path == "/api/link-preview":
            return super().do_GET()

        try:
            query = parse_qs(parsed.query)
            url = query.get("url", [""])[0]
            if not url.startswith(("http://", "https://")):
                self._send_json(400, {"ok": False, "error": "URL non válida."})
                return
            req = Request(url, headers={"User-Agent": "Fol-e-ar-local-preview/1.0"})
            with urlopen(req, timeout=6) as response:
                html = response.read(512_000).decode("utf-8", errors="ignore")
            parser = PreviewParser()
            parser.feed(html)
            description = (
                parser.meta.get("og:description")
                or parser.meta.get("description")
                or parser.meta.get("twitter:description")
            )
            title = parser.meta.get("og:title") or parser.meta.get("twitter:title") or parser.title
            og_type = parser.meta.get("og:type") or ""
            author = None
            if og_type.startswith("music") and description and " · " in description:
                # As paxinas de faixa de Spotify (e similares) formatan a
                # descricion coma "Artista · Cancion · Ano": collemos o
                # primeiro segmento coma autoria se non coincide co titulo.
                first_segment = description.split(" · ")[0].strip()
                if first_segment and first_segment.lower() != (title or "").strip().lower():
                    author = first_segment
            self._send_json(200, {
                "ok": True,
                "title": title,
                "description": description,
                "thumbnail_url": parser.meta.get("og:image") or parser.meta.get("twitter:image"),
                "provider": parser.meta.get("og:site_name"),
                "author_or_source": author,
            })
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("", port), LocalHandler)
    print("Fol e ar")
    print(f"Servidor local: http://localhost:{port}/frontend/index.html")
    print("API local: POST /api/coplas")
    print("API local: DELETE /api/coplas")
    print("API local: POST /api/media")
    print("API local: POST /api/pieces")
    print("API local: POST /api/territory-traits")
    print("API local: POST /api/pdf/piece-draft")
    print("API local: GET /api/pieces/{id}/pdf")
    print("API local: GET /api/territories/{id}/pdf")
    print()
    print("Para parar: Ctrl+C")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
