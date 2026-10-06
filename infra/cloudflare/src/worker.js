/**
 * Fol e ar · Worker API (fase 1, ampliado)
 *
 * Punto de partida orixinal: 2 endpoints de só lectura para validar que o
 * esquema D1 funcionaba. Isto amplía iso para servir o SITIO REAL contra D1
 * (lectura dinámica coa mesma forma que os JSON estáticos que xera
 * backend/services/exporters.py) e para permitir crear/editar/borrar coplas
 * e recursos de media directamente dende a web, sen pushes/pulls.
 *
 * Deseño deliberado (herdado do esqueleto orixinal):
 *   - Sen ORM: SQL explícito, para comparar doadamente coa lóxica Python
 *     equivalente en backend/services/importers.py e exporters.py.
 *   - CORS restrinxido por ALLOWED_ORIGIN, nunca "*" en produción.
 *   - Formato de erro consistente: { ok: false, error: string }.
 *
 * O frontend estático (frontend/) segue a pedir os datos coma ficheiros JSON
 * (p.ex. "./data/exports/coplas/coplas.json") e as escrituras coma
 * "../api/coplas" / "../api/media" (ver frontend/js/api.js e
 * frontend/js/archive_app.js) -- exactamente igual có servidor Python local
 * (tools/local_server.py). Este Worker intercepta eses mesmos camiños:
 * as rutas /data/exports/*.json respóndense en directo dende D1 (nunca
 * dende un ficheiro estático, que aquí non existe), e todo o demais
 * (HTML/CSS/JS/geojson) cae ao binding ASSETS tal cal está en frontend/.
 *
 * O QUE FALTA (fase 2, ver README.md):
 *   - Endpoints de pezas (pieces/piece_coplas) -- a pestana "Pezas" do
 *     frontend NON funciona aínda contra este Worker.
 *   - Xeración de PDF (depende de Cloudflare Browser Rendering, sen empezar).
 *   - POST /api/submissions (achegas públicas pendentes de revisión).
 *   - Turnstile + rate limiting nas rutas públicas de escritura.
 *   - Autenticación: login con Google e roles (foleante / guia / admin)
 *     máis abaixo, na sección "Identidade e roles". A consulta é libre; as
 *     escrituras (coplas, media, melodías) piden rol guía ou admin e os
 *     PDFs piden estar logueada (calquera rol).
 *   - Atomicidade parcial: cada copla do payload procésase coas súas
 *     propias escrituras secuenciais (non hai unha soa transacción que
 *     cubra TODAS as coplas dun payload con varias á vez); un fallo a
 *     metade dun payload de varias coplas pode deixar as anteriores xa
 *     escritas. Para o uso normal (editar unha copla de cada vez dende a
 *     web) isto non chega a ser un problema real.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    "x-content-type-options": "nosniff",
  };
}

function jsonResponse(data, { status = 200, env } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) },
  });
}

function errorResponse(message, { status = 400, env } = {}) {
  return jsonResponse({ ok: false, error: message }, { status, env });
}

// ---------------------------------------------------------------------
// Utilidades de texto (espello de backend/services/text_utils.py)
// ---------------------------------------------------------------------

function normalizeText(text) {
  const value = String(text || "").trim().toLowerCase();
  const decomposed = value.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return decomposed.split(/\s+/).filter(Boolean).join(" ");
}

function slugify(text) {
  return normalizeText(text).replace(/ /g, "-");
}

function makeIncipit(text, maxWords = 6) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

async function getOrCreateTag(db, tagName) {
  const existing = await db.prepare("SELECT id FROM tags WHERE name = ?").bind(tagName).first();
  if (existing) return existing.id;
  const result = await db
    .prepare("INSERT INTO tags (name, slug) VALUES (?, ?)")
    .bind(tagName, slugify(tagName))
    .run();
  return result.meta.last_row_id;
}

// ---------------------------------------------------------------------
// Lectura dinámica (espello de backend/services/exporters.py)
// ---------------------------------------------------------------------

async function handleTerritories(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, tipo, cod, nome, slug, search,
            prov_cod AS prov, com_cod AS com, con_cod AS con, parent_id
     FROM territories
     ORDER BY tipo, nome`
  ).all();
  return jsonResponse(results, { env });
}

async function handleCoplas(env, url) {
  const territoryId = url.searchParams.get("territory_id");
  const limitParam = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;
  const offsetParam = Number(url.searchParams.get("offset") || 0);
  const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

  let query = `
    SELECT c.id, c.text, c.normalized_text, c.incipit, c.notes, c.status,
           c.territory_state, c.created_at, c.updated_at
    FROM coplas c`;
  const bindings = [];

  if (territoryId) {
    query += `
    WHERE c.id IN (
      SELECT copla_id FROM copla_territories WHERE territory_id = ?
    )`;
    bindings.push(territoryId);
  }

  query += " ORDER BY c.id DESC LIMIT ? OFFSET ?";
  bindings.push(limit, offset);

  const { results } = await env.DB.prepare(query).bind(...bindings).all();
  return jsonResponse({ items: results, limit, offset }, { env });
}

async function exportTerritoriosJson(env) {
  const { results: rows } = await env.DB.prepare(
    `SELECT id, tipo, cod, nome, slug, search,
            prov_cod AS prov, com_cod AS com, con_cod AS con, parent_id
     FROM territories
     ORDER BY tipo, nome`
  ).all();

  const { results: traitRows } = await env.DB.prepare(
    `SELECT id, territory_id, trait, category, notes
     FROM territory_traits
     ORDER BY territory_id, category, trait`
  ).all();

  const traitsByTerritory = new Map();
  for (const trait of traitRows) {
    const list = traitsByTerritory.get(trait.territory_id) || [];
    list.push({ id: trait.id, trait: trait.trait, category: trait.category, notes: trait.notes });
    traitsByTerritory.set(trait.territory_id, list);
  }

  return rows.map(row => ({ ...row, traits: traitsByTerritory.get(row.id) || [] }));
}

async function exportCoplasJson(env) {
  // Consultas en bloque (5 no total), en paralelo, en vez dunha consulta
  // por copla/version (chegaba a ~472 voltas de rede para 156 coplas).
  // Verificado byte-a-byte idéntico á versión anterior antes de trocalo
  // (ver infra/cloudflare/scripts, test local con node:sqlite).
  const [
    { results: coplas },
    { results: territoryRows },
    { results: tagRows },
    { results: versionRows },
    { results: versionTerritoryRows },
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT id, text, normalized_text, incipit, notes, status,
              territory_state, is_volta, created_at, updated_at
       FROM coplas
       ORDER BY id DESC`
    ).all(),
    env.DB.prepare(
      `SELECT ct.copla_id AS copla_id, t.id AS id, t.nome AS nome, t.tipo AS tipo,
              ct.relation_type AS relation_type, ct.is_direct AS is_direct
       FROM copla_territories ct
       JOIN territories t ON t.id = ct.territory_id
       ORDER BY ct.copla_id, t.tipo, t.nome`
    ).all(),
    env.DB.prepare(
      `SELECT ct.copla_id AS copla_id, tg.name AS name
       FROM copla_tags ct
       JOIN tags tg ON tg.id = ct.tag_id
       ORDER BY ct.copla_id, tg.name`
    ).all(),
    env.DB.prepare(
      `SELECT id, copla_id, label, text, normalized_text, incipit, notes, position, created_at, updated_at
       FROM copla_versions
       ORDER BY copla_id, position ASC, id ASC`
    ).all(),
    env.DB.prepare(
      `SELECT cvt.version_id AS version_id, t.id AS id, t.nome AS nome, t.tipo AS tipo
       FROM copla_version_territories cvt
       JOIN territories t ON t.id = cvt.territory_id
       ORDER BY cvt.version_id, t.tipo, t.nome`
    ).all(),
  ]);

  const territoriesByCopla = new Map();
  for (const row of territoryRows) {
    const list = territoriesByCopla.get(row.copla_id) || [];
    list.push({ id: row.id, nome: row.nome, tipo: row.tipo, relation_type: row.relation_type, is_direct: row.is_direct });
    territoriesByCopla.set(row.copla_id, list);
  }

  const tagsByCopla = new Map();
  for (const row of tagRows) {
    const list = tagsByCopla.get(row.copla_id) || [];
    list.push(row.name);
    tagsByCopla.set(row.copla_id, list);
  }

  const versionTerritoriesByVersion = new Map();
  for (const row of versionTerritoryRows) {
    const list = versionTerritoriesByVersion.get(row.version_id) || [];
    list.push({ id: row.id, nome: row.nome, tipo: row.tipo });
    versionTerritoriesByVersion.set(row.version_id, list);
  }

  const versionsByCopla = new Map();
  for (const version of versionRows) {
    const versionTerritories = versionTerritoriesByVersion.get(version.id) || [];
    const list = versionsByCopla.get(version.copla_id) || [];
    list.push({
      id: version.id,
      label: version.label,
      text: version.text,
      normalized_text: version.normalized_text,
      incipit: version.incipit,
      notes: version.notes,
      position: version.position,
      created_at: version.created_at,
      updated_at: version.updated_at,
      territory_mode: versionTerritories.length ? "custom" : "inherit",
      territories: versionTerritories,
    });
    versionsByCopla.set(version.copla_id, list);
  }

  return coplas.map(copla => ({
    id: copla.id,
    text: copla.text,
    normalized_text: copla.normalized_text,
    incipit: copla.incipit,
    notes: copla.notes,
    status: copla.status,
    territory_state: copla.territory_state,
    is_volta: Boolean(copla.is_volta),
    created_at: copla.created_at,
    updated_at: copla.updated_at,
    territories: territoriesByCopla.get(copla.id) || [],
    tags: tagsByCopla.get(copla.id) || [],
    versions: versionsByCopla.get(copla.id) || [],
  }));
}

async function exportMediaJson(env) {
  // Consultas en bloque (2), en paralelo, en vez dunha consulta por media
  // (antes 1+N). Verificado idéntico á versión anterior antes de trocalo.
  const [{ results: mediaRows }, { results: linkRows }] = await Promise.all([
    env.DB.prepare(
      `SELECT id, provider, media_kind, title, url, description,
              author_or_source, thumbnail_url, status, created_at, updated_at
       FROM media
       ORDER BY updated_at DESC, id DESC`
    ).all(),
    env.DB.prepare(
      `SELECT media_id, entity_type, entity_id, relation_type
       FROM media_links
       ORDER BY media_id, entity_type, entity_id`
    ).all(),
  ]);

  const linksByMedia = new Map();
  for (const row of linkRows) {
    const list = linksByMedia.get(row.media_id) || [];
    list.push({ entity_type: row.entity_type, entity_id: row.entity_id, relation_type: row.relation_type });
    linksByMedia.set(row.media_id, list);
  }

  return mediaRows.map(media => ({ ...media, links: linksByMedia.get(media.id) || [] }));
}

// Melodías (inventario). Se a migración 0002 aínda non se aplicou na D1, a
// táboa non existe: nese caso devólvese [] e o resto da aplicación segue a
// funcionar igual que antes.
async function loadMelodiesOrEmpty(env, sql) {
  try {
    const { results } = await env.DB.prepare(sql).all();
    return results;
  } catch (err) {
    if (/no such table: melodies/i.test(String(err && err.message))) return [];
    throw err;
  }
}

async function exportMelodiasJson(env) {
  const rows = await loadMelodiesOrEmpty(
    env,
    `SELECT m.id, m.territory_id, m.rhythm, m.number, m.notes, m.created_at, m.updated_at,
            t.nome AS territory_nome
     FROM melodies m
     JOIN territories t ON t.id = m.territory_id
     ORDER BY t.nome, m.rhythm_key, m.number`
  );
  return rows.map(row => ({
    id: row.id,
    territory_id: row.territory_id,
    rhythm: row.rhythm,
    number: row.number,
    name: `${row.rhythm} número ${row.number} de ${row.territory_nome}`,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

// ---------------------------------------------------------------------
// Validación (espello de backend/services/importers.py)
// ---------------------------------------------------------------------

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function validateCoplasPayload(env, payload) {
  const errors = [];
  if (!payload || !Array.isArray(payload.coplas)) {
    return ["O JSON debe ser un obxecto con clave 'coplas' en forma de lista."];
  }

  const { results: territoryRows } = await env.DB.prepare("SELECT id FROM territories").all();
  const knownTerritories = new Set(territoryRows.map(row => row.id));
  const { results: coplaRows } = await env.DB.prepare("SELECT id FROM coplas").all();
  const knownCoplaIds = new Set(coplaRows.map(row => row.id));

  payload.coplas.forEach((copla, index) => {
    const label = `Copla #${index + 1}`;
    if (typeof copla !== "object" || copla === null) {
      errors.push(`${label}: debe ser un obxecto.`);
      return;
    }
    const coplaId = copla.id;
    if (coplaId !== undefined && coplaId !== null) {
      if (!Number.isInteger(coplaId)) {
        errors.push(`${label}: 'id' debe ser enteiro cando existe.`);
      } else if (!knownCoplaIds.has(coplaId)) {
        errors.push(`${label}: non existe unha copla co id ${coplaId}.`);
      }
    }
    if (typeof copla.text !== "string" || !copla.text.trim()) {
      errors.push(`${label}: falta 'text' ou está baleiro.`);
    }
    if (copla.notes !== undefined && copla.notes !== null && typeof copla.notes !== "string") {
      errors.push(`${label}: 'notes' debe ser string.`);
    }
    const status = copla.status ?? "published";
    if (!["draft", "published"].includes(status)) {
      errors.push(`${label}: 'status' debe ser 'draft' ou 'published'.`);
    }
    const territoryState = copla.territory_state ?? "assigned";
    if (!["assigned", "unassigned", "general"].includes(territoryState)) {
      errors.push(`${label}: 'territory_state' debe ser 'assigned', 'unassigned' ou 'general'.`);
    }
    if (copla.is_volta !== undefined && typeof copla.is_volta !== "boolean") {
      errors.push(`${label}: 'is_volta' debe ser booleano.`);
    }
    const tags = copla.tags ?? [];
    if (!Array.isArray(tags)) errors.push(`${label}: 'tags' debe ser unha lista.`);

    const versions = copla.versions ?? [];
    if (!Array.isArray(versions)) {
      errors.push(`${label}: 'versions' debe ser unha lista.`);
    } else {
      versions.forEach((version, vIndex) => {
        const vLabel = `${label}, versión #${vIndex + 1}`;
        if (typeof version !== "object" || version === null) {
          errors.push(`${vLabel}: debe ser un obxecto.`);
          return;
        }
        if (typeof version.text !== "string" || !version.text.trim()) {
          errors.push(`${vLabel}: falta 'text' ou está baleiro.`);
        }
        if (version.notes !== undefined && version.notes !== null && typeof version.notes !== "string") {
          errors.push(`${vLabel}: 'notes' debe ser string.`);
        }
        const versionTerritories = version.territories ?? [];
        if (!Array.isArray(versionTerritories)) {
          errors.push(`${vLabel}: 'territories' debe ser unha lista.`);
        } else {
          for (const territory of versionTerritories) {
            const territoryId = territory && typeof territory === "object" ? territory.id : null;
            if (!territoryId || !knownTerritories.has(territoryId)) {
              errors.push(`${vLabel}: territorio descoñecido: ${territoryId}`);
            }
          }
        }
      });
    }

    const territories = copla.territories ?? [];
    if (!Array.isArray(territories)) {
      errors.push(`${label}: 'territories' debe ser unha lista.`);
    } else {
      for (const territory of territories) {
        if (typeof territory !== "object" || territory === null || !territory.id) {
          errors.push(`${label}: hai un territorio sen 'id' válido.`);
          continue;
        }
        if (!knownTerritories.has(territory.id)) {
          errors.push(`${label}: territorio descoñecido: ${territory.id}`);
        }
      }
    }
    if (territoryState === "assigned" && territories.length === 0) {
      errors.push(`${label}: se 'territory_state' é 'assigned', cómpre indicar algún territorio.`);
    }
    if (territoryState !== "assigned" && territories.length > 0) {
      errors.push(`${label}: se 'territory_state' non é 'assigned', a lista de territorios debe ir baleira.`);
    }
  });

  return errors;
}

async function validateMediaPayload(env, payload) {
  const errors = [];
  if (!payload || !Array.isArray(payload.media)) {
    return ["O JSON debe ser un obxecto con clave 'media' en forma de lista."];
  }

  const { results: territoryRows } = await env.DB.prepare("SELECT id FROM territories").all();
  const knownTerritories = new Set(territoryRows.map(row => row.id));
  const { results: coplaRows } = await env.DB.prepare("SELECT id FROM coplas").all();
  const knownCoplas = new Set(coplaRows.map(row => row.id));
  const { results: pieceRows } = await env.DB.prepare("SELECT id FROM pieces").all();
  const knownPieces = new Set(pieceRows.map(row => row.id));
  const melodyRows = await loadMelodiesOrEmpty(env, "SELECT id FROM melodies");
  const knownMelodies = new Set(melodyRows.map(row => row.id));
  const { results: mediaRows } = await env.DB.prepare("SELECT id FROM media").all();
  const knownMediaIds = new Set(mediaRows.map(row => row.id));

  payload.media.forEach((media, index) => {
    const label = `Media #${index + 1}`;
    if (typeof media !== "object" || media === null) {
      errors.push(`${label}: debe ser un obxecto.`);
      return;
    }
    const mediaId = media.id;
    if (mediaId !== undefined && mediaId !== null) {
      if (!Number.isInteger(mediaId)) {
        errors.push(`${label}: 'id' debe ser enteiro cando existe.`);
      } else if (!knownMediaIds.has(mediaId)) {
        errors.push(`${label}: non existe unha media co id ${mediaId}.`);
      }
    }
    for (const field of ["provider", "media_kind", "title", "url"]) {
      if (typeof media[field] !== "string" || !media[field].trim()) {
        errors.push(`${label}: falta '${field}' ou está baleiro.`);
      }
    }
    if (typeof media.url === "string" && !isValidUrl(media.url)) {
      errors.push(`${label}: URL non válida: ${media.url}`);
    }
    const status = media.status ?? "published";
    if (!["draft", "published"].includes(status)) {
      errors.push(`${label}: 'status' debe ser 'draft' ou 'published'.`);
    }
    const links = media.links;
    if (!Array.isArray(links) || links.length === 0) {
      errors.push(`${label}: 'links' debe ser unha lista non baleira.`);
      return;
    }
    for (const link of links) {
      if (typeof link !== "object" || link === null) {
        errors.push(`${label}: cada link debe ser un obxecto.`);
        continue;
      }
      const entityType = link.entity_type;
      const entityId = link.entity_id;
      if (!["territory", "copla", "piece", "melody"].includes(entityType)) {
        errors.push(`${label}: entity_type non válido: ${entityType}`);
        continue;
      }
      if (entityType === "territory" && !knownTerritories.has(entityId)) {
        errors.push(`${label}: territorio descoñecido: ${entityId}`);
      }
      if (entityType === "copla") {
        const numericId = Number(entityId);
        if (!Number.isInteger(numericId)) {
          errors.push(`${label}: copla_id non válido: ${entityId}`);
        } else if (!knownCoplas.has(numericId)) {
          errors.push(`${label}: copla descoñecida: ${entityId}`);
        }
      }
      if (entityType === "piece") {
        const numericId = Number(entityId);
        if (!Number.isInteger(numericId)) {
          errors.push(`${label}: piece_id non válido: ${entityId}`);
        } else if (!knownPieces.has(numericId)) {
          errors.push(`${label}: peza descoñecida: ${entityId}`);
        }
      }
      if (entityType === "melody") {
        const numericId = Number(entityId);
        if (!Number.isInteger(numericId)) {
          errors.push(`${label}: melody_id non válido: ${entityId}`);
        } else if (!knownMelodies.has(numericId)) {
          errors.push(`${label}: melodía descoñecida: ${entityId}`);
        }
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------
// Escritura (espello de backend/services/importers.py)
// ---------------------------------------------------------------------

async function importCoplas(env, payload) {
  const errors = await validateCoplasPayload(env, payload);
  if (errors.length) throw new Error(errors.join("\n"));

  const db = env.DB;
  const importedIds = [];

  for (const copla of payload.coplas) {
    const text = copla.text.trim();
    const normalized = normalizeText(text);
    const incipit = makeIncipit(text);
    const notes = copla.notes || null;
    const status = copla.status ?? "published";
    const territoryState = copla.territory_state ?? "assigned";
    const isVolta = copla.is_volta ? 1 : 0;
    let coplaId = copla.id;

    if (Number.isInteger(coplaId)) {
      await db.prepare(
        `UPDATE coplas
         SET text = ?, normalized_text = ?, incipit = ?, notes = ?, status = ?,
             territory_state = ?, is_volta = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(text, normalized, incipit, notes, status, territoryState, isVolta, coplaId).run();
      await db.prepare("DELETE FROM copla_territories WHERE copla_id = ?").bind(coplaId).run();
      await db.prepare("DELETE FROM copla_tags WHERE copla_id = ?").bind(coplaId).run();
    } else {
      const result = await db.prepare(
        `INSERT INTO coplas (text, normalized_text, incipit, notes, status, territory_state, is_volta, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(text, normalized, incipit, notes, status, territoryState, isVolta).run();
      coplaId = result.meta.last_row_id;
    }
    importedIds.push(coplaId);

    await db.prepare("DELETE FROM copla_versions WHERE copla_id = ?").bind(coplaId).run();
    const versions = copla.versions ?? [];
    for (let i = 0; i < versions.length; i += 1) {
      const version = versions[i];
      const position = i + 1;
      const versionText = version.text.trim();
      const versionResult = await db.prepare(
        `INSERT INTO copla_versions (copla_id, label, text, normalized_text, incipit, notes, position, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(
        coplaId,
        version.label || null,
        versionText,
        normalizeText(versionText),
        makeIncipit(versionText),
        version.notes || null,
        position,
      ).run();
      const versionId = versionResult.meta.last_row_id;
      for (const territory of version.territories ?? []) {
        await db.prepare(
          "INSERT INTO copla_version_territories (version_id, territory_id) VALUES (?, ?)"
        ).bind(versionId, territory.id).run();
      }
    }

    for (const territory of copla.territories ?? []) {
      await db.prepare(
        `INSERT INTO copla_territories (copla_id, territory_id, relation_type, is_direct)
         VALUES (?, ?, 'direct', 1)`
      ).bind(coplaId, territory.id).run();
    }

    for (const rawTag of copla.tags ?? []) {
      const tagName = normalizeText(rawTag);
      if (!tagName) continue;
      const tagId = await getOrCreateTag(db, tagName);
      await db.prepare("INSERT OR IGNORE INTO copla_tags (copla_id, tag_id) VALUES (?, ?)")
        .bind(coplaId, tagId).run();
    }
  }

  return importedIds;
}

async function deleteCoplas(env, coplaIds) {
  if (!Array.isArray(coplaIds) || coplaIds.length === 0) {
    throw new Error("Cómpre indicar polo menos un ID de copla para borrar.");
  }
  const ids = coplaIds.map(id => {
    if (!Number.isInteger(id)) throw new Error(`ID de copla non válido: ${JSON.stringify(id)}.`);
    return id;
  });

  const { results: coplaRows } = await env.DB.prepare("SELECT id FROM coplas").all();
  const knownIds = new Set(coplaRows.map(row => row.id));
  const missing = ids.filter(id => !knownIds.has(id));
  if (missing.length) {
    throw new Error(`Non existe ningunha copla con estes IDs: [${missing.join(", ")}].`);
  }

  for (const coplaId of ids) {
    await env.DB.prepare(
      "DELETE FROM media_links WHERE entity_type = 'copla' AND entity_id = ?"
    ).bind(String(coplaId)).run();
    await env.DB.prepare("DELETE FROM coplas WHERE id = ?").bind(coplaId).run();
  }
  return ids;
}

async function importMedia(env, payload) {
  const errors = await validateMediaPayload(env, payload);
  if (errors.length) throw new Error(errors.join("\n"));

  const db = env.DB;
  const importedIds = [];

  for (const media of payload.media) {
    let mediaId = media.id;
    if (Number.isInteger(mediaId)) {
      await db.prepare(
        `UPDATE media
         SET provider = ?, media_kind = ?, title = ?, url = ?, description = ?,
             author_or_source = ?, thumbnail_url = ?, status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(
        media.provider.trim(), media.media_kind.trim(), media.title.trim(), media.url.trim(),
        media.description || null, media.author_or_source || null, media.thumbnail_url || null,
        media.status || "published", mediaId,
      ).run();
      await db.prepare("DELETE FROM media_links WHERE media_id = ?").bind(mediaId).run();
    } else {
      const result = await db.prepare(
        `INSERT INTO media (provider, media_kind, title, url, description, author_or_source, thumbnail_url, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(
        media.provider.trim(), media.media_kind.trim(), media.title.trim(), media.url.trim(),
        media.description || null, media.author_or_source || null, media.thumbnail_url || null,
        media.status || "published",
      ).run();
      mediaId = result.meta.last_row_id;
    }
    importedIds.push(mediaId);

    for (const link of media.links ?? []) {
      await db.prepare(
        "INSERT INTO media_links (media_id, entity_type, entity_id, relation_type) VALUES (?, ?, ?, ?)"
      ).bind(mediaId, link.entity_type, String(link.entity_id), link.relation_type || "direct").run();
    }
  }

  return importedIds;
}

async function deleteMedia(env, mediaIds) {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throw new Error("Cómpre indicar polo menos un ID de recurso para borrar.");
  }
  const ids = mediaIds.map(id => {
    if (!Number.isInteger(id)) throw new Error(`ID de recurso non válido: ${JSON.stringify(id)}.`);
    return id;
  });

  const { results: mediaRows } = await env.DB.prepare("SELECT id FROM media").all();
  const knownIds = new Set(mediaRows.map(row => row.id));
  const missing = ids.filter(id => !knownIds.has(id));
  if (missing.length) {
    throw new Error(`Non existe ningún recurso con estes IDs: [${missing.join(", ")}].`);
  }

  for (const mediaId of ids) {
    // media_links.media_id ten ON DELETE CASCADE real, abonda con isto.
    await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(mediaId).run();
  }
  return ids;
}


// ---------------------------------------------------------------------
// Melodías (espello de import_melodies / delete_melodies en Python)
// ---------------------------------------------------------------------

const MAX_RHYTHM_LENGTH = 60;

async function validateMelodiesPayload(env, payload) {
  if (!payload || !Array.isArray(payload.melodies)) {
    return ["O JSON debe ser un obxecto con clave 'melodies' en forma de lista."];
  }
  const { results: territoryRows } = await env.DB.prepare("SELECT id FROM territories").all();
  const knownTerritories = new Set(territoryRows.map(row => row.id));
  const knownMelodies = new Set((await env.DB.prepare("SELECT id FROM melodies").all()).results.map(row => row.id));
  const errors = [];
  payload.melodies.forEach((melody, index) => {
    const label = `Melodía #${index + 1}`;
    if (typeof melody !== "object" || melody === null) {
      errors.push(`${label}: debe ser un obxecto.`);
      return;
    }
    const melodyId = melody.id;
    if (melodyId !== undefined && melodyId !== null) {
      if (!Number.isInteger(melodyId)) {
        errors.push(`${label}: 'id' debe ser enteiro cando existe.`);
        return;
      }
      if (!knownMelodies.has(melodyId)) {
        errors.push(`${label}: non existe unha melodía co id ${melodyId}.`);
        return;
      }
    }
    if (melody._delete) {
      if (melodyId === undefined || melodyId === null) errors.push(`${label}: falta 'id' para borrar.`);
      return;
    }
    if (typeof melody.territory_id !== "string" || !knownTerritories.has(melody.territory_id)) {
      errors.push(`${label}: territorio descoñecido: ${melody.territory_id}`);
    }
    if (typeof melody.rhythm !== "string" || !melody.rhythm.trim()) {
      errors.push(`${label}: falta 'rhythm' ou está baleiro.`);
    } else if (melody.rhythm.trim().length > MAX_RHYTHM_LENGTH) {
      errors.push(`${label}: o ritmo é demasiado longo.`);
    }
    if (melody.number !== undefined && melody.number !== null && (!Number.isInteger(melody.number) || melody.number < 1)) {
      errors.push(`${label}: 'number' debe ser un enteiro maior ca 0.`);
    }
    if (melody.notes !== undefined && melody.notes !== null && typeof melody.notes !== "string") {
      errors.push(`${label}: 'notes' debe ser texto.`);
    }
  });
  return errors;
}

async function canonicalMelodyRhythm(db, rhythm, rhythmKey) {
  const row = await db.prepare(
    "SELECT rhythm FROM melodies WHERE rhythm_key = ? ORDER BY id LIMIT 1"
  ).bind(rhythmKey).first();
  if (row) return row.rhythm;
  return rhythm.charAt(0).toUpperCase() + rhythm.slice(1);
}

async function nextMelodyNumber(db, territoryId, rhythmKey) {
  const row = await db.prepare(
    "SELECT COALESCE(MAX(number), 0) + 1 AS next FROM melodies WHERE territory_id = ? AND rhythm_key = ?"
  ).bind(territoryId, rhythmKey).first();
  return Number(row.next);
}

async function deleteMelodyRows(db, melodyId) {
  const melody = await db.prepare("SELECT territory_id FROM melodies WHERE id = ?").bind(melodyId).first();
  const { results: links } = await db.prepare(
    "SELECT media_id, relation_type FROM media_links WHERE entity_type = 'melody' AND entity_id = ?"
  ).bind(String(melodyId)).all();
  await db.prepare("DELETE FROM media_links WHERE entity_type = 'melody' AND entity_id = ?").bind(String(melodyId)).run();
  for (const link of links) {
    const remaining = await db.prepare("SELECT COUNT(*) AS total FROM media_links WHERE media_id = ?").bind(link.media_id).first();
    if (remaining.total === 0 && melody) {
      await db.prepare(
        "INSERT OR IGNORE INTO media_links (media_id, entity_type, entity_id, relation_type) VALUES (?, 'territory', ?, ?)"
      ).bind(link.media_id, melody.territory_id, link.relation_type || "direct").run();
    }
  }
  await db.prepare("DELETE FROM melodies WHERE id = ?").bind(melodyId).run();
}

async function importMelodies(env, payload) {
  const errors = await validateMelodiesPayload(env, payload);
  if (errors.length) throw new Error(errors.join("\n"));

  const db = env.DB;
  const affectedIds = [];
  for (const melody of payload.melodies) {
    let melodyId = Number.isInteger(melody.id) ? melody.id : null;

    if (melody._delete) {
      await deleteMelodyRows(db, melodyId);
      affectedIds.push(melodyId);
      continue;
    }

    const territoryId = melody.territory_id;
    let rhythm = melody.rhythm.trim().split(/\s+/).join(" ");
    const rhythmKey = normalizeText(rhythm);
    rhythm = await canonicalMelodyRhythm(db, rhythm, rhythmKey);
    const notes = (melody.notes || "").trim() || null;
    let number = Number.isInteger(melody.number) ? melody.number : null;

    let current = null;
    if (melodyId !== null) {
      current = await db.prepare(
        "SELECT territory_id, rhythm_key, number FROM melodies WHERE id = ?"
      ).bind(melodyId).first();
      const sameGroup = current.territory_id === territoryId && current.rhythm_key === rhythmKey;
      if (number === null) number = sameGroup ? current.number : await nextMelodyNumber(db, territoryId, rhythmKey);
    } else if (number === null) {
      number = await nextMelodyNumber(db, territoryId, rhythmKey);
    }

    const clash = await db.prepare(
      `SELECT id FROM melodies
       WHERE territory_id = ? AND rhythm_key = ? AND number = ? AND id IS NOT ?`
    ).bind(territoryId, rhythmKey, number, melodyId).first();
    if (clash) throw new Error(`Xa existe a melodía ${rhythm} número ${number} neste territorio.`);

    if (current) {
      await db.prepare(
        `UPDATE melodies
         SET territory_id = ?, rhythm = ?, rhythm_key = ?, number = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(territoryId, rhythm, rhythmKey, number, notes, melodyId).run();
    } else {
      const result = await db.prepare(
        `INSERT INTO melodies (territory_id, rhythm, rhythm_key, number, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(territoryId, rhythm, rhythmKey, number, notes).run();
      melodyId = result.meta.last_row_id;
    }
    affectedIds.push(melodyId);
  }
  return affectedIds;
}

async function deleteMelodies(env, melodyIds) {
  if (!Array.isArray(melodyIds) || melodyIds.length === 0) {
    throw new Error("Cómpre indicar polo menos un ID de melodía para borrar.");
  }
  const ids = melodyIds.map(id => {
    if (!Number.isInteger(id)) throw new Error(`ID de melodía non válido: ${JSON.stringify(id)}.`);
    return id;
  });
  const known = new Set((await env.DB.prepare("SELECT id FROM melodies").all()).results.map(row => row.id));
  const missing = ids.filter(id => !known.has(id));
  if (missing.length) throw new Error(`Non existe ningunha melodía con estes IDs: [${missing.join(", ")}].`);
  for (const id of ids) await deleteMelodyRows(env.DB, id);
  return ids;
}


// ---------------------------------------------------------------------
// Vista previa de ligazóns ("Obter datos" no formulario de recursos).
// Espello de /api/link-preview de tools/local_server.py: le as etiquetas
// og:/twitter:/title da páxina e devolve título, descrición, miniatura,
// proveedor e autoría. Para YouTube, Spotify e SoundCloud, se a páxina non
// dá datos útiles (os servidores de Cloudflare reciben pantallas de
// consentimento ou bloqueos que o teu ordenador non), usa o seu oEmbed.
// ---------------------------------------------------------------------

const PREVIEW_MAX_BYTES = 512000;

function decodeHtmlEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", copy: "©" };
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const value = named[entity.toLowerCase()];
    return value !== undefined ? value : match;
  });
}

function parseLinkPreviewHtml(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const found of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[found[1].toLowerCase()] = decodeHtmlEntities(found[2] ?? found[3] ?? "");
    }
    const key = attrs.property || attrs.name;
    if (key && attrs.content) meta[key] = attrs.content;
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { meta, title: titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "" };
}

async function readLimitedText(response, limit) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(merged);
}

const CONSENT_TITLES = /before you continue|antes de continuar|just a moment|access denied|attention required/i;

function oembedEndpoint(target) {
  const host = new URL(target).hostname.replace(/^www\./, "").replace(/^m\./, "");
  const encoded = encodeURIComponent(target);
  if (host === "youtube.com" || host === "youtu.be") return `https://www.youtube.com/oembed?format=json&url=${encoded}`;
  if (host === "open.spotify.com") return `https://open.spotify.com/oembed?url=${encoded}`;
  if (host === "soundcloud.com") return `https://soundcloud.com/oembed?format=json&url=${encoded}`;
  return null;
}

async function handleLinkPreview(env, url) {
  const target = url.searchParams.get("url") || "";
  if (!isValidUrl(target)) return errorResponse("URL non válida.", { env });
  if (isInternalHost(new URL(target).hostname)) return errorResponse("Enderezo non permitido.", { status: 403, env });

  const result = { title: null, description: null, thumbnail_url: null, provider: null, author_or_source: null };
  let pageError = null;

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Fol-e-ar-preview/1.0)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "gl,es;q=0.9,en;q=0.8",
        Cookie: "CONSENT=YES+1; SOCS=CAI",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) throw new Error(`O servidor respondeu ${response.status}.`);
    const { meta, title: pageTitle } = parseLinkPreviewHtml(await readLimitedText(response, PREVIEW_MAX_BYTES));
    const description = meta["og:description"] || meta.description || meta["twitter:description"] || null;
    const title = meta["og:title"] || meta["twitter:title"] || pageTitle || null;
    if (title && !CONSENT_TITLES.test(title)) {
      result.title = title;
      result.description = description;
      result.thumbnail_url = meta["og:image"] || meta["twitter:image"] || null;
      result.provider = meta["og:site_name"] || null;
      if ((meta["og:type"] || "").startsWith("music") && description && description.includes(" · ")) {
        // As paxinas de faixa de Spotify formatan a descrición coma
        // "Artista · Cancion · Ano": o primeiro segmento é a autoría.
        const first = description.split(" · ")[0].trim();
        if (first && first.toLowerCase() !== title.trim().toLowerCase()) result.author_or_source = first;
      }
    }
  } catch (error) {
    pageError = error instanceof Error ? error.message : String(error);
  }

  if (!result.title || !result.thumbnail_url) {
    const endpoint = oembedEndpoint(target);
    if (endpoint) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(7000) });
        if (response.ok) {
          const data = await response.json();
          result.title = result.title || data.title || null;
          result.thumbnail_url = result.thumbnail_url || data.thumbnail_url || null;
          result.provider = result.provider || data.provider_name || null;
          result.author_or_source = result.author_or_source || data.author_name || null;
        }
      } catch {
        // Se o oEmbed tamén falla, quedamos co que haxa.
      }
    }
  }

  if (!result.title && !result.thumbnail_url) {
    return errorResponse(pageError || "A páxina non ofrece título nin miniatura.", { env });
  }
  return jsonResponse({ ok: true, ...result }, { env });
}


// ---------------------------------------------------------------------
// Pasarela de PDFs para a miniatura da primeira páxina (pdf.js no
// navegador non pode ler a maioría dos PDFs alleos por CORS). Só serve
// URLs que xa están rexistradas como recurso, e só http/https públicos.
// ---------------------------------------------------------------------

const MAX_PDF_BYTES = 25 * 1024 * 1024;

function isInternalHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return true; // IPv6 literal
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

async function handlePdfProxy(env, url) {
  const target = url.searchParams.get("url") || "";
  if (!isValidUrl(target)) return errorResponse("URL non válida.", { env });
  if (isInternalHost(new URL(target).hostname)) return errorResponse("Enderezo non permitido.", { status: 403, env });
  const known = await env.DB.prepare("SELECT 1 AS ok FROM media WHERE url = ? LIMIT 1").bind(target).first();
  if (!known) return errorResponse("Só se poden previsualizar PDFs rexistrados.", { status: 403, env });

  // Redirecións manuais: cada salto revísase (sen hosts internos).
  let upstream;
  let current = target;
  for (let hop = 0; hop <= 3; hop += 1) {
    upstream = await fetch(current, {
      headers: { "User-Agent": "Fol-e-ar-pdf-preview/1.0", Accept: "application/pdf,*/*" },
      redirect: "manual",
    });
    if (upstream.status < 300 || upstream.status >= 400) break;
    const next = upstream.headers.get("location");
    if (!next || hop === 3) return errorResponse("Demasiadas redireccións.", { status: 502, env });
    current = new URL(next, current).toString();
    if (!isValidUrl(current) || isInternalHost(new URL(current).hostname)) {
      return errorResponse("Enderezo non permitido.", { status: 403, env });
    }
  }
  if (!upstream.ok) return errorResponse(`O servidor do PDF respondeu ${upstream.status}.`, { status: 502, env });
  const declared = Number(upstream.headers.get("content-length") || 0);
  if (declared > MAX_PDF_BYTES) return errorResponse("O PDF é demasiado grande para previsualizalo.", { env });
  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_PDF_BYTES) return errorResponse("O PDF é demasiado grande para previsualizalo.", { env });
  const head = new TextDecoder("latin1").decode(body.slice(0, 1024));
  if (!head.includes("%PDF")) return errorResponse("O recurso non é un PDF.", { env });
  return new Response(body, {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "private, max-age=86400",
      ...corsHeaders(env),
    },
  });
}


