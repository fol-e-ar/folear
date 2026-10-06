# Fol e ar · Cloudflare (infraestrutura de produción, fase 1)

Este directorio contén a arquitectura de produción en Cloudflare descrita en
`docs/arquitectura-cloudflare.md`. É código novo e illado: **non modifica
nada do frontend nin do backend Python actuais**, e **non toca
`data/db/coplas.sqlite`** (todo o que le a SQLite real fai unha conexión de
só lectura).

Todo o que hai aquí está preparado e probado localmente (esquema, seed,
lectura e escritura completas contra unha D1 local emulada por Wrangler).
Non hai conta nin credenciais de Cloudflare configuradas neste repositorio,
así que non hai ningún despregamento real feito nin simulado.

## Estado actual (actualizado)

- **Esquema D1** (`migrations/0001_init.sql`): agora coincide co esquema real
  de `data/db/coplas.sqlite`, incluíndo `coplas.is_volta`,
  `copla_version_territories` e `territory_traits` (faltaban na primeira
  versión) e as columnas `inline_text`/`role` de `piece_coplas`.
- **Lectura** (`src/worker.js`): ademais dos 2 endpoints orixinais
  (`GET /api/territories`, `GET /api/coplas`, simplificados, de proba de
  concepto), o Worker agora serve en directo dende D1 os TRES ficheiros que
  o frontend real xa pide (`frontend/js/api.js`), coa MESMA forma aniñada
  que xera `backend/services/exporters.py`:
  - `GET /data/exports/territorios/territorios.json` (con `traits`)
  - `GET /data/exports/coplas/coplas.json` (con `territories`, `tags`,
    `versions` e as súas propias `territories` por versión)
  - `GET /data/exports/media/media.json` (con `links`)

  Todo o demais (`/`, `/js/*`, `/css/*`, `/pages/*`, `/assets/*`) cae ao
  binding `ASSETS`, é dicir, serve `frontend/` tal cal está, sen tocar nada.
- **Escritura** (`src/worker.js`): `POST /api/coplas` (crear/editar, coa
  mesma validación que `import_coplas`/`validate_coplas_payload` en Python:
  territorios, versións, etiquetas), `DELETE /api/coplas`,
  `POST /api/media` e `DELETE /api/media` (ídem con `import_media` /
  `delete_media`). O frontend xa chama a estas rutas exactas
  (`../api/coplas`, `../api/media`) para gardar e borrar, así que non fixo
  falla tocar nin unha liña de `frontend/js/archive_app.js` para isto.
- **Probado**: as catro operacións (crear copla, borrar copla, crear media,
  borrar media) e os tres exports probáronse de punta a punta contra
  `wrangler dev` en local (D1 emulada, sen conta de Cloudflare), incluíndo
  casos de erro (territorio obrigatorio, id inexistente, media sen links).
  O propio frontend (HTML/CSS/JS/geojson) tamén se comprobou servido a
  través do binding `ASSETS` do mesmo Worker.

## Que hai aquí

```text
infra/cloudflare/
├── wrangler.toml.example   # modelo de configuración (copiar a wrangler.toml)
├── .dev.vars.example       # modelo de variables locais (copiar a .dev.vars)
├── package.json            # dependencia de wrangler, illada do resto do repo
├── migrations/
│   └── 0001_init.sql       # esquema D1 completo (ver "Estado actual")
├── seed/                   # xerado por scripts/export_sqlite_to_d1.py
│   ├── 01_territories.sql … 12_territory_traits.sql
│   └── _manifest.json      # reconto de filas exportadas/excluídas por táboa
├── scripts/
│   ├── export_sqlite_to_d1.py   # SQLite (read-only) -> SQL de seed
│   └── verify_migration.py      # verifica recontos e integridade do seed
└── src/
    └── worker.js            # API completa: lectura dinámica + escritura
                              # de coplas e media (ver "Estado actual")
```

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
   npx wrangler d1 execute fol-e-ar-db --local --file=migrations/0001_init.sql
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

## Migracións futuras

Migracións novas engádense como `migrations/0002_*.sql`, `0003_*.sql`, etc.,
seguindo o mesmo patrón que `backend/schema/00N_*.sql` no proxecto Python.
`wrangler d1 migrations apply` lévalles a conta. (A migración `0001` xa
inclúe todo o esquema real coñecido a día de hoxe, ver "Estado actual".)

### 0002 · inventario de melodías

`migrations/0002_melodies.sql` crea a táboa `melodies` (espello de
`backend/schema/008_melodies.sql`). É aditiva e idempotente. Para levala á D1
de produción:

```bash
cd infra/cloudflare
npx wrangler d1 execute fol-e-ar-db --remote --file=migrations/0002_melodies.sql
npx wrangler deploy
```

