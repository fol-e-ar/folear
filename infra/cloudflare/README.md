# Fol e ar · Cloudflare (infraestrutura de produción, fase 1)

Este directorio contén o punto de partida da arquitectura de produción en
Cloudflare descrita en `docs/arquitectura-cloudflare.md`. É código novo e
illado: **non modifica nada do frontend nin do backend Python actuais**, e
**non toca `data/db/coplas.sqlite`**.

Non hai conta nin credenciais de Cloudflare configuradas neste repositorio.
Todo o que hai aquí está preparado e probado localmente (esquema, seed,
verificación), pero non hai ningún despregamento real feito nin simulado.

## Que hai aquí

```text
infra/cloudflare/
├── wrangler.toml.example   # modelo de configuración (copiar a wrangler.toml)
├── .dev.vars.example       # modelo de variables locais (copiar a .dev.vars)
├── package.json            # dependencia de wrangler, illada do resto do repo
├── migrations/
│   └── 0001_init.sql       # esquema D1, traducido do esquema SQLite actual
├── seed/                   # xerado por scripts/export_sqlite_to_d1.py
│   ├── 01_territories.sql … 10_media_links.sql
│   └── _manifest.json      # reconto de filas exportadas/excluídas por táboa
├── scripts/
│   ├── export_sqlite_to_d1.py   # SQLite (read-only) -> SQL de seed
│   └── verify_migration.py      # verifica recontos e integridade do seed
└── src/
    └── worker.js            # esqueleto de API (GET /api/territories, /api/coplas)
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
   falta para `--remote` (preview/produción).

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

   Isto serve `frontend/` (binding `ASSETS`) máis `GET /api/territories` e
   `GET /api/coplas` contra a D1 local, sen tocar `./serve.sh` nin o backend
   Python existente, que seguen funcionando exactamente igual.

## Contornos

| Contorno   | Como se executa               | D1                        | Notas |
|------------|--------------------------------|----------------------------|-------|
| Local      | `wrangler dev` (`--local`)     | SQLite local en `.wrangler/state/` | sen conta de Cloudflare |
| Preview    | `wrangler deploy --env preview`| `fol-e-ar-db-preview`      | unha D1 real de proba, illada da de produción |
| Produción  | `wrangler deploy`              | `fol-e-ar-db`              | require conta e créditos de Cloudflare |

## Migracións futuras

Migracións novas engádense como `migrations/0002_*.sql`, `0003_*.sql`, etc.,
seguindo o mesmo patrón que `backend/schema/00N_*.sql` no proxecto Python.
`wrangler d1 migrations apply` lévalles a conta.

## Secrets

Nunca en `wrangler.toml` nin en `.dev.vars` cando teñan valores reais (ambos
os dous quedan fóra de git, ver `.gitignore`). Secrets previstos (ver
`docs/arquitectura-cloudflare.md`, secc. "API e seguridade"):

- `ADMIN_TOKEN` — autenticación mínima da administración na fase 1.
- `TURNSTILE_SECRET_KEY` — cando se active Turnstile no formulario público
  "Enviar unha copla".

Configúranse con `wrangler secret put NOME` (por contorno).

## O que NON está feito aquí (fase 2)

Ver a lista completa en `docs/arquitectura-cloudflare.md`, secc. "Pendente
para fase 2". Resumo rápido: autenticación de administración real, endpoints
de pezas/media, formulario de achegas pendentes de revisión, Turnstile +
rate limiting, R2 para ficheiros propios, xeración de PDF en Cloudflare
(ou estratexia alternativa), dominio `folear.gal`, e o propio despregamento
en si (require conta de Cloudflare).
