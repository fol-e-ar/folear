import html
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from .documents import build_piece_document, build_piece_draft_document, build_territory_document

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "templates"
STYLE_PATH = BASE_DIR / "styles" / "print.css"


class PdfRenderError(RuntimeError):
    pass


def safe_filename(value: str | None, fallback: str = "documento") -> str:
    text = (value or fallback).strip().lower()
    text = (
        text.replace("á", "a")
        .replace("é", "e")
        .replace("í", "i")
        .replace("ó", "o")
        .replace("ú", "u")
        .replace("ñ", "n")
        .replace("ç", "c")
        .replace("ü", "u")
    )
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or fallback


def html_escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def nl2br(value: str | None) -> str:
    return "<br>".join(html_escape(value).splitlines())


def load_template(name: str) -> str:
    return (TEMPLATE_DIR / name).read_text(encoding="utf-8")


def render_meta(document: dict[str, Any]) -> str:
    items = []
    if document.get("author"):
        items.append(f"<span>{html_escape(document['author'])}</span>")
    if document.get("context"):
        items.append(f"<span>{html_escape(document['context'])}</span>")
    if document.get("territory_type"):
        items.append(f"<span>{html_escape(document['territory_type'])}</span>")
    return "\n".join(items)


def render_copla(copla: dict[str, Any]) -> str:
    role = "retrouso" if copla.get("role") == "retrouso" else "copla"
    notes = ""
    if copla.get("notes"):
        notes = f"<div class=\"copla-notes\">{html_escape(copla['notes'])}</div>"
    return f"""
      <article class="copla {role}">
        <div class="copla-text">{nl2br(copla.get("text"))}</div>
        {notes}
      </article>
    """


def render_piece_html(document: dict[str, Any]) -> str:
    sections = []
    for section in document.get("sections", []):
        coplas = "".join(render_copla(copla) for copla in section.get("coplas", []))
        if not coplas:
            continue
        sections.append(
            f"""
            <section class="part">
              <h2 class="part-title">{html_escape(section.get("label") or "Parte")}</h2>
              {coplas}
            </section>
            """
        )
    body = "\n".join(sections) or "<p class=\"empty\">Esta peza aínda non ten coplas.</p>"
    return load_template("piece.html").replace("{{ title }}", html_escape(document.get("title"))).replace(
        "{{ meta }}", render_meta(document)
    ).replace("{{ description }}", html_escape(document.get("description"))).replace("{{ notes }}", html_escape(document.get("notes"))).replace(
        "{{ body }}", body
    ).replace("{{ print_css }}", STYLE_PATH.read_text(encoding="utf-8"))


def render_territory_html(document: dict[str, Any]) -> str:
    coplas = "".join(render_copla(copla) for copla in document.get("coplas", []))
    body = coplas or "<p class=\"empty\">Non hai coplas rexistradas para este territorio.</p>"
    meta = f"<span>{html_escape(document.get('territory_type'))}</span>" if document.get("territory_type") else ""
    return load_template("territory.html").replace("{{ title }}", html_escape(document.get("title"))).replace(
        "{{ meta }}", meta
    ).replace("{{ context }}", html_escape(document.get("context"))).replace("{{ body }}", body).replace(
        "{{ print_css }}", STYLE_PATH.read_text(encoding="utf-8")
    )


def chrome_binary() -> str:
    configured = os.environ.get("FOL_E_AR_CHROME")
    candidates = [
        configured,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise PdfRenderError(
        "Non se atopou Chrome/Chromium. Instala Google Chrome ou define FOL_E_AR_CHROME co binario."
    )


def render_pdf_from_html(html_text: str) -> bytes:
    with tempfile.TemporaryDirectory(prefix="fol-e-ar-pdf-") as tmpdir:
        tmp = Path(tmpdir)
        html_path = tmp / "document.html"
        pdf_path = tmp / "document.pdf"
        profile_path = tmp / "chrome-profile"
        html_path.write_text(html_text, encoding="utf-8")
        command = [
            chrome_binary(),
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--disable-extensions",
            "--no-sandbox",
            "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=1000",
            f"--user-data-dir={profile_path}",
            f"--print-to-pdf={pdf_path}",
            html_path.as_uri(),
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.time() + 60
        while time.time() < deadline:
            if pdf_path.exists() and pdf_path.stat().st_size > 0:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                break
            if process.poll() is not None:
                break
            time.sleep(0.2)
        else:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            detail = (stderr or stdout or "tempo de espera esgotado").strip()
            raise PdfRenderError(f"Chrome non puido xerar o PDF: {detail}")

        if process.poll() not in (0, None) and not pdf_path.exists():
            stdout, stderr = process.communicate()
            detail = (stderr or stdout or f"código de saída {process.returncode}").strip()
            raise PdfRenderError(f"Chrome non puido xerar o PDF: {detail}")
        data = pdf_path.read_bytes()
        if not data.startswith(b"%PDF"):
            raise PdfRenderError("O motor devolveu un ficheiro que non parece PDF.")
        return data


def render_piece_pdf(conn, piece_id: int) -> tuple[bytes, str]:
    document = build_piece_document(conn, int(piece_id))
    pdf = render_pdf_from_html(render_piece_html(document))
    return pdf, f"fol-e-ar-{safe_filename(document.get('title'), 'peza')}.pdf"


def render_piece_draft_pdf(conn, payload: dict[str, Any]) -> tuple[bytes, str]:
    document = build_piece_draft_document(conn, payload)
    pdf = render_pdf_from_html(render_piece_html(document))
    return pdf, f"fol-e-ar-{safe_filename(document.get('title'), 'peza')}.pdf"


def render_territory_pdf(conn, territory_id: str) -> tuple[bytes, str]:
    document = build_territory_document(conn, territory_id)
    pdf = render_pdf_from_html(render_territory_html(document))
    return pdf, f"fol-e-ar-{safe_filename(document.get('title'), 'territorio')}.pdf"
