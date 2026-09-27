# Arquitectura de destino · Fol e ar en Cloudflare

Complementa `docs/auditoria-tecnica.md` (o diagnóstico) e
`docs/redesign-plan.md`/`docs/notes.md` (xa vixentes e correctos para o
modelo de datos actual). Este documento define a arquitectura de produción
e que parte se implementou xa en `infra/cloudflare/` nesta iteración.

**Non hai conta de Cloudflare configurada neste repositorio.** Todo o que
segue é deseño + código preparado e verificado localmente (esquema, seed,
comprobacións), non un despregamento real nin simulado.

## 1. Hipótese validada

A hipótese inicial do encargo confírmase como a correcta para este
repositorio, sen cambios de fondo:

- **Frontend + assets estáticos** → Cloudflare Workers con **Static
  Assets** (non Pages). Motivo: un único Worker pode servir `frontend/` E a
  API baixo o mesmo dominio, sen CORS entre eles, e sen manter dous
  proxectos de despregamento separados. Pages tamén serviría o estático,
  pero engadiría un segundo sistema de despregamento sen necesidade real.
- **API de lectura/escritura** → Workers (JS/TS), SQL explícito contra D1,
  igual de explícito que `backend/services/*.py` hoxe.
- **Datos relacionais** → **D1**. É SQLite: o esquema actual pasa
  practicamente literal (ver `infra/cloudflare/migrations/0001_init.sql`).
- **Ficheiros propios futuros** → **R2**. Sen uso hoxe (todo o media é
  externo por referencia, ver auditoría secc. 10), pero é o sitio correcto
  cando haxa gravacións propias.
- **KV**: **non se usa nesta fase.** Non hai ningún dato hoxe que sexa
  puramente clave/valor sen relacións (nin sequera cache: D1 xa é rápido
  dabondo para o volume actual). Engadir KV sen caso de uso sería
  complexidade sen beneficio.
- **Durable Objects**: **non se usan.** Non hai estado coordinado en tempo
  real (edición colaborativa, WebSockets) previsto nin pedido.
- **Queues**: **non se usan aínda.** O único candidato razoable sería
  procesar achegas públicas de forma asíncrona, pero co volume actual unha
  fila síncrona (INSERT directo en `submissions`, ver secc. 4) chega e é
  máis simple de operar. Queda anotado como posible fase 3 se o volume de
  achegas medra moito.
- **Turnstile**: previsto para o formulario público "Enviar unha copla" (a
  única ruta de escritura verdadeiramente pública). Non implementado aínda
  en código (require conta de Cloudflare para as claves), pero o esquema
  (`submissions`) e o deseño de API xa contan con el.

Ningunha destas decisións é definitiva de forma irreversible: D1, R2 e
Workers pódense adoptar de forma incremental sen romper o fluxo local
actual (secc. 6).

## 2. Fluxo de datos

```
                    ┌─────────────────────────┐
                    │   data/db/coplas.sqlite  │   ← fonte canónica hoxe
                    │  (SQLite, fonte única)   │
                    └───────────┬──────────────┘
                                │ tools/admin.py / API local
                                │ (import_* + export_web)
                                ▼
                    ┌─────────────────────────┐
                    │   data/exports/*.json    │   ← capa de publicación
                    └───────────┬──────────────┘      actual (GitHub Pages)
                                │
                                ▼
                    ┌─────────────────────────┐
                    │  frontend/ (estático)     │
                    └─────────────────────────┘

──────────────────── transición (este documento) ────────────────────

                    ┌─────────────────────────┐
                    │   data/db/coplas.sqlite  │   ← segue sendo recuperable
                    │  (sen tocar, ver secc.5) │      ata validar D1
                    └───────────┬──────────────┘
                                │ infra/cloudflare/scripts/
                                │ export_sqlite_to_d1.py (unha vez)
                                ▼
                    ┌─────────────────────────┐
                    │   Cloudflare D1 (fol-e-ar-db)   │  ← nova fonte canónica
                    └───────────┬──────────────┘       en produción, unha vez
                                │                        validada (secc. 5)
                    Worker (infra/cloudflare/src/worker.js)
                                │
                    ┌───────────┴──────────────┐
                    ▼                           ▼
        Static Assets (frontend/)      API JSON (/api/*)
                    │                           │
                    └─────────────┬─────────────┘
                                  ▼
                          folear.gal (futuro)
```

