# Fol e ar · Cloudflare (Worker + D1)

Aquí vive a produción: un **Worker** que serve o frontend (Static Assets) e a API, e unha base **D1**. Para a visión xeral ver o `README.md` da raíz; para operar (desprega, copias, volver atrás) `docs/operacion.md`.

## O que hai

```text
infra/cloudflare/
├── wrangler.toml.example   # modelo de configuración (copiar a wrangler.toml, que non se sube a git)
├── .dev.vars.example       # modelo de variables locais (copiar a .dev.vars)
├── package.json            # wrangler, illado do resto do repo
├── migrations/             # 0001..0009, aditivas (ver táboa)
├── seed/                   # xerado por scripts/export_sqlite_to_d1.py (carga inicial)
├── scripts/
│   ├── export_sqlite_to_d1.py    # SQLite (só lectura) -> SQL de seed
│   ├── verify_migration.py       # verifica recontos e integridade do seed
│   └── baseline_migrations.sql   # marca 0001-0005 como aplicadas (unha vez)
└── src/worker.js           # API: lectura (exports), escritura, login, perfís, pezas, PDF
```

## Rutas principais do Worker

- Lectura pública: `GET /data/exports/{territorios,coplas,media,melodias,pezas}/*.json` (caché por versión con ETag), `GET /api/territories`, `GET /api/coplas`, `GET /api/people`, `GET /api/link-preview`, `GET /api/pdf-proxy` (só para PDFs rexistrados na media).
- Escritura do arquivo (guía/admin): `POST|DELETE /api/coplas`, `/api/media`, `/api/melodies`, `POST /api/territory-traits`.
- Conta (calquera rol): `/api/auth/*`, `/api/me/*` (perfil, favoritos, seguimentos), `/api/pieces*` (pezas persoais).
- PDF (con sesión): `GET /api/pieces/:id/pdf`, `POST /api/pdf/piece-draft`, `GET /api/territories/:id/pdf`.
- Todo o demais cae no binding `ASSETS` (`frontend/`).

## Migracións

| Ficheiro | Contido |
|---|---|
| `0001_init.sql` | esquema base (territorios, coplas, versións, etiquetas, media, pezas...) |
| `0002_melodies.sql` | inventario de melodías |
| `0003_users.sql` | contas e sesións (login con Google) |
| `0004_profiles.sql` | perfís, favoritos e `site_meta.data_version` (caché) |
| `0005_pieces_and_follows.sql` | dona e visibilidade das pezas, seguimentos (**non idempotente**) |
| `0006_piece_links.sql` | ligazóns externas nas pezas |
| `0007_pdf_usage.sql` | contador diario de PDFs por persoa |
| `0008_piece_resources_in_media.sql` | os recursos das pezas pasan a Media (dona, visibilidade, peza) e copia as ligazóns de `piece_links` |
| `0009_lugar.sql` | «lugar» (subdivisión dunha parroquia) como texto libre en coplas e pezas |

Aplícanse con `npx wrangler d1 migrations apply fol-e-ar-db --remote` (despois de executar unha vez `scripts/baseline_migrations.sql`; ver `docs/operacion.md`). Cada migración nova é un ficheiro `NNNN_nome.sql`, aditivo.

## Fluxo local (sen conta de Cloudflare)

1. Instalar wrangler illado neste directorio:

   ```bash
   cd infra/cloudflare
   npm install
   ```

2. Copiar os modelos:

   ```bash
   cp wrangler.toml.example wrangler.toml
   cp .dev.vars.example .dev.vars
   ```

   Para desenvolvemento **local** con `--local`, os `database_id` de
   `wrangler.toml` poden quedar co valor de exemplo: `wrangler d1` en modo
   `--local` crea unha base SQLite propia en `.wrangler/state/` a partir do
   `database_name`, sen necesidade dunha conta real. Os IDs reais só fan
   falla para `--remote` (preview/produción).

3. Xerar (ou rexenerar) o seed desde a SQLite real, sen tocala:

   ```bash
   cd ../..   # raíz do repo
   python3 infra/cloudflare/scripts/export_sqlite_to_d1.py
   python3 infra/cloudflare/scripts/verify_migration.py
   ```

   O segundo script ten que rematar con `Verificación local OK`. Se atopa
   filas orfas na SQLite orixe (integridade referencial xa rota antes desta
   auditoría), lístaas e exclúeas do seed, pero nunca escribe na SQLite.

