"""Descarga controlada de PDFs para xerar a miniatura da primeira páxina.

O navegador non pode ler a maioría dos PDFs alleos directamente (CORS), así
que o servidor local fai de pasarela. Por seguridade:

- só se serven URLs que xa están rexistradas como recurso na táboa media;
- só http/https, e rexéitanse enderezos internos (localhost, redes privadas);
- máximo de MAX_PDF_BYTES e comprobación de que o contido é un PDF.
"""
import ipaddress
import socket
import sqlite3
from urllib.parse import urlparse
from urllib.request import Request, urlopen

MAX_PDF_BYTES = 25 * 1024 * 1024
FETCH_TIMEOUT = 15


class PdfProxyError(ValueError):
    pass


def _assert_public_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise PdfProxyError("Non se pode resolver o enderezo do PDF.") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            raise PdfProxyError("Enderezo non permitido.")


def fetch_registered_pdf(conn: sqlite3.Connection, url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise PdfProxyError("URL non válida.")
    known = conn.execute("SELECT 1 FROM media WHERE url = ? LIMIT 1", (url,)).fetchone()
    if not known:
        raise PdfProxyError("Só se poden previsualizar PDFs rexistrados.")
    _assert_public_host(parsed.hostname)

    request = Request(url, headers={"User-Agent": "Fol-e-ar-pdf-preview/1.0", "Accept": "application/pdf,*/*"})
    with urlopen(request, timeout=FETCH_TIMEOUT) as response:
        declared = response.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > MAX_PDF_BYTES:
            raise PdfProxyError("O PDF é demasiado grande para previsualizalo.")
        body = response.read(MAX_PDF_BYTES + 1)
    if len(body) > MAX_PDF_BYTES:
        raise PdfProxyError("O PDF é demasiado grande para previsualizalo.")
    if b"%PDF" not in body[:1024]:
        raise PdfProxyError("O recurso non é un PDF.")
    return body