// ---------------------------------------------------------------------
// Xeracion de PDF (espello de backend/services/pdf/documents.py e
// renderer.py): o Worker constroe o MESMO HTML que antes renderizaba
// Chrome local, e pidelle a Cloudflare Browser Run (Quick Action /pdf)
// que o converta en PDF -- non fai falla ningun binding de Puppeteer.
// Require dous valores no Worker (ver README "Acceso e secrets"):
//   - CLOUDFLARE_ACCOUNT_ID: variable normal (non e secreto).
//   - BROWSER_RUN_API_TOKEN: secret, token de API con permiso
//     "Browser Rendering - Edit" (creado no dashboard de Cloudflare).
// Dispoñible no plan gratuito: 10 minutos de navegador/dia, abondo para
// exportacions puntuais coma esta.
// ---------------------------------------------------------------------

const PDF_TYPE_LABELS = { prov: "Provincia", com: "Comarca", con: "Concello", par: "Parroquia" };

const PRINT_CSS = `@import url("https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500&display=swap");

@page {
  size: A4;
  margin: 16mm 12mm 16mm;
}

@page {
  @bottom-right {
    content: "fol e ar \\\\ " counter(page);
    color: #6B6B64;
    font-family: "DM Mono", "Courier New", monospace;
    font-size: 8pt;
  }
}

* {
  box-sizing: border-box;
}

body {
  color: #171717;
  font-family: "Inter", "Arial", "Helvetica", sans-serif;
  font-size: 10.5pt;
  line-height: 1.4;
  margin: 0;
}

.document-header {
  border-bottom: 0.4pt solid #D8D8D0;
  margin-bottom: 6mm;
  padding-bottom: 4mm;
}

.brand {
  align-items: baseline;
  color: #171717;
  display: flex;
  gap: 4mm;
  margin-bottom: 5mm;
}

.wordmark {
  font-family: "DM Mono", "Courier New", monospace;
  font-size: 15pt;
  font-weight: 400;
  line-height: 1;
  white-space: nowrap;
}

.wordmark-o {
  display: inline-block;
  height: 0.54em;
  overflow: visible;
  vertical-align: -0.02em;
  width: 0.6em;
}

.wordmark-o path {
  fill: none;
  stroke: #171717;
  stroke-linecap: round;
  stroke-width: 8.4;
}

.wordmark-o circle {
  fill: #C24330;
}

h1 {
  color: #171717;
  font-family: "DM Mono", "Courier New", monospace;
  font-size: 24pt;
  font-weight: 400;
  letter-spacing: -0.02em;
  line-height: 1.08;
  margin: 0 0 3mm;
}

.meta-row {
  color: #6B6B64;
  display: flex;
  flex-wrap: wrap;
  font-family: "DM Mono", "Courier New", monospace;
  font-size: 8.5pt;
  gap: 3mm;
  margin-bottom: 3mm;
}

.meta-row span + span::before {
  color: #8C8C84;
  content: "\\\\";
  margin-right: 3mm;
}

.description,
.notes {
  color: #4A4A45;
  margin: 2mm 0 0;
}

.description:empty,
.notes:empty,
.meta-row:empty {
  display: none;
}

.piece-grid {
  column-count: 2;
  column-fill: auto;
  column-gap: 9mm;
}

.territory-list {
  max-width: 150mm;
}

.part {
  break-inside: auto;
  margin: 0 0 5mm;
}

.part-title {
  break-after: avoid;
  color: #C24330;
  font-family: "DM Mono", "Courier New", monospace;
  font-size: 8.5pt;
  font-weight: 500;
  letter-spacing: 0.06em;
  margin: 0 0 3mm;
  text-transform: uppercase;
}

.copla {
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 0 0 4mm;
}

.copla-text {
  font-family: "DM Mono", "Courier New", monospace;
  font-size: 10pt;
  line-height: 1.38;
  white-space: pre-line;
}

.copla.retrouso .copla-text {
  color: #4A4A45;
  margin-left: 8mm;
}

.copla-meta,
.copla-notes {
  color: #6B6B64;
  font-size: 8pt;
  margin-top: 1.8mm;
}

.copla-notes {
  font-style: italic;
}

.empty {
  color: #6B6B64;
  font-style: italic;
}
`;

