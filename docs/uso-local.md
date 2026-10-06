# Uso local

## Ver a web no navegador

Desde a raíz do repo:

```bash
./serve.sh
```

Abre:

```text
http://localhost:8765/frontend/index.html
```

Este servidor tamén activa a API local (no modo local non hai login):

```text
POST /api/coplas
POST /api/media
POST /api/territory-traits
POST /api/pdf/piece-draft
GET /api/pieces/{id}/pdf
GET /api/territories/{id}/pdf
```

Iso permite que a pantalla `Alta` garde novas coplas directamente na SQLite e rexenere as exportacións web, sen descargar/importar JSON manualmente.

Se o porto está ocupado:

```bash
./serve.sh 8780
```

## Fluxo editorial básico

1. Abre `Alta`. Por defecto a copla queda `Sen asignar`; só se busca un territorio se se quere asignar explicitamente.
2. Marca `Úsase como volta` se o texto é un retrouso e non unha copla de seu.
3. Mentres escribes, se xa existe algo parecido no arquivo aparece un aviso con ligazón á copla existente (para evitar duplicados).
4. Engade variantes se existen. Nacen numeradas automaticamente (Variante 1, 2...) co mesmo texto ca copla principal para editar só o que cambia, e o territorio amósase como texto editable que herda o da copla principal ata que se escribe outro no seu lugar.
5. Para dar de alta varias coplas dun mesmo territorio nunha soa sesión, usa `+ Engadir á lista` despois de cada copla (mantén o territorio e o estado, limpa o resto do formulario) e remata con `Gardar todas`. Se só hai unha copla, `Gardar copla` abonda.
6. Para editar unha copla xa existente (engadir variante, marcar como volta, cambiar de territorio...), ábrea e usa `Editar copla` na ficha.

Para importar varias coplas desde un ficheiro xa preparado, abre `Importar varias coplas desde JSON` ao final da pantalla. Desde aí podes descargar o modelo, escoller un ficheiro e importalo directamente. O mesmo formato tamén funciona desde a terminal:

```bash
python3 tools/admin.py import-coplas ruta/ao/lote.json
```

7. Rexenera a web:

```bash
python3 tools/admin.py export-web
python3 tools/admin.py check
```

8. Para publicar en produción non se sobe un ficheiro: os datos viven na D1 de Cloudflare e a web edítase directamente en <https://folear.gal> con conta guía ou admin. O modo local é para desenvolver e probar (ver `docs/operacion.md`).

## Montar pezas e letras

1. Vai a `Pezas` e abre `Obradoiro`.
2. Engade contido desde o repertorio, escribe novas coplas directamente ou importa unha peza desde TXT/JSON.
3. As importacións convértense nun borrador visual: non se mostra nin se edita código na aplicación.
4. Organiza as coplas por partes: `xota`, `muiñeira`, `pasodobre`, `valse`, `danza`, `dous pasos`, `mazurca`, `polca`, etc.
5. As coplas escritas dentro dunha peza poden gardarse como texto propio da composición sen darse de alta automaticamente no corpus.
6. Usa `Gardar peza` para incorporala á biblioteca local.
7. Usa `Exportar PDF` para xerar un PDF real desde o servidor local e previsualizalo dentro da app.

O importador ofrece modelos descargábeis en TXT e JSON. O TXT admite metadatos simples (`Título`, `Autoría`, `Territorio`), nomes de ritmo nunha liña propia e coplas separadas por unha liña en branco. O prefixo `Retrouso:` identifica un retrouso sen engadir esa palabra ao texto final.

## Exportación PDF

En produción o PDF xérase no Worker (Cloudflare Browser Run) e só o pode pedir unha persoa con sesión iniciada. En local xérase con Chrome (abaixo).

O motor empregado é Google Chrome/Chromium en modo headless. Nun Mac con Google Chrome instalado non hai que instalar nada máis. Se queres usar outro binario:

```bash
FOL_E_AR_CHROME=/ruta/a/chromium ./serve.sh
```

Tamén podes xerar PDFs desde CLI:

```bash
python3 tools/admin.py pdf-territory par:3603002
python3 tools/admin.py pdf-piece 12 --output /tmp/peza.pdf
```

Se non se indica `--output`, o PDF escríbese en `data/exports/pdf/`.


## Territorios: resumo e trazos herdados

A pestana `Resumo` dun territorio xa non repite unha mostra de coplas (iso vive só en `Coplas`, con vistas de galería, lista e só íncipits). No seu lugar amosa os subterritorios (destacados en azul cando teñen coplas) e unha tarxeta de identidade con trazos documentados (instrumentos, bailes, fala...), coma "tócase lata" ou "gheada". Un territorio maior (provincia, comarca) herda na súa propia tarxeta os trazos documentados nos seus subterritorios, agrupados por quen os documenta. Trázos engádense e retíranse desde `+ Engadir trazo` na propia tarxeta.

Premer `Territorios` no menú lateral sempre volve á vista xeral de Galiza.
