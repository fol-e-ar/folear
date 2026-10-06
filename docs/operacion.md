# Operación da produción

Guía práctica para quen leva o despregue (Cloudflare Workers + D1). Todo funciona co plan gratuíto.

## Onde está cada cousa

- **Fonte de verdade dos datos: a D1 de produción** (`fol-e-ar-db`). A web edítase directamente en <https://folear.gal> (contas guía/admin). `data/db/coplas.sqlite` é unha copia de traballo para desenvolver en local; **non se sincroniza de volta** desde produción, así que non a tomes como reflexo do que hai en liña.
- **Código**: este repo. O Worker serve `frontend/` e a API desde o mesmo dominio.
- **Secrets e variables**: só en Wrangler/Cloudflare, nunca no repo (ver `infra/cloudflare/README.md`, «Acceso e secrets»).

## Despregar

```bash
cd infra/cloudflare
npm install                                              # a primeira vez
npx wrangler d1 migrations apply fol-e-ar-db --remote    # só se hai migracións novas
npx wrangler deploy
```

Orde segura: **primeiro as migracións, despois o `deploy`**. Todas as migracións son aditivas (non borran datos) e o Worker funciona coa esquema vello mentres non se apliquen.

### Primeira vez co rexistro de migracións

As migracións 0001-0005 aplicáronse a man. Para que `migrations apply` saiba cales están feitas, executa **unha soa vez**:

```bash
npx wrangler d1 execute fol-e-ar-db --remote --file=scripts/baseline_migrations.sql
npx wrangler d1 migrations apply fol-e-ar-db --remote      # aplica as migracións pendentes (0006 a 0009)
```

Unha migración nova é un ficheiro `infra/cloudflare/migrations/NNNN_nome.sql`: aditivo, con `IF NOT EXISTS` sempre que sexa posible.

## Copias de seguridade

```bash
tools/backup.sh                 # gárdase en ~/folear-backups/AAAA-MM-DD/
```

Garda o dump completo da D1 (`d1-AAAA-MM-DD.sql`) e os cinco exports públicos en JSON, e comproba que o dump se pode restaurar (`tools/check_backup.py`). **O dump leva nomes e correos das contas: gárdao fóra do repo e non o compartas.** (`backup-d1-*.sql` está en `.gitignore` por se acaso, pero o sitio correcto é fóra do cartafol do proxecto.)

Fai unha copia antes de calquera migración ou cambio grande. Para restaurar nunha D1 baleira: `npx wrangler d1 execute <base> --remote --file=d1-AAAA-MM-DD.sql`.

Cloudflare tamén ofrece *Time Travel* na D1 (restaurar a un instante dos últimos 30 días): `npx wrangler d1 time-travel info fol-e-ar-db`.

## Volver atrás

- **Código**: `npx wrangler rollback` (volve á versión anterior do Worker) ou despregar de novo un commit anterior.
- **Datos**: restaurar con *Time Travel* ou co dump.

## Límites do plan gratuíto a vixiar

- Workers: 100.000 peticións/día. Os ficheiros estáticos non contan.
- D1: 5 M filas lidas/día e 100.000 escritas/día. Os exports públicos cachéanse por versión.
- Browser Run (PDF): 10 min/día. Por iso o PDF require sesión e hai un tope de 15 PDFs por persoa e día.

## Seguridade en resumo

- A web aplica unha CSP estrita (`frontend/_headers`): só se executa JS propio, sen CDNs. Se engades unha biblioteca, ponla en `frontend/assets/vendor/` (con licenza en `assets/vendor/README.md`).
- Escribir require rol guía/admin; PDF e espazo persoal requiren sesión. Sempre se valida no servidor.
- As mensaxes de erro internos (SQL, esquema) non chegan á persoa: quedan no log do Worker (`npx wrangler tail`).
