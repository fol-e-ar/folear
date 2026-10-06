# Redeseño técnico · Coplas + territorios + pezas + media

## 1. Obxectivo

Esta proposta redefine o proxecto arredor de catro capas:

- `territorios`: eixo principal de navegación e absorción
- `coplas`: unidade básica do corpus
- `pezas`: montaxes ordenadas e asinadas feitas a partir de coplas
- `media`: recursos asociados a territorios, coplas e pezas

O principio xeral é este:

- a fonte canónica segue a ser SQLite
- os JSON de `data/exports/` seguen a ser a capa de publicación web
- toda asociación se garda de maneira directa
- a absorción territorial calcúlase nas consultas e nos exports, non na escritura

---

## 2. Decisións de produto que se dan por pechadas

- O núcleo do sistema é `coplas + territorios`.
- `Pezas` é unha capa importante de curadoría, non un detalle accesorio.
- `Media` é unha capa de contexto e documentación, subordinada ao núcleo.
- Unha peza ten:
  - título
  - autoría
  - territorio de contexto principal
  - orde explícita das coplas
- Un territorio amosa información absorbida dos seus descendentes.
- A xeración de PDF é unha función administrativa de exportación, non unha responsabilidade do frontend público.

---

## 3. Modelo de datos proposto

## 3.1 Territorios

Mantense a táboa actual, que xa é suficiente para a lóxica territorial básica:

```sql
CREATE TABLE territories (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  cod INTEGER NOT NULL,
  nome TEXT NOT NULL,
  slug TEXT NOT NULL,
  search TEXT NOT NULL,
  prov_cod INTEGER,
  com_cod INTEGER,
  con_cod INTEGER,
  parent_id TEXT
);
```

Notas:

- `parent_id` serve para consultas rápidas de navegación.
- `prov_cod`, `com_cod` e `con_cod` seguen sendo útiles para absorción por nivel.

## 3.2 Coplas

Proponse enriquecer a táboa actual cun estado editorial e marca de actualización:

```sql
CREATE TABLE coplas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  incipit TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Notas:

- `status` permite distinguir entre borrador e publicado sen borrar rexistros.
- `updated_at` será útil para exports, revisións e sincronización.

## 3.3 Etiquetas

Mantense o modelo actual:

```sql
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL
);

CREATE TABLE copla_tags (
  copla_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (copla_id, tag_id)
);
```

## 3.4 Relación copla-territorio

Mantense o modelo actual:

```sql
CREATE TABLE copla_territories (
  copla_id INTEGER NOT NULL,
  territory_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'direct',
  is_direct INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (copla_id, territory_id, relation_type)
);
```

Notas:

- Na primeira versión, `relation_type = 'direct'` chega.
- Se no futuro se quere distinguir recolla, procedencia, difusión ou atribución, este campo xa deixa a porta aberta.

## 3.5 Pezas

O modelo actual é insuficiente. Proponse substituílo por este:

```sql
CREATE TABLE pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  context_territory_id TEXT,
  description TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (context_territory_id) REFERENCES territories(id)
);
```

E manter a táboa de orde, enriquecida opcionalmente:

```sql
CREATE TABLE piece_coplas (
  piece_id INTEGER NOT NULL,
  copla_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  section_label TEXT,
  notes TEXT,
  PRIMARY KEY (piece_id, position),
  FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
  FOREIGN KEY (copla_id) REFERENCES coplas(id) ON DELETE CASCADE
);
```

Notas:

- `author` é texto libre na primeira fase.
- `context_territory_id` indica o territorio principal da montaxe.
- `status` permite gardar borradores.
- `section_label` e `notes` en `piece_coplas` non son imprescindíbeis o primeiro día, pero convén deixalos previstos para bloques ou observacións.

## 3.6 Media

O modelo actual é demasiado abstracto. Proponse substituílo por:

```sql
CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  media_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  author_or_source TEXT,
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

E manter a táboa de asociación xenérica:

