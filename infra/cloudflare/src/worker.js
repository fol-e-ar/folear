/**
 * Fol e ar · Worker API (fase 1, punto de partida)
 *
 * Isto NON é a API de produción completa descrita en
 * docs/arquitectura-cloudflare.md (secc. 6). É un esqueleto mínimo que
 * demostra o patrón: binding de D1, CORS controlado, erros consistentes en
 * JSON, e dous endpoints de só lectura equivalentes aos exports estáticos
 * actuais (territorios e coplas). Serve para validar que o esquema D1
 * funciona e como base para engadir o resto en fase 2:
 *
 *   - autenticación de administración (ADMIN_TOKEN / OAuth)
 *   - POST /api/submissions (achegas pendentes de revisión, nunca escritura
 *     directa no corpus publicado)
 *   - endpoints de pezas e media
 *   - Turnstile + rate limiting nas rutas públicas de escritura
 *   - xeración/descarga de PDF (ver secc. 7, depende de Browser Rendering)
 *
 * Deseño deliberado:
 *   - Sen ORM: SQL explícito, igual que backend/services/*.py, para que a
 *     lóxica sexa doada de comparar cos exportadores Python existentes.
 *   - CORS restrinxido por variable de contorno ALLOWED_ORIGIN, nunca "*"
 *     en produción.
 *   - Formato de erro consistente: { ok: false, error: string }.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
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

export default {
  async fetch(request, env) {
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

      // Calquera outra ruta cae ao binding de Static Assets (frontend),
      // se este Worker está configurado con [assets] en wrangler.toml.
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return errorResponse("Endpoint non atopado.", { status: 404, env });
    } catch (err) {
      return errorResponse(err instanceof Error ? err.message : String(err), {
        status: 500,
        env,
      });
    }
  },
};
