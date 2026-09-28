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