```sql
CREATE TABLE media_links (
  media_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'direct',
  PRIMARY KEY (media_id, entity_type, entity_id),
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);
```

Valores previstos:

- `provider`: `youtube`, `spotify`, `mp3`, `video`, `audio`, `other`
- `media_kind`: `video`, `audio`, `playlist`, `external`
- `entity_type`: `territory`, `copla`, `piece`

Notas:

- `entity_id` é `TEXT` porque pode apuntar a `territories.id`, a un `copla.id` serializado ou a un `piece.id` serializado.
- A absorción territorial nunca se garda en `media_links`; calcúlase.

---

## 4. Migración SQL proposta

## 4.1 Estratexia

Como o proxecto aínda está nunha fase temperá, recoméndase unha migración simple:

1. crear unha nova migración SQL `002_curation.sql`
2. facer `ALTER TABLE` cando sexa doado
3. recrear táboas pequenas cando o cambio estrutural o xustifique
4. migrar os datos existentes

## 4.2 Contido orientativo de `002_curation.sql`

```sql
PRAGMA foreign_keys = OFF;

ALTER TABLE coplas ADD COLUMN status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE coplas ADD COLUMN updated_at TEXT;
UPDATE coplas SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE pieces RENAME TO pieces_old;

CREATE TABLE pieces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL DEFAULT '',
  context_territory_id TEXT,
  description TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (context_territory_id) REFERENCES territories(id)
);

INSERT INTO pieces (id, title, slug, description, created_at)
SELECT id, title, slug, description, created_at
FROM pieces_old;

DROP TABLE pieces_old;

ALTER TABLE piece_coplas RENAME TO piece_coplas_old;

CREATE TABLE piece_coplas (
  piece_id INTEGER NOT NULL,
  copla_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  section_label TEXT,
  notes TEXT,
  PRIMARY KEY (piece_id, position),
  FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
  FOREIGN KEY (copla_id) REFERENCES coplas(id) ON DELETE CASCADE
);

INSERT INTO piece_coplas (piece_id, copla_id, position)
SELECT piece_id, copla_id, position
FROM piece_coplas_old;

DROP TABLE piece_coplas_old;

ALTER TABLE media RENAME TO media_old;

CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'other',
  media_kind TEXT NOT NULL DEFAULT 'external',
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  author_or_source TEXT,
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO media (id, title, url, description)
SELECT id, title, url, description
FROM media_old;

DROP TABLE media_old;

ALTER TABLE media_links RENAME TO media_links_old;

CREATE TABLE media_links (
  media_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'direct',
  PRIMARY KEY (media_id, entity_type, entity_id),
  FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
);

INSERT INTO media_links (media_id, entity_type, entity_id)
SELECT media_id, entity_type, entity_id
FROM media_links_old;

DROP TABLE media_links_old;

PRAGMA foreign_keys = ON;
```

Nota:

- `author TEXT NOT NULL DEFAULT ''` úsase para simplificar a migración inicial. Unha vez haxa UI ou importadores, poderase facer obrigatorio con valor real en altas novas.

---

## 5. Regras de absorción territorial

## 5.1 Principio

Só se gardan asociacións directas.

Exemplos:

- unha copla pode estar ligada a `par:...`
- unha peza pode ter `context_territory_id = par:...`
- unha media pode estar ligada a `par:...`

Cando se consulta un territorio superior, recóllense os seus descendentes e agréganse os resultados.

## 5.2 Resultado esperado por entidade

Nunha vista de territorio:

- `coplas`: as ligadas ao territorio actual e aos seus descendentes
- `pezas`: as contextualizadas no territorio actual ou descendentes, e opcionalmente tamén as que conteñan coplas dese ámbito
- `media`: a ligada ao territorio actual, aos descendentes e, se se quere, a coplas/pezas absorbidas

## 5.3 Sitio onde calcular a absorción

Curto prazo:

- no exportador Python

Medio prazo:

