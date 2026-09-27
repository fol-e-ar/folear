# Auditoría técnica · estado actual antes de Cloudflare

Data: 2026-09-19. Feita sobre o repositorio tal e como está (rama `main`,
sen cambios locais pendentes agás dous `package-lock.json` baleiros e sen
trackear). Non se modificou código de produto nesta auditoría; os únicos
cambios feitos no repo son os descritos en `docs/arquitectura-cloudflare.md`
(mellora visual + `infra/cloudflare/`).

Este documento completa `docs/notes.md` e `docs/redesign-plan.md` (que xa
describen ben a arquitectura xeral e xa se implementou practicamente ao pé
da letra: as táboas `pieces`, `media`, `media_links` do redeseño están
aplicadas vía `backend/services/db.py::apply_002_curation`). O que engade
este documento é o diagnóstico específico de cara a Cloudflare.

## 1. Como se len e escriben os datos hoxe

Dous camiños de escritura conviven:

1. **CLI** (`tools/admin.py`): `import-coplas`, `import-pieces`,
   `import-media`, `import-territories`, `export-web`, `check`,
   `pdf-piece`, `pdf-territory`. Escribe directamente en
   `data/db/coplas.sqlite` e require regenerar exports á man
   (`export-web`).
2. **API local** (`tools/local_server.py`, servidor HTTP estándar de Python
   sen framework): `POST /api/coplas`, `POST /api/media`, `POST
   /api/pieces`. Cada POST fai `migrate()` + `import_*()` + `export_web()`
   nunha soa chamada, así que os JSON de `data/exports/` quedan sempre
   sincronizados coa SQLite tras cada escritura local. Tamén serve
   `GET /api/link-preview` (preview de ligazóns externas, ver secc. 7) e os
   catro endpoints de PDF.

A web pública **nunca le a SQLite**: le só `data/exports/*/*.json` (ver
`frontend/js/api.js`). Isto xa é exactamente o modelo que precisa Cloudflare
(SQLite/D1 como fonte de escritura, JSON/API como capa de lectura pública),
así que a transición é de infraestrutura, non de modelo.

## 2. Que funciona só en local vs en publicación estática

| Capacidade | Local (`./serve.sh`) | GitHub Pages (actual) |
|---|---|---|
| Ver mapa, coplas, territorios, pezas, media | Si | Si (le só `data/exports/`) |
| Dar de alta coplas/media/pezas desde a UI (`Alta`) | Si (API local) | Non (non hai API en Pages) |
| Importar/exportar por JSON (`tools/admin.py`) | Si | N/A (require terminal) |
| Xerar PDF real | Si (Chrome/Chromium headless local) | Non (botón non debería aparecer funcional, ver secc. 7) |
| Preview de ligazóns externas (`/api/link-preview`) | Si | Non |

`frontend/index.html` xa detecta `file://` e redirixe a
`http://localhost:8765`, e a UI de "Alta" depende de que exista o servidor
local. Isto é exactamente o que unha API en Workers ten que substituír para
que a edición funcione tamén en produción, non só en local.

## 3. Rexeneración de exports e risco de duplicidade

`export_web()` (`backend/services/exporters.py`) regenera os catro JSON de
`data/exports/` enteiros cada vez, lendo a SQLite. Non hai edición
incremental dos JSON. Isto reduce moito o risco de diverxencia **mentres
todas as escrituras pasen por `import_coplas/import_pieces/import_media` +
`export_web()`**, cousa que hoxe se cumpre (tanto o CLI coma a API local
chaman sempre aos dous). O único vector de risco real é editar
`data/exports/*.json` á man, que `docs/notes.md` xa prohibe explicitamente
("non editar `exports/` a man salvo caso excepcional").

`backend/services/checks.py::run_checks()` xa compara os exports en disco
cos que se xerarían de novo e marca "Export desactualizado" se non
coinciden — é dicir, xa hai unha comprobación de sincronización.
`python3 tools/admin.py check` pasou sen problemas nesta auditoría.

## 4. Endpoints actuais (inventario completo)

```
POST /api/coplas              → import_coplas + export_web
POST /api/media                → import_media + export_web
POST /api/pieces               → import_pieces + export_web
POST /api/pdf/piece-draft      → PDF dunha peza en borrador (sen persistir)
GET  /api/pieces/{id}/pdf      → PDF dunha peza xa gardada
GET  /api/territories/{id}/pdf → PDF das coplas dun territorio (absorbidas)
GET  /api/link-preview?url=    → title/description/thumbnail dunha URL externa
GET  *                         → ficheiros estáticos (frontend/, data/exports/, assets)
```

