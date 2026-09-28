# Fol e ar — despregar o Worker + D1 real en Cloudflare (conta fol-e-ar)

Todo isto xa está feito e probado en local (D1 emulada). O que falta é
crealo de verdade na túa conta de Cloudflare "fol-e-ar" — e iso só o podes
facer ti, dende o teu propio terminal (Terminal.app / iTerm no teu Mac, non
a ponte desta conversa, que non chega aos servidores de Cloudflare).

## 0. Antes de nada

```bash
cd ~/dev/repos/prova/infra/cloudflare
npm install          # se aínda non o fixeches
```

## 1. Iniciar sesión coa conta de Cloudflare correcta

```bash
npx wrangler login
```

Ábrese o navegador. Inicia sesión coa conta **fol-e-ar** (a que creaches
onte), non coa túa persoal, se tes as dúas abertas.

## 2. Crear a base de datos D1 real

```bash
npx wrangler d1 create fol-e-ar-db
```

A saída dá un `database_id` (algo como `xxxxxxxx-xxxx-...`). Cópiao.

## 3. Configurar wrangler.toml

```bash
cp wrangler.toml.example wrangler.toml
```

Edita `wrangler.toml`:
- Substitúe `REPLACE_WITH_REAL_D1_DATABASE_ID` polo ID real do paso 2.
- **Comenta ou borra o bloque `[[r2_buckets]]`** (as tres liñas
  `binding`/`bucket_name` e a liña `[[r2_buckets]]`) — aínda non usamos R2
  para nada, e un bucket que non existe faría fallar o despregamento.
- De momento podes deixar `ALLOWED_ORIGIN = "https://folear.gal"` tal cal
  (non afecta a nada mentres frontend e API vivan no mesmo Worker).

## 4. Cargar o esquema e os datos reais na D1 (unha soa vez)

**Actualización (2026-09-27):** se xa executaches isto e che deu un erro tipo
`BEGIN TRANSACTION or SAVEPOINT statements...`, é un problema real que
detectamos grazas a ti — D1 en `--remote` non acepta eses statements SQL
explícitos (esixe a súa propia API de JS para transaccións), aínda que en
local (`--local`) non daba problema ningún, por iso non se detectara antes.
**Xa está arranxado**: `export_sqlite_to_d1.py` xa non xera `BEGIN
TRANSACTION;`/`COMMIT;` nos ficheiros de seed (cada `wrangler d1 execute
--file=...` xa trata o ficheiro enteiro coma unha soa unidade, así que non
facían falla). Os ficheiros `seed/*.sql` novos xa están rexenerados no teu
repo (verificados: mesmos recontos de sempre — 156 coplas, 4155 territorios,
etc. — e probados cargando nunha SQLite illada de proba sen erros).

Sobre o prompt `Would you like to report this error to Cloudflare? (Y/n)`
que quedou colgado: podes responder `n` tranquilamente, non fai falla
reportalo, xa sabemos cal é o problema.

Antes de retentar, convén comprobar se o primeiro ficheiro de seed
(`01_territories.sql`) chegou a inserir algo antes de fallar:

```bash
npx wrangler d1 execute fol-e-ar-db --remote --command "SELECT COUNT(*) FROM territories;"
```

- Se dá `0`: non se inseriu nada, podes retentar a secuencia completa tal
  cal (abaixo).
- Se dá un número >0 pero menor que 4155: houbo unha inserción parcial.
  Neste caso dime o número exacto e paramos a decidir xuntos como limpar
  antes de continuar (o máis simple adoita ser borrar todo o contido das
  táboas antes de recargar, pero mellor confirmalo primeiro que adiviñar).

Se deu `0` (o caso máis probable, xa que o erro parece saltar antes de
executar ningún `INSERT`), retenta a secuencia completa cos ficheiros xa
arranxados:

```bash
npx wrangler d1 execute fol-e-ar-db --remote --file=migrations/0001_init.sql
for f in seed/*.sql; do
  npx wrangler d1 execute fol-e-ar-db --remote --file="$f"
done
```

