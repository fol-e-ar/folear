# Notes · Fol e ar

## 1. Que é este proxecto

Este repositorio contén un sistema para organizar, editar e publicar un arquivo relacional de coplas galegas, con vínculos a territorios, etiquetas e, no futuro, pezas e media relacionada.
,
A arquitectura do proxecto separa claramente:

- **datos canónicos**: a base SQLite e os JSON mestres
- **exports para web**: JSON lixeiros que consome o frontend
- **frontend estático**: páxinas HTML/CSS/JS que se publican en GitHub Pages
- **scripts de mantemento**: ferramentas para inicializar a base, importar datos, exportar JSON e facer operacións sobre as coplas

---

## 2. Idea xeral de funcionamento

A web pública **non le directamente a SQLite**.

O fluxo é este:

1. A información real gárdase na base SQLite:
   - `data/db/coplas.sqlite`

2. Os scripts de `tools/` modifican esa base:
   - engadir coplas
   - borrar coplas
   - importar territorios
   - etc.

3. A partir da SQLite, xéranse JSON exportados:
   - `data/exports/coplas/coplas.json`
   - `data/exports/territorios/territorios.json`

4. O frontend le eses JSON exportados:
   - non a base `.sqlite`

5. GitHub Pages publica o frontend e os JSON.

En resumo:

**SQLite = fonte canónica**  
**JSON exportados = capa de publicación web**

---

## 3. Estrutura actual do proxecto