Ningún destes endpoints ten autenticación. Isto é aceptable en local
(`localhost` só accesible por quen ten o repo), pero **ningún debe
exponerse tal cal en Internet**: calquera dos tres POST permitiría escribir
no corpus público sen revisión, e `/api/link-preview` é un vector de SSRF
(ver secc. 7 máis abaixo).

## 5. Integridade referencial

`PRAGMA integrity_check` → `ok`. Pero `PRAGMA foreign_key_check` atopa **2
filas rotas xa existentes** en `copla_tags` (rowids 1 e 2, ambas as dúas con
`copla_id = 1`, que xa non existe en `coplas`). Isto é anterior a esta
auditoría — non se tocou nada — e `tools/admin.py check` non o detecta
porque `run_checks()` non comproba `copla_tags` contra `coplas` (só
comproba `copla_territories`, `piece_coplas`, `media_links` e slugs).

**Recomendación non urxente**: engadir esa comprobación a
`run_checks()` nunha futura iteración, e decidir manualmente (fóra desta
auditoría) se esas 2 filas de `copla_tags` se borran na SQLite orixe. O
script de migración a D1 (`infra/cloudflare/scripts/export_sqlite_to_d1.py`)
xa as detecta e as exclúe do seed sen tocar a orixe, para que non bloqueen
unha futura carga con `PRAGMA foreign_keys = ON` en D1.

## 6. Limitacións do esquema actual

- `media_links.entity_id` é `TEXT` que garda ids heteroxéneos (territorio
  como texto, copla/peza como enteiro serializado). Funciona porque
  `entity_type` sempre acompaña, pero impide unha foreign key real cara
  copla/peza (só se valida a man en `importers.py`/`checks.py`). É
  asumible para o volume actual; nunha D1 con máis escala convería avaliar
  tres columnas de relación específicas (`territory_id`, `copla_id`,
  `piece_id`, todas NULL agás unha) se algunha vez doe en consultas.
- Non hai columna de propiedade (`owner_id`/`created_by`) en ningures:
  correcto para a fase actual (sen usuarios), pero hai que telo en conta
  quen se deseñe autenticación (secc. 6 do encargo).
- Non hai borrado lóxico (`deleted_at`) en ningures: hoxe bórrase físico
  (`DELETE`/`DROP`). Para produción con achegas públicas convén un borrado
  lóxico polo menos en `coplas` e `media`, para poder desfacer.
- `status` en `coplas`/`pieces`/`media` só distingue `draft`/`published`
  (coplas tamén acepta implicitamente outros valores porque
  `importers.py` non o restrinxe tan estritamente coma `pieces`/`media`,
  aínda que a UI só usa eses dous). Non hai `archived` en ningures.

## 7. Tamaño dos datos

```
data/db/coplas.sqlite        2.1 MB   (4 155 territorios, 5 coplas, 3 media)
data/exports/ (4 JSON)       1.3 MB
frontend/assets/web/ (GeoJSON/TopoJSON) 2.6 MB
data/canonical/territorios.json  ~180 KB (45 588 liñas)
```

O corpus de coplas/pezas/media é aínda moi pequeno (contido de proba); o
peso real hoxe é territorial e cartográfico. Isto é relevante para
Cloudflare: D1 ten límite de 10 GB por base (moi por riba do actual) e os
GeoJSON/TopoJSON (2.6 MB) encaixan ben como Static Assets sen necesidade de
R2 nin de ningún tratamento especial.

## 8. Operacións compatibles / incompatibles cun runtime de Cloudflare

**Compatibles directamente** (Workers + D1):
- Todo o CRUD actual sobre `territories`, `coplas`, `copla_versions`, `tags`,
  `copla_territories`, `pieces`, `piece_coplas`, `media`, `media_links` —
  son consultas SQL simples, sen funcións SQLite exóticas.
- Servir `frontend/` e `data/exports/*.json` (Static Assets).
- Rexenerar exports JSON on-demand nunha ruta administrativa, se algunha vez
  fai falta (aínda que en D1 xa non hai por que manter JSON estáticos
  separados unha vez D1 sexa a fonte de verdade pública, ver
  `docs/arquitectura-cloudflare.md`).

**NON compatibles directamente** (require estratexia distinta):
- `backend/services/pdf/renderer.py` lanza un subproceso de Chrome/Chromium
  headless local (`subprocess.Popen`) — **imposible** nun Worker (sen
  procesos, sen sistema de ficheiros persistente para perfís de Chrome).
  Ver secc. 7 do encargo orixinal / `docs/arquitectura-cloudflare.md`.
