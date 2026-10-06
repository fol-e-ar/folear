# Fol e ar

Atlas textual, musical e editorial de coplas galegas: un arquivo consultable por lugar (provincia, comarca, concello, parroquia), con recursos de media, melodías, pezas e perfís de persoas.

Produción: <https://folear.gal> (Cloudflare Workers + D1).

## Como está feito

| Capa | Onde vive | Notas |
|---|---|---|
| Frontend | `frontend/` | JavaScript puro (sen build), mapa con Leaflet. Todas as bibliotecas van no repo (`frontend/assets/vendor/`), sen CDNs. |
| API de produción | `infra/cloudflare/src/worker.js` | Cloudflare Worker + D1. Sirve tamén `frontend/` (Static Assets). |
| Modo local | `tools/local_server.py` + `backend/` | Servidor Python sobre `data/db/coplas.sqlite`. Sen login, todo permitido. Serve para desenvolver e exportar PDF con Chrome local. |
| Datos | D1 (produción) | **A fonte de verdade é a D1 de produción.** A SQLite local é unha copia de traballo (ver `docs/operacion.md`). |

Os papeis: visitante (consulta), `foleante` (conta con Google: perfil, favoritos, pezas, PDF), `guia` (edita o arquivo) e `admin`. Máis detalle en `infra/cloudflare/README.md`.

## Arrincar en local

```bash
./serve.sh            # http://localhost:8765/frontend/index.html
```

Máis en `docs/uso-local.md`. Probas rápidas do frontend: `node tools/smoke_frontend.mjs`. Probas completas: ver `tests/README.md`.

## Despregar

```bash
cd infra/cloudflare
npx wrangler d1 migrations apply fol-e-ar-db --remote   # só se hai migracións novas
npx wrangler deploy
```

Primeira configuración, secrets, copias de seguridade e como volver atrás: `docs/operacion.md`.

## Estrutura do repo

```text
frontend/            app web (HTML, CSS, JS, datos xeográficos) + _headers (CSP) + _redirects
backend/             esquema SQLite e servizos Python (modo local, PDF local)
tools/               admin.py (CLI), local_server.py, smoke test; tools/legacy/ = scripts vellos
infra/cloudflare/    Worker, migracións D1, seed, scripts de migración
data/                db/coplas.sqlite (copia local), exports/, canonical/
docs/                uso local, operación, arquitectura; docs/arquivo/ = notas históricas
tests/               probas (API e navegador)
```
