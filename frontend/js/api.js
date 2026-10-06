const cache = new Map();
let cacheVersion = 0;

function isLocalFrontendMode() {
  return window.location.pathname.includes("/frontend/");
}

// En local a app vive en /frontend/ e os datos un nivel por riba; en produción
// (Cloudflare) frontend e datos cuelgan da mesma raíz.
function getDataPrefix() {
  return isLocalFrontendMode() ? "../" : "./";
}

function getAssetsPrefix() {
  return "./";
}

function buildPaths() {
  const dataBase = getDataPrefix();
  const assetsBase = getAssetsPrefix();

  return {
    territorios: `${dataBase}data/exports/territorios/territorios.json`,
    coplas: `${dataBase}data/exports/coplas/coplas.json`,
    pezas: `${dataBase}data/exports/pezas/pezas.json`,
    media: `${dataBase}data/exports/media/media.json`,
    melodias: `${dataBase}data/exports/melodias/melodias.json`,
    geo: {
      prov: `${assetsBase}assets/web/provincias.web.geojson`,
      com: `${assetsBase}assets/web/comarcas.web.geojson`,
      con: `${assetsBase}assets/web/concellos.web.geojson`,
      par: `${assetsBase}assets/web/parroquias.web.topo.json`,
      cerdedoCotobadeParts: `${assetsBase}assets/web/cerdedo-cotobade-parts.geojson`,
    },
  };
}

function resolvePath(path) {
  const url = new URL(path, window.location.href);
  if (cacheVersion) url.searchParams.set("_", String(cacheVersion));
  return url.toString();
}

async function fetchJson(path) {
  const resolved = resolvePath(path);

  if (cache.has(resolved)) {
    return cache.get(resolved);
  }

  const promise = fetch(resolved, { cache: "no-store" }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`Non se puido cargar ${path}`);
    }
    return res.json();
  });

  cache.set(resolved, promise);
  return promise;
}

export async function getTerritorios() {
  const paths = buildPaths();
  return fetchJson(paths.territorios);
}

function firstTextLine(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  const found = lines.find(line => line.trim());
  return found ? found.trim() : "";
}

function coplaSortKey(copla) {
  const line = firstTextLine(copla.text) || copla.incipit || "";
  return line
    .replace(/^[¿¡\s]+/, "")
    .replace(/[¿¡!?.,;:"'«»“”()]/g, "")
    .trim();
}

function sortCoplas(list) {
  return [...list].sort((a, b) => coplaSortKey(a).localeCompare(coplaSortKey(b), "gl", { sensitivity: "base", numeric: true }));
}

export async function getCoplas() {
  const paths = buildPaths();
  const data = await fetchJson(paths.coplas);
  return sortCoplas(Array.isArray(data) ? data : []);
}

export async function getGeoLayer(tipo) {
  const paths = buildPaths();
  const path = paths.geo[tipo];

  if (!path) {
    throw new Error(`Tipo de capa non soportado: ${tipo}`);
  }

  return fetchJson(path);
}

// Pezas públicas (exporte cacheado) + as da persoa con sesión (privadas e
// públicas) + as agochadas por moderación para guías/admin. Se algunha das
// dúas últimas falla (sen sesión, sen migración, modo local), a biblioteca
// segue funcionando coas públicas.
async function getJsonOrNull(url) {
  try {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok !== false ? data : null;
  } catch {
    return null;
  }
}

export async function getPezas({ account = false, moderator = false } = {}) {
  const paths = buildPaths();
  const publicList = await fetchJson(paths.pezas);
  const base = Array.isArray(publicList) ? publicList : [];
  if (!account && !moderator) return base;
  const [mine, hidden] = await Promise.all([
    account ? getJsonOrNull("../api/me/pieces") : null,
    moderator ? getJsonOrNull("../api/pieces/hidden") : null,
  ]);
  const byId = new Map();
  base.forEach(piece => byId.set(piece.id, { ...piece }));
  (hidden?.pieces || []).forEach(piece => byId.set(piece.id, { ...piece, moderation: true }));
  (mine?.pieces || []).forEach(piece => byId.set(piece.id, { ...piece, mine: true }));
  return [...byId.values()].sort((a, b) =>
    String(b.updated_at || "").localeCompare(String(a.updated_at || "")) || Number(b.id) - Number(a.id));
}

// Media pública (exporte cacheado) + os recursos privados da persoa con sesión (os que
// van ligados ás súas pezas privadas). Se o segundo pedido falla, queda a pública.
export async function getMedia({ account = false } = {}) {
  const paths = buildPaths();
  const publicList = await fetchJson(paths.media);
  const base = Array.isArray(publicList) ? publicList : [];
  if (!account) return base;
  const mine = await getJsonOrNull("../api/me/media");
  const seen = new Set(base.map(item => String(item.id)));
  return [...base, ...(mine?.media || []).filter(item => !seen.has(String(item.id)))];
}

export async function getMelodias() {
  // O inventario de melodías é novo: se o ficheiro aínda non existe (base
  // sen migrar) a aplicación segue funcionando coma antes, só sen melodías.
  try {
    const data = await fetchJson(buildPaths().melodias);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function clearApiCache() {
  cache.clear();
  cacheVersion += 1;
}

export function getPathConfig() {
  return buildPaths();
}

export async function getTextAsset(path) {
  const res = await fetch(new URL(`${getAssetsPrefix()}${path}`, window.location.href).toString());
  if (!res.ok) throw new Error(`Non se puido cargar ${path}`);
  return res.text();
}