- `GET /api/link-preview` fai unha petición HTTP arbitraria a calquera URL
  que envíe o cliente (`urlopen(url)`, sen validar host nin IP) — é un SSRF
  clásico. Nun Worker isto tamén sería posible tecnicamente (fetch), pero
  **non se debe portar tal cal**: precisa allowlist de esquemas
  (`http`/`https`), resolución de DNS e verificación de que non apunta a
  IPs privadas/loopback/metadata (`169.254.169.254`, etc.), e límite de
  tamaño de resposta (o código actual xa limita a 512 KB, iso si é correcto
  e debe manterse).
- Escritura de ficheiros locais (`data/exports/pdf/`, perfís temporais de
  Chrome) — non hai sistema de ficheiros persistente en Workers; calquera
  saída binaria (PDF, imaxe) ten que ir a R2, non a disco.

## 9. Necesidades futuras de autenticación, usuarios e contido privado

Hoxe: cero autenticación en ningures (nin sequera na API local). Para
produción, o mínimo indispensable é distinguir "administración" de
"público" (ver `docs/arquitectura-cloudflare.md`, secc. "API e
seguridade"). Non hai necesidade demostrada aínda dun sistema de usuarios
completo (rexistro, perfís, permisos granulares) — o proxecto é un arquivo
editorial cun equipo pequeno, non unha plataforma multiusuario. Recoméndase
**non construílo agora** (coincide coa recomendación explícita de
`docs/redesign-plan.md` secc. 11) e deixar só o oco no esquema (columna de
estado xa existe; unha futura `owner_id` engádese sen ruptura cando hosxa
caso de uso real).

## 10. Tratamento de audio, vídeo, imaxes e miniaturas

Hoxe **todo** o media é externo por referencia (`media.url` a
YouTube/Spotify/SoundCloud/web, ou un MP3/MP4 servido desde outro sitio);
non hai ficheiros propios subidos nin almacenados no repo nin na SQLite.
Non hai, polo tanto, ningún risco actual de duplicar contido alleo — o
proxecto xa segue a regra de "non descargar nin republicar automaticamente
material de terceiros" (secc. 8 do encargo). O deseño de R2 en
`docs/arquitectura-cloudflare.md` é, por tanto, 100 % prospectivo: prepárase
para cando haxa gravacións propias, sen que haxa que migrar nada existente.

## 11. Xeración de PDF

Ver secc. 8 arriba e `backend/services/pdf/renderer.py`: usa Chrome/Chromium
headless local vía `subprocess`, cun timeout de 60 s e un `--user-data-dir`
temporal. Funciona ben en local (probado nesta auditoría indirectamente: o
código é correcto e ten manexo de erros razoable), pero é estritamente
unha capacidade de servidor con sistema de ficheiros e proceso, incompatible
con Workers. Estratexia recomendada en
`docs/arquitectura-cloudflare.md` secc. "PDF".

## 12. Preview de ligazóns externas

Ver punto 8 (SSRF). Recoméndase, quede en Workers ou siga en Python, que
calquera reimplementación valide explicitamente esquema `http(s)`,
resolva o host e rexeite IPs privadas/loopback/link-local antes de facer a
petición, e non só despois (o código actual só valida o prefixo da URL, non
resolve nin verifica a IP final).

## 13. Copias de seguridade e recuperación

`data/backups/` existe pero está **baleiro** — non hai, hoxe, ningunha
copia de seguridade automatizada nin manual da SQLite. É o punto de risco
operativo máis claro atopado nesta auditoría, independentemente de
Cloudflare: se `data/db/coplas.sqlite` se corrompe ou bórrase por erro, hoxe
non hai forma de recuperala salvo o historial de git (que só ten o que se
fixo commit). Recoméndase, xa en local e independentemente do calendario de
Cloudflare, engadir un `cp data/db/coplas.sqlite data/backups/coplas-$(date
+%Y%m%d).sqlite` (ou equivalente) ao fluxo de publicación descrito en
`docs/uso-local.md`. Isto queda anotado tamén como pendente en
`docs/arquitectura-cloudflare.md`.

## 14. Tests e comprobacións existentes

Executados nesta auditoría, ambos os dous en verde:

```
python3 tools/admin.py check     → "Comprobación correcta: sen problemas."
node tools/smoke_frontend.mjs    → "frontend smoke ok"
```

Non hai suite de tests automatizados alén destes dous (sen pytest, sen
Jest/Vitest). Non se engadiron tests novos nesta iteración por non estar
pedido explicitamente, pero é un oco real: ningún dos exportadores,
importadores nin validadores ten cobertura automatizada máis alá do smoke
test de navegación do frontend e do `check` de integridade. Queda anotado
como pendente de fase 2.