function pdfSafeFilename(value, fallback) {
  // Mirror backend/services/pdf/renderer.py::safe_filename() exactly
  // (not the generic slugify() used elsewhere): lowercase, map the
  // common accented Galician letters to plain ASCII, then collapse any
  // run of non [a-z0-9] characters (spaces, parentheses, punctuation)
  // into a single hyphen.
  let text = (value || fallback || "").trim().toLowerCase();
  const accents = { "\u00e1": "a", "\u00e9": "e", "\u00ed": "i", "\u00f3": "o", "\u00fa": "u", "\u00f1": "n", "\u00e7": "c", "\u00fc": "u" };
  text = text.replace(/[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00e7\u00fc]/g, ch => accents[ch] || ch);
  text = text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

function pdfFirstLine(text) {
  if (!text) return "";
  const line = String(text).split(/\r?\n/).find(l => l.trim());
  return line ? line.trim() : "";
}

async function fetchTerritoryForPdf(env, territoryId) {
  const row = await env.DB.prepare(
    `SELECT id, tipo, cod, nome, slug, prov_cod, com_cod, con_cod, parent_id FROM territories WHERE id = ?`
  ).bind(territoryId).first();
  if (!row) throw new Error(`Non existe o territorio ${territoryId}.`);
  return row;
}

async function territoryHierarchyForPdf(env, territory) {
  const { results } = await env.DB.prepare(
    `SELECT id, tipo, nome, prov_cod, com_cod, con_cod FROM territories
     WHERE id = ? OR (tipo = 'prov' AND cod = ?) OR (tipo = 'com' AND cod = ?) OR (tipo = 'con' AND cod = ?)`
  ).bind(territory.id, territory.prov_cod, territory.com_cod, territory.con_cod).all();
  const byType = new Map(results.map(row => [row.tipo, row]));
  const order = ["prov", "com", "con", "par"];
  return order.filter(t => byType.has(t)).map(t => byType.get(t));
}

async function parentCouncilNameForPdf(env, territory) {
  if (territory.tipo === "con") return territory.nome || "";
  if (!territory.con_cod) return "";
  const row = await env.DB.prepare(`SELECT nome FROM territories WHERE tipo = 'con' AND cod = ? LIMIT 1`).bind(territory.con_cod).first();
  return row ? row.nome : "";
}

async function territoryLabelForPdf(env, territory) {
  if (!territory) return "";
  let label = territory.nome || "";
  if (territory.tipo === "par") {
    const council = await parentCouncilNameForPdf(env, territory);
    if (council) label = `${label} \\ ${council}`;
  }
  return label;
}

async function territoryContextForPdf(env, territory) {
  const hierarchy = await territoryHierarchyForPdf(env, territory);
  return hierarchy.map(item => `${PDF_TYPE_LABELS[item.tipo] || item.tipo}: ${item.nome}`).join(" \\ ");
}

async function descendantIdsForPdf(env, territory) {
  const tipo = territory.tipo;
  let query;
  let bind;
  if (tipo === "prov") { query = `SELECT id FROM territories WHERE id = ? OR prov_cod = ?`; bind = [territory.id, territory.cod]; }
  else if (tipo === "com") { query = `SELECT id FROM territories WHERE id = ? OR com_cod = ?`; bind = [territory.id, territory.cod]; }
  else if (tipo === "con") { query = `SELECT id FROM territories WHERE id = ? OR con_cod = ?`; bind = [territory.id, territory.cod]; }
  else { query = `SELECT id FROM territories WHERE id = ?`; bind = [territory.id]; }
  const { results } = await env.DB.prepare(query).bind(...bind).all();
  return results.map(row => row.id);
}

async function coplaTerritoriesForPdf(env, coplaId) {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.tipo, t.nome, t.prov_cod, t.com_cod, t.con_cod
     FROM copla_territories ct JOIN territories t ON t.id = ct.territory_id
     WHERE ct.copla_id = ? ORDER BY t.tipo, t.nome`
  ).bind(coplaId).all();
  const labels = [];
  for (const row of results) labels.push(await territoryLabelForPdf(env, row));
  return labels;
}

async function fetchCoplaForPdf(env, coplaId) {
  const row = await env.DB.prepare(
    `SELECT id, text, incipit, notes, territory_state FROM coplas WHERE id = ?`
  ).bind(coplaId).first();
  if (!row) throw new Error(`Non existe a copla ${coplaId}.`);
  const incipit = row.incipit || pdfFirstLine(row.text);
  const territories = await coplaTerritoriesForPdf(env, coplaId);
  return { ...row, incipit, territories };
}

async function fetchPieceSectionsForPdf(env, pieceId) {
  const { results } = await env.DB.prepare(
    `SELECT pc.position, pc.section_label, pc.notes, pc.role, c.id AS copla_id,
            COALESCE(NULLIF(pc.inline_text, ''), c.text) AS text, COALESCE(c.incipit, '') AS incipit
     FROM piece_coplas pc LEFT JOIN coplas c ON c.id = pc.copla_id
     WHERE pc.piece_id = ? ORDER BY pc.position ASC`
  ).bind(pieceId).all();
  const sections = new Map();
  for (const row of results) {
    const label = row.section_label || "Parte";
    if (!sections.has(label)) sections.set(label, []);
    let copla;
    if (row.copla_id) {
      copla = await fetchCoplaForPdf(env, row.copla_id);
    } else {
      copla = { id: null, text: row.text, incipit: pdfFirstLine(row.text), notes: null, territories: [] };
    }
    copla = {
      ...copla,
      position: row.position,
      text: row.text,
      incipit: row.incipit || pdfFirstLine(row.text),
      role: row.role || "copla",
      occurrence_notes: row.notes,
    };
    sections.get(label).push(copla);
  }
  return Array.from(sections.entries()).map(([label, coplas]) => ({ label, coplas }));
}

async function buildPieceDocumentForPdf(env, pieceId) {
  const row = await env.DB.prepare(
    `SELECT id, title, slug, author, context_territory_id, description, notes, status FROM pieces WHERE id = ?`
  ).bind(pieceId).first();
  if (!row) throw new Error(`Non existe a peza ${pieceId}.`);
  const territory = row.context_territory_id ? await fetchTerritoryForPdf(env, row.context_territory_id) : null;
  return {
    kind: "piece",
    title: row.title || "Peza sen t\u00edtulo",
    slug: row.slug,
    author: row.author,
    description: row.description,
    notes: row.notes,
    context: territory ? await territoryLabelForPdf(env, territory) : "",
    sections: await fetchPieceSectionsForPdf(env, pieceId),
  };
}

async function buildPieceDraftDocumentForPdf(env, payload) {
  const territoryId = payload.context_territory_id;
  const territory = territoryId ? await fetchTerritoryForPdf(env, territoryId) : null;
  const sections = [];
  for (const section of payload.sections || []) {
    const coplas = [];
    for (const item of section.coplas || []) {
      let copla;
      if (item.copla_id === null || item.copla_id === undefined) {
        const text = item.text || "";
        if (!text.trim()) continue;
        copla = {
          id: null,
          text,
          incipit: item.incipit || pdfFirstLine(text),
          notes: item.notes,
          territories: item.territory ? [item.territory] : [],
        };
      } else {
        copla = await fetchCoplaForPdf(env, Number(item.copla_id));
      }
      copla = { ...copla, position: item.position, role: item.role || "copla", occurrence_notes: item.notes };
      coplas.push(copla);
    }
    sections.push({ label: section.label || "Parte", coplas });
  }
  return {
    kind: "piece",
    title: payload.title || "Peza sen t\u00edtulo",
    slug: payload.slug,
    author: payload.author,
    description: payload.description,
    notes: payload.notes,
    context: territory ? await territoryLabelForPdf(env, territory) : "",
    sections,
  };
}

async function buildTerritoryDocumentForPdf(env, territoryId) {
  const territory = await fetchTerritoryForPdf(env, territoryId);
  const ids = await descendantIdsForPdf(env, territory);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT c.id, c.text, c.incipit, c.notes, c.territory_state
     FROM coplas c JOIN copla_territories ct ON ct.copla_id = c.id
     WHERE ct.territory_id IN (${placeholders}) ORDER BY c.id DESC`
  ).bind(...ids).all();
  const coplas = [];
  for (const row of results) {
    const incipit = row.incipit || pdfFirstLine(row.text);
    const territories = await coplaTerritoriesForPdf(env, row.id);
    coplas.push({ ...row, incipit, territories });
  }
  return {
    kind: "territory",
    title: await territoryLabelForPdf(env, territory),
    territory_type: PDF_TYPE_LABELS[territory.tipo] || territory.tipo,
    context: await territoryContextForPdf(env, territory),
    coplas,
  };
}