4. Cargar o esquema e os datos nunha D1 local:

   ```bash
   cd infra/cloudflare
   npx wrangler d1 migrations apply fol-e-ar-db --local
   for f in seed/*.sql; do
     npx wrangler d1 execute fol-e-ar-db --local --file="$f"
   done
   ```

5. Arrincar o Worker en local:

   ```bash
   npx wrangler dev
   ```

   Isto serve `frontend/` (binding `ASSETS`) máis todos os endpoints de
   lectura e escritura descritos en "Estado actual", contra a D1 local,
   sen tocar `./serve.sh` nin o backend Python existente, que seguen
   funcionando exactamente igual. Abre `http://localhost:8787/` (ou o porto
   que indique a terminal) para ver o sitio real, xa lendo e escribindo
   contra D1.

## Contornos

| Contorno   | Como se executa               | D1                        | Notas |
|------------|--------------------------------|----------------------------|-------|
| Local      | `wrangler dev` (`--local`)     | SQLite local en `.wrangler/state/` | sen conta de Cloudflare |
| Preview    | `wrangler deploy --env preview`| `fol-e-ar-db-preview`      | unha D1 real de proba, illada da de produción |
| Produción  | `wrangler deploy`              | `fol-e-ar-db`              | require conta e créditos de Cloudflare |

## Acceso e secrets

A consulta é pública. As escrituras e os PDFs requiren login con Google (ver
a sección seguinte). Non hai contrasinal compartido: o antigo
`SITE_PASSWORD` (HTTP Basic) quitouse do código. Se ese secret aínda existe na
conta, pódese borrar sen risco: `npx wrangler secret delete SITE_PASSWORD`.

Os secrets viven só en Wrangler (`npx wrangler secret put NOME`), nunca en
`wrangler.toml` nin en `.dev.vars` con valores reais (ambos quedan fóra de git):

| Nome | Tipo | Para que |
|---|---|---|
| `GOOGLE_CLIENT_ID` | variable (`[vars]`) | login con Google |
| `GOOGLE_CLIENT_SECRET` | secret | login con Google |
| `ADMIN_EMAILS` | variable (`[vars]`) | contas sempre admin |
| `BROWSER_RUN_API_TOKEN` | secret | xerar PDFs (Cloudflare Browser Run) |
| `CLOUDFLARE_ACCOUNT_ID` | variable (`[vars]`) | xerar PDFs |

## Usuarias e roles (login con Google)

A plataforma pódese **consultar libremente**, coma unha wikipedia. Para
xerar PDFs fai falla entrar con Google (calquera rol; tope de 15 PDFs/día por
persoa, `0007_pdf_usage.sql`). Para escribir fai falla entrar con Google e ter rol **guía** ou **admin**:

| Rol | Que pode facer |
|---|---|
| visitante (sen entrar) | consultar todo (os PDFs piden login) |
| `foleante` | consultar, ter perfil, pezas persoais, favoritos e **xerar PDFs** (rol por defecto de quen entra por primeira vez) |
| `guia` | dar de alta, editar e borrar coplas, recursos e melodías |
| `admin` | o mesmo ca guía + ver a lista de persoas e cambiar roles (botón «Persoas») |

As contas listadas en `ADMIN_EMAILS` son **sempre admin** ao entrar (non se
poden baixar desde a interface). O resto entra coma `foleante` e unha persoa
admin promóveas a `guia` desde «Persoas».

Implementación (`src/worker.js`, bloque «Identidade e roles»): fluxo OAuth 2.0
«authorization code» con Google; a sesión é un token aleatorio nunha cookie
`folear_session` (HttpOnly, SameSite=Lax, Secure en https) e en D1 só se
garda o seu hash SHA-256 (táboas `users` e `sessions`, migración
`0003_users.sql`). As peticións que escriben comproban ademais que a cabeceira
`Origin` coincida co sitio (defensa CSRF). No navegador, `frontend/js/auth.js`
só mostra/agocha botóns; quen manda é sempre o servidor.

### Posta en marcha