Punto clave: **mentres D1 non estea validada, `data/db/coplas.sqlite` segue
sendo a única fonte de verdade**, e o fluxo local actual (`./serve.sh`,
`tools/admin.py`) segue funcionando exactamente igual — nada nesta
iteración o rompe nin depende del.

## 3. Modelo de datos: axustes propostos

O esquema actual (post `002_curation`, `003_territory_state`,
`004_copla_versions`) xa cobre a inmensa maioría do que pide o encargo:
copla + variantes (`copla_versions`), territorios múltiples
(`copla_territories`), tipo de relación (`relation_type`), coplas
xerais/sen clasificar (`territory_state`), pezas con orde explícita e
repetición permitida (`piece_coplas`, PK por `position` non por
`copla_id`), fontes/autoría de pezas (`pieces.author`), media documental
(`media` + `media_links` xenérico por `entity_type`).

**Cambio imprescindible xa feito** (`infra/cloudflare/migrations/0001_init.sql`):
engadir `submissions` — é o único bloque que faltaba para poder cumprir a
regra explícita do encargo: *"O formulario público 'Enviar unha copla' non
debe escribir directamente no corpus publicado"*. Sen esta táboa (ou
equivalente) non hai onde poñer as achegas pendentes de revisión.

**Cambios documentados pero NON implementados aínda** (deliberadamente, por
non ser imprescindibles agora — mesmo criterio que
`docs/redesign-plan.md` secc. 11):

- `deleted_at` (borrado lóxico) en `coplas` e `media`, útil unha vez haxa
  achegas públicas que se poidan rexeitar despois de xa estar publicadas.
- Verificación de FK `copla_tags → coplas` en `run_checks()` (ver auditoría
  secc. 5).
- Tres columnas específicas en `media_links` en troques de `entity_id TEXT`
  xenérico, só se algunha vez o volume xustifica índices por tipo.
- `owner_id` en `pieces`/`coplas`, só cando exista autenticación de usuarios
  final (non administración) real.

## 4. Migración desde SQLite: como se fixo e como se repite

Implementado e **executado nesta auditoría** contra a SQLite real (en modo
`read-only`, sen escribir nela):

```bash
python3 infra/cloudflare/scripts/export_sqlite_to_d1.py
python3 infra/cloudflare/scripts/verify_migration.py
```

Resultado real desta execución (ver `infra/cloudflare/seed/_manifest.json`
para o detalle completo):

| Táboa | Orixe | Exportadas | Excluídas |
|---|---|---|---|
| territories | 4155 | 4155 | 0 |
| tags | 7 | 7 | 0 |
| coplas | 5 | 5 | 0 |
| copla_versions | 0 | 0 | 0 |
| copla_tags | 10 | 8 | **2** |
| copla_territories | 5 | 5 | 0 |
| pieces | 0 | 0 | 0 |
| piece_coplas | 0 | 0 | 0 |
| media | 3 | 3 | 0 |
| media_links | 3 | 3 | 0 |

`verify_migration.py` rematou con **"Verificación local OK"**. As 2 filas
excluídas de `copla_tags` son as mesmas 2 filas orfas xa identificadas na
auditoría técnica (secc. 5 alí) — existían antes desta migración, non as
creou nin as tocou; simplemente non se copian ao seed para non romper a
carga en D1 con `PRAGMA foreign_keys = ON`.

**Preservación garantida**: os IDs orixinais (`INSERT INTO ... (id, ...)
VALUES (...)` explícito), Unicode (escritura UTF-8 directa, sen
normalización), e as repeticións dentro de pezas (`piece_coplas` non
deduplica por deseño — a PK é `(piece_id, position)`, non
`(piece_id, copla_id)`).

**Rollback / recuperación**: como D1 aínda non ten datos reais de
produción, o "rollback" nesta fase é trivial — bórrase a base D1 e
repítese a carga desde o seed, que por súa vez se rexenera sempre desde
`data/db/coplas.sqlite`. Unha vez D1 sexa fonte de verdade en produción
(secc. seguinte), o rollback pasa a ser: `wrangler d1 export` (exportación
nativa de D1 a SQL) como backup regular, máis a posibilidade de
reexportar a JSON abertos en calquera momento (D1 segue sendo SQL
estándar).