function pdfHtmlEscape(value) {
  // Mirror Python's html.escape(str, quote=True), which also escapes '.
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function pdfNl2br(value) {
  return pdfHtmlEscape(value).split(/\r?\n/).join("<br>");
}

function renderPdfMeta(document) {
  const items = [];
  if (document.author) items.push(`<span>${pdfHtmlEscape(document.author)}</span>`);
  if (document.context) items.push(`<span>${pdfHtmlEscape(document.context)}</span>`);
  if (document.territory_type) items.push(`<span>${pdfHtmlEscape(document.territory_type)}</span>`);
  return items.join("\n");
}

function renderPdfCopla(copla) {
  const role = copla.role === "retrouso" ? "retrouso" : "copla";
  const notes = copla.notes ? `<div class="copla-notes">${pdfHtmlEscape(copla.notes)}</div>` : "";
  return `
      <article class="copla ${role}">
        <div class="copla-text">${pdfNl2br(copla.text)}</div>
        ${notes}
      </article>
    `;
}

function renderPiecePdfHtml(document) {
  const sections = [];
  for (const section of document.sections || []) {
    const coplas = (section.coplas || []).map(renderPdfCopla).join("");
    if (!coplas) continue;
    sections.push(`
            <section class="part">
              <h2 class="part-title">${pdfHtmlEscape(section.label || "Parte")}</h2>
              ${coplas}
            </section>
            `);
  }
  const body = sections.join("\n") || `<p class="empty">Esta peza a\u00ednda non ten coplas.</p>`;
  return `<!doctype html>
<html lang="gl">
<head>
  <meta charset="utf-8">
  <title>${pdfHtmlEscape(document.title)}</title>
  <style>${PRINT_CSS}</style>
</head>
<body>
  <header class="document-header">
    <div class="brand"><span class="wordmark">f<svg class="wordmark-o" viewBox="0 0 60 54" aria-hidden="true"><path d="M49.56 21.27A20.45 20.45 0 1 1 35.98 7.69"/><circle cx="49.52" cy="7.73" r="5.6"/></svg>l e ar</span></div>
    <h1>${pdfHtmlEscape(document.title)}</h1>
    <div class="meta-row">${renderPdfMeta(document)}</div>
    <p class="description">${pdfHtmlEscape(document.description)}</p>
    <p class="notes">${pdfHtmlEscape(document.notes)}</p>
  </header>
  <main class="piece-grid">
    ${body}
  </main>
</body>
</html>`;
}

function renderTerritoryPdfHtml(document) {
  const coplas = (document.coplas || []).map(renderPdfCopla).join("");
  const body = coplas || `<p class="empty">Non hai coplas rexistradas para este territorio.</p>`;
  const meta = document.territory_type ? `<span>${pdfHtmlEscape(document.territory_type)}</span>` : "";
  return `<!doctype html>
<html lang="gl">
<head>
  <meta charset="utf-8">
  <title>${pdfHtmlEscape(document.title)}</title>
  <style>${PRINT_CSS}</style>
</head>
<body>
  <header class="document-header">
    <div class="brand"><span class="wordmark">f<svg class="wordmark-o" viewBox="0 0 60 54" aria-hidden="true"><path d="M49.56 21.27A20.45 20.45 0 1 1 35.98 7.69"/><circle cx="49.52" cy="7.73" r="5.6"/></svg>l e ar</span></div>
    <h1>${pdfHtmlEscape(document.title)}</h1>
    <div class="meta-row">${meta}</div>
    <p class="description">${pdfHtmlEscape(document.context)}</p>
  </header>
  <main class="territory-list">
    ${body}
  </main>
</body>
</html>`;
}

async function renderPdfViaBrowserRun(env, htmlText) {
  if (!env.BROWSER_RUN_API_TOKEN) {
    throw new Error("Falta configurar o secret BROWSER_RUN_API_TOKEN no Worker (ver README, seccion Acceso e secrets) para poder xerar PDFs.");
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Falta configurar a variable CLOUDFLARE_ACCOUNT_ID no Worker para poder xerar PDFs.");
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-run/pdf`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.BROWSER_RUN_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ html: htmlText }),
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Browser Run:", response.status, detail.slice(0, 500));
    throw new HttpError(502, `O servizo de PDF devolveu un erro (${response.status}). Téntao de novo máis tarde.`);
  }
  return response.arrayBuffer();
}

function pdfResponse(pdfBuffer, filename) {
  return new Response(pdfBuffer, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// ---------------------------------------------------------------------
// Identidade e roles (login con Google)
//
// Tres roles: "foleante" (consulta e ten o seu espazo), "guia" (da de alta,
// edita e borra coplas, recursos e melodías) e "admin" (ademais, reparte
// roles). A consulta segue sendo libre: só as escrituras piden sesión.
//
// Variables: GOOGLE_CLIENT_ID (var), GOOGLE_CLIENT_SECRET (secret),
// ADMIN_EMAILS (var, correos separados por comas: sempre son admin ao entrar).
// AUTH_DISABLED="true" abre as escrituras sen login (só para desenvolvemento).
// Sen Google configurado e sen AUTH_DISABLED, as escrituras quedan PECHADAS.
// A sesión é unha cookie HttpOnly co token; na D1 só se garda o seu hash.
// ---------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLES = ["foleante", "guia", "admin"];
const EDITOR_ROLES = ["guia", "admin"];
const SESSION_COOKIE = "folear_session";
const OAUTH_COOKIE = "folear_oauth";
const SESSION_DAYS = 30;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function authMode(env) {
  if (String(env.AUTH_DISABLED || "").toLowerCase() === "true") return "open";
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return "google";
  return "unconfigured";
}

function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function buildCookie(name, value, url, { maxAge, path = "/" } = {}) {
  const parts = [`${name}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Lax"];
  if (url.protocol === "https:") parts.push("Secure");
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlToString(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

// Só rutas internas do propio sitio como destino despois do login.
function safeNextPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

function redirectResponse(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  cookies.forEach(cookie => headers.append("set-cookie", cookie));
  return new Response(null, { status: 302, headers });
}

function jsonNoStore(data, { env, status = 200, cookies = [] } = {}) {
  const headers = new Headers({ ...JSON_HEADERS, ...corsHeaders(env), "cache-control": "no-store" });
  cookies.forEach(cookie => headers.append("set-cookie", cookie));
  return new Response(JSON.stringify(data), { status, headers });
}

// Defensa en profundidade contra CSRF (a cookie xa é SameSite=Lax): unha
// escritura cunha orixe distinta da do propio sitio rexéitase.
function assertSameOrigin(request, url) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "Orixe non permitida.");
}

async function getViewer(request, env) {
  const mode = authMode(env);
  if (mode === "open") return { id: 0, name: "Acceso aberto", email: "", picture: null, role: "admin", open: true };
  if (mode !== "google") return null;
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.picture, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    ).bind(await sha256Hex(token)).first();
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return { id: row.id, name: row.name, email: row.email, picture: row.picture, role: row.role };
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return null;
    throw err;
  }
}