Mentres a migración non estea aplicada, o Worker segue funcionando coma antes
(`melodias.json` devolve `[]`); só falla gardar melodías. Rutas novas:
`GET /data/exports/melodias/melodias.json`, `POST /api/melodies` e
`DELETE /api/melodies`. Os recursos ligan coas melodías cunha ligazón
`entity_type = "melody"` en `media_links`.

## Acceso e secrets

O plan orixinal (2026-09-27) era Cloudflare Access, pero require un plan
de pago que o equipo non ten. Optouse por unha alternativa gratuita e moito
máis simple: **un contrasinal único compartido (HTTP Basic Auth)** que
protexe TODO o Worker (frontend estático + API), comprobado en
`checkSitePassword()` / `authRequiredResponse()` en `src/worker.js`, antes
de calquera outra lóxica. O navegador amosa o seu diálogo nativo de login;
o nome de usuario ignórase, só importa o contrasinal.

O contrasinal gárdase coma **secret de Wrangler**, nunca en `wrangler.toml`
nin en `.dev.vars` con valor real (ambos os dous quedan fóra de git, ver
`.gitignore`):

```bash
npx wrangler secret put SITE_PASSWORD
# pide o valor por prompt interactivo, nunca queda en ficheiros nin en git
npx wrangler deploy   # redespregar para que o Worker recolla o secret novo
```

Se `SITE_PASSWORD` non está configurado (por exemplo en local dev sen ese
secret posto), o Worker NON bloquea nada -- útil para desenvolver sen ter
que meter contrasinal cada vez.

**Limitacións coñecidas desta alternativa** (fronte a Cloudflare Access):
non hai identidade por persoa (un contrasinal compartido para os tres),
non hai caducidade nin revogación individual (cambiar o contrasinal
desloga a todos), e o navegador cachea as credenciais ata que se pecha
(non hai "logout" real). Para o uso actual (equipo pequeno, contrasinal
provisional) chega; se no futuro hai orzamento, migrar a Cloudflare
Access segue sendo unha mellora doada (a lóxica de `checkSitePassword`
sinxelamente quitaríase).

## Usuarias e roles (login con Google)

A plataforma pódese **consultar libremente**, coma unha wikipedia. Para
escribir fai falla entrar con Google e ter rol **guía** ou **admin**:

| Rol | Que pode facer |
|---|---|
| visitante (sen entrar) | consultar todo |
| `foleante` | consultar (rol por defecto de quen entra por primeira vez); no futuro, espazo propio con favoritos e pezas persoais |
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
4. Aplicar a migración na D1 remota:
   `npx wrangler d1 execute fol-e-ar-db --remote --file=migrations/0003_users.sql`
5. `npx wrangler deploy`
6. Se estaba posto `SITE_PASSWORD` e se quere que o sitio sexa público:
   `npx wrangler secret delete SITE_PASSWORD`.

### Modos (`GET /api/auth/me` devolve o activo)

- `google`: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` presentes. Modo normal.
- `unconfigured`: sen credenciais de Google. **Escritura pechada** (falla
  pechado); a consulta segue aberta.
- `open`: `AUTH_DISABLED = "true"`. Sen login, calquera pode escribir. Só para
  desenvolvemento.
- En local (`tools/local_server.py`) non hai login: a persoa é sempre admin.

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

Rutas novas no Worker (mesmos camiños que en local, ver `tools/local_server.py`):

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

## O que NON está feito aquí (fase 2)

- **Pezas** (`pieces`/`piece_coplas`): sen endpoints de lectura nin
  escritura. A pestana "Pezas" do frontend NON funciona aínda contra este
  Worker (a táboa xa existe no esquema D1 e no seed, pero non hai handlers).
- ~~Xeración de PDF~~: **xa implementado**, ver seccion "Xeración de PDF"
  máis arriba (Cloudflare Browser Run). Falta só que crees o token
  `BROWSER_RUN_API_TOKEN` na conta e fagas `wrangler secret put` +
  `wrangler deploy` para que quede activo en produción.
- **`POST /api/submissions`**: formulario público "Enviar unha copla"
  pendente de revisión (a táboa `submissions` xa existe no esquema, sen uso).
- **Turnstile + rate limiting** nas rutas públicas de escritura.
- **R2** para ficheiros propios: sen uso real aínda.
- **Atomicidade parcial**: cada copla dun payload escríbese secuencialmente
  (non hai unha soa transacción D1 que cubra un payload con varias coplas á
  vez); para o uso normal (editar unha copla de cada vez dende a web) isto
  non chega a ser un problema real, pero é unha limitación coñecida.
- **O propio despregamento**: require conta real de Cloudflare (o usuario
  xa ten unha, conta "fol-e-ar"), dominio (pendente de merca) e configurar
  Access + os IDs reais de D1/R2 en `wrangler.toml`.
