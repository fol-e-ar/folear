const cache = new Map();
let cacheVersion = 0;

function isLocalFrontendMode() {
  return window.location.pathname.includes("/frontend/");
}

function isInsidePages() {
  return window.location.pathname.includes("/pages/");
}

function getDataPrefix() {
  const localFrontend = isLocalFrontendMode();
  const insidePages = isInsidePages();

  if (localFrontend) {
    return insidePages ? "../../" : "../";
  }

  return insidePages ? "../" : "./";
}

function getAssetsPrefix() {
  const localFrontend = isLocalFrontendMode();
  const insidePages = isInsidePages();

  if (localFrontend) {
    return insidePages ? "../" : "./";
  }

  return insidePages ? "../" : "./";
}

function buildPaths() {
  const dataBase = getDataPrefix();
  const assetsBase = getAssetsPrefix();

  return {
    territorios: `${dataBase}data/exports/territorios/territorios.json`,
    coplas: `${dataBase}data/exports/coplas/coplas.json`,
    pezas: `${dataBase}data/exports/pezas/pezas.json`,
    media: `${dataBase}data/exports/media/media.json`,
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

export async function getPezas() {
  const paths = buildPaths();
  return fetchJson(paths.pezas);
}

export async function getMedia() {
  const paths = buildPaths();
  return fetchJson(paths.media);
}

export function clearApiCache() {
  cache.clear();
  cacheVersion += 1;
}

export function getPathConfig() {
  return buildPaths();
}