async function requireRole(request, env, url, roles) {
  assertSameOrigin(request, url);
  const viewer = await getViewer(request, env);
  if (!viewer) {
    if (authMode(env) === "unconfigured") {
      throw new HttpError(503, "O acceso con Google aínda non está configurado no servidor, así que as escrituras están pechadas.");
    }
    throw new HttpError(401, "Tes que entrar con Google para facer isto.");
  }
  if (!roles.includes(viewer.role)) {
    throw new HttpError(403, roles.includes("guia") ? "O teu rol non permite facer isto: fai falla ser guía." : "Isto só o pode facer unha persoa admin.");
  }
  return viewer;
}

// Os PDFs gastan a cota gratuíta de Browser Run (10 min/día): só os pode xerar
// unha persoa logueada (calquera rol) e hai un tope diario por persoa.
const PDF_DAILY_LIMIT = 15;

async function requirePdfViewer(request, env, url) {
  assertSameOrigin(request, url);
  const mode = authMode(env);
  if (mode === "open") return null;
  if (mode === "unconfigured") {
    throw new HttpError(503, "O acceso con Google aínda non está configurado no servidor, así que non se poden xerar PDFs.");
  }
  const viewer = await getViewer(request, env);
  if (!viewer) throw new HttpError(401, "Para xerar PDFs tes que entrar con Google.");
  if (viewer.role !== "admin") {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const row = await env.DB.prepare(
        `INSERT INTO pdf_usage (user_id, day, n) VALUES (?, ?, 1)
         ON CONFLICT(user_id, day) DO UPDATE SET n = n + 1 RETURNING n`
      ).bind(viewer.id, day).first();
      if (row && Number(row.n) > PDF_DAILY_LIMIT) {
        throw new HttpError(429, `Chegaches ao límite de ${PDF_DAILY_LIMIT} PDFs por día. Volve tentalo mañá.`);
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (!/no such table/i.test(String(err && err.message))) throw err;
    }
  }
  return viewer;
}

function publicViewer(viewer) {
  return viewer && { id: viewer.id, name: viewer.name, email: viewer.email, picture: viewer.picture, role: viewer.role, open: Boolean(viewer.open) };
}

async function handleAuthMe(request, env) {
  const viewer = await getViewer(request, env);
  const user = publicViewer(viewer);
  if (user && viewer.id > 0 && !viewer.open) {
    try {
      const row = await env.DB.prepare("SELECT handle, display_name, is_public FROM profiles WHERE user_id = ?").bind(viewer.id).first();
      if (row) {
        user.profile = { handle: row.handle || "", display_name: row.display_name || "", is_public: Boolean(row.is_public) };
        if (row.display_name) user.name = row.display_name;
      }
    } catch (err) {
      // Sen migración 0004 segue valendo o nome de Google.
    }
  }
  return jsonNoStore({ ok: true, mode: authMode(env), user }, { env });
}

async function handleGoogleStart(request, env, url) {
  if (authMode(env) !== "google") return redirectResponse("/?auth_error=config");
  try {
    await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
  } catch (err) {
    return redirectResponse("/?auth_error=migration");
  }
  const state = randomToken(16);
  const nonce = randomToken(16);
  const next = safeNextPath(url.searchParams.get("next"));
  const authUrl = new URL(env.GOOGLE_AUTH_URL || GOOGLE_AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  }).toString();
  const cookie = buildCookie(OAUTH_COOKIE, `${state}.${nonce}.${encodeURIComponent(next)}`, url, { maxAge: 600, path: "/api/auth" });
  return redirectResponse(authUrl.toString(), [cookie]);
}

// O id_token chega directamente de Google por HTTPS (endpoint de tokens),
// polo que non fai falla verificar a sinatura, só os seus campos.
async function exchangeGoogleCode(env, code, redirectUri, nonce) {
  const response = await fetch(env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.id_token) {
    throw new Error(`Google rexeitou o código (${response.status}${data && data.error ? `: ${data.error}` : ""})`);
  }
  const claims = JSON.parse(base64UrlToString(String(data.id_token).split(".")[1] || ""));
  if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) throw new Error("Emisor do token non válido");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new Error("Audiencia do token non válida");
  if (!claims.exp || claims.exp * 1000 < Date.now() - 60000) throw new Error("Token caducado");
  if (!nonce || claims.nonce !== nonce) throw new Error("Nonce non válido");
  if (!(claims.email_verified === true || claims.email_verified === "true")) throw new Error("O correo de Google non está verificado");
  if (!claims.sub || !claims.email) throw new Error("O token non traía identidade");
  return claims;
}

async function handleGoogleCallback(request, env, url) {
  const clear = buildCookie(OAUTH_COOKIE, "", url, { maxAge: 0, path: "/api/auth" });
  const fail = code => redirectResponse(`/?auth_error=${code}`, [clear]);
  if (authMode(env) !== "google") return fail("config");
  const [cookieState, nonce, ...rest] = (parseCookies(request)[OAUTH_COOKIE] || "").split(".");
  let next = "/";
  try {
    next = safeNextPath(decodeURIComponent(rest.join(".")));
  } catch (err) {
    next = "/";
  }
  if (url.searchParams.get("error")) return fail("denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !cookieState || state !== cookieState) return fail("state");

  let claims;
  try {
    claims = await exchangeGoogleCode(env, code, `${url.origin}/api/auth/google/callback`, nonce);
  } catch (err) {
    console.error("Login con Google fallou:", err && err.message);
    return fail("google");
  }

  const db = env.DB;
  const email = String(claims.email).toLowerCase();
  const name = claims.name || email.split("@")[0];
  const picture = claims.picture || null;
  const isAdmin = adminEmails(env).includes(email);
  let userId;
  try {
    const existing = await db.prepare("SELECT id, role FROM users WHERE google_sub = ?").bind(claims.sub).first();
    if (existing) {
      userId = existing.id;
      const role = isAdmin ? "admin" : existing.role;
      await db.prepare(
        "UPDATE users SET email = ?, name = ?, picture = ?, role = ?, last_login_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(email, name, picture, role, userId).run();
    } else {
      const result = await db.prepare(
        "INSERT INTO users (google_sub, email, name, picture, role, last_login_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
      ).bind(claims.sub, email, name, picture, isAdmin ? "admin" : "foleante").run();
      userId = result.meta.last_row_id;
    }
    const token = randomToken(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(token), userId, expires).run();
    await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run();
    const session = buildCookie(SESSION_COOKIE, token, url, { maxAge: SESSION_DAYS * 86400 });
    return redirectResponse(next, [session, clear]);
  } catch (err) {
    console.error("Non se puido gardar a sesión:", err && err.message);
    return fail("db");
  }
}

async function handleLogout(request, env, url) {
  assertSameOrigin(request, url);
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token) {
    try {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
    } catch (err) {
      // Sen táboa non hai sesión que pechar.
    }
  }
  return jsonNoStore({ ok: true }, { env, cookies: [buildCookie(SESSION_COOKIE, "", url, { maxAge: 0 })] });
}

async function handleUsersList(request, env, url) {
  await requireRole(request, env, url, ["admin"]);
  const { results } = await env.DB.prepare(
    "SELECT id, email, name, picture, role, created_at, last_login_at FROM users ORDER BY role = 'admin' DESC, role = 'guia' DESC, created_at"
  ).all();
  const fixed = new Set(adminEmails(env));
  return jsonNoStore({ ok: true, users: results.map(row => ({ ...row, fixed_admin: fixed.has(String(row.email).toLowerCase()) })) }, { env });
}

async function handleUserRole(request, env, url) {
  const viewer = await requireRole(request, env, url, ["admin"]);
  const payload = await request.json();
  const id = payload && payload.id;
  const role = payload && payload.role;
  if (!Number.isInteger(id)) throw new HttpError(400, "Falta o id da persoa.");
  if (!ROLES.includes(role)) throw new HttpError(400, `Rol descoñecido: ${role}.`);
  const target = await env.DB.prepare("SELECT id, email, role FROM users WHERE id = ?").bind(id).first();
  if (!target) throw new HttpError(404, "Non existe esa persoa.");
  if (adminEmails(env).includes(String(target.email).toLowerCase()) && role !== "admin") {
    throw new HttpError(400, "Esa conta é admin pola configuración do servidor; non se pode baixar de rol aquí.");
  }
  if (target.id === viewer.id && role !== "admin") {
    throw new HttpError(400, "Non podes quitarte a ti mesma o rol de admin.");
  }
  await env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, id).run();
  return jsonNoStore({ ok: true, id, role }, { env });
}

