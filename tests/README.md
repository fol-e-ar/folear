# Probas

Levantan o **Worker real** (`wrangler dev`) con unha D1 local feita desde as migracións e o seed do repo (`infra/cloudflare/seed`) máis `fixtures/extra.sql`, un **Google falso** (`harness/fakegoogle.py`) e un navegador (Playwright/Chromium). Non tocan `data/db/coplas.sqlite` nin ningunha D1 real: todo vive en `tests/.tmp/` (ignorado por git).

```bash
tests/run.sh          # todo (API + navegador)
tests/run.sh api      # só API (rápido)
tests/run.sh e2e      # só navegador
```

Requisitos: `npm install` en `infra/cloudflare`, e `pip install playwright && playwright install chromium`. Con outro wrangler: `WRANGLER=/ruta/a/wrangler tests/run.sh`.

| Ficheiro | Cobre |
|---|---|
| `api/test_api.py` | roles e permisos, orixe (CSRF), privacidade das pezas, ligazóns, PDF só con sesión + tope diario, `pdf-proxy`, erros sen filtrar SQL, cabeceiras (CSP, nosniff) |
| `e2e/test_account_flow.py` | visitante, login, gardar/editar/copiar pezas, favoritos, perfís, seguimentos, moderación, «Sobre o arquivo», privacidade, móbil |
| `e2e/test_authors_links.py` | fichas de autoría e ligazóns nas pezas |
| `e2e/test_pdf_viewer.py` | visor de PDF por riba de todo (escritorio e móbil) |
| `e2e/test_lists_select_paste.py` | vistas de lista, selección múltipla, pegar varias coplas, aliñamento dos íncipits |
| `e2e/test_security_pdf.py` | sen peticións a terceiros, Leaflet/fontes locais, miniaturas de PDF con CSP, PDF só con sesión |

Cada ficheiro escribe `PASS`/`FAIL` e `run.sh` falla se hai algún `FAIL`. As capturas quedan en `tests/out/`.

O Worker non pode xerar PDFs reais aquí (non hai Browser Run): as probas comproban o control de acceso e a mensaxe de erro, e o visor proba cun PDF de mostra.

Probas rápidas sen Worker: `node tools/smoke_frontend.mjs`.