1. **Google Cloud** (gratis): crear proxecto → «Google Auth Platform» →
   pantalla de consentimento (Externa, nome «Fol e ar», dominio autorizado
   `folear.gal`, ámbitos `openid`, `email`, `profile`; publicar en
   «Produción» para que non quede limitada a usuarias de proba) →
   Credenciais → ID de cliente OAuth → «Aplicación web» → URIs de
   redirección autorizados:
   - `https://folear.gal/api/auth/google/callback`
   - `https://fol-e-ar-api.<subdominio>.workers.dev/api/auth/google/callback` (proba)
   - `http://localhost:8787/api/auth/google/callback` (só para `wrangler dev`)
2. En `wrangler.toml` (non se sube a git) engadir en `[vars]`:
   `GOOGLE_CLIENT_ID = "...apps.googleusercontent.com"` e
   `ADMIN_EMAILS = "folear3@gmail.com"` (varias separadas por comas).
3. `npx wrangler secret put GOOGLE_CLIENT_SECRET`
4. Aplicar as migracións na D1 remota: `npx wrangler d1 migrations apply fol-e-ar-db --remote`
5. `npx wrangler deploy`

### Modos (`GET /api/auth/me` devolve o activo)

- `google`: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` presentes. Modo normal.
- `unconfigured`: sen credenciais de Google. **Escritura pechada** (falla
  pechado); a consulta segue aberta.
- `open`: `AUTH_DISABLED = "true"`. Sen login, calquera pode escribir. Só para
  desenvolvemento.
- En local (`tools/local_server.py`) non hai login: a persoa é sempre admin.

### Perfís, favoritos e caché (migración 0004)

Migración aditiva `migrations/0004_profiles.sql` (non borra nada): táboas
`profiles`, `favorites` e `site_meta`.

- **O meu espazo** (`frontend/js/profile.js`): nome que se amosa, username,
  lugar (concello/parroquia/comarca), presentación, perfil público
  (desactivado por defecto) e favoritos de coplas e lugares. A API (`/api/me/*`)
  só deixa tocar o que é da propia persoa; calquera persoa con sesión pode usala
  (tamén os foleantes). O correo e a foto de Google non saen en ningunha ruta
  pública.
- **Persoas**: `GET /api/people` (directorio) e `GET /api/people/<username>`
  só devolven perfís con `is_public = 1`; os favoritos só se se activou
  «amosar os meus favoritos». Hai un botón para borrar a conta (`POST
  /api/me/delete`).
- `frontend/privacidade.html` é a política de privacidade (ligada desde o
  menú; desde a fase 3, no pé de «Sobre o arquivo», que a le e a amosa dentro
  da aplicación, e no perfil). Revísase cando cambie o tratamento de datos.
- A migración 0004 tamén crea `site_meta.data_version`. Sube con cada escritura
  de coplas, recursos e melodías e permite **cachear os exportes públicos**
  (`/data/exports/*.json`): ETag por versión (o navegador recibe 304 sen
  consultar a base) e caché do bordo de Cloudflare por versión (só funciona co
  dominio propio, non en `workers.dev`). Sen a migración, os exportes
  calcúlanse sempre coma antes.

### Pezas con dona, visibilidade e seguimentos (migración 0005)

Migración aditiva `migrations/0005_pieces_and_follows.sql`: engade
`owner_user_id` e `visibility` a `pieces` (as pezas que xa existen quedan
**públicas e sen dona**, é dicir, editoriais) e crea a táboa `follows`. Os
`ALTER TABLE` non son idempotentes: **aplícase unha soa vez**, e o rexistro de
migracións (`d1_migrations`) encárgase diso.

- **Gardar unha peza require conta** (`POST /api/pieces` devolve 401 sen
  sesión). Sen conta pódese compoñer no obradoiro (o borrador vive no navegador);
  exportar a PDF (`/api/pdf/piece-draft`) require sesión.
- Cada peza é `private` (só a dona) ou `public` (biblioteca). O exporte público
  `/data/exports/pezas/pezas.json` (cacheado por versión) só leva as públicas e
  non agochadas; `GET /api/me/pieces` devolve as da persoa.
  O PDF dunha peza privada só o pode pedir a súa dona.
- Calquera conta publica directamente. Unha persoa guía/admin pode **agochar**
  unha peza pública (`POST /api/pieces/moderate`; a dona segue vendoa) e ver as
  agochadas (`GET /api/pieces/hidden`). A dona edita (`POST /api/pieces` con
  `id`), cambia a visibilidade (`/api/pieces/visibility`) e borra
  (`DELETE /api/pieces`). Admin pode xestionar calquera; as pezas editoriais
  (sen dona) xestiónanas guías e admin.
- O nome da dona só se amosa nunha peza pública se o seu perfil é público.
- Seguir persoas: `GET/POST /api/me/follows` (só perfís públicos; a lista é
  privada). Favoritos tamén de pezas.
- Borrar a conta elimina tamén as pezas da persoa, os seus seguimentos e os
  favoritos que apuntaban a elas. Límites: 200 pezas por persoa e 300 coplas
  por peza.
- Sen a 0005 a web segue funcionando: as pezas existentes saen como públicas e
  gardar devolve un erro claro que pide aplicar a migración.

### Fichas de autoría e ligazóns nas pezas (migración 0006)

Migración aditiva e **idempotente** `migrations/0006_piece_links.sql`: crea a
táboa `piece_links` (ata 10 ligazóns externas por peza: título + URL).

- Unha peza pode ser unha selección de coplas ou un arranxo dun grupo, artista
  ou persoa: o campo «Autoría» é texto libre. A web agrupa as autorías sen ter
  en conta maiúsculas nin acentos e cada unha ten ficha en `#/autoria/<nome>`
  coas súas pezas públicas, as ligazóns e os recursos de media ligados ás pezas.
- As ligazóns viven coa peza (privada ⇒ ligazóns privadas; se se borra, bórranse)
  e non entran no inventario público de media. Só aceptan `http(s)://`.
- Sen a 0006 a web segue funcionando; gardar unha peza con ligazóns devolve un
  erro claro que pide aplicar a migración.

### Recursos das pezas en Media (migración 0008)

Migración aditiva `migrations/0008_piece_resources_in_media.sql`: engade a `media` as
columnas `owner_user_id`, `visibility` (`public`|`private`) e `piece_id`, e copia as
ligazóns que xa había en `piece_links` (a táboa queda como está; non se borra nada).

- Cada recurso dunha peza é unha fila de **Media** con datos completos (título, plataforma,
  tipo, uso, fonte, descrición, miniatura) e unha ligazón `piece` en `media_links` cuxo
  `relation_type` garda o uso (`documental`, `melody` ou `mixed`).
- Segue a peza: pública ⇒ sae en `/data/exports/media/media.json`; privada ou agochada ⇒
  só a dona a ve, vía `GET /api/me/media` (a web une as dúas listas). Publicar ou facer
  privada a peza muda tamén os seus recursos; borrar a peza borra os seus recursos.
- Gárdanse coa peza (`links` en `POST /api/pieces`) ou soltos con
  `POST /api/pieces/resources {id, links}` (lista completa; os que xa estaban conservan o
  seu id e favoritos). Máximo 10 por peza, só `http(s)://`.
- O formulario do obradoiro e o da ficha da peza son os mesmos que «Novo recurso»:
  URL + «Obter datos» (`GET /api/link-preview`, agora aberto a calquera conta con sesión).
- Sen a 0008 a web segue funcionando coas ligazóns antigas; gardar recursos devolve un erro
  claro que pide aplicar a migración.
- **Ligados ao territorio e ás coplas da peza**: ao gardar, cada recurso leva tamén ligazóns
  `territory` (o territorio de contexto da peza) e `copla` (as coplas do arquivo que a forman)
  en `media_links`, con `relation_type='piece'` (marca de ligazón automática: refánse con
  cada gardado da peza, ao dar de alta as súas coplas e ao cambiar o seu territorio; as que
  un guía edite a man en Media pasan a ser súas e xa non se tocan).
- **Editar e borrar desde Media** (`POST`/`DELETE /api/media`): guías e admin xestionan os
  recursos públicos (os privados, só a súa dona ou admin) e a dona dun recurso de peza
  edita os seus datos (título, URL, tipo, uso, fonte...) e bórrao ela mesma; non pode crear
  Media nova nin tocar a doutra persoa (403). Borrar un recurso desvincúlao de todo (peza,
  territorios, coplas, melodías e favoritos). O tipo `web` é un recurso máis.

### Lugares e alta automática das coplas das pezas (migración 0009)

Migración aditiva `migrations/0009_lugar.sql`: columna `lugar` (texto, nula) en `coplas` e `pieces`.

- **Lugar** = subdivisión dunha parroquia que non existe como territorio (ex.: «Laxoso», en
  Ponte Caldelas). Escríbese como texto libre e queda ligado á parroquia da copla ou da peza;
  o formulario suxire os lugares xa usados nesa parroquia (para non duplicar «Laxoso» e
  «laxoso»). Sae diante do territorio («Laxoso, Ponte Caldelas (...)») e entra na busca.
  Local: o `db.py` engade a columna de forma defensiva (`009_lugar`).
- **Publicar pezas na biblioteca é cousa de guías e admin** (`403` para unha foleante; unha
  foleante garda pezas privadas). Unha peza pública que xa existise segue pública.
- **Alta automática**: ao gardar unha peza, se quen garda é guía/admin, as coplas soltas (sen
  `copla_id`) dan de alta no arquivo co territorio e o lugar da peza (a volta, coma volta). Se xa
  hai unha copla co mesmo texto non se duplica: úsase e, se non ten o territorio da peza,
  engádeselle. Así «Lira (Santa María)» xa non pode ter unha peza e 0 coplas.
  `POST /api/pieces/register-coplas {id}` fai o mesmo cunha peza xa gardada (botón «Dar de alta
  as coplas no arquivo» na ficha). As coplas soltas dunha foleante non entran no arquivo.
- Sen a 0009 a web segue funcionando, só que o lugar non se garda.

### Escalabilidade (plan gratuíto)

Límites do plan gratuíto de Cloudflare (mirar a documentación oficial antes de
confiar en cifras): Workers 100.000 peticións/día e 10 ms de CPU por petición;
D1 5 millóns de filas lidas/día, 100.000 escritas/día e 5 GB. Os ficheiros
estáticos do frontend non gastan peticións de Worker. O custo que importaba
eran os exportes (milleiros de filas por visita); coa caché por versión unha
visita nova adoita gastar unhas poucas filas, así que a cota non é un problema
para centos de persoas ao día. Se un día se superase, o plan de pago de
Workers custa uns poucos dólares ao mes e non require cambiar código.

## Xeración de PDF

Pezas e territorios pódense exportar a PDF dende o propio Worker, usando
**Cloudflare Browser Run** (o "Quick Action" `/pdf` da API REST, gratuíto
no plan Free: 10 minutos de navegador/día, 3 navegadores concorrentes).
O Worker constrúe o mesmo HTML que xerarían `backend/services/pdf/renderer.py`
+ `documents.py` en local (mesmas consultas, mesmo `print.css` incrustado)
e mándao por `fetch()` a:

```
POST https://api.cloudflare.com/client/v4/accounts/<CLOUDFLARE_ACCOUNT_ID>/browser-run/pdf
Authorization: Bearer <BROWSER_RUN_API_TOKEN>
```

Rutas do Worker (mesmos camiños que en local, ver `tools/local_server.py`). **Todas piden sesión** (`requirePdfViewer`): gastan a cota gratuíta de Browser Run, así que hai ademais un tope de 15 PDFs por persoa e día (táboa `pdf_usage`, migración 0007; as contas admin non teñen tope):

- `GET /api/pieces/:id/pdf`
- `POST /api/pdf/piece-draft`
- `GET /api/territories/:id/pdf`

Para activalo hai que:

1. Crear un API Token na conta de Cloudflare (dashboard → **My Profile** →
   **API Tokens** → **Create Token**) co permiso **"Browser Rendering -
   Edit"** para a conta `fol-e-ar`.
2. Gardalo coma secret do Worker:
   ```bash
   npx wrangler secret put BROWSER_RUN_API_TOKEN
   ```
3. Confirmar que `wrangler.toml` ten `CLOUDFLARE_ACCOUNT_ID` en `[vars]`
   (xa está posto). Non é un secret, é só o identificador da conta.
4. `npx wrangler deploy`.

Se falta o token ou o `CLOUDFLARE_ACCOUNT_ID`, as rutas de PDF devolven un
erro claro explicando que falta configurar, en vez de fallar en seco.

## Pendente / ideas

- Formulario público «Enviar unha copla» con revisión (`POST /api/submissions`; a táboa `submissions` existe, sen uso).
- Limitar peticións nas rutas públicas de escritura (Turnstile / rate limiting) se algún día fai falla.
- Atomicidade parcial: unha copla escríbese con varias operacións secuenciais; un payload con varias coplas non é unha soa transacción. Para o uso real (unha copla ou un lote pequeno desde a web) non é un problema.