// ---------------------------------------------------------------------
// Caché dos exportes públicos
//
// Cada visita carga catro exportes que se constrúen lendo milleiros de
// filas de D1 (a cota gratuíta é de 5 M de filas lidas ao día). Para non
// repetilo en cada visita, `site_meta.data_version` sobe con cada escritura
// de coplas/recursos/melodías e o exporte cachéase por versión:
//   - ETag = versión -> o navegador recibe 304 sen que se lea nada máis.
//   - Caché do bordo de Cloudflare (Cache API, só con dominio propio) por
//     versión -> o exporte constrúese unha vez por versión e centro de datos.
// Se a migración 0004 non está aplicada, calcúlase sempre coma antes.
// ---------------------------------------------------------------------

async function readDataVersion(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM site_meta WHERE key = 'data_version'").first();
    return row && row.value != null ? String(row.value) : null;
  } catch (err) {
    return null;
  }
}

async function bumpDataVersion(env) {
  try {
    await env.DB.prepare(
      "UPDATE site_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'data_version'"
    ).run();
  } catch (err) {
    // Sen migración 0004 non hai caché que invalidar.
  }
}

async function cachedExport(request, env, ctx, url, name, build) {
  const version = await readDataVersion(env);
  if (version === null) return jsonResponse(await build(), { env });

  const etag = `"v${version}-${name}"`;
  const headers = {
    ...JSON_HEADERS,
    ...corsHeaders(env),
    etag,
    "cache-control": "public, max-age=0, must-revalidate",
  };
  const sent = String(request.headers.get("if-none-match") || "")
    .split(",")
    .map(item => item.trim().replace(/^W\//, ""));
  if (sent.includes(etag)) return new Response(null, { status: 304, headers });

  const edge = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`${url.origin}/__export-cache/${name}/${version}`);
  if (edge) {
    try {
      const hit = await edge.match(cacheKey);
      if (hit) return new Response(hit.body, { status: 200, headers });
    } catch (err) {
      // A caché é opcional.
    }
  }

  const body = JSON.stringify(await build());
  if (edge && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      edge
        .put(cacheKey, new Response(body, { headers: { ...JSON_HEADERS, "cache-control": "public, max-age=86400" } }))
        .catch(() => {})
    );
  }
  return new Response(body, { status: 200, headers });
}

// ---------------------------------------------------------------------
// Perfís e favoritos (espazo persoal). Calquera persoa con sesión pode usalo;
// só pode tocar o que é seu. Os datos persoais (correo, foto de Google) nunca
// saen nas rutas públicas.
// ---------------------------------------------------------------------

const FAVORITE_KINDS = ["copla", "territory", "tag", "media", "melody", "piece"];
const MAX_FAVORITES_PER_USER = 3000;
const RESERVED_HANDLES = new Set([
  "admin", "api", "data", "perfil", "persoa", "persoas", "privacidade", "entrar",
  "login", "logout", "sair", "folear", "fol-e-ar", "arquivo", "ajuda", "sobre",
]);

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function requirePersonalSpace(request, env, url) {
  assertSameOrigin(request, url);
  const viewer = await getViewer(request, env);
  if (!viewer) throw new HttpError(401, "Tes que entrar con Google para usar o teu espazo.");
  if (viewer.open || !(viewer.id > 0)) throw new HttpError(403, "O espazo persoal só existe con conta de Google.");
  return viewer;
}

async function personalTables(env, run) {
  try {
    return await run();
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) {
      throw new HttpError(503, "Falta aplicar a migración 0004 (perfís e favoritos) na base de datos.");
    }
    throw err;
  }
}

function profileRowToJson(row) {
  return {
    handle: row?.handle || "",
    display_name: row?.display_name || "",
    bio: row?.bio || "",
    territory_id: row?.territory_id || "",
    territory_name: row?.territory_name || "",
    is_public: Boolean(row?.is_public),
    show_favorites: Boolean(row?.show_favorites),
  };
}

async function loadProfile(env, userId) {
  return env.DB.prepare(
    `SELECT p.handle, p.display_name, p.bio, p.territory_id, p.is_public, p.show_favorites, t.nome AS territory_name
     FROM profiles p LEFT JOIN territories t ON t.id = p.territory_id
     WHERE p.user_id = ?`
  ).bind(userId).first();
}

async function handleMyProfile(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const row = await personalTables(env, () => loadProfile(env, viewer.id));
  const count = await personalTables(env, () =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?").bind(viewer.id).first()
  );
  return jsonNoStore({
    ok: true,
    profile: profileRowToJson(row),
    account: { google_name: viewer.name, picture: viewer.picture, role: viewer.role },
    favorites_count: Number(count?.n || 0),
  }, { env });
}

async function handleSaveProfile(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const payload = await request.json().catch(() => ({}));

  const displayName = cleanText(payload.display_name, 60);
  const bio = cleanText(payload.bio, 280);
  const handleRaw = String(payload.handle ?? "").trim().toLowerCase();
  let handle = null;
  if (handleRaw) {
    if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(handleRaw) || handleRaw.includes("--")) {
      throw new HttpError(400, "O username ten que ter 3-30 caracteres: letras sen acentos, números e guións.");
    }
    if (RESERVED_HANDLES.has(handleRaw)) throw new HttpError(400, "Ese username está reservado; elixe outro.");
    handle = handleRaw;
  }
  const isPublic = payload.is_public === true || payload.is_public === 1;
  const showFavorites = payload.show_favorites === true || payload.show_favorites === 1;
  if (isPublic && (!handle || !displayName)) {
    throw new HttpError(400, "Para ter perfil público fai falta un nome e un username.");
  }

  let territoryId = null;
  const territoryRaw = String(payload.territory_id ?? "").trim();
  if (territoryRaw) {
    const found = await env.DB.prepare("SELECT id FROM territories WHERE id = ?").bind(territoryRaw).first();
    if (!found) throw new HttpError(400, "Ese lugar non existe.");
    territoryId = found.id;
  }

  try {
    await personalTables(env, () => env.DB.prepare(
      `INSERT INTO profiles (user_id, handle, display_name, bio, territory_id, is_public, show_favorites)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         handle = excluded.handle,
         display_name = excluded.display_name,
         bio = excluded.bio,
         territory_id = excluded.territory_id,
         is_public = excluded.is_public,
         show_favorites = excluded.show_favorites,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(viewer.id, handle, displayName, bio, territoryId, isPublic ? 1 : 0, showFavorites ? 1 : 0).run());
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) throw new HttpError(409, "Ese username xa está collido; elixe outro.");
    throw err;
  }
  await bumpDataVersion(env); // a autoría pública das pezas depende do perfil
  const row = await loadProfile(env, viewer.id);
  return jsonNoStore({ ok: true, profile: profileRowToJson(row) }, { env });
}

async function handleMyFavorites(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const { results } = await personalTables(env, () =>
    env.DB.prepare("SELECT kind, ref FROM favorites WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").bind(viewer.id).all()
  );
  const grouped = Object.fromEntries(FAVORITE_KINDS.map(kind => [kind, []]));
  for (const row of results) if (grouped[row.kind]) grouped[row.kind].push(row.ref);
  return jsonNoStore({ ok: true, favorites: grouped }, { env });
}

async function favoriteTargetExists(env, kind, ref, viewer) {
  if (kind === "piece") {
    try {
      return Boolean(await env.DB.prepare(
        "SELECT 1 AS ok FROM pieces p WHERE p.id = ? AND ((p.visibility = 'public' AND p.status <> 'hidden') OR p.owner_user_id = ?)"
      ).bind(Number(ref), viewer.id).first());
    } catch (err) {
      return false;
    }
  }
  const queries = {
    copla: ["SELECT 1 AS ok FROM coplas WHERE id = ?", Number(ref)],
    territory: ["SELECT 1 AS ok FROM territories WHERE id = ?", ref],
    tag: ["SELECT 1 AS ok FROM tags WHERE name = ?", ref],
    media: ["SELECT 1 AS ok FROM media WHERE id = ?", Number(ref)],
    melody: ["SELECT 1 AS ok FROM melodies WHERE id = ?", Number(ref)],
  };
  const [sql, value] = queries[kind];
  if (typeof value === "number" && !Number.isFinite(value)) return false;
  return Boolean(await env.DB.prepare(sql).bind(value).first());
}

async function handleToggleFavorite(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const payload = await request.json().catch(() => ({}));
  const kind = String(payload.kind || "");
  const ref = String(payload.ref ?? "").trim().slice(0, 200);
  if (!FAVORITE_KINDS.includes(kind) || !ref) throw new HttpError(400, "Favorito non válido.");
  const on = payload.on !== false;
  if (on) {
    if (!(await favoriteTargetExists(env, kind, ref, viewer))) throw new HttpError(404, "Iso xa non existe.");
    const count = await personalTables(env, () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?").bind(viewer.id).first()
    );
    if (Number(count?.n || 0) >= MAX_FAVORITES_PER_USER) throw new HttpError(400, "Chegaches ao límite de favoritos.");
    await env.DB.prepare("INSERT OR IGNORE INTO favorites (user_id, kind, ref) VALUES (?, ?, ?)").bind(viewer.id, kind, ref).run();
  } else {
    await personalTables(env, () =>
      env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND kind = ? AND ref = ?").bind(viewer.id, kind, ref).run()
    );
  }
  return jsonNoStore({ ok: true, kind, ref, on }, { env });
}

async function handleDeleteAccount(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const payload = await request.json().catch(() => ({}));
  if (payload.confirm !== true) throw new HttpError(400, "Falta confirmar o borrado da conta.");
  // Borra todo o que é da persoa, incluídas as súas pezas (públicas e privadas).
  const linksOk = await pieceLinksAvailable(env);
  await personalTables(env, async () => {
    try {
      await env.DB.batch([
        ...(linksOk ? [env.DB.prepare("DELETE FROM piece_links WHERE piece_id IN (SELECT id FROM pieces WHERE owner_user_id = ?)").bind(viewer.id)] : []),
        env.DB.prepare("DELETE FROM favorites WHERE kind = 'piece' AND ref IN (SELECT CAST(id AS TEXT) FROM pieces WHERE owner_user_id = ?)").bind(viewer.id),
        env.DB.prepare("DELETE FROM media_links WHERE entity_type = 'piece' AND entity_id IN (SELECT id FROM pieces WHERE owner_user_id = ?)").bind(viewer.id),
        env.DB.prepare("DELETE FROM piece_coplas WHERE piece_id IN (SELECT id FROM pieces WHERE owner_user_id = ?)").bind(viewer.id),
        env.DB.prepare("DELETE FROM pieces WHERE owner_user_id = ?").bind(viewer.id),
        env.DB.prepare("DELETE FROM follows WHERE follower_id = ? OR followee_id = ?").bind(viewer.id, viewer.id),
      ]);
    } catch (err) {
      if (!/no such (column|table)/i.test(String(err && err.message))) throw err; // sen migración 0005 non hai pezas de persoas
    }
    return env.DB.batch([
      env.DB.prepare("DELETE FROM favorites WHERE user_id = ?").bind(viewer.id),
      env.DB.prepare("DELETE FROM profiles WHERE user_id = ?").bind(viewer.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(viewer.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(viewer.id),
    ]);
  });
  await bumpDataVersion(env);
  return jsonNoStore({ ok: true }, { env, cookies: [buildCookie(SESSION_COOKIE, "", url, { maxAge: 0 })] });
}

function publicJson(data, env, maxAge = 60) {
  return new Response(JSON.stringify(data), {
    headers: { ...JSON_HEADERS, ...corsHeaders(env), "cache-control": `public, max-age=${maxAge}` },
  });
}

async function handlePeopleList(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT p.handle, p.display_name, p.bio, p.territory_id, t.nome AS territory_name
       FROM profiles p LEFT JOIN territories t ON t.id = p.territory_id
       WHERE p.is_public = 1 AND p.handle IS NOT NULL AND p.display_name <> ''
       ORDER BY p.display_name COLLATE NOCASE
       LIMIT 500`
    ).all();
    return publicJson({ ok: true, people: results }, env);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return publicJson({ ok: true, people: [] }, env, 0);
    throw err;
  }
}

async function handlePersonPage(env, handle) {
  const clean = String(handle || "").toLowerCase();
  let row;
  try {
    row = await env.DB.prepare(
      `SELECT p.user_id, p.handle, p.display_name, p.bio, p.territory_id, p.show_favorites, t.nome AS territory_name
       FROM profiles p LEFT JOIN territories t ON t.id = p.territory_id
       WHERE p.handle = ? AND p.is_public = 1`
    ).bind(clean).first();
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) row = null;
    else throw err;
  }
  if (!row) return jsonResponse({ ok: false, error: "Non existe ese perfil." }, { status: 404, env });

  let favorites = null;
  if (row.show_favorites) {
    const { results } = await env.DB.prepare(
      "SELECT kind, ref FROM favorites WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1500"
    ).bind(row.user_id).all();
    favorites = Object.fromEntries(FAVORITE_KINDS.map(kind => [kind, []]));
    for (const item of results) if (favorites[item.kind]) favorites[item.kind].push(item.ref);
  }
  return publicJson({
    ok: true,
    person: {
      handle: row.handle,
      display_name: row.display_name,
      bio: row.bio,
      territory_id: row.territory_id || "",
      territory_name: row.territory_name || "",
      show_favorites: Boolean(row.show_favorites),
    },
    favorites,
  }, env);
}