(A liña da migración xa a executaras ben a primeira vez — `CREATE TABLE IF
NOT EXISTS` fai que repetila sexa inofensivo, así que non pasa nada por
executala de novo.)

**Segunda actualización (mesmo día, un pouco despois):** ao retentar coa
corrección de arriba, `01_territories.sql` cargou ben (4155 filas), pero
`02_tags.sql` fallou con `UNIQUE constraint failed: tags.id` — sinal de que
xa había datos parciais na D1 remota dun intento anterior (probablemente do
propio bucle orixinal, que seguiu a outros ficheiros mentres o terminal
parecía "colgado"). En vez de perder tempo a diagnosticar exactamente que
quedou a medias en cada táboa, cambiei os INSERT xerados a
**`INSERT OR IGNORE INTO`**: así, se unha fila xa existe (mesmo id), sáltase
sen erro en vez de fallar, e se non existe, insírese normal. Isto fai que
**se poida retentar a secuencia completa canta veces faga falla, sen
preocuparse polo estado parcial** — probado localmente cargando os seed
dúas veces seguidas sobre a mesma base de proba, cos mesmos recontos finais
e sen erros nin duplicados. Tamén actualicei `verify_migration.py` (que
contaba os INSERT por regex) para que siga a recoñecer os ficheiros novos.

Coa corrección aplicada, retenta simplemente dende o principio:

```bash
npx wrangler d1 execute fol-e-ar-db --remote --file=migrations/0001_init.sql
for f in seed/*.sql; do
  npx wrangler d1 execute fol-e-ar-db --remote --file="$f"
done
```

Non fai falla borrar nada antes nin comprobar recontos parciais — con
`INSERT OR IGNORE` calquera dato xa presente simplemente se ignora.

Isto copia os teus datos reais (156 coplas, territorios, media, etc.) á D1
de produción. **Non toca `data/db/coplas.sqlite`** en ningún momento — só o
le.

## 5. Despregar o Worker

```bash
npx wrangler deploy
```

Ao rematar dá unha URL do estilo `https://fol-e-ar-api.<algo>.workers.dev`.
Ábrea: debería verse o sitio real, xa lendo e escribindo contra D1 — sen
dominio, sen custo.

## 6. Gardar o acceso con Cloudflare Access (os 3 correos)

No panel de Cloudflare (dashboard.cloudflare.com, conta fol-e-ar):

1. **Workers & Pages** → o teu Worker (`fol-e-ar-api`) → pestana **Access**
   (ou **Settings**, segundo a versión do panel) → activa "Protect this
   Worker" / engade unha Access Application.
2. Se non aparece esa opción directamente: **Zero Trust** → **Access** →
   **Applications** → **Add an application** → **Self-hosted** → como
   dominio pon o `*.workers.dev` que che deu o paso 5.
3. Política "Allow" → Include → **Emails**:
   - folear3@gmail.com
   - davidenverde@gmail.com
   - amoronbandin@gmail.com
4. Método de login: **One-time PIN** (código por correo).
5. Garda. A partir de aí, ese enderezo pídeche un dos tres correos e un
   código antes de amosar nada.

## 7. Proba final

Abre a URL en modo privado: debe pedir o correo. Unha vez dentro, crea unha
copla de proba, comproba que aparece, e bórraa dende a ficha. Todo iso xa
está probado en local; isto é só confirmar que se comporta igual en real.

## O que aínda NON funciona nesta URL (a propósito, fase 2)

- A pestana **Pezas**: aínda sen endpoints no Worker.
- **Xerar PDF**: precisa Cloudflare Browser Rendering, sen empezar.
- O formulario público "Enviar unha copla" e Turnstile: sen facer.

## Se algo falla

Cóntame exactamente o erro (a mensaxe que dea `wrangler` ou o que vexas no
navegador) e seguimos dende aquí — eu non podo executar estes comandos, pero
podo ler o código e propoñerche o arranxo exacto.