**Cando D1 pasa a ser a fonte de verdade**: só despois de (a) ter conta de
Cloudflare real, (b) cargar e verificar en `--remote` igual que se fixo en
local, (c) decidir e implementar como as escrituras futuras (API de
administración) escriben en D1 en vez de (ou ademais de) SQLite durante un
período de transición curto, e (d) confirmar que os exports JSON públicos
seguen sendo válidos xerándoos desde D1. **Non se recomenda manter as dúas
fontes escribibles a a vez máis aló dese período curto de validación** —
iso é exactamente o risco de diverxencia que o encargo pide evitar.

## 5. API e seguridade

Implementado nesta iteración (`infra/cloudflare/src/worker.js`), **só
lectura**, como punto de partida:

```
GET /api/territories        (equivalente a data/exports/territorios/territorios.json)
GET /api/coplas?territory_id=&limit=&offset=
```

Con CORS restrinxido por `ALLOWED_ORIGIN` (nunca `*` en produción), erros
consistentes en JSON (`{ ok: false, error }`), e paginación básica en
`/api/coplas` (límite 1–200, por defecto 50) — o export estático actual non
pagina porque só hai 5 coplas de proba; en produción cun corpus real,
paginar é obrigatorio.

**Pendente para fase 2** (documentado aquí, non implementado por non ser
seguro nin razoable sen conta de Cloudflare para probalo):

- Autenticación de administración (`ADMIN_TOKEN` como mínimo viable —
  cabeceira `Authorization: Bearer`, comparación en tempo constante; OAuth
  ou Cloudflare Access como evolución) para `POST /api/coplas`,
  `POST /api/pieces`, `POST /api/media` equivalentes aos que hoxe existen
  en `tools/local_server.py` sen protección ningunha.
- `POST /api/submissions`: única ruta de escritura pública, sen
  autenticación pero con Turnstile + rate limiting (por IP, ventá curta),
  validación estrita de payload (mesmas regras que
  `importers.py::validate_coplas_payload`, reutilizables case a case), e
  sanitización de texto libre antes de gardar.
- Endpoints de administración para revisar `submissions` (aprobar → INSERT
  en `coplas` real; rexeitar → marcar `status = 'rejected'`).
- `GET /api/link-preview` reimplementado con allowlist de esquema e
  verificación de IP resolta (ver auditoría secc. 12) antes de facer
  `fetch()` — nunca portar o código Python tal cal.
- Transaccións explícitas nas escrituras que tocan varias táboas (D1
  soporta `batch()` para agrupar statements atomicamente; hoxe
  `importers.py` confía no `conn.commit()` único de SQLite, que hai que
  reproducir explicitamente en D1).
- Límites de tamaño de payload (hoxe non hai ningún límite explícito nin en
  Python nin estaría en Workers por defecto).
- CORS "só cando sexa necesario": as rutas GET públicas poden ser abertas
  (`ALLOWED_ORIGIN` do dominio propio abonda); as rutas de administración
  non precisan CORS ningún se só se chaman desde o mesmo dominio.

## 6. PDF: estratexia explícita

`backend/services/pdf/renderer.py` (Chrome/Chromium headless local vía
`subprocess`) **non se pode portar a un Worker** (sen procesos, sen
sistema de ficheiros persistente). Tres opcións reais, e a decisión:

1. **Manter o PDF como capacidade local/admin** (a que xa existe hoxe,
   documentada en `docs/uso-local.md`) — segue funcionando exactamente
   igual que agora, sen cambios. É a opción por defecto nesta fase.
2. **Cloudflare Browser Rendering** (Chromium xestionado por Cloudflare,
   accesible desde un Worker) — candidata natural para fase 2, porque o
   HTML e CSS de impresión xa existen e están illados
   (`backend/services/pdf/templates/`, `backend/services/pdf/styles/print.css`)
   e reutilizaríanse case sen cambios; só cambiaría quen lanza o navegador.
   Require conta de Cloudflare co produto activado para validar límites
   reais (tempo de execución, concorrencia).
3. **Servizo especializado externo**, se Browser Rendering non chega
   (límites de tempo/tamaño para pezas moi longas).

**Decisión desta iteración**: opción 1 (manter local/admin), documentando
2 como o camiño natural de fase 2. **A aplicación pública non debe amosar
un botón de PDF aparentemente funcional** quen se sirva desde Cloudflare
sen Browser Rendering activado — o Worker de fase 2 ten que devolver un
erro claro (`501` ou similar) en vez de fallar en silencio, ou o frontend
debe ocultar/desactivar ese botón cando a API indique que a capacidade non
está dispoñible no contorno.

## 7. Media