// ---------------------------------------------------------------------
// Pezas con dono e visibilidade (biblioteca pública + as miñas pezas)
//
//   owner_user_id NULL  -> peza do arquivo (editorial): editable por guías/admin.
//   owner_user_id = id  -> peza dunha persoa: só ela (e admin) a xestiona.
//   visibility          -> 'private' (só a dona) ou 'public' (biblioteca).
//   status 'hidden'     -> peza pública agochada por moderación (guía/admin).
//
// As pezas privadas NUNCA saen no exporte público nin no PDF a terceiras.
// ---------------------------------------------------------------------

const PIECE_VISIBILITIES = ["private", "public"];
const PUBLIC_PIECE_SQL = "p.visibility = 'public' AND p.status <> 'hidden'";
const MAX_PIECES_PER_USER = 200;
const MAX_COPLAS_PER_PIECE = 300;
const MAX_LINKS_PER_PIECE = 10;

// Ligazóns a recursos externos (migración 0006). Se a táboa aínda non existe, as
// pezas seguen funcionando sen ligazóns.
async function pieceLinksAvailable(env) {
  try {
    await env.DB.prepare("SELECT 1 FROM piece_links LIMIT 1").first();
    return true;
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return false;
    throw err;
  }
}

function cleanPieceLinks(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "As ligazóns da peza non son válidas.");
  if (raw.length > MAX_LINKS_PER_PIECE) throw new HttpError(400, `Unha peza non pode ter máis de ${MAX_LINKS_PER_PIECE} ligazóns.`);
  return raw.map((item, index) => {
    const text = String((item && item.url) ?? "").trim();
    let parsed;
    try { parsed = new URL(text); } catch { parsed = null; }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || text.length > 500 || parsed.username || parsed.password) {
      throw new HttpError(400, `Ligazón ${index + 1}: a URL debe ser http(s) e non pasar de 500 caracteres.`);
    }
    const title = cleanText(item.title, 120) || parsed.hostname.replace(/^www\./, "");
    return { title, url: parsed.toString(), position: index };
  });
}

function cleanMultiline(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

function pieceSlugFor(title) {
  const base = String(title || "peza")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "peza";
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4))).map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${base}-${suffix}`;
}

function piecesMigrationError(err) {
  if (/no such (column|table)/i.test(String(err && err.message))) {
    return new HttpError(503, "Falta aplicar a migración 0005 (pezas con dono) na base de datos.");
  }
  return err;
}

async function knownCoplaTexts(env, ids) {
  const found = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT id, text FROM coplas WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    results.forEach(row => found.set(row.id, row.text || ""));
  }
  return found;
}

const normalizeCoplaText = value => String(value || "").replace(/\r\n?/g, "\n").trim();

async function cleanPieceInput(env, raw) {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Peza non válida.");
  const title = cleanText(raw.title, 160) || "Peza sen título";
  const author = cleanText(raw.author, 120) || "Sen autoría";
  const description = cleanMultiline(raw.description, 1000);
  const notes = cleanMultiline(raw.notes, 4000);
  const visibility = PIECE_VISIBILITIES.includes(raw.visibility) ? raw.visibility : "private";

  let territoryId = null;
  if (raw.context_territory_id) {
    const found = await env.DB.prepare("SELECT id FROM territories WHERE id = ?").bind(String(raw.context_territory_id)).first();
    if (!found) throw new HttpError(400, "O territorio de contexto da peza non existe.");
    territoryId = found.id;
  }

  const coplas = Array.isArray(raw.coplas) ? raw.coplas : [];
  if (!coplas.length) throw new HttpError(400, "A peza precisa polo menos unha copla.");
  if (coplas.length > MAX_COPLAS_PER_PIECE) throw new HttpError(400, `Unha peza non pode ter máis de ${MAX_COPLAS_PER_PIECE} coplas.`);
  const positions = new Set();
  const items = coplas.map((item, index) => {
    if (!item || typeof item !== "object") throw new HttpError(400, `Copla ${index + 1} da peza: non válida.`);
    const position = Number(item.position);
    if (!Number.isInteger(position) || position < 1) throw new HttpError(400, `Copla ${index + 1} da peza: posición non válida.`);
    if (positions.has(position)) throw new HttpError(400, `Copla ${index + 1} da peza: posición repetida.`);
    positions.add(position);
    const role = item.role === "retrouso" ? "retrouso" : "copla";
    const coplaId = item.copla_id == null ? null : Number(item.copla_id);
    if (coplaId !== null && (!Number.isInteger(coplaId) || coplaId < 1)) throw new HttpError(400, `Copla ${index + 1} da peza: referencia non válida.`);
    const text = cleanMultiline(item.text, 4000);
    if (coplaId === null && !text) throw new HttpError(400, `Copla ${index + 1} da peza: falta o texto.`);
    return {
      copla_id: coplaId,
      // O texto garda en liña se non apunta a unha copla do arquivo ou se a persoa o adaptou (ver abaixo).
      inline_text: text || null,
      position,
      section_label: cleanText(item.section_label, 80) || "Parte",
      role,
      notes: cleanMultiline(item.notes, 1000) || null,
    };
  });
  const referenced = items.map(item => item.copla_id).filter(id => id !== null);
  if (referenced.length) {
    const known = await knownCoplaTexts(env, referenced);
    const missing = referenced.find(id => !known.has(id));
    if (missing !== undefined) throw new HttpError(400, `A copla ${missing} xa non existe no arquivo.`);
    // Se o texto é igual ao do arquivo non o duplicamos: así a peza segue as correccións da copla.
    for (const item of items) {
      if (item.copla_id !== null && item.inline_text && normalizeCoplaText(item.inline_text) === normalizeCoplaText(known.get(item.copla_id))) {
        item.inline_text = null;
      }
    }
  }
  const links = cleanPieceLinks(raw.links);
  return { title, author, description, notes, visibility, territoryId, items, links };
}

function pieceCoplaStatements(env, pieceId, items) {
  return items.map(item => env.DB.prepare(
    `INSERT INTO piece_coplas (piece_id, copla_id, inline_text, position, section_label, role, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(pieceId, item.copla_id, item.inline_text, item.position, item.section_label, item.role, item.notes));
}

function pieceLinkStatements(env, pieceId, links) {
  return links.map(link => env.DB.prepare(
    "INSERT INTO piece_links (piece_id, title, url, position) VALUES (?, ?, ?, ?)"
  ).bind(pieceId, link.title, link.url, link.position));
}

function canManagePiece(viewer, row) {
  if (viewer.open || viewer.role === "admin") return true;
  if (row.owner_user_id == null) return EDITOR_ROLES.includes(viewer.role);
  return row.owner_user_id === viewer.id;
}

async function requirePieceWriter(request, env, url) {
  assertSameOrigin(request, url);
  const viewer = await getViewer(request, env);
  if (!viewer) {
    if (authMode(env) === "unconfigured") throw new HttpError(503, "O acceso con Google aínda non está configurado no servidor.");
    throw new HttpError(401, "Tes que entrar con Google para gardar pezas.");
  }
  return viewer;
}

async function handleSavePiece(request, env, url) {
  const viewer = await requirePieceWriter(request, env, url);
  const payload = await request.json().catch(() => null);
  const list = payload && Array.isArray(payload.pieces) ? payload.pieces : null;
  if (!list || !list.length) throw new HttpError(400, "O JSON debe levar unha lista 'pieces'.");
  if (list.length > 20) throw new HttpError(400, "Demasiadas pezas de golpe.");

  const ownerId = viewer.open ? null : viewer.id;
  const ids = [];
  for (const raw of list) {
    const input = await cleanPieceInput(env, raw);
    const linksOk = await pieceLinksAvailable(env);
    if (!linksOk && input.links.length) throw new HttpError(503, "Falta aplicar a migración 0006 (ligazóns das pezas) na base de datos.");
    const existingId = raw && raw.id != null ? Number(raw.id) : null;
    try {
      if (existingId !== null) {
        const row = await env.DB.prepare("SELECT id, owner_user_id FROM pieces WHERE id = ?").bind(existingId).first();
        if (!row || !canManagePiece(viewer, row)) throw new HttpError(404, "Non existe esa peza ou non é túa.");
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE pieces SET title = ?, author = ?, context_territory_id = ?, description = ?, notes = ?,
               visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          ).bind(input.title, input.author, input.territoryId, input.description, input.notes, input.visibility, existingId),
          env.DB.prepare("DELETE FROM piece_coplas WHERE piece_id = ?").bind(existingId),
          ...pieceCoplaStatements(env, existingId, input.items),
          ...(linksOk ? [env.DB.prepare("DELETE FROM piece_links WHERE piece_id = ?").bind(existingId), ...pieceLinkStatements(env, existingId, input.links)] : []),
        ]);
        ids.push(existingId);
      } else {
        if (ownerId !== null && viewer.role !== "admin") {
          const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM pieces WHERE owner_user_id = ?").bind(ownerId).first();
          if (Number(count?.n || 0) >= MAX_PIECES_PER_USER) throw new HttpError(400, "Chegaches ao límite de pezas gardadas.");
        }
        const inserted = await env.DB.prepare(
          `INSERT INTO pieces (title, slug, author, context_territory_id, description, notes, status, visibility, owner_user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`
        ).bind(input.title, pieceSlugFor(input.title), input.author, input.territoryId, input.description, input.notes, input.visibility, ownerId).run();
        const pieceId = inserted.meta.last_row_id;
        try {
          await env.DB.batch([...pieceCoplaStatements(env, pieceId, input.items), ...pieceLinkStatements(env, pieceId, input.links)]);
        } catch (err) {
          await env.DB.prepare("DELETE FROM pieces WHERE id = ?").bind(pieceId).run();
          throw err;
        }
        ids.push(pieceId);
      }
    } catch (err) {
      throw piecesMigrationError(err);
    }
  }
  await bumpDataVersion(env);
  return jsonNoStore({ ok: true, ids }, { env });
}

async function loadManagedPiece(env, viewer, id) {
  let row;
  try {
    row = await env.DB.prepare("SELECT id, owner_user_id, visibility, status FROM pieces WHERE id = ?").bind(id).first();
  } catch (err) {
    throw piecesMigrationError(err);
  }
  if (!row || !canManagePiece(viewer, row)) throw new HttpError(404, "Non existe esa peza ou non é túa.");
  return row;
}

async function deletePieceRows(env, ids) {
  const linksOk = await pieceLinksAvailable(env);
  for (const id of ids) {
    await env.DB.batch([
      ...(linksOk ? [env.DB.prepare("DELETE FROM piece_links WHERE piece_id = ?").bind(id)] : []),
      env.DB.prepare("DELETE FROM favorites WHERE kind = 'piece' AND ref = ?").bind(String(id)),
      env.DB.prepare("DELETE FROM media_links WHERE entity_type = 'piece' AND entity_id = ?").bind(id),
      env.DB.prepare("DELETE FROM piece_coplas WHERE piece_id = ?").bind(id),
      env.DB.prepare("DELETE FROM pieces WHERE id = ?").bind(id),
    ]);
  }
}

async function handleDeletePiece(request, env, url) {
  const viewer = await requirePieceWriter(request, env, url);
  const payload = await request.json().catch(() => ({}));
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Peza non válida.");
  await loadManagedPiece(env, viewer, id);
  await deletePieceRows(env, [id]);
  await bumpDataVersion(env);
  return jsonNoStore({ ok: true, id }, { env });
}

async function handlePieceVisibility(request, env, url) {
  const viewer = await requirePieceWriter(request, env, url);
  const payload = await request.json().catch(() => ({}));
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id < 1 || !PIECE_VISIBILITIES.includes(payload.visibility)) throw new HttpError(400, "Datos non válidos.");
  await loadManagedPiece(env, viewer, id);
  await env.DB.prepare("UPDATE pieces SET visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(payload.visibility, id).run();
  await bumpDataVersion(env);
  return jsonNoStore({ ok: true, id, visibility: payload.visibility }, { env });
}

// Moderación: un guía/admin pode agochar unha peza pública (ou volver amosala)
// sen borrala. A dona segue vendo a súa peza coa marca de agochada.
async function handlePieceModerate(request, env, url) {
  await requireRole(request, env, url, EDITOR_ROLES);
  const payload = await request.json().catch(() => ({}));
  const id = Number(payload.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "Peza non válida.");
  try {
    const row = await env.DB.prepare("SELECT id FROM pieces WHERE id = ? AND visibility = 'public'").bind(id).first();
    if (!row) throw new HttpError(404, "Non existe esa peza pública.");
    await env.DB.prepare("UPDATE pieces SET status = ? WHERE id = ?").bind(payload.hidden ? "hidden" : "published", id).run();
  } catch (err) {
    throw piecesMigrationError(err);
  }
  await bumpDataVersion(env);
  return jsonNoStore({ ok: true, id, hidden: Boolean(payload.hidden) }, { env });
}

