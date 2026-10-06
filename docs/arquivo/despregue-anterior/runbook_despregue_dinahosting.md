# Fol e ar — despregue en Dinahosting VPS Lite + Cloudflare

Resumo do plan: o backend actual (Python + SQLite, xa probado) múdase tal cal a un VPS de Dinahosting sempre acendido. O dominio (folear.gal) pasa por Cloudflare (gratis) só para xestionar o acceso por correo (Cloudflare Access) e a protección básica. Non fai falla reescribir nada do código: todo o que usa `backend/` e `tools/` é libraría estándar de Python, sen dependencias externas que instalar.

## 0. Que mercar mañá en Dinahosting

- **Dominio**: `folear.gal`.
- **VPS Lite I** (Linux **non administrado**): 1 vCPU, 1 GB RAM, 20 GB — abonda de sobra para 156 coplas e uso persoal/familiar. É a opción máis barata que dá acceso root completo por SSH (as necesitamos para instalar Chromium e deixar o servidor a correr sempre).

## 1. Primeira conexión ao VPS

```bash
ssh root@<IP-do-VPS>
apt update && apt upgrade -y
apt install -y python3 chromium git caddy
```

> Se `chromium` non existe co ese nome exacto na túa distribución, proba `chromium-browser`. O código xa busca os dous nomes automaticamente (`chrome_binary()` en `backend/services/pdf/renderer.py`), así que non hai que tocar nada de código.

Crea un usuario propio para a app (mellor ca usar root para todo):

```bash
adduser --disabled-password --gecos "" folear
mkdir -p /home/folear/app
chown -R folear:folear /home/folear/app
```

## 2. Levar o código ao VPS

A forma máis simple, sen depender de git nin de claves SSH adicionais: comprime o repositorio local e cópiao por `scp`.

Dende o teu Mac (non dende o VPS):

```bash
cd /caminho/a/prova
tar --exclude=.git --exclude=worker --exclude=.DS_Store -czf folear.tar.gz .
scp folear.tar.gz root@<IP-do-VPS>:/home/folear/app/
```

E xa no VPS:

```bash
su - folear
cd /home/folear/app
tar xzf folear.tar.gz
rm folear.tar.gz
```

(Exclúo `worker/` porque é só o esqueleto experimental de Cloudflare Workers, sen relación co que vai correr aquí.)

## 3. Proba manual antes de automatizar nada

```bash
cd /home/folear/app
python3 tools/local_server.py 8765
```

Nunha segunda terminal (ou dende o teu Mac, se abriches o porto temporalmente):

```bash
curl -s http://localhost:8765/frontend/index.html | head -5
```

Se ves HTML, para o proceso con Ctrl+C e pasa ao seguinte punto.

## 4. Servizo permanente (systemd)

Xa preparei o ficheiro `folear.service` (adxunto). Só hai que copialo:

```bash
# como root:
cp folear.service /etc/systemd/system/folear.service
systemctl daemon-reload
systemctl enable --now folear
systemctl status folear
```

Isto fai que o servidor arrinque só ao reiniciar o VPS e que se recupere só se falla.

## 5. HTTPS co dominio (Caddy)

Xa preparei o `Caddyfile` (adxunto), que xa asume `folear.gal`. Só hai que copialo:

```bash
cp Caddyfile /etc/caddy/Caddyfile
systemctl restart caddy
```

Caddy pedirá o certificado a Let's Encrypt automaticamente en canto o DNS (punto seguinte) apunte a este servidor.

## 6. DNS: pasar folear.gal por Cloudflare

1. Crea unha conta gratuíta en cloudflare.com (se aínda non a usaches para isto).
2. "Add a site" → `folear.gal`. Cloudflare dirache os seus dous *nameservers* (algo como `ana.ns.cloudflare.com` / `bob.ns.cloudflare.com`).
3. En Dinahosting, no panel de xestión do dominio, cambia os *nameservers* aos que che deu Cloudflare.
4. En Cloudflare, crea un rexistro DNS:
   - Tipo `A`, nome `folear.gal` (ou `@`), valor = IP do VPS, **proxy activado** (a nubiña laranxa).
5. En "SSL/TLS", pon o modo en **"Full"** (non "Flexible"): así o tráfico entre Cloudflare e o VPS tamén vai cifrado, aproveitando o certificado que xestiona Caddy.

O cambio de nameservers pode tardar dende minutos ata varias horas en propagarse.

## 7. Cloudflare Access: só vós tres podedes entrar

1. No panel de Cloudflare, vai a **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Dominio da aplicación: `folear.gal`.
3. Política de acceso: "Allow" → Include → **Emails**:
   - `folear3@gmail.com`
   - `davidenverde@gmail.com`
   - o teu correo persoal (revisa antes se é `amoronbandin@gmail.com` — o que me deches tiña "gmai.com" sen "l", e así nunca chegaría o código de acceso)
4. Método de login: **"One-time PIN"** (código por correo) abonda e é gratis; non fai falla ningunha conta de Google nin similar.
5. Garda. A partir de aí, calquera que entre en folear.gal terá que meter un dos tres correos e o código que lle chegue por email antes de ver nada.

## 8. Proba final de punta a punta

- Abre `https://folear.gal` nun navegador en modo privado: debe pedirche o correo antes de amosar a web.
- Crea unha copla de proba dende "Nova copla", compróbaa, e bórraa dende a ficha (o botón "Borrar copla" que engadimos esta semana). Debe desaparecer sen ter que facer nada en git.

## 9. Copias de seguridade (importante)

A base de datos real (`data/db/coplas.sqlite`) agora vive só no VPS. Recomendo un cron sinxelo que a copie a outro sitio a diario, por exemplo:

```bash
# crontab -e (como usuario folear)
0 4 * * * cp /home/folear/app/data/db/coplas.sqlite /home/folear/backups/coplas-$(date +\%Y\%m\%d).sqlite
```

(e de cando en vez baixar eses backups ao teu Mac ou subilos a algún almacenamento en nube, para non depender só do propio VPS).

## O que NON cambia

- O código de `backend/` e `tools/` non necesita ningunha reescritura: só usa a libraría estándar de Python (comprobado: non hai `requirements.txt` porque non hai dependencias externas).
- A xeración de PDF segue a funcionar igual, xa que o VPS ten o seu propio Chromium instalado — non depende de Cloudflare para nada.
- `data/db/coplas.sqlite` non se toca nin se recrea: só se copia tal cal ao VPS.

## O que si queda pendente para máis adiante (non urxente)

- A migración a Cloudflare Workers + D1 (backend "100% na nube", sen servidor propio) segue a ser posible no futuro, se algún día queredes deixar de pagar o VPS. Quedou o esqueleto en `worker/api/` para retomalo con calma, probándoo ben antes de tocar datos reais.