- en funcións compartidas de backend para evitar duplicar lóxica entre exports e administración

Non se recomenda:

- calcular absorción no frontend con datos crus cando o volume medre

---

## 6. Contratos JSON de importación

## 6.1 Importación de coplas

Formato de lote:

```json
{
  "coplas": [
    {
      "text": "Teño unha casiña branca\ná beiriña do camiño",
      "notes": "",
      "tags": ["amor", "muiñeira"],
      "territories": [
        { "id": "par:360..." }
      ],
      "status": "published"
    }
  ]
}
```

Regras:

- `text` obrigatorio
- `notes` opcional, string
- `tags` opcional, lista de strings
- `territories` opcional, lista de obxectos con `id`
- `status` opcional, por defecto `published`

## 6.2 Importación de pezas

Formato de lote:

```json
{
  "pieces": [
    {
      "title": "Muiñeira de Toutón",
      "slug": "muineira-de-touton",
      "author": "Alejandro",
      "context_territory_id": "par:360...",
      "description": "Montaxe feita a partir de coplas recollidas en Toutón.",
      "notes": "",
      "status": "draft",
      "coplas": [
        { "copla_id": 12, "position": 1 },
        { "copla_id": 18, "position": 2 },
        { "copla_id": 19, "position": 3 }
      ]
    }
  ]
}
```

Regras:

- `title`, `slug`, `author` obrigatorios
- `context_territory_id` recomendado
- `coplas` obrigatorio, lista non baleira
- `position` único dentro de cada peza

## 6.3 Importación de media

Formato de lote:

```json
{
  "media": [
    {
      "provider": "youtube",
      "media_kind": "video",
      "title": "Melodía 1: Xota",
      "url": "https://www.youtube.com/watch?v=...",
      "description": "",
      "author_or_source": "",
      "thumbnail_url": "",
      "status": "published",
      "links": [
        { "entity_type": "territory", "entity_id": "par:360..." }
      ]
    }
  ]
}
```

Regras:

- `provider`, `media_kind`, `title`, `url` obrigatorios
- `links` obrigatorio, lista non baleira
- `entity_type` debe ser `territory`, `copla` ou `piece`

---

## 7. Contratos JSON de exportación para a web

## 7.1 `territorios.json`

Pode manter o formato actual, pero convén engadir campos derivados se van facer falta na UI:

```json
[
  {
    "id": "par:360...",
    "tipo": "par",
    "cod": 123,
    "nome": "Toutón",
    "slug": "touton",
    "search": "touton",
    "prov": 36,
    "com": 3601,
    "con": 36030,
    "parent_id": "con:36030"
  }
]
```

## 7.2 `coplas.json`

Export orientado á UI:

```json
[
  {
    "id": 12,
    "text": "Teño unha casiña branca\ná beiriña do camiño",
    "normalized_text": "teno unha casina branca a beirina do camino",
    "incipit": "Teño unha casiña branca",
    "notes": "",
    "status": "published",
    "created_at": "2026-04-19 10:00:00",
    "updated_at": "2026-04-19 10:00:00",
    "territories": [
      {
        "id": "par:360...",
        "nome": "Toutón",
        "tipo": "par",
        "relation_type": "direct",
        "is_direct": 1
      }
    ],
    "tags": ["amor", "muiñeira"]
  }
]
```

## 7.3 `pezas.json`

Export orientado á UI:

```json
[
  {
    "id": 4,
    "title": "Muiñeira de Toutón",
    "slug": "muineira-de-touton",
    "author": "Alejandro",
    "context_territory": {
      "id": "par:360...",
      "nome": "Toutón",
      "tipo": "par"
    },
    "description": "Montaxe para serán.",
    "notes": "",
    "status": "published",
    "created_at": "2026-04-19 10:00:00",
    "updated_at": "2026-04-19 10:00:00",
    "copla_count": 3,
    "coplas": [
      {
        "position": 1,
        "id": 12,
        "incipit": "Teño unha casiña branca",
        "text": "Teño unha casiña branca\ná beiriña do camiño"
      },
      {
        "position": 2,
        "id": 18,
        "incipit": "Fun ao muíño moer",
        "text": "Fun ao muíño moer\nco saco cheo de millo"
      }
    ]
  }
]
```