async function exportPiecesJson(env, { ownerId = null, hiddenOnly = false } = {}) {
  const condition = hiddenOnly
    ? "p.visibility = 'public' AND p.status = 'hidden'"
    : ownerId === null ? PUBLIC_PIECE_SQL : "p.owner_user_id = ?";
  const binds = hiddenOnly || ownerId === null ? [] : [ownerId];
  let pieces;
  let coplaRows;
  try {
    [{ results: pieces }, { results: coplaRows }] = await Promise.all([
      env.DB.prepare(
        `SELECT p.id, p.title, p.slug, p.author, p.context_territory_id, p.description, p.notes, p.status, p.visibility,
                p.created_at, p.updated_at, t.nome AS context_nome, t.tipo AS context_tipo,
                pr.handle AS owner_handle, pr.display_name AS owner_name, p.owner_user_id
         FROM pieces p
         LEFT JOIN territories t ON t.id = p.context_territory_id
         LEFT JOIN profiles pr ON pr.user_id = p.owner_user_id AND pr.is_public = 1 AND pr.handle IS NOT NULL
         WHERE ${condition}
         ORDER BY p.updated_at DESC, p.id DESC`
      ).bind(...binds).all(),
      env.DB.prepare(
        `SELECT pc.piece_id, pc.position, pc.section_label, pc.notes, pc.role, c.id AS id,
                COALESCE(c.incipit, '') AS incipit, COALESCE(NULLIF(pc.inline_text, ''), c.text) AS text
         FROM piece_coplas pc
         JOIN pieces p ON p.id = pc.piece_id
         LEFT JOIN coplas c ON c.id = pc.copla_id
         WHERE ${condition}
         ORDER BY pc.piece_id, pc.position ASC`
      ).bind(...binds).all(),
    ]);
  } catch (err) {
    if (ownerId !== null || hiddenOnly) throw piecesMigrationError(err);
    if (!/no such (column|table)/i.test(String(err && err.message))) throw err;
    // Sen migracións 0004/0005: exporte antigo (todas as pezas son públicas).
    const legacy = await env.DB.prepare(
      `SELECT p.id, p.title, p.slug, p.author, p.context_territory_id, p.description, p.notes, p.status,
              p.created_at, p.updated_at, t.nome AS context_nome, t.tipo AS context_tipo
       FROM pieces p LEFT JOIN territories t ON t.id = p.context_territory_id
       ORDER BY p.updated_at DESC, p.id DESC`
    ).all();
    const legacyCoplas = await env.DB.prepare(
      `SELECT pc.piece_id, pc.position, pc.section_label, pc.notes, pc.role, c.id AS id,
              COALESCE(c.incipit, '') AS incipit, COALESCE(NULLIF(pc.inline_text, ''), c.text) AS text
       FROM piece_coplas pc LEFT JOIN coplas c ON c.id = pc.copla_id ORDER BY pc.piece_id, pc.position ASC`
    ).all();
    pieces = legacy.results;
    coplaRows = legacyCoplas.results;
  }
  let linkRows = [];
  try {
    ({ results: linkRows } = await env.DB.prepare(
      `SELECT pl.piece_id, pl.title, pl.url FROM piece_links pl JOIN pieces p ON p.id = pl.piece_id WHERE ${condition} ORDER BY pl.piece_id, pl.position ASC`
    ).bind(...binds).all());
  } catch (err) {
    if (!/no such (column|table)/i.test(String(err && err.message))) throw err;
  }
  const linksByPiece = new Map();
  for (const row of linkRows) {
    const list = linksByPiece.get(row.piece_id) || [];
    list.push({ title: row.title, url: row.url });
    linksByPiece.set(row.piece_id, list);
  }
  const byPiece = new Map();
  for (const row of coplaRows) {
    const list = byPiece.get(row.piece_id) || [];
    list.push({ position: row.position, section_label: row.section_label, notes: row.notes, role: row.role, id: row.id, incipit: row.incipit, text: row.text });
    byPiece.set(row.piece_id, list);
  }
  return pieces.map(piece => {
    const coplas = byPiece.get(piece.id) || [];
    return {
      id: piece.id,
      title: piece.title,
      slug: piece.slug,
      author: piece.author,
      context_territory: piece.context_territory_id
        ? { id: piece.context_territory_id, nome: piece.context_nome, tipo: piece.context_tipo }
        : null,
      description: piece.description,
      notes: piece.notes,
      status: piece.status,
      visibility: piece.visibility || "public",
      owner: piece.owner_handle ? { handle: piece.owner_handle, display_name: piece.owner_name } : null,
      editorial: piece.owner_user_id == null,
      created_at: piece.created_at,
      updated_at: piece.updated_at,
      copla_count: coplas.length,
      links: linksByPiece.get(piece.id) || [],
      coplas,
    };
  });
}

async function handleMyPieces(request, env, url) {
  const viewer = await getViewer(request, env);
  if (!viewer) throw new HttpError(401, "Tes que entrar con Google.");
  if (viewer.open || !(viewer.id > 0)) return jsonNoStore({ ok: true, pieces: [] }, { env });
  return jsonNoStore({ ok: true, pieces: await exportPiecesJson(env, { ownerId: viewer.id }) }, { env });
}

// Pezas públicas agochadas: só para guías/admin, para poder volver amosalas.
async function handleHiddenPieces(request, env, url) {
  await requireRole(request, env, url, EDITOR_ROLES);
  return jsonNoStore({ ok: true, pieces: await exportPiecesJson(env, { hiddenOnly: true }) }, { env });
}

// O PDF dunha peza só sae se é pública (e non agochada) ou se a pide a súa dona.
async function assertPieceReadable(request, env, pieceId) {
  let row;
  try {
    row = await env.DB.prepare("SELECT owner_user_id, visibility, status FROM pieces WHERE id = ?").bind(pieceId).first();
  } catch (err) {
    if (/no such column/i.test(String(err && err.message))) return; // sen migración: todas públicas
    throw err;
  }
  if (!row) throw new HttpError(404, "Non existe a peza.");
  if (row.visibility === "public" && row.status !== "hidden") return;
  const viewer = await getViewer(request, env);
  if (viewer && (viewer.open || (viewer.id > 0 && viewer.id === row.owner_user_id))) return;
  if (viewer && row.visibility === "public" && EDITOR_ROLES.includes(viewer.role)) return;
  throw new HttpError(404, "Non existe a peza.");
}

// ---------------------------------------------------------------------
// Seguir persoas (só perfís públicos)
// ---------------------------------------------------------------------

async function handleMyFollows(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const { results } = await personalTables(env, () => env.DB.prepare(
    `SELECT pr.handle, pr.display_name, t.nome AS territory_name
     FROM follows f
     JOIN profiles pr ON pr.user_id = f.followee_id AND pr.is_public = 1 AND pr.handle IS NOT NULL
     LEFT JOIN territories t ON t.id = pr.territory_id
     WHERE f.follower_id = ? ORDER BY pr.display_name COLLATE NOCASE`
  ).bind(viewer.id).all());
  return jsonNoStore({ ok: true, following: results }, { env });
}

async function handleToggleFollow(request, env, url) {
  const viewer = await requirePersonalSpace(request, env, url);
  const payload = await request.json().catch(() => ({}));
  const handle = String(payload.handle || "").toLowerCase();
  const target = await personalTables(env, () => env.DB.prepare(
    "SELECT user_id FROM profiles WHERE handle = ? AND is_public = 1"
  ).bind(handle).first());
  if (!target) throw new HttpError(404, "Non existe ese perfil.");
  if (target.user_id === viewer.id) throw new HttpError(400, "Non podes seguirte a ti mesma.");
  if (payload.on === false) {
    await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?").bind(viewer.id, target.user_id).run();
  } else {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(viewer.id).first();
    if (Number(count?.n || 0) >= 500) throw new HttpError(400, "Chegaches ao límite de perfís seguidos.");
    await env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)").bind(viewer.id, target.user_id).run();
  }
  return jsonNoStore({ ok: true, handle, on: payload.on !== false }, { env });
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (!env.DB) {
      return errorResponse("Falta o binding D1 'DB' na configuración do Worker.", {
        status: 500,
        env,
      });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/territories") {
        return await handleTerritories(env);
      }
      if (request.method === "GET" && url.pathname === "/api/coplas") {
        return await handleCoplas(env, url);
      }

      if (request.method === "GET" && url.pathname === "/data/exports/territorios/territorios.json") {
        return await cachedExport(request, env, ctx, url, "territorios", () => exportTerritoriosJson(env));
      }
      if (request.method === "GET" && url.pathname === "/data/exports/coplas/coplas.json") {
        return await cachedExport(request, env, ctx, url, "coplas", () => exportCoplasJson(env));
      }
      if (request.method === "GET" && url.pathname === "/data/exports/media/media.json") {
        return await cachedExport(request, env, ctx, url, "media", () => exportMediaJson(env));
      }

      if (request.method === "GET" && url.pathname === "/data/exports/melodias/melodias.json") {
        return await cachedExport(request, env, ctx, url, "melodias", () => exportMelodiasJson(env));
      }
      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        return await handleAuthMe(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/google") {
        return await handleGoogleStart(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/google/callback") {
        return await handleGoogleCallback(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        return await handleLogout(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/users") {
        return await handleUsersList(request, env, url);
      }
      if (url.pathname === "/api/me/profile") {
        if (request.method === "GET") return await handleMyProfile(request, env, url);
        if (request.method === "POST") return await handleSaveProfile(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/me/favorites") {
        return await handleMyFavorites(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/me/favorites") {
        return await handleToggleFavorite(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/pieces/hidden") {
        return await handleHiddenPieces(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/me/pieces") {
        return await handleMyPieces(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/me/follows") {
        return await handleMyFollows(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/me/follows") {
        return await handleToggleFollow(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/data/exports/pezas/pezas.json") {
        return await cachedExport(request, env, ctx, url, "pezas", () => exportPiecesJson(env));
      }
      if (request.method === "POST" && url.pathname === "/api/pieces") {
        return await handleSavePiece(request, env, url);
      }
      if (request.method === "DELETE" && url.pathname === "/api/pieces") {
        return await handleDeletePiece(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/pieces/visibility") {
        return await handlePieceVisibility(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/pieces/moderate") {
        return await handlePieceModerate(request, env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/me/delete") {
        return await handleDeleteAccount(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/people") {
        return await handlePeopleList(env);
      }
      const personMatch = url.pathname.match(/^\/api\/people\/([a-z0-9-]{3,30})$/);
      if (request.method === "GET" && personMatch) {
        return await handlePersonPage(env, personMatch[1]);
      }
      if (request.method === "POST" && url.pathname === "/api/users/role") {
        return await handleUserRole(request, env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/link-preview") {
        await requireRole(request, env, url, EDITOR_ROLES);
        return await handleLinkPreview(env, url);
      }
      if (request.method === "GET" && url.pathname === "/api/pdf-proxy") {
        return await handlePdfProxy(env, url);
      }
      if (request.method === "POST" && url.pathname === "/api/melodies") {
        await requireRole(request, env, url, EDITOR_ROLES);
        const payload = await request.json();
        const ids = await importMelodies(env, payload);
        await bumpDataVersion(env);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "DELETE" && url.pathname === "/api/melodies") {
        await requireRole(request, env, url, EDITOR_ROLES);
        const payload = await request.json().catch(() => ({}));
        const ids = await deleteMelodies(env, payload.ids);
        await bumpDataVersion(env);
        return jsonResponse({ ok: true, ids }, { env });
      }

      if (request.method === "POST" && url.pathname === "/api/coplas") {
        await requireRole(request, env, url, EDITOR_ROLES);
        const payload = await request.json();
        const ids = await importCoplas(env, payload);
        await bumpDataVersion(env);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "DELETE" && url.pathname === "/api/coplas") {
        await requireRole(request, env, url, EDITOR_ROLES);
        const payload = await request.json().catch(() => ({}));
        const ids = await deleteCoplas(env, payload.ids);
        await bumpDataVersion(env);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "POST" && url.pathname === "/api/media") {
        await requireRole(request, env, url, EDITOR_ROLES);
        const payload = await request.json();
        const ids = await importMedia(env, payload);
        await bumpDataVersion(env);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "DELETE" && url.pathname === "/api/media") {
        await requireRole(request, env, url, EDITOR_ROLES);
        const payload = await request.json().catch(() => ({}));
        const ids = await deleteMedia(env, payload.ids);
        await bumpDataVersion(env);
        return jsonResponse({ ok: true, ids }, { env });
      }

      const pieceIdMatch = url.pathname.match(/^\/api\/pieces\/(\d+)\/pdf$/);
      if (request.method === "GET" && pieceIdMatch) {
        await requirePdfViewer(request, env, url);
        await assertPieceReadable(request, env, Number(pieceIdMatch[1]));
        const document = await buildPieceDocumentForPdf(env, Number(pieceIdMatch[1]));
        const pdf = await renderPdfViaBrowserRun(env, renderPiecePdfHtml(document));
        return pdfResponse(pdf, `fol-e-ar-${pdfSafeFilename(document.title, "peza")}.pdf`);
      }

      if (request.method === "POST" && url.pathname === "/api/pdf/piece-draft") {
        await requirePdfViewer(request, env, url);
        const payload = await request.json();
        const document = await buildPieceDraftDocumentForPdf(env, payload);
        const pdf = await renderPdfViaBrowserRun(env, renderPiecePdfHtml(document));
        return pdfResponse(pdf, `fol-e-ar-${pdfSafeFilename(document.title, "peza")}.pdf`);
      }

      const territoryIdMatch = url.pathname.match(/^\/api\/territories\/([^/]+)\/pdf$/);
      if (request.method === "GET" && territoryIdMatch) {
        await requirePdfViewer(request, env, url);
        const document = await buildTerritoryDocumentForPdf(env, decodeURIComponent(territoryIdMatch[1]));
        const pdf = await renderPdfViaBrowserRun(env, renderTerritoryPdfHtml(document));
        return pdfResponse(pdf, `fol-e-ar-${pdfSafeFilename(document.title, "territorio")}.pdf`);
      }

      // Calquera outra ruta cae ao binding de Static Assets (frontend).
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return errorResponse("Endpoint non atopado.", { status: 404, env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof HttpError) && /D1_|SQLITE_|no such (table|column)|constraint|binding/i.test(message)) {
        // Detalle interno (esquema, SQL): vai ao log do Worker, non á persoa.
        console.error("Erro interno:", message);
        return errorResponse("Erro interno do servidor.", { status: 500, env });
      }
      return errorResponse(message, { status: err instanceof HttpError ? err.status : 400, env });
    }
  },
};