Modelo xa correcto para isto (ver auditoría secc. 10): `media.provider` +
`media.media_kind` distinguen provedor/formato, `media_links.entity_type`
distingue territorio/copla/peza, e un mesmo recurso pode ter varios roles
(varias filas en `media_links` para o mesmo `media_id`) sen duplicar a fila
de `media`. Isto xa cumpre "un recurso pode ter varios roles e relacións,
sen duplicarse".

Para ficheiros propios futuros (R2, aínda sen uso real):

- **Almacenamento**: bucket `fol-e-ar-media` (ver
  `infra/cloudflare/wrangler.toml.example`), separado do bucket de preview.
- **Límites**: tamaño máximo por ficheiro a decidir segundo tipo (proposta:
  20 MB para audio, 200 MB para vídeo — a validar cando haxa casos reais).
- **Tipos MIME permitidos**: allowlist estrita (`audio/mpeg`, `audio/wav`,
  `video/mp4`, `image/jpeg`, `image/png`, `image/webp`), rexeitando
  calquera outro no propio Worker antes de subir a R2.
- **Nomes seguros**: nunca o nome orixinal do ficheiro subido; xerar un
  identificador (UUID ou hash de contido) + extensión validada contra o
  MIME real (non contra o nome).
- **Metadatos**: gardados en `media` (xa ten `title`, `description`,
  `author_or_source`); engadir `r2_key`, `mime_type`, `size_bytes` cando se
  implemente.
- **Acceso público/privado**: por defecto público (é un arquivo público),
  cun futuro flag privado se algunha vez fai falta contido restrinxido.
- **Eliminación**: borrado do obxecto en R2 + fila de `media` (ou borrado
  lóxico, ver secc. 3) na mesma operación.
- **Custos/abuso**: límite de tamaño + Turnstile na subida pública (se
  algunha vez se permite subida pública; hoxe non está pedida) +
  rate limiting por IP.

**Non se descarga nin republica material de terceiros** — isto xa se cumpre
hoxe (todo é referencia externa) e o deseño de R2 non o cambia.

## 8. Despregamento e dominio

| Elemento | Estado |
|---|---|
| Desenvolvemento local | Preparado e probado (`infra/cloudflare/README.md`) |
| Preview por rama/PR | Deseñado (`[env.preview]` en `wrangler.toml.example`), non probado (sen conta) |
| Produción | Deseñada, non despregada |
| Migracións D1 | Preparadas e verificadas en local (`migrations/`, `seed/`) |
| Bindings R2 | Declarados no exemplo, sen uso real aínda |
| Despregamento automatizado (CI) | Non implementado nesta iteración — ver nota abaixo |
| Dominio `folear.gal` | Non comprado nin configurado (fóra do alcance sen conta) |

**CI**: hoxe `.github/workflows/pages.yml` despraga a GitHub Pages en cada
push a `main`. Non se tocou. Cando exista conta de Cloudflare, o camiño
natural é un segundo workflow (`.github/workflows/cloudflare.yml`, non
creado aínda por non poder probalo sen credenciais) que faga `wrangler
deploy` en `main` e `wrangler deploy --env preview` en PRs, gardando
`CLOUDFLARE_API_TOKEN` como secret de GitHub — nunca no repositorio.

**Dominio e redes** (todo pendente, require conta):
- `folear.gal` apuntando ao Worker (ou a Cloudflare Pages, segundo se
  confirme a decisión da secc. 1) vía DNS xestionado por Cloudflare.