## 7.4 `media.json`

Export orientado á UI:

```json
[
  {
    "id": 22,
    "provider": "youtube",
    "media_kind": "video",
    "title": "Melodía 1: Xota",
    "url": "https://www.youtube.com/watch?v=...",
    "description": "",
    "author_or_source": "",
    "thumbnail_url": "",
    "status": "published",
    "created_at": "2026-04-19 10:00:00",
    "updated_at": "2026-04-19 10:00:00",
    "links": [
      {
        "entity_type": "territory",
        "entity_id": "par:360..."
      }
    ]
  }
]
```

---

## 8. Pipeline administrativo proposto

Recoméndase unificar os scripts soltos nunha entrada única:

```bash
python3 tools/admin.py init-db
python3 tools/admin.py migrate
python3 tools/admin.py import-territories data/canonical/territorios.json
python3 tools/admin.py import-coplas ficheiro.json
python3 tools/admin.py import-pieces ficheiro.json
python3 tools/admin.py import-media ficheiro.json
python3 tools/admin.py export-web
python3 tools/admin.py check
python3 tools/admin.py pdf-piece 4
python3 tools/admin.py pdf-territory par:360...
```

Comandos mínimos:

- `init-db`: crea a base co esquema inicial
- `migrate`: aplica migracións pendentes
- `import-territories`: importa catálogo territorial
- `import-coplas`: importa lote de coplas
- `import-pieces`: importa lote de pezas
- `import-media`: importa lote de media
- `export-web`: xera todos os JSON para o frontend
- `check`: valida integridade e sincronización
- `pdf-piece`: xera PDF dunha peza
- `pdf-territory`: xera PDF das coplas dun territorio absorbido

## 8.1 Validacións de `check`

Debe comprobar:

- IDs territoriais existentes
- referencias a coplas existentes en pezas
- posicións únicas dentro de cada peza
- slugs únicos
- URLs de media ben formadas
- exports actualizados respecto da base

---

## 9. Implicacións para o frontend

## 9.1 Vista de territorio

A vista de territorio debe pasar a estar composta por tres bloques:

- `Coplas`
- `Pezas`
- `Media`

Curto prazo:

- pestanas ou selector simple

Medio prazo:

- filtros por tipo de visualización
- selección múltiple de coplas para crear pezas

## 9.2 Creador de pezas

Primeira versión:

- botón `Engadir á peza actual` nas coplas
- estado local tipo carriño
- panel con orde das coplas seleccionadas
- formulario final con:
  - título
  - autoría
  - territorio de contexto
  - descrición

Segunda versión:

- edición de pezas existentes
- duplicación de pezas
- exportación PDF

---

## 10. Fases de implementación recomendadas

## Fase 1

- crear migración `002_curation.sql`
- engadir `status` e `updated_at`
- redefinir `pieces` e `media`
- crear `admin.py`

## Fase 2

- crear exportadores de `pezas` e `media`
- crear exportador formal de `territorios`
- crear comando `export-web`

## Fase 3

- actualizar a vista pública de territorio
- engadir listaxes e fichas de pezas
- engadir bloque de media absorbida

## Fase 4

- implementar creador de pezas
- implementar importadores mellorados

## Fase 5

- xeración de PDFs
- revisión de estilos de impresión

---

## 11. Decisións que se recomenda non complicar de inicio

- non crear aínda unha táboa de autores
- non gardar absorcións materializadas
- non introducir versionado complexo de pezas
- non facer aínda edición colaborativa en tempo real
- non depender do frontend público para operacións de administración críticas

Estas decisións simplifican moito a primeira posta en marcha sen pechar portas a futuro.
