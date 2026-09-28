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
 *   - Autenticación real de administración: por agora confíase en que
 *     Cloudflare Access garda TODO o Worker antes de que calquera petición
 *     chegue aquí (ver README.md "Acceso"); non hai ADMIN_TOKEN aplicado
 *     no código, aínda que a variable segue dispoñible por se fai falla
 *     coma defensa extra no futuro.
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
// Contrasinal unico compartido (HTTP Basic Auth), alternativa gratuita a
// Cloudflare Access (que require plan de pago). O navegador amosa o seu
// dialogo nativo de login; o nome de usuario ignorase, so importa o
// contrasinal. Se non hai SITE_PASSWORD configurado (p.ex. en local dev
// sen secret posto), non bloquea nada.
// ---------------------------------------------------------------------

function checkSitePassword(request, env) {
  if (!env.SITE_PASSWORD) return true;
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(auth.slice(6));
  } catch (err) {
    return false;
  }
  const sepIndex = decoded.indexOf(":");
  const password = sepIndex === -1 ? decoded : decoded.slice(sepIndex + 1);
  return password === env.SITE_PASSWORD;
}

function authRequiredResponse() {
  return new Response("Autenticacion necesaria.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="fol e ar", charset="UTF-8"' },
  });
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
      if (!["territory", "copla", "piece"].includes(entityType)) {
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

const PRINT_CSS = `@page {
  size: A4;
  margin: 18mm 16mm 18mm;
}

@page {
  @bottom-right {
    content: "Fol e Ar · " counter(page);
    color: #8a8d86;
    font-size: 8pt;
  }
}

* {
  box-sizing: border-box;
}

body {
  color: #22261f;
  font-family: "Arial", "Helvetica", sans-serif;
  font-size: 10.5pt;
  line-height: 1.45;
  margin: 0;
}

.document-header {
  border-bottom: 0.4pt solid #d7d9d2;
  margin-bottom: 8mm;
  padding-bottom: 5mm;
}

.brand {
  color: #6f7668;
  font-size: 8pt;
  letter-spacing: 0.12em;
  margin-bottom: 5mm;
  text-transform: uppercase;
}

h1 {
  color: #151814;
  font-family: "Georgia", "Times New Roman", serif;
  font-size: 26pt;
  font-weight: 400;
  line-height: 1.05;
  margin: 0 0 3mm;
}

.meta-row {
  color: #5d6458;
  display: flex;
  flex-wrap: wrap;
  font-size: 9pt;
  gap: 3mm;
  margin-bottom: 3mm;
}

.meta-row span + span::before {
  color: #a2a79f;
  content: "·";
  margin-right: 3mm;
}

.description,
.notes {
  color: #545a50;
  margin: 2mm 0 0;
}

.description:empty,
.notes:empty,
.meta-row:empty {
  display: none;
}

.piece-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 11mm;
  align-items: start;
}

.territory-list {
  max-width: 150mm;
}

.part {
  break-inside: avoid;
  margin: 0 0 8mm;
}

.part-title {
  break-after: avoid;
  color: #305946;
  font-size: 9.5pt;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0 0 4mm;
  text-transform: uppercase;
}

.copla {
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 0 0 5.5mm;
}

.copla-text {
  font-family: "Georgia", "Times New Roman", serif;
  font-size: 11.2pt;
  line-height: 1.38;
  white-space: pre-line;
}

.copla.retrouso .copla-text {
  color: #3f463c;
  font-style: italic;
  margin-left: 8mm;
}

.copla-meta,
.copla-notes {
  color: #737a70;
  font-size: 8pt;
  margin-top: 1.8mm;
}

.copla-notes {
  font-style: italic;
}

.empty {
  color: #6c7368;
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
    if (council) label = `${label} \u00b7 ${council}`;
  }
  return label;
}

async function territoryContextForPdf(env, territory) {
  const hierarchy = await territoryHierarchyForPdf(env, territory);
  return hierarchy.map(item => `${PDF_TYPE_LABELS[item.tipo] || item.tipo}: ${item.nome}`).join(" \u00b7 ");
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
    <div class="brand">Fol e Ar</div>
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
    <div class="brand">Fol e Ar</div>
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
    throw new Error(`Cloudflare Browser Run devolveu un erro (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.arrayBuffer();
}

function pdfResponse(pdfBuffer, filename) {
  return new Response(pdfBuffer, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
    },
  });
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (!checkSitePassword(request, env)) {
      return authRequiredResponse();
    }

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
        return jsonResponse(await exportTerritoriosJson(env), { env });
      }
      if (request.method === "GET" && url.pathname === "/data/exports/coplas/coplas.json") {
        return jsonResponse(await exportCoplasJson(env), { env });
      }
      if (request.method === "GET" && url.pathname === "/data/exports/media/media.json") {
        return jsonResponse(await exportMediaJson(env), { env });
      }

      if (request.method === "POST" && url.pathname === "/api/coplas") {
        const payload = await request.json();
        const ids = await importCoplas(env, payload);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "DELETE" && url.pathname === "/api/coplas") {
        const payload = await request.json().catch(() => ({}));
        const ids = await deleteCoplas(env, payload.ids);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "POST" && url.pathname === "/api/media") {
        const payload = await request.json();
        const ids = await importMedia(env, payload);
        return jsonResponse({ ok: true, ids }, { env });
      }
      if (request.method === "DELETE" && url.pathname === "/api/media") {
        const payload = await request.json().catch(() => ({}));
        const ids = await deleteMedia(env, payload.ids);
        return jsonResponse({ ok: true, ids }, { env });
      }

      const pieceIdMatch = url.pathname.match(/^\/api\/pieces\/(\d+)\/pdf$/);
      if (request.method === "GET" && pieceIdMatch) {
        const document = await buildPieceDocumentForPdf(env, Number(pieceIdMatch[1]));
        const pdf = await renderPdfViaBrowserRun(env, renderPiecePdfHtml(document));
        return pdfResponse(pdf, `fol-e-ar-${pdfSafeFilename(document.title, "peza")}.pdf`);
      }

      if (request.method === "POST" && url.pathname === "/api/pdf/piece-draft") {
        const payload = await request.json();
        const document = await buildPieceDraftDocumentForPdf(env, payload);
        const pdf = await renderPdfViaBrowserRun(env, renderPiecePdfHtml(document));
        return pdfResponse(pdf, `fol-e-ar-${pdfSafeFilename(document.title, "peza")}.pdf`);
      }

      const territoryIdMatch = url.pathname.match(/^\/api\/territories\/([^/]+)\/pdf$/);
      if (request.method === "GET" && territoryIdMatch) {
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
      return errorResponse(err instanceof Error ? err.message : String(err), {
        status: 400,
        env,
      });
    }
  },
};