```text
.
├── backend
│   ├── schema
│   │   └── 001_init.sql
│   └── services
│       └── db_paths.py
├── data
│   ├── backups
│   ├── canonical
│   │   └── territorios.json
│   ├── db
│   │   └── coplas.sqlite
│   └── exports
│       ├── coplas
│       │   └── coplas.json
│       └── territorios
│           └── territorios.json
├── docs
│   └── notes.md
├── frontend
│   ├── assets
│   │   └── web
│   │       ├── comarcas.web.geojson
│   │       ├── concellos.web.geojson
│   │       ├── parroquias.web.topo.json
│   │       └── provincias.web.geojson
│   ├── css
│   │   └── style.css
│   ├── index.html
│   ├── js
│   │   ├── api.js
│   │   ├── copla.js
│   │   ├── coplas.js
│   │   ├── mapa.js
│   │   ├── nav.js
│   │   ├── territorio.js
│   │   ├── territorios.js
│   │   └── utils.js
│   └── pages
│       ├── copla.html
│       ├── coplas.html
│       ├── mapa.html
│       ├── peza.html
│       ├── pezas.html
│       ├── territorio.html
│       └── territorios.html
└── tools
    ├── add_copla.py
    ├── delete_copla.py
    ├── export_coplas.py
    ├── import_territorios.py
    ├── init_db.py
    ├── list_coplas.py
    ├── list_territories_search.py
    └── list_territorios.py
````

---

## 4. Significado de cada bloque

### `backend/`

Contén o esquema SQL e, no futuro, posibles servizos auxiliares.

* `backend/schema/001_init.sql`

  * crea as táboas da base SQLite

* `backend/services/db_paths.py`

  * rutas compartidas para a base e territorios, se se precisan noutros scripts

### `data/`

Contén os datos do proxecto.

#### `data/canonical/`

Datos mestres en JSON.

* `territorios.json`

  * catálogo territorial lóxico
  * sen xeometría
  * con `id`, `tipo`, `cod`, `nome`, `slug`, etc.

#### `data/db/`

Fonte canónica relacional.

* `coplas.sqlite`

  * base principal do proxecto

#### `data/exports/`

JSON xerados para o frontend.

* `exports/coplas/coplas.json`
* `exports/territorios/territorios.json`

#### `data/backups/`

Copias de seguridade manuais da SQLite, se se fan.

### `frontend/`

Web pública estática.

* `index.html`
* `pages/*.html`
* `js/*.js`
* `css/style.css`
* `assets/web/*.web.geojson`
* `assets/web/*.web.topo.json`

### `tools/`

Scripts de mantemento.

---

## 5. Modelo de datos actual

### Territorios

A información territorial vive en dous planos:

#### A. Plano lóxico

* `data/canonical/territorios.json`
* `data/exports/territorios/territorios.json`
* táboa `territories` na SQLite

Contén:

* `id` (`prov:15`, `con:15001`, etc.)
* `tipo`
* `cod`
* `nome`
* relacións xerárquicas (`prov`, `com`, `con`)

#### B. Plano xeométrico

* `frontend/assets/web/*.web.geojson`
* `frontend/assets/web/*.web.topo.json`

Serve só para:

* debuxar
* navegar no mapa
* resaltar territorios

A lóxica territorial **non se deduce da xeometría**.

### Coplas

As coplas gárdanse en:

* táboa `coplas`

E relaciónanse con:

* territorios → `copla_territories`
* etiquetas → `copla_tags`

Isto permite que:

* unha copla teña varios territorios
* unha copla non teña ningún territorio
* unha copla teña varias etiquetas

---

## 6. Scripts principais

### Inicializar a base

```bash
python3 tools/init_db.py
```

Crea a SQLite segundo `backend/schema/001_init.sql`.

### Importar territorios

```bash
python3 tools/import_territorios.py
```

Importa `data/canonical/territorios.json` á táboa `territories`.

### Engadir copla

```bash
python3 tools/add_copla.py
```

Permite:

* introducir texto multilinea
* engadir varios territorios
* engadir etiquetas
* engadir notas

### Borrar copla

```bash
python3 tools/delete_copla.py
```

Pide o ID, amosa a copla e solicita confirmación antes de borrala.

### Listar coplas

```bash
python3 tools/list_coplas.py
```

### Buscar territorios na base

```bash
python3 tools/list_territories_search.py
```

### Exportar coplas a JSON

```bash
python3 tools/export_coplas.py
```

Importante: este paso hai que facelo despois de modificar coplas se queremos que a web quede actualizada.

---

## 7. Fluxo normal de traballo

### Caso A: engadir ou borrar coplas

1. Modificar a base:

   * `python3 tools/add_copla.py`
   * ou `python3 tools/delete_copla.py`

2. Exportar de novo:

   * `python3 tools/export_coplas.py`

3. Comprobar a web en local:

   * `python3 -m http.server 8000`
   * abrir `http://localhost:8000/frontend/`

4. Se todo está ben:

   * `git add .`
   * `git commit -m "..." `
   * `git push`

### Caso B: actualizar territorios

1. Editar ou substituír:

   * `data/canonical/territorios.json`

2. Recrear ou actualizar a base:

   * se é preciso, reinicializar
   * `python3 tools/import_territorios.py`

3. Copiar/exportar tamén a:

   * `data/exports/territorios/territorios.json`
   * se ese ficheiro non se xera automaticamente nese momento

4. Comprobar a web

5. Commit + push

---

## 8. Protocolo recomendado para traballar dúas persoas

Como a base SQLite é un único ficheiro, **non convén que os dous a editemos á vez sen coordinación**.

### Recomendación

Traballar así:

1. Antes de empezar:

   ```bash
   git pull
   ```

2. Unha persoa fai cambios na base local

3. Exporta os JSON necesarios

4. Comproba en local

5. Fai:

   ```bash
   git add .
   git commit -m "..."
   git push
   ```

6. A outra persoa, antes de seguir, fai:

   ```bash
   git pull
   ```

### Non recomendado

* editar os dous ao mesmo tempo a mesma SQLite e facer push sen coordinar
* modificar JSON exportados manualmente se deberían saír da base
* tocar a SQLite e esquecer exportar

---

## 9. Que ficheiros son fonte e cales son derivados

### Fonte canónica

* `data/db/coplas.sqlite`
* `data/canonical/territorios.json`
* `backend/schema/001_init.sql`
* scripts de `tools/`
* frontend fonte (`html`, `css`, `js`)

### Derivados / exportados

* `data/exports/coplas/coplas.json`
* `data/exports/territorios/territorios.json`

Regra xeral:

* os JSON de `exports/` non se deberían editar a man se hai un proceso claro que os xera

---

## 10. Sobre os IDs

### Coplas

O ID das coplas é un `INTEGER PRIMARY KEY AUTOINCREMENT`.

Isto implica:

* se borramos unha copla, o seu ID desaparece
* os demais IDs non cambian
* non se recolocan
* poden quedar ocos

Exemplo:

* hai coplas 1, 2, 3
* bórrase a 2
* a seguinte creada será a 4

### Territorios

Os IDs territoriais son semánticos:

* `prov:15`
* `con:15001`
* `par:3690221`

Eses son estables e non dependen da orde.

---

## 11. Publicación en GitHub Pages

GitHub Pages publica:

* HTML
* CSS
* JS
* JSON
* assets

Pero **non executa SQLite**.

Isto significa:

* a SQLite si se pode subir ao repo
* pero a web pública non a consulta directamente
* a web le os JSON exportados

Fluxo de publicación:

1. modificar SQLite en local
2. exportar JSON
3. commit + push
4. GitHub Pages serve a nova versión

---

## 12. Comandos útiles

### Ver a base con SQLite

```bash
sqlite3 data/db/coplas.sqlite
```

### Ver táboas

```sql
.tables
```

### Ver esquema

```sql
.schema coplas
.schema territories
.schema copla_territories
```

### Saír

```sql
.quit
```

---

## 13. Pendentes actuais

* sistema de pezas
* media relacionada
* exportadores máis completos
* posible script unificado tipo `rebuild_site.py`
* mellor fluxo de actualización de `territorios.json`
* navegación e detalle de pezas
* formularios web locais para edición, se se quere evitar terminal

---

## 14. Convencións de traballo

* non editar `exports/` a man salvo caso excepcional
* facer sempre export despois de modificar a base
* probar en local antes de facer push
* documentar cambios estruturais neste ficheiro
* se se cambia o esquema SQL, anotalo aquí

---

## 15. Resumo operativo mínimo

Para engadir unha copla e publicala:

```bash
python3 tools/add_copla.py
python3 tools/export_coplas.py
python3 -m http.server 8000
```

Se todo está ben:

```bash
git add .
git commit -m "Engadir novas coplas"
git push
```


## To-do

- [ ] Facer que o buscador en /Coplas busque por todas as xerarquías (se a copla está gardada con parroquia, poder buscala por concello, comarca e provincia).