- Redirección de `www.folear.gal` → `folear.gal` (ou ao revés, a decidir).
- HTTPS automático (Cloudflare xestiona os certificados).
- Cabeceiras de seguridade mínimas a engadir no Worker:
  `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- Caché: os JSON de `data/exports/` e os GeoJSON/TopoJSON son ideais para
  caché longa con invalidación por versión (engadir un parámetro de versión
  ou hash ao nome/query, como xa fai `frontend/js/api.js` con
  `cacheVersion` para o caso local).

## 9. Criterios de aceptación — estado

- Interface conserva todos os fluxos actuais: **si**, non se tocou
  JS/HTML, só CSS (ver máis abaixo) e ficheiros novos en `infra/`.
- Mapa segue cargando e sendo navegable: **si** (non tocado; verificado
  servindo `./serve.sh` e comprobando `200` en `frontend/pages/mapa.html`
  e nos catro JSON de export).
- Coplas, Territorios, Pezas, Media funcionan: **si** (código non tocado;
  smoke test de navegación en verde).
- Accesibilidade por teclado: **mellorada, non empeorada** — engadíronse
  estados `:focus-visible` explícitos que antes non existían en boa parte
  dos controis (ver a continuación).
- Corpus non modificado: **verificado** — `data/db/coplas.sqlite` abriuse
  sempre en modo `read-only` (`file:...?mode=ro`) durante a exportación a
  D1; hash do ficheiro comprobado antes/despois desta auditoría.
- SQLite segue abrindo correctamente: **si** (`PRAGMA integrity_check` =
  `ok`, `tools/admin.py check` en verde).
- Exports existentes seguen válidos: **si** (non se rexeneraron; non se
  tocou `data/exports/`).
- Migración de proba conserva IDs e relacións: **si**, ver secc. 4.
- Repeticións dunha copla nunha peza consérvanse: **si por deseño** (PK de
  `piece_coplas` e do seed é `position`, non `copla_id`; hoxe non hai pezas
  reais para probalo empiricamente, pero o esquema e o exportador non
  deduplican en ningún punto).
- Caracteres galegos/Unicode: **si**, exportados e verificados (os textos
  de territorios con diacríticos e o corpus de coplas de proba manteñen
  UTF-8 correcto no seed xerado).

## 10. Mellora visual desta iteración (resumo)

Aplicada directamente en `frontend/css/style.css`, sen tocar HTML nin JS:

- Tokens centralizados: engadíronse `--font-sans`, `--font-serif`,
  `--radius-sm/--radius/--radius-lg`, `--shadow-sm/--shadow/--shadow-lg`,
  `--overlay`; substituíronse ~60 valores literais repetidos (radios,
  sombras, `background: #ffffff`, familias de fonte) polos tokens
  correspondentes.
- Retirouse todo `backdrop-filter: blur(...)` (catro sitios: tarxeta do
  mapa, modal de media, visor de PDF, nav móbil) e gradientes decorativos
  (nota do creador de pezas, seccións do montador, as catro tarxetas de
  provedor de media) — substituídos por cores planas e opacidade sólida,
  seguindo a instrución explícita de evitar vidro/transparencias e
  gradientes decorativos.
- Suavizáronse as sombras máis pesadas (as de `0 30px 90px` con opacidade
  0.28 en modais/PDF pasaron ao token `--shadow-lg`, moito máis discreto).
- Reducíronse os radios de bordo grandes (14–18px → 12px consistente).
- `--muted` escureceuse lixeiramente (`#71776f` → `#5c625b`) para mellorar
  o contraste sobre fondo claro.
- Engadíronse estados `:focus-visible` explícitos (antes ausentes en boa
  parte dos formularios e controis) e áreas táctiles mínimas de 40–44px en
  botóns de icona dentro do punto de ruptura móbil (920px).

Non se tocou a paleta base (verde atlántico existente), a tipografía
(Inter + Georgia xa era unha boa elección editorial), nin a estrutura de
compoñentes — é intencionadamente unha pasada moderada, non un redeseño.

## 11. Pendente para fase 2 (lista explícita)

- Autenticación de administración real e todos os endpoints de escritura
  do Worker (pezas, media, aprobación de achegas).
- `POST /api/submissions` + Turnstile + rate limiting.
- Reimplementación segura de `/api/link-preview` (allowlist + verificación
  de IP resolta).
- Cloudflare Browser Rendering para PDF (ou confirmar que se queda en
  local/admin indefinidamente).
- R2 para ficheiros propios, cando existan gravacións propias reais.
- Despregamento real (require conta de Cloudflare): D1 remota, workflow de
  CI, dominio `folear.gal`.
- Borrado lóxico (`deleted_at`) en `coplas`/`media`.
- Verificación de FK `copla_tags → coplas` en `backend/services/checks.py`.
- Copias de seguridade automatizadas da SQLite local (ver auditoría
  secc. 13) — independente do calendario de Cloudflare.
- Tests automatizados para exportadores/importadores/validadores (hoxe só
  hai un smoke test de frontend e un `check` de integridade).
- Pantallas verdadeiramente independentes: hoxe `frontend/pages/*.html`
  son redireccións a `index.html?mode=X` (SPA), non pantallas
  autónomas reais. Non se tocou nesta iteración por ser un cambio de
  routing maior, non "moderado"; queda anotado porque o encargo pide
  explicitamente que Coplas/Pezas/Media/fichas territoriais "funcionen
  tamén como pantallas independentes".
