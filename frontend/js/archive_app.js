import { clearApiCache, getCoplas, getGeoLayer, getMedia, getMelodias, getPezas, getTerritorios, getTextAsset } from "./api.js";
import { escapeHtml, loaderHtml, nl2br, normalizeText, setLoading, slugify } from "./utils.js";
import { initPdfThumbs } from "./pdf_thumbs.js";
import {
  TYPE_LABELS,
  buildHierarchy,
  filterCoplasByTerritory,
  filterMediaByContext,
  filterPiecesByTerritory,
  findTerritoryByFeature,
  getChildren,
  getDescendantIds,
  getFeatureCod,
  getFeatureNome,
  searchTerritories,
} from "./territory_data.js";

const RHYTHMS = [
  "Carballesa",
  "Charrasquiño",
  "Chiqui-chiqui",
  "Danza",
  "Dous pasos",
  "Esparabán",
  "Fandango",
  "Maneo",
  "Mazurca",
  "Muiñeira",
  "Muiñeira corrida",
  "Pandeirada",
  "Pasodobre",
  "Polca",
  "Ribeirana",
  "Rumba",
  "Valse",
  "Xota",
].sort((a, b) => a.localeCompare(b, "gl"));
const MUSICAL_MEDIA_KINDS = new Set(["audio", "spotify", "soundcloud"]);
const DRAFT_KEY = "fol-e-ar-piece-cart-v2";
const RESUME_KEY = "fol-e-ar-resume";
const VIEWS = ["map", "coplas", "melodies", "pieces", "territory", "submit", "media", "about", "profile", "people"];

const VIEW_PREFS_KEY = "fol-e-ar-view-prefs";

// Vista escollida en cada listaxe (só unha comodidade por navegador).
function loadViewPrefs() {
  try {
    return JSON.parse(localStorage.getItem(VIEW_PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveViewPref(key, value) {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify({ ...loadViewPrefs(), [key]: value }));
  } catch {
    // Sen almacenamento (modo privado): a escolla vale só ata recargar.
  }
}

const state = {
  historyReady: false,
  territorios: [],
  coplas: [],
  pezas: [],
  media: [],
  melodias: [],
  mediaMelodyIds: [],
  melodyModal: null,
  map: null,
  layer: null,
  layerType: "con",
  selectedTerritory: null,
  resourcesOpen: false,
  drawerResourcesOpen: false,
  selectedCoplaId: null,
  view: "map",
  territoryTab: "coplas",
  coplaViewMode: "gallery",
  mediaViewMode: "grid",
  melodyViewMode: "grid",
  pieceViewMode: "grid",
  authorStripOpen: false,
  coplaLastSelectedId: null,
  pasteDraft: "",
  pasteFeedback: "",
  pasteDupes: null,
  pastePlace: null,
  pasteLugar: "",
  pasteLotSeq: 0,
  pieceTab: "workshop",
  coplaQuery: "",
  coplaStateFilter: "all",
  coplaSelectMode: false,
  coplaSelectedIds: [],
  batchTerritoryIds: [],
  batchAssignModalOpen: false,
  deleteConfirmIds: [],
  deleteConfirmKind: "coplas",
  deleteConfirmOpen: false,
  deleteConfirmBusy: false,
  territoryQuery: "",
  territoryCoplaQuery: "",
  pieceLibraryQuery: "",
  pieceTerritoryQuery: "",
  pieceRepositoryQuery: "",
  pieceRhythmQuery: "",
  pieceAuthorFilter: "",
  pieceScope: "all",
  pieceEntryModal: "",
  pieceNotice: "",
  pieceAddMenu: false,
  pieceLibraryOpen: false,
  pieceAddTarget: "",
  melodyQuery: "",
  melodyRhythmFilter: "",
  mediaQuery: "",
  mediaKindFilter: "",
  mediaRoleFilter: "",
  mediaModalOpen: false,
  mediaDefaultRole: "",
  aboutPrivacy: false,
  aboutTerritoryQuery: "",
  aboutTerritoryId: "",
  submitTerritoryId: "",
  submitTerritoryIds: [],
  submitGeneral: false,
  submitEditingId: null,
  submitEditingSnapshot: null,
  submitReturnView: null,
  submitBatch: [],
  mediaTerritoryIds: [],
  mediaCoplaIds: [],
  mediaEditingId: null,
  mediaEditingSnapshot: null,
  mediaEditingPieceLinks: [],
  pdfUrl: "",
  pdfFilename: "",
  pdfBusy: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const memoryStore = new Map();

function storageGet(key) {
  try {
    return window.localStorage?.getItem(key) ?? memoryStore.get(key) ?? null;
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

function storageSet(key, value) {
  memoryStore.set(key, value);
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Keep the current session usable when browser storage is unavailable.
  }
}

if (window.FOL_E_AR_FILE_MODE) {
  throw new Error("Fol e ar debe abrirse desde o servidor local, non con file://.");
}

function normalizeView(view = "map") {
  const aliases = {
    place: "map",
    lugar: "map",
    mapa: "map",
    corpus: "coplas",
    copla: "coplas",
    pezas: "pieces",
    builder: "pieces",
    obradoiro: "pieces",
    alta: "submit",
    importar: "submit",
    territorios: "territory",
    melodias: "melodies",
    melodia: "melodies",
  };
  return aliases[view] || (VIEWS.includes(view) ? view : "map");
}

// --- Conta e permisos (js/auth.js) ----------------------------------------
// O servidor é quen decide; isto só adapta a interface.

function authInfo() {
  return window.folearAuth || { mode: "offline", user: null, ready: false };
}

function isGoogleMode() {
  return authInfo().mode === "google";
}

function isAccount() {
  const info = authInfo();
  return info.mode === "google" && Boolean(info.user) && !info.user.open;
}

function isEditorAccount() {
  return isAccount() && Boolean(authInfo().canEdit?.());
}

function notify(message) {
  if (window.folearAuth?.toast) window.folearAuth.toast(message);
}

// Os PDFs xéranse no servidor con cota limitada: en produción só para contas.
function pdfNeedsLogin() {
  const info = authInfo();
  return info.mode === "google" && !info.user;
}

function pdfErrorMessage(error) {
  const text = String(error?.message || "");
  // Mensaxes do servidor (galego) pásanse tal cal; o resto, xenérico.
  if (text && !/^HTTP \d+$|^Resposta inesperada|Failed to fetch|NetworkError|Load failed/i.test(text)) return text;
  return "Non foi posíbel xerar o PDF agora. Téntao de novo en pouco.";
}

function loginLink() {
  return window.folearAuth?.loginUrl?.() || "../api/auth/google";
}

// Media pública + (con sesión) os recursos privados das pezas privadas da persoa.
function loadMedia() {
  return getMedia({ account: isAccount() });
}

async function refreshPezas({ render = true } = {}) {
  clearApiCache();
  try {
    const [pezas, media] = await Promise.all([
      getPezas({ account: isAccount(), moderator: isEditorAccount() }),
      loadMedia().catch(() => null),
    ]);
    state.pezas = pezas;
    if (media) state.media = media;
  } catch (error) {
    console.error(error);
  }
  if (!isAccount() && state.pieceScope === "mine") state.pieceScope = "all";
  window.dispatchEvent(new CustomEvent("folear:pezas"));
  if (render && state.view === "pieces") renderPiecesView();
}

async function pieceApi(path, method, body) {
  const response = await fetch(`../api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) {
    const error = new Error((data && data.error) || `Erro ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function defaultDraft() {
  return {
    title: "",
    author: "",
    notes: "",
    status: "draft",
    territoryId: "",
    lugar: "",
    sections: [
      { id: "parte-1", label: "", coplas: [] },
    ],
  };
}

function loadDraft() {
  try {
    const raw = JSON.parse(storageGet(DRAFT_KEY));
    if (!raw || typeof raw !== "object") return defaultDraft();
    const base = defaultDraft();
    const sections = Array.isArray(raw.sections) && raw.sections.length ? raw.sections : base.sections;
    return {
      ...base,
      ...raw,
      sections: sections.map(section => ({
        ...section,
        coplas: (section.coplas || []).map(item => ({ ...item, uid: item.uid || `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2)}` })),
      })),
    };
  } catch {
    return defaultDraft();
  }
}

function saveDraft(draft) {
  storageSet(DRAFT_KEY, JSON.stringify(draft));
  updateCartBadges(draft);
  return draft;
}

function draftCount(draft = loadDraft()) {
  return draft.sections.reduce((sum, section) => sum + section.coplas.length, 0);
}

function updateCartBadges(draft = loadDraft()) {
  const total = draftCount(draft);
  all("[data-cart-count]").forEach(badge => {
    badge.textContent = total;
    badge.hidden = total === 0;
  });
}

function topoToGeo(data) {
  if (data?.type !== "Topology" || !window.topojson) return data;
  const objectName = Object.keys(data.objects || {})[0];
  return window.topojson.feature(data, data.objects[objectName]);
}

async function geoLayerForMap(type) {
  let data = topoToGeo(await getGeoLayer(type));
  if (type !== "com") return data;
  data = {
    ...data,
    features: (data.features || []).filter(feature => Number(feature?.properties?.CODCOM) !== 0),
  };
  const parts = await getGeoLayer("cerdedoCotobadeParts");
  return { ...data, features: [...data.features, ...(parts.features || [])] };
}

/* ==========================================================
   Siluetas: contorno de cada territorio debuxado en SVG a partir
   dos mesmos GeoJSON do mapa (sen Leaflet, sen mapa base).
   Galiza usa assets/silhuetas/galiza.svg (substituíbel).
   ========================================================== */
const silhouetteIndexes = new Map();
const silhouetteCache = new Map();
const SIL_DETAIL = { hero: 0.12, chip: 0.55 };

function geoIndexFor(tipo) {
  if (!silhouetteIndexes.has(tipo)) {
    silhouetteIndexes.set(tipo, geoLayerForMap(tipo).then(data => {
      const index = new Map();
      (data.features || []).forEach(feature => {
        const cod = getFeatureCod(feature, tipo);
        if (cod == null || Number.isNaN(cod)) return;
        if (!index.has(cod)) index.set(cod, []);
        index.get(cod).push(feature);
      });
      return index;
    }).catch(error => {
      silhouetteIndexes.delete(tipo);
      throw error;
    }));
  }
  return silhouetteIndexes.get(tipo);
}

function simplifyLine(points, eps) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const e2 = eps * eps;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    const [ax, ay] = points[from];
    const dx = points[to][0] - ax;
    const dy = points[to][1] - ay;
    const len2 = dx * dx + dy * dy;
    let far = 0;
    let index = -1;
    for (let i = from + 1; i < to; i += 1) {
      const px = points[i][0] - ax;
      const py = points[i][1] - ay;
      let d2;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      }
      if (d2 > far) { far = d2; index = i; }
    }
    if (far > e2 && index > 0) {
      keep[index] = 1;
      stack.push([from, index], [index, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function ringArea(points) {
  let area = 0;
  for (let i = 0; i < points.length - 1; i += 1) area += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
  return Math.abs(area) / 2;
}

function geometryPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") return (geometry.geometries || []).flatMap(geometryPolygons);
  return [];
}

function buildSilhouette(features, eps) {
  const polygons = features.flatMap(feature => geometryPolygons(feature.geometry));
  if (!polygons.length) return null;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  polygons.forEach(polygon => (polygon[0] || []).forEach(([lon, lat]) => {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }));
  const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = (maxLon - minLon) * k;
  const h = maxLat - minLat;
  if (!(w > 0) || !(h > 0)) return null;
  const scale = 100 / Math.max(w, h);
  let d = "";
  polygons.forEach(polygon => polygon.forEach((ring, ringIndex) => {
    const points = ring.map(([lon, lat]) => [(lon - minLon) * k * scale, (maxLat - lat) * scale]);
    const simple = simplifyLine(points, eps);
    if (simple.length < 4) return;
    if (ringIndex === 0 && polygons.length > 1 && ringArea(simple) < eps * eps * 4) return;
    d += `M${simple.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
  }));
  if (!d) return null;
  return { d, w: Number((w * scale).toFixed(2)), h: Number((h * scale).toFixed(2)) };
}

async function territorySilhouette(territory, detail) {
  const key = `${territory.id}:${detail}`;
  if (!silhouetteCache.has(key)) {
    silhouetteCache.set(key, geoIndexFor(territory.tipo).then(index => {
      const features = index.get(Number(territory.cod));
      return features?.length ? buildSilhouette(features, SIL_DETAIL[detail]) : null;
    }).catch(() => null));
  }
  return silhouetteCache.get(key);
}

function silhouetteSvg(sil, label = "") {
  if (!sil) return "";
  return `<svg class="silhouette" viewBox="0 0 ${sil.w} ${sil.h}" preserveAspectRatio="xMidYMid meet" ${label ? `role="img" aria-label="Silueta de ${escapeHtml(label)}"` : `aria-hidden="true"`}><path d="${sil.d}" fill="currentColor" fill-rule="evenodd"/></svg>`;
}

let galizaSilhouettePromise = null;
function galizaSilhouetteMarkup() {
  if (!galizaSilhouettePromise) {
    galizaSilhouettePromise = getTextAsset("assets/silhuetas/galiza.svg")
      .then(text => text.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "").trim())
      .then(text => /<svg[\s>]/i.test(text) ? `<span class="silhouette-file" role="img" aria-label="Silueta de Galiza">${text}</span>` : "")
      .catch(() => "");
  }
  return galizaSilhouettePromise;
}

async function hydrateSilhouettes(root = document) {
  const hero = $("[data-silhouette-hero]", root);
  if (hero) {
    const id = hero.dataset.silhouetteHero;
    const territory = id === "galiza" ? null : state.territorios.find(item => item.id === id);
    const markup = territory ? silhouetteSvg(await territorySilhouette(territory, "hero"), territory.nome) : await galizaSilhouetteMarkup();
    if (hero.dataset.silhouetteHero === id && hero.isConnected) hero.innerHTML = markup;
  }
  const chips = all("[data-silhouette]", root);
  if (!chips.length) return;
  const items = chips.map(node => ({ node, territory: state.territorios.find(item => item.id === node.dataset.silhouette) })).filter(entry => entry.territory);
  await Promise.all(items.map(async ({ node, territory }) => {
    const markup = silhouetteSvg(await territorySilhouette(territory, "chip"));
    if (node.isConnected) node.innerHTML = markup;
  }));
}

function territoryLabel(territory) {
  return territory ? (TYPE_LABELS[territory.tipo] || territory.tipo || "Territorio") : "Territorio";
}

function parentCouncil(territory) {
  if (!territory || territory.tipo !== "par") return null;
  return state.territorios.find(item => item.tipo === "con" && item.cod === territory.con) || null;
}

function territoryChipMarkup(item) {
  const full = territoryHasCoplas(item);
  const council = parentCouncil(item);
  return `<button type="button" class="chip-territory ${full ? "has-coplas" : ""}" data-territory-id="${item.id}" title="${escapeHtml(council ? `${item.nome} \\ ${council.nome}` : item.nome)}"><span class="chip-sil" data-silhouette="${item.id}" aria-hidden="true"></span><span class="chip-name">${escapeHtml(item.nome)}</span></button>`;
}

function territorySearchMeta(territory) {
  const council = parentCouncil(territory);
  return council ? `${territoryLabel(territory)} \\ ${council.nome}` : territoryLabel(territory);
}

function territoryDisplayName(territory) {
  const council = parentCouncil(territory);
  return council ? `${territory.nome} \\ ${council.nome}` : territory.nome;
}

function coplaPlaceChipsHtml(copla) {
  const territories = copla.territories || [];
  if (territories.length) {
    return territories.map(t => `<span class="level-chip level-${t.tipo}">${escapeHtml(t.nome)}</span>`).join("");
  }
  return `<span class="level-chip level-empty">${escapeHtml(coplaPlaceLabel(copla))}</span>`;
}

function coplaPlaceTextHtml(copla) {
  const territories = copla.territories || [];
  if (territories.length) {
    return territories.map(t => `<span class="level-text level-${t.tipo}">${escapeHtml(t.nome)}</span>`).join("");
  }
  return `<span class="level-text level-empty">${escapeHtml(coplaPlaceLabel(copla))}</span>`;
}

function coplaPlaceLabel(copla) {
  // «Lugar concreto» (Laxoso...): subdivisión da parroquia, texto libre; vai diante do territorio.
  const lugar = String(copla.lugar || "").trim();
  if ((copla.territories || []).length) return `${lugar ? `${lugar}, ` : ""}${copla.territories.map(item => territoryDisplayName(item)).join(", ")}`;
  if (lugar) return lugar;
  if (copla.territory_state === "general") return "Galiza xeral";
  if (copla.territory_state === "unassigned") return "Territorio descoñecido";
  return "Sen territorio";
}

// Lugares concretos xa usados dentro dos territorios dados (e os seus descendentes), para
// suxerilos ao escribir e non duplicar «Laxoso» / «laxoso».
function knownLugares(territoryIds = []) {
  const wanted = new Set();
  territoryIds.forEach(id => {
    const territory = state.territorios.find(item => item.id === id);
    (territory ? getDescendantIds(territory, state.territorios) : [id]).forEach(value => wanted.add(value));
  });
  const found = new Map();
  const add = (lugar, ids) => {
    const name = String(lugar || "").trim();
    if (!name || (wanted.size && !ids.some(id => wanted.has(id)))) return;
    const key = normalizeText(name);
    const entry = found.get(key) || { name, count: 0 };
    entry.count += 1;
    found.set(key, entry);
  };
  state.coplas.forEach(copla => add(copla.lugar, (copla.territories || []).map(item => item.id)));
  state.pezas.forEach(piece => add(piece.lugar, [piece.context_territory?.id || piece.context_territory_id].filter(Boolean)));
  return [...found.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "gl"));
}

function lugarOptionsMarkup(territoryIds) {
  return knownLugares(territoryIds).slice(0, 60).map(item => `<option value="${escapeHtml(item.name)}"></option>`).join("");
}

function refreshLugarOptions() {
  const ids = state.submitGeneral ? [] : state.submitTerritoryIds;
  const list = $("#lugarList");
  if (list) list.innerHTML = ids.length ? lugarOptionsMarkup(ids) : "";
}

function territoryHasCoplas(territory) {
  if (!territory) return false;
  const ids = new Set(getDescendantIds(territory, state.territorios));
  return state.coplas.some(copla => (copla.territories || []).some(t => ids.has(t.id)));
}

function placeContext(territory = state.selectedTerritory) {
  if (!territory) {
    return {
      hierarchy: [],
      children: state.territorios.filter(item => item.tipo === "prov"),
      descendantIds: state.territorios.map(item => item.id),
      coplas: state.coplas,
      pezas: state.pezas,
      media: state.media,
      melodias: state.melodias,
    };
  }
  const descendantIds = getDescendantIds(territory, state.territorios);
  const coplas = filterCoplasByTerritory(state.coplas, descendantIds);
  const pezas = filterPiecesByTerritory(state.pezas, descendantIds, coplas);
  const territoryScope = new Set(descendantIds);
  const melodias = state.melodias.filter(melody => territoryScope.has(melody.territory_id));
  const media = filterMediaByContext(state.media, descendantIds, coplas, pezas, melodias.map(melody => melody.id));
  return {
    hierarchy: buildHierarchy(territory, state.territorios),
    children: getChildren(territory, state.territorios),
    descendantIds,
    coplas,
    pezas,
    media,
    melodias,
  };
}

// Nomes do territorio e de todos os superiores (provincia, comarca/s, concello): unha copla de Lira
// (parroquia) tamén se atopa buscando «Carnota» (concello), a súa comarca ou a provincia.
let territoryTreeCache = { source: null, names: new Map() };
function territoryTreeNames(territory) {
  if (!territory) return "";
  if (territoryTreeCache.source !== state.territorios) territoryTreeCache = { source: state.territorios, names: new Map() };
  const cache = territoryTreeCache.names;
  if (!cache.has(territory.id)) {
    const full = state.territorios.find(item => item.id === territory.id) || territory;
    cache.set(territory.id, buildHierarchy(full, state.territorios).map(item => item.nome).join(" "));
  }
  return cache.get(territory.id);
}

function coplaHaystack(copla) {
  return [
    (copla.territories || []).map(territoryTreeNames).join(" "),
    copla.text,
    copla.incipit,
    copla.notes,
    copla.territory_state,
    copla.lugar,
    coplaPlaceLabel(copla),
    (copla.tags || []).join(" "),
    (copla.versions || []).map(version => `${version.label || ""} ${version.text || ""} ${version.notes || ""}`).join(" "),
  ].join(" ");
}

function firstLine(text = "") {
  return String(text).split(/\r?\n/).find(line => line.trim())?.trim() || "";
}

function restOfText(text = "") {
  const lines = String(text).split(/\r?\n/);
  const firstIndex = lines.findIndex(line => line.trim());
  if (firstIndex === -1) return "";
  return lines.slice(firstIndex + 1).join("\n");
}

function coplaTitle(copla) {
  return firstLine(copla.text) || copla.incipit || "Copla sen íncipit";
}

function mediaUrl(item) {
  return item.url || item.href || item.link || "";
}

function mediaKind(item) {
  const explicit = normalizeText(item.media_kind || item.type || item.provider || item.kind || "");
  const url = mediaUrl(item).toLowerCase();
  if (explicit.includes("spotify") || url.includes("open.spotify.com")) return "spotify";
  if (explicit.includes("youtube") || url.includes("youtu.be") || url.includes("youtube.com")) return "youtube";
  if (explicit.includes("soundcloud") || url.includes("soundcloud.com")) return "soundcloud";
  if (explicit.includes("audio") || /\.(mp3|wav|ogg|m4a)(\?|#|$)/.test(url)) return "audio";
  if (explicit.includes("video") || /\.(mp4|mov|webm)(\?|#|$)/.test(url)) return "video";
  if (explicit.includes("imaxe") || explicit.includes("image") || /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/.test(url)) return "image";
  if (explicit.includes("pdf") || /\.pdf(\?|#|$)/.test(url)) return "pdf";
  return url ? "web" : "media";
}

function mediaRole(item) {
  const relationTypes = (item.links || []).map(link => normalizeText(link.relation_type || ""));
  if (relationTypes.includes("mixed") || relationTypes.includes("ambas")) return "mixed";
  if (relationTypes.includes("melody") || relationTypes.includes("melodia")) return "melody";
  if (relationTypes.includes("documental") || relationTypes.includes("direct")) {
    return MUSICAL_MEDIA_KINDS.has(mediaKind(item)) ? "melody" : "documental";
  }
  return MUSICAL_MEDIA_KINDS.has(mediaKind(item)) ? "melody" : "documental";
}

function mediaRoleLabel(role) {
  return {
    documental: "Documental",
    melody: "Melodía",
    mixed: "Media + melodía",
  }[role] || "Media";
}

function mediaLabel(kind) {
  return {
    spotify: "Spotify",
    youtube: "YouTube",
    soundcloud: "SoundCloud",
    audio: "Audio",
    video: "Video",
    image: "Imaxe",
    pdf: "PDF",
    web: "Web",
    media: "Media",
  }[kind] || "Media";
}

function youtubeId(url = "") {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.slice(1);
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
    const match = parsed.pathname.match(/\/(embed|shorts)\/([^/?]+)/);
    return match?.[2] || "";
  } catch {
    return "";
  }
}

const MEDIA_KIND_ICONS = {
  youtube: '<path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 5 12 5 12 5s-6 0-7.7.3A2.7 2.7 0 0 0 2.4 7.2 28 28 0 0 0 2 12a28 28 0 0 0 .4 4.8 2.7 2.7 0 0 0 1.9 1.9C6 19 12 19 12 19s6 0 7.7-.3a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 22 12a28 28 0 0 0-.4-4.8Z"/><path d="m10 9.7 5 2.3-5 2.3Z"/>',
  spotify: '<circle cx="12" cy="12" r="9"/><path d="M7.5 10.2c3-.8 6.5-.5 9 1"/><path d="M8 13.3c2.5-.6 5.3-.4 7.5.8"/><path d="M8.5 16.2c2-.5 4.2-.3 6 .6"/>',
  soundcloud: '<path d="M3 15.5V12"/><path d="M6 16v-6"/><path d="M9 16.3V9"/><path d="M12 16.3V7.5c2-1 4.6-.3 5.6 1.7"/><path d="M12 16.3h7a3 3 0 0 0 0-6 4 4 0 0 0-.4 0"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="10" r="1.75"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  pdf: '<path d="M7 3h7l4 4v14H7Z"/><path d="M14 3v4h4"/><path d="M9.5 13.2h1.2c.7 0 1.3.6 1.3 1.3s-.6 1.3-1.3 1.3H9.5Zm0 0v3.8m4-3.8h1.6c.9 0 1.6.9 1.6 2s-.7 2-1.6 2h-1.6Zm5.2 0v3.8m0-2h1.6"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.4 2.5 3.6 5.6 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.6-3.6-9S9.6 5.5 12 3Z"/>',
  media: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m9.5 9 6 3-6 3Z"/>',
};

const UI_ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2m-8 0 1 12h8l1-12M10 11v5m4-5v5"/>',
  grip: '<circle cx="9" cy="6" r="1.1"/><circle cx="15" cy="6" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="18" r="1.1"/><circle cx="15" cy="18" r="1.1"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  pen: '<path d="m4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19Z"/><path d="m14.5 6.5 3 3"/>',
  file: '<path d="M7 3h7l4 4v14H7Z"/><path d="M14 3v4h4"/><path d="M12 11v6m-3-3 3 3 3-3"/>',
};

function uiIcon(name, size = 18) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UI_ICONS[name] || ""}</svg>`;
}

function mediaKindIconSvg(kind) {
  const paths = MEDIA_KIND_ICONS[kind] || MEDIA_KIND_ICONS.media;
  return `<svg class="media-kind-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Un recurso ligado a unha peza pódese editar e borrar desde Media (e desvincúlase de todo): as
// persoas guía/admin ven todos os públicos; a dona, os dos seus propios (só datos e borrado).
function ownPieceResource(item) {
  if (item.piece_id == null || isEditorAccount() || !isAccount()) return false;
  const piece = state.pezas.find(entry => String(entry.id) === String(item.piece_id));
  return Boolean(piece && canManagePiece(piece));
}

function canEditMedia(item) {
  return item.piece_id == null ? true : (!isGoogleMode() || isEditorAccount() || ownPieceResource(item));
}

function mediaEditButtons(item) {
  const own = ownPieceResource(item) ? " data-own-media" : "";
  return `<button class="btn" type="button" data-edit-media="${item.id}"${own}>Editar</button><button class="btn danger" type="button" data-delete-media="${item.id}"${own}>Borrar</button>`;
}

function mediaCard(item, options = {}) {
  const url = mediaUrl(item);
  const kind = mediaKind(item);
  const title = item.title || item.label || item.name || "Recurso sen título";
  const description = item.description || item.notes || item.artist || item.context || "";
  const role = mediaRole(item);
  const territoryLinks = mediaTerritories(item).map(territory => territory.nome);
  const linkedCoplas = mediaCoplas(item);
  const linkedMelodies = mediaMelodies(item);
  const yt = kind === "youtube" ? youtubeId(url) : "";
  const pdfThumb = kind === "pdf" && url && !item.thumbnail_url ? ` data-pdf-thumb="${escapeHtml(url)}"` : "";
  let preview = `<div class="media-preview is-${kind}"${pdfThumb}><span class="media-preview-icon">${mediaKindIconSvg(kind)}</span></div>`;
  if (item.thumbnail_url) preview = `<img class="media-preview is-photo" src="${escapeHtml(item.thumbnail_url)}" alt="">`;
  if (kind === "image" && url) preview = `<img class="media-preview is-photo" src="${escapeHtml(url)}" alt="">`;
  if (kind === "youtube" && yt) preview = `<img class="media-preview is-photo" src="https://img.youtube.com/vi/${escapeHtml(yt)}/hqdefault.jpg" alt="">`;
  if (kind === "audio" && url) preview = `<div class="media-preview is-audio"><span class="media-preview-icon">${mediaKindIconSvg("audio")}</span><audio controls src="${escapeHtml(url)}"></audio></div>`;
  if (kind === "video" && url) preview = `<video class="media-preview is-video" controls src="${escapeHtml(url)}"></video>`;
  return `
    <article class="media-card" tabindex="${url ? "0" : "-1"}" role="${url ? "link" : "article"}" data-open-media="${escapeHtml(url)}"${item.id != null ? ` data-media-id="${escapeHtml(item.id)}"` : ""} aria-label="${escapeHtml(title)}">
      <div class="media-preview-wrap">
        ${preview}
        <span class="media-kind-badge">${mediaKindIconSvg(kind)}${escapeHtml(mediaLabel(kind))}</span>
      </div>
      <div class="media-body">
        <h2>${escapeHtml(title)}</h2>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
        <div class="meta">
          <span class="tag">${escapeHtml(mediaRoleLabel(role))}</span>
          ${item.visibility === "private" ? `<span class="tag is-private" title="Só a ves ti: vai ligada a unha peza privada">Privada</span>` : ""}
          ${mediaPieceTag(item)}
          ${territoryLinks.length ? `<span class="tag place">${escapeHtml(territoryLinks.slice(0, 2).join(" \\ "))}</span>` : ""}
          ${linkedCoplas.length ? `<span class="tag">${linkedCoplas.length} copla${linkedCoplas.length === 1 ? "" : "s"}</span>` : ""}
          ${linkedMelodies.slice(0, 2).map(melody => `<span class="tag is-melody" title="${escapeHtml(melodyName(melody))}">${escapeHtml(melodyShortName(melody))}</span>`).join("")}
          ${linkedMelodies.length > 2 ? `<span class="tag is-melody">+${linkedMelodies.length - 2} melodías</span>` : ""}
        </div>
        ${url ? "" : `<p class="muted">Sen ligazón pública.</p>`}
        ${options.editable && canEditMedia(item) ? `<div class="media-card-actions">${mediaEditButtons(item)}</div>` : ""}
        ${options.removeFromPiece ? `<div class="media-card-actions is-visible"><button class="btn" type="button" data-remove-piece-resource="${escapeHtml(item.id)}">Quitar da peza</button></div>` : ""}
      </div>
    </article>
  `;
}

function mediaPieceTitle(item) {
  if (item.piece_id == null) return "";
  const piece = state.pezas.find(entry => String(entry.id) === String(item.piece_id));
  return piece ? (piece.title || piece.titulo || "") : "";
}

function mediaPieceTag(item) {
  const title = mediaPieceTitle(item);
  return title ? `<span class="tag place" title="Recurso ligado a unha peza">Peza: ${escapeHtml(title.length > 28 ? `${title.slice(0, 27)}…` : title)}</span>` : "";
}

function levelPlacesHtml(territories, emptyLabel = "Sen territorio") {
  if (!territories.length) return `<span class="level-text level-empty">${escapeHtml(emptyLabel)}</span>`;
  return territories.map(territory => `<span class="level-text level-${territory.tipo}">${escapeHtml(territory.nome)}</span>`).join("");
}

// Vista compacta: unha liña por recurso, coas columnas aliñadas.
function mediaRow(item, options = {}) {
  const url = mediaUrl(item);
  const kind = mediaKind(item);
  const title = item.title || item.label || item.name || "Recurso sen título";
  const role = mediaRole(item);
  const territories = mediaTerritories(item);
  const linkedCoplas = mediaCoplas(item);
  const linkedMelodies = mediaMelodies(item);
  const extras = [
    linkedCoplas.length ? `${linkedCoplas.length} copla${linkedCoplas.length === 1 ? "" : "s"}` : "",
    ...linkedMelodies.slice(0, 2).map(melodyShortName),
    linkedMelodies.length > 2 ? `+${linkedMelodies.length - 2} melodías` : "",
  ].filter(Boolean);
  return `
    <article class="media-row" tabindex="${url ? "0" : "-1"}" role="${url ? "link" : "article"}" data-open-media="${escapeHtml(url)}"${item.id != null ? ` data-media-id="${escapeHtml(item.id)}"` : ""} aria-label="${escapeHtml(title)}">
      <span class="row-kind">${mediaKindIconSvg(kind)}<span>${escapeHtml(mediaLabel(kind))}</span></span>
      <span class="row-title"><strong>${escapeHtml(title)}${item.visibility === "private" ? ` <span class="tag is-private">Privada</span>` : ""}</strong>${extras.length ? `<small>${escapeHtml(extras.join(" \\ "))}</small>` : ""}${mediaPieceTitle(item) ? `<small>Peza: ${escapeHtml(mediaPieceTitle(item))}</small>` : ""}${url ? "" : `<small>Sen ligazón pública</small>`}</span>
      <span class="row-place" title="${escapeHtml(territories.map(territory => territory.nome).join(", "))}">${levelPlacesHtml(territories.slice(0, 2))}</span>
      <span class="row-role">${escapeHtml(mediaRoleLabel(role))}</span>
      ${options.editable && canEditMedia(item) ? `<span class="row-actions">${mediaEditButtons(item)}</span>` : ""}
    </article>
  `;
}

function mediaTerritories(item) {
  return (item.links || [])
    .filter(link => link.entity_type === "territory")
    .map(link => state.territorios.find(territory => territory.id === link.entity_id))
    .filter(Boolean);
}

function mediaCoplas(item) {
  return (item.links || [])
    .filter(link => link.entity_type === "copla")
    .map(link => state.coplas.find(copla => String(copla.id) === String(link.entity_id)))
    .filter(Boolean);
}

function coplaMedia(copla) {
  return state.media.filter(item => (item.links || []).some(link => link.entity_type === "copla" && String(link.entity_id) === String(copla.id)));
}

function bindMediaCards(root = document) {
  all("[data-open-media]", root).forEach(card => {
    if (card.dataset.boundMediaCard) return;
    card.dataset.boundMediaCard = "true";
    const open = event => {
      if (event?.target?.closest?.("audio, video, button, input, select, textarea")) return;
      const url = card.dataset.openMedia;
      if (url) window.open(url, "_blank", "noopener");
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open(event);
      }
    });
  });
}

// ---------------------------------------------------------------------
// Melodías (inventario)
//
// Unha melodía é un ritmo + un número dentro dese ritmo e dese lugar,
// rexistrada no territorio máis baixo no que se documenta. Non hai
// xerarquía propia: o nome ("Xota número 1 de Moscoso") constrúese con eses
// tres datos, e iso é o que as fai distinguibles ao subir a un
// supraterritorio. Cada melodía pode aparecer en varios recursos e cada
// recurso pode conter varias melodías (ligazóns `melody` en media_links).
// ---------------------------------------------------------------------

function melodyTerritory(melody) {
  return state.territorios.find(item => item.id === melody.territory_id) || null;
}

function melodyName(melody) {
  if (melody.name) return melody.name;
  const territory = melodyTerritory(melody);
  return `${melody.rhythm} número ${melody.number}${territory ? ` de ${territory.nome}` : ""}`;
}

function melodyShortName(melody) {
  return `${melody.rhythm} #${melody.number}`;
}

function melodyMedia(melody) {
  return state.media.filter(item => (item.links || []).some(link => link.entity_type === "melody" && String(link.entity_id) === String(melody.id)));
}

function mediaMelodies(item) {
  return (item.links || [])
    .filter(link => link.entity_type === "melody")
    .map(link => state.melodias.find(melody => String(melody.id) === String(link.entity_id)))
    .filter(Boolean);
}

function compareMelodies(a, b) {
  const territoryA = melodyTerritory(a)?.nome || "";
  const territoryB = melodyTerritory(b)?.nome || "";
  return a.rhythm.localeCompare(b.rhythm, "gl", { sensitivity: "base" })
    || territoryA.localeCompare(territoryB, "gl", { sensitivity: "base" })
    || a.number - b.number;
}

function rhythmSuggestions() {
  const known = new Map(RHYTHMS.map(rhythm => [normalizeText(rhythm), rhythm]));
  state.melodias.forEach(melody => {
    const key = normalizeText(melody.rhythm);
    if (!known.has(key)) known.set(key, melody.rhythm);
  });
  return [...known.values()].sort((a, b) => a.localeCompare(b, "gl"));
}

function rhythmDatalist(id) {
  return `<datalist id="${id}">${rhythmSuggestions().map(rhythm => `<option value="${escapeHtml(rhythm)}"></option>`).join("")}</datalist>`;
}

// Grafía do ritmo que quedará gardada (a mesma que xa se usa no inventario).
function canonicalRhythm(rhythm) {
  const clean = String(rhythm || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  const key = normalizeText(clean);
  const existing = state.melodias.find(melody => normalizeText(melody.rhythm) === key);
  return existing ? existing.rhythm : clean.charAt(0).toUpperCase() + clean.slice(1);
}

function nextMelodyNumberFor(territoryId, rhythm, ignoreId = null) {
  const key = normalizeText(rhythm);
  const group = state.melodias.filter(melody => melody.territory_id === territoryId && normalizeText(melody.rhythm) === key);
  const current = ignoreId ? group.find(melody => Number(melody.id) === Number(ignoreId)) : null;
  if (current) return current.number;
  return group.reduce((max, melody) => Math.max(max, melody.number), 0) + 1;
}

function melodyCard(melody, options = {}) {
  const own = options.territoryId && melody.territory_id === options.territoryId;
  const territory = melodyTerritory(melody);
  const resources = melodyMedia(melody).length;
  const notes = (melody.notes || "").trim();
  return `
    <article class="melody-card" tabindex="0" role="button" data-open-melody="${melody.id}" aria-label="${escapeHtml(melodyName(melody))}">
      <h3>${escapeHtml(own ? melodyShortName(melody) : melodyName(melody))}</h3>
      ${!own && territory ? `<p class="melody-card-place">${escapeHtml(territorySearchMeta(territory))}</p>` : ""}
      ${notes ? `<p class="melody-card-notes">${escapeHtml(notes.length > 110 ? `${notes.slice(0, 107)}…` : notes)}</p>` : ""}
      <div class="meta"><span class="tag">${resources ? `${resources} recurso${resources === 1 ? "" : "s"}` : "Sen recursos"}</span></div>
    </article>
  `;
}

// Vista compacta: unha liña por melodía, co lugar na súa propia columna.
function melodyRow(melody) {
  const territory = melodyTerritory(melody);
  const resources = melodyMedia(melody).length;
  const notes = (melody.notes || "").trim();
  return `
    <article class="melody-row" tabindex="0" role="button" data-open-melody="${melody.id}" aria-label="${escapeHtml(melodyName(melody))}">
      <span class="row-title"><strong>${escapeHtml(melodyShortName(melody))}</strong>${notes ? `<small>${escapeHtml(notes.length > 90 ? `${notes.slice(0, 87)}…` : notes)}</small>` : ""}</span>
      <span class="row-place" title="${escapeHtml(territory ? territorySearchMeta(territory) : "")}">${levelPlacesHtml(territory ? [territory] : [], "Sen territorio")}</span>
      <span class="row-role">${resources ? `${resources} recurso${resources === 1 ? "" : "s"}` : "Sen recursos"}</span>
    </article>
  `;
}

// Lista plana (para poder cargar por tramos): a cabeceira de cada ritmo
// ponse ao cambiar de ritmo, tendo en conta a melodía anterior ao tramo.
function melodyItemsMarkup(slice, previous, counts, territoryId, rows = false) {
  let last = previous ? normalizeText(previous.rhythm) : null;
  return slice.map(melody => {
    const key = normalizeText(melody.rhythm);
    const head = key !== last ? `<h3 class="melody-group-title melody-grid-title">${escapeHtml(melody.rhythm)} <span class="muted">${counts.get(key)}</span></h3>` : "";
    last = key;
    return head + (rows ? melodyRow(melody) : melodyCard(melody, { territoryId }));
  }).join("");
}

function mountMelodyList(list, melodias, key, territoryId, rows = false) {
  const melodies = [...melodias].sort(compareMelodies);
  const counts = new Map();
  melodies.forEach(melody => {
    const rhythmKey = normalizeText(melody.rhythm);
    counts.set(rhythmKey, (counts.get(rhythmKey) || 0) + 1);
  });
  mountInfiniteList(list, melodies, {
    key,
    renderItems: (slice, previous) => melodyItemsMarkup(slice, previous, counts, territoryId, rows),
  });
}

function melodiesTabMarkup(territory, ctx) {
  const melodies = ctx.melodias;
  const loose = ctx.media.filter(item => ["melody", "mixed"].includes(mediaRole(item)) && !mediaMelodies(item).length);
  return `
    <div class="section-title">
      <h2>Melodías${territory ? ` de ${escapeHtml(territory.nome)}` : " de Galiza"}</h2>
      <span class="muted">${melodies.length} inventariada${melodies.length === 1 ? "" : "s"}</span>
    </div>
    <div class="melody-actions">
      ${territory ? `<button class="btn primary" type="button" data-new-melody="${territory.id}">+ Nova melodía</button>` : ""}
      <button class="btn" type="button" data-view="media" data-media-role="melody">+ Novo recurso</button>
    </div>
    ${melodies.length
      ? `<div id="territoryMelodyList" class="melody-grid"></div>`
      : `<p class="muted melody-empty">${territory ? "Aínda non hai melodías inventariadas neste territorio. Crea a primeira e despois indica en que recursos aparece." : "Aínda non hai melodías inventariadas."}</p>`}
    ${loose.length ? `
      <section class="melody-group">
        <h3 class="melody-group-title">Recursos sonoros sen melodía asignada <span class="muted">${loose.length}</span></h3>
        <div class="media-grid">${loose.map(item => mediaCard(item)).join("")}</div>
      </section>
    ` : ""}
  `;
}

// --- Rexistro no servidor --------------------------------------------

// Fala á API de melodías e devolve o JSON. Se a rede falla ou o servidor
// responde algo que non é JSON (por exemplo unha páxina de erro), a mensaxe
// di que pasou en vez do críptico "Failed to fetch".
async function melodiesRequest(method, body, fallbackMessage) {
  let response;
  try {
    response = await fetch("../api/melodies", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("Erro de rede en /api/melodies:", error);
    throw new Error("Non se puido contactar co servidor (/api/melodies). Revisa a conexión e que a API estea desprazada; detalle na consola do navegador.");
  }
  let result = null;
  try {
    result = await response.json();
  } catch {
    throw new Error(`${fallbackMessage} O servidor respondeu ${response.status} sen JSON; a API de melodías pode non estar desprazada.`);
  }
  if (!response.ok) throw new Error(result?.error || fallbackMessage);
  return result;
}

async function postMelodies(melodies) {
  const result = await melodiesRequest("POST", { melodies }, "Non se puido gardar a melodía.");
  clearApiCache();
  state.melodias = await getMelodias();
  return result.ids || [];
}

async function removeMelody(melodyId) {
  await melodiesRequest("DELETE", { ids: [melodyId] }, "Non se puido borrar a melodía.");
  clearApiCache();
  [state.melodias, state.media] = await Promise.all([getMelodias(), loadMedia()]);
}

function rerenderMelodyViews() {
  if (state.view === "territory") renderTerritoryView();
  else if (state.view === "media") renderMediaView();
  else if (state.view === "melodies") renderMelodiesView();
}

// --- Vista "Melodías" (todo o inventario, con filtros) -----------------

function melodySearchText(melody) {
  const territory = melodyTerritory(melody);
  const hierarchy = territory
    ? buildHierarchy(territory, state.territorios).map(item => `${item.nome} ${territorySearchMeta(item)}`).join(" ")
    : "";
  return normalizeText([
    melodyName(melody),
    melodyShortName(melody),
    melody.notes,
    hierarchy,
    melodyMedia(melody).map(item => `${item.title || ""} ${item.author_or_source || ""}`).join(" "),
  ].join(" "));
}

function filteredMelodies() {
  const query = normalizeText(state.melodyQuery);
  const rhythmKey = normalizeText(state.melodyRhythmFilter);
  return state.melodias.filter(melody => {
    if (rhythmKey && normalizeText(melody.rhythm) !== rhythmKey) return false;
    return !query || melodySearchText(melody).includes(query);
  });
}

function updateMelodiesResults(view = $("#view-melodies")) {
  const melodies = filteredMelodies();
  const filtering = state.melodyQuery.trim() || state.melodyRhythmFilter;
  const count = filtering
    ? `${melodies.length} de ${state.melodias.length} melodías`
    : `${melodies.length} melodía${melodies.length === 1 ? "" : "s"} inventariada${melodies.length === 1 ? "" : "s"}`;
  $("#melodiesCount", view).textContent = count;
  const empty = $("#melodiesEmpty", view);
  empty.hidden = melodies.length > 0;
  empty.textContent = state.melodias.length
    ? "Ningunha melodía coincide cos filtros."
    : "Aínda non hai melodías inventariadas. Crea a primeira co botón de arriba e despois indica en que recursos aparece.";
  const rows = state.melodyViewMode === "rows";
  const list = $("#melodiesList", view);
  list.className = rows ? "melody-rows" : "melody-grid";
  mountMelodyList(list, melodies, `${state.melodyQuery}|${state.melodyRhythmFilter}|${state.melodyViewMode}`, null, rows);
}

function renderMelodiesView() {
  const view = $("#view-melodies");
  if (!view) return;
  const rhythms = [...new Map(state.melodias.map(melody => [normalizeText(melody.rhythm), melody.rhythm])).values()]
    .sort((a, b) => a.localeCompare(b, "gl"));
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Melodías</h1>
          <p class="muted">Inventario de melodías, cada unha co seu ritmo, número e territorio.</p>
        </div>
        <button class="btn primary" type="button" data-new-melody="">+ Nova melodía</button>
      </div>
      <div class="toolbar melody-toolbar">
        <div class="searchbox"><span>⌕</span><input id="melodiesSearch" type="search" value="${escapeHtml(state.melodyQuery)}" placeholder="Buscar por ritmo, territorio, notas ou recurso..."></div>
        <select id="melodiesRhythmFilter" aria-label="Filtrar por ritmo">
          <option value="">Todos os ritmos</option>
          ${rhythms.map(rhythm => `<option value="${escapeHtml(rhythm)}" ${normalizeText(state.melodyRhythmFilter) === normalizeText(rhythm) ? "selected" : ""}>${escapeHtml(rhythm)}</option>`).join("")}
        </select>
        ${listViewToggleMarkup("data-melody-view", state.melodyViewMode)}
      </div>
      <p class="muted melody-count" id="melodiesCount"></p>
      <div id="melodiesList" class="melody-grid"></div>
      <p class="muted melody-empty" id="melodiesEmpty" hidden></p>
    </div>
  `;
  const update = () => updateMelodiesResults(view);
  $("#melodiesSearch", view).addEventListener("input", event => {
    state.melodyQuery = event.target.value;
    update();
  });
  all("[data-melody-view]", view).forEach(button => button.addEventListener("click", () => {
    state.melodyViewMode = button.dataset.melodyView;
    saveViewPref("melodies", state.melodyViewMode);
    all("[data-melody-view]", view).forEach(item => item.classList.toggle("active", item === button));
    update();
  }));
  $("#melodiesRhythmFilter", view).addEventListener("change", event => {
    state.melodyRhythmFilter = event.target.value;
    update();
  });
  update();
}

// --- Ficha da melodía -------------------------------------------------

function openMelodyDrawer(melodyId) {
  const melody = state.melodias.find(item => Number(item.id) === Number(melodyId));
  const drawer = $("#melodyDrawer");
  if (!melody || !drawer) return;
  const territory = melodyTerritory(melody);
  const resources = melodyMedia(melody);
  const notes = (melody.notes || "").trim();
  drawer.hidden = false;
  drawer.dataset.melodyId = String(melody.id);
  drawer.innerHTML = `
    <div class="drawer-scrim" data-close-melody-drawer></div>
    <aside class="drawer-panel melody-drawer" role="dialog" aria-modal="true" aria-label="Ficha da melodía">
      <button class="card-close" type="button" data-close-melody-drawer aria-label="Pechar">×</button>
      <div class="eyebrow">Ficha de melodía</div>
      <h2>${escapeHtml(melodyName(melody))}</h2>
      <div class="meta"><span class="tag">${escapeHtml(melody.rhythm)}</span><span class="tag">Número ${melody.number}</span></div>
      <div class="drawer-section">
        <h3>Territorio</h3>
        <div class="territory-links">
          ${territory ? `<button type="button" data-territory-id="${territory.id}"><strong>${escapeHtml(territory.nome)}</strong><span>${escapeHtml(territorySearchMeta(territory))}</span></button>` : `<p class="muted">Territorio non atopado.</p>`}
        </div>
      </div>
      <div class="drawer-section">
        <h3>Notas</h3>
        <p class="muted">${notes ? nl2br(notes) : "Sen notas rexistradas."}</p>
      </div>
      <div class="drawer-section">
        <h3>Recursos onde aparece</h3>
        <div class="melody-resources">
          ${resources.map(item => `
            <div class="melody-resource">
              ${mediaCard(item)}
              <button class="link-button" type="button" data-unlink-melody-media="${item.id}">Desvincular</button>
            </div>
          `).join("") || `<p class="muted">Aínda non aparece en ningún recurso.</p>`}
        </div>
        <div class="melody-link-existing">
          <input id="melodyLinkQuery" type="search" placeholder="Vincular un recurso xa gardado (título, fonte...)">
          <div id="melodyLinkResults" class="territory-results compact"></div>
          <p id="melodyDrawerFeedback" class="muted"></p>
        </div>
      </div>
      <div class="drawer-actions">
        <button class="btn" type="button" data-edit-melody="${melody.id}">Editar</button>
        <button class="btn danger" type="button" data-delete-melody="${melody.id}">Borrar</button>
        <button class="btn primary" type="button" data-new-melody-media="${melody.id}">+ Novo recurso con esta melodía</button>
      </div>
    </aside>
  `;
  bindMediaCards(drawer);
  bindResultButtons(drawer);
  $("#melodyLinkQuery", drawer)?.addEventListener("input", event => renderMelodyLinkResults(melody, event.target.value));
}

function closeMelodyDrawer() {
  const drawer = $("#melodyDrawer");
  if (!drawer) return;
  drawer.hidden = true;
  drawer.innerHTML = "";
  delete drawer.dataset.melodyId;
}

function renderMelodyLinkResults(melody, rawQuery) {
  const results = $("#melodyLinkResults");
  if (!results) return;
  const query = normalizeText(rawQuery || "");
  if (!query) {
    results.innerHTML = "";
    return;
  }
  const linked = new Set(melodyMedia(melody).map(item => Number(item.id)));
  const matches = state.media
    .filter(item => !linked.has(Number(item.id)))
    .filter(item => normalizeText([item.title, item.author_or_source, item.description, item.url].join(" ")).includes(query))
    .slice(0, 8);
  results.innerHTML = matches.map(item => `
    <button type="button" data-link-melody-media="${item.id}">
      <strong>${escapeHtml(item.title || "Recurso sen título")}</strong>
      <span>${escapeHtml([mediaLabel(mediaKind(item)), item.author_or_source].filter(Boolean).join(" \\ "))}</span>
    </button>
  `).join("") || `<p class="muted">Sen resultados.</p>`;
}

async function linkMediaToMelody(mediaId, melodyId) {
  const media = state.media.find(item => Number(item.id) === Number(mediaId));
  if (!media) return;
  if ((media.links || []).some(link => link.entity_type === "melody" && String(link.entity_id) === String(melodyId))) return;
  const relation = media.links?.[0]?.relation_type || "melody";
  const links = [...(media.links || []), { entity_type: "melody", entity_id: melodyId, relation_type: relation }];
  await postMediaUpdate(mediaFullPayload(media, links));
}

async function unlinkMediaFromMelody(mediaId, melody) {
  const media = state.media.find(item => Number(item.id) === Number(mediaId));
  if (!media) return;
  let links = (media.links || []).filter(link => !(link.entity_type === "melody" && String(link.entity_id) === String(melody.id)));
  // Un recurso non pode quedar sen ningunha ligazón: se esta era a única,
  // ligámolo ao lugar da melodía para que non desapareza do arquivo.
  if (!links.length) links = [{ entity_type: "territory", entity_id: melody.territory_id, relation_type: media.links?.[0]?.relation_type || "direct" }];
  await postMediaUpdate(mediaFullPayload(media, links));
}

function startMediaForMelody(melodyId) {
  const melody = state.melodias.find(item => Number(item.id) === Number(melodyId));
  if (!melody) return;
  closeMelodyDrawer();
  setView("media");
  openMediaModal("melody", { territoryIds: [melody.territory_id], melodyIds: [melody.id] });
}

// --- Alta e edición de melodías --------------------------------------

function openMelodyModal({ id = null, territoryId = "" } = {}) {
  const existing = id ? state.melodias.find(item => Number(item.id) === Number(id)) : null;
  state.melodyModal = {
    id: existing ? existing.id : null,
    territoryId: existing ? existing.territory_id : territoryId,
    rhythm: existing ? existing.rhythm : "",
    notes: existing ? existing.notes || "" : "",
    picking: !existing && !territoryId,
  };
  renderMelodyModal();
  window.setTimeout(() => $("#melodyRhythm")?.focus(), 30);
}

function closeMelodyModal() {
  state.melodyModal = null;
  renderMelodyModal();
}

function melodyNamePreview() {
  const modal = state.melodyModal;
  const territory = state.territorios.find(item => item.id === modal?.territoryId);
  const rhythm = canonicalRhythm(modal?.rhythm || "");
  if (!territory || !rhythm) return "Escolle o ritmo para ver como se vai chamar.";
  return `Chamarase: ${rhythm} número ${nextMelodyNumberFor(territory.id, rhythm, modal.id)} de ${territory.nome}`;
}

function renderMelodyModal() {
  const host = $("#melodyModal");
  if (!host) return;
  const modal = state.melodyModal;
  if (!modal) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const territory = state.territorios.find(item => item.id === modal.territoryId);
  host.hidden = false;
  host.innerHTML = `
    <div class="media-modal melody-modal" role="dialog" aria-modal="true" aria-label="${modal.id ? "Editar melodía" : "Nova melodía"}">
      <div class="media-modal-backdrop" data-close-melody-modal></div>
      <div class="media-modal-panel">
        <div class="media-modal-head">
          <div>
            <div class="eyebrow">${modal.id ? "Edición de melodía" : "Alta de melodía"}</div>
            <h2>${modal.id ? "Editar melodía" : "Nova melodía"}</h2>
          </div>
          <button class="card-close" type="button" data-close-melody-modal aria-label="Pechar">×</button>
        </div>
        <div class="melody-modal-body">
          <div class="formgrid">
            <div class="field">
              <label for="melodyRhythm">Ritmo</label>
              <input id="melodyRhythm" type="text" list="melodyRhythmList" autocomplete="off" value="${escapeHtml(modal.rhythm)}" placeholder="Xota, muiñeira, pandeirada...">
              ${rhythmDatalist("melodyRhythmList")}
            </div>
            <div class="field">
              <label>Territorio</label>
              <div class="melody-place">
                ${territory ? `<span class="selected-chip">${escapeHtml(territory.nome)} <small class="level-badge level-${territory.tipo}">${escapeHtml(territoryLabel(territory))}</small></span>` : `<span class="muted">Sen territorio.</span>`}
                <button class="link-button" type="button" id="melodyChangeTerritory">${territory ? "Cambiar" : "Escoller"}</button>
              </div>
              <input id="melodyTerritoryQuery" type="search" placeholder="Buscar parroquia, concello, comarca..." ${modal.picking ? "" : "hidden"}>
              <div id="melodyTerritoryResults" class="territory-results compact"></div>
            </div>
            <div class="field full"><p class="melody-name-preview" id="melodyNamePreview">${escapeHtml(melodyNamePreview())}</p></div>
            <div class="field full">
              <label for="melodyNotes">Notas (opcional)</label>
              <textarea id="melodyNotes" rows="3" placeholder="Como se toca, quen a canta, como se recoñece...">${escapeHtml(modal.notes)}</textarea>
            </div>
          </div>
          <div class="gallery-actions">
            <button class="btn primary" type="button" id="saveMelody">${modal.id ? "Gardar cambios" : "Crear melodía"}</button>
            <p id="melodyFeedback" class="muted"></p>
          </div>
        </div>
      </div>
    </div>
  `;
  const updatePreview = () => {
    const preview = $("#melodyNamePreview");
    if (preview) preview.textContent = melodyNamePreview();
  };
  $("#melodyRhythm", host)?.addEventListener("input", event => {
    modal.rhythm = event.target.value;
    updatePreview();
  });
  $("#melodyNotes", host)?.addEventListener("input", event => {
    modal.notes = event.target.value;
  });
  $("#melodyChangeTerritory", host)?.addEventListener("click", () => {
    modal.picking = true;
    const input = $("#melodyTerritoryQuery", host);
    if (input) {
      input.hidden = false;
      input.focus();
    }
  });
  $("#melodyTerritoryQuery", host)?.addEventListener("input", event => {
    const query = event.target.value.trim();
    const results = $("#melodyTerritoryResults", host);
    if (!query) {
      results.innerHTML = "";
      return;
    }
    const matches = searchTerritories(state.territorios, query).slice(0, 10);
    results.innerHTML = matches.map(item => `
      <button type="button" data-pick-melody-territory="${item.id}">
        <strong>${escapeHtml(item.nome)}</strong>
        <span>${escapeHtml(territorySearchMeta(item))}</span>
      </button>
    `).join("") || `<p class="muted">Sen resultados.</p>`;
  });
  $("#melodyTerritoryResults", host)?.addEventListener("click", event => {
    const button = event.target.closest("[data-pick-melody-territory]");
    if (!button) return;
    modal.territoryId = button.dataset.pickMelodyTerritory;
    modal.picking = false;
    renderMelodyModal();
  });
  $("#saveMelody", host)?.addEventListener("click", saveMelodyForm);
}

async function saveMelodyForm() {
  const modal = state.melodyModal;
  if (!modal) return;
  const feedback = $("#melodyFeedback");
  const rhythm = (modal.rhythm || "").trim();
  if (!rhythm) {
    feedback.textContent = "Indica o ritmo (xota, muiñeira...).";
    return;
  }
  if (!modal.territoryId) {
    feedback.textContent = "Escolle o territorio da melodía.";
    return;
  }
  setLoading(feedback, "Gardando");
  const entry = { territory_id: modal.territoryId, rhythm, notes: (modal.notes || "").trim() || null };
  if (modal.id) entry.id = modal.id;
  try {
    const [id] = await postMelodies([entry]);
    state.melodyModal = null;
    renderMelodyModal();
    rerenderMelodyViews();
    openMelodyDrawer(id);
  } catch (error) {
    feedback.textContent = error.message;
  }
}

// --- Selector de melodías no formulario de recursos -------------------

function mediaMelodyScope() {
  const scope = new Set();
  state.mediaTerritoryIds.forEach(id => {
    const territory = state.territorios.find(item => item.id === id);
    if (territory) getDescendantIds(territory, state.territorios).forEach(descendant => scope.add(descendant));
  });
  return scope;
}

function mediaMelodyCandidates() {
  const scope = mediaMelodyScope();
  const selected = new Set(state.mediaMelodyIds.map(Number));
  return state.melodias.filter(melody => scope.has(melody.territory_id) || selected.has(Number(melody.id))).sort(compareMelodies);
}

function mediaMelodyOptionsMarkup() {
  if (!state.mediaTerritoryIds.length && !state.mediaMelodyIds.length) {
    return `<p class="muted">Escolle un territorio para ver as melodías que ten inventariadas.</p>`;
  }
  const candidates = mediaMelodyCandidates();
  if (!candidates.length) {
    return `<p class="muted">Os territorios escollidos aínda non teñen melodías inventariadas. Podes crear a primeira aquí embaixo.</p>`;
  }
  const byTerritory = new Map();
  candidates.forEach(melody => {
    if (!byTerritory.has(melody.territory_id)) byTerritory.set(melody.territory_id, []);
    byTerritory.get(melody.territory_id).push(melody);
  });
  const selected = new Set(state.mediaMelodyIds.map(Number));
  return `
    ${[...byTerritory.entries()].map(([territoryId, melodies]) => {
      const territory = state.territorios.find(item => item.id === territoryId);
      return `
        <div class="melody-picker-group">
          ${byTerritory.size > 1 ? `<div class="melody-picker-place">${escapeHtml(territory?.nome || territoryId)}</div>` : ""}
          <div class="melody-picker-chips">
            ${melodies.map(melody => `
              <label class="melody-chip ${selected.has(Number(melody.id)) ? "is-on" : ""}" title="${escapeHtml(melodyName(melody))}">
                <input type="checkbox" data-media-melody="${melody.id}" ${selected.has(Number(melody.id)) ? "checked" : ""}>
                <span>${escapeHtml(melodyShortName(melody))}</span>
              </label>
            `).join("")}
          </div>
        </div>
      `;
    }).join("")}
    <div class="melody-picker-actions">
      <button class="link-button" type="button" data-media-melody-all>Marcar todas</button>
      <button class="link-button" type="button" data-media-melody-none>Desmarcar todas</button>
    </div>
  `;
}

function mediaMelodyFieldMarkup() {
  const territories = state.mediaTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  return `
    <div class="field full melody-field">
      <label>Melodías que aparecen neste recurso (opcional)</label>
      <div id="mediaMelodyOptions" class="melody-picker">${mediaMelodyOptionsMarkup()}</div>
      <details class="melody-new">
        <summary>+ Nova melodía</summary>
        <div class="melody-new-row">
          <input id="mediaNewMelodyRhythm" type="text" list="mediaNewMelodyRhythmList" autocomplete="off" placeholder="Ritmo (xota, muiñeira...)">
          ${rhythmDatalist("mediaNewMelodyRhythmList")}
          <select id="mediaNewMelodyTerritory" aria-label="Territorio da nova melodía">${territories.map(territory => `<option value="${territory.id}">${escapeHtml(territory.nome)}</option>`).join("")}</select>
          <button class="btn" type="button" id="mediaNewMelodyCreate">Crear e marcar</button>
        </div>
        <p id="mediaNewMelodyFeedback" class="muted"></p>
      </details>
    </div>
  `;
}

function refreshMediaMelodyOptions() {
  const box = $("#mediaMelodyOptions");
  if (!box) return;
  box.innerHTML = mediaMelodyOptionsMarkup();
  const select = $("#mediaNewMelodyTerritory");
  if (select) {
    const previous = select.value;
    select.innerHTML = state.mediaTerritoryIds
      .map(id => state.territorios.find(item => item.id === id))
      .filter(Boolean)
      .map(territory => `<option value="${territory.id}">${escapeHtml(territory.nome)}</option>`)
      .join("");
    if (previous && state.mediaTerritoryIds.includes(previous)) select.value = previous;
  }
}

function bindMediaMelodyPicker() {
  const box = $("#mediaMelodyOptions");
  if (!box) return;
  box.addEventListener("change", event => {
    const input = event.target.closest("[data-media-melody]");
    if (!input) return;
    const id = Number(input.dataset.mediaMelody);
    state.mediaMelodyIds = state.mediaMelodyIds.filter(existing => Number(existing) !== id);
    if (input.checked) state.mediaMelodyIds.push(id);
    input.closest(".melody-chip")?.classList.toggle("is-on", input.checked);
  });
  box.addEventListener("click", event => {
    if (event.target.closest("[data-media-melody-all]")) {
      mediaMelodyCandidates().forEach(melody => {
        if (!state.mediaMelodyIds.some(existing => Number(existing) === Number(melody.id))) state.mediaMelodyIds.push(melody.id);
      });
      refreshMediaMelodyOptions();
    } else if (event.target.closest("[data-media-melody-none]")) {
      const visible = new Set(mediaMelodyCandidates().map(melody => Number(melody.id)));
      state.mediaMelodyIds = state.mediaMelodyIds.filter(id => !visible.has(Number(id)));
      refreshMediaMelodyOptions();
    }
  });
  $("#mediaNewMelodyCreate")?.addEventListener("click", async () => {
    const feedback = $("#mediaNewMelodyFeedback");
    const rhythm = $("#mediaNewMelodyRhythm").value.trim();
    const territoryId = $("#mediaNewMelodyTerritory")?.value;
    if (!territoryId) {
      feedback.textContent = "Escolle antes un territorio para este recurso.";
      return;
    }
    if (!rhythm) {
      feedback.textContent = "Indica o ritmo da melodía.";
      return;
    }
    setLoading(feedback, "Creando");
    try {
      const [id] = await postMelodies([{ territory_id: territoryId, rhythm }]);
      state.mediaMelodyIds.push(id);
      $("#mediaNewMelodyRhythm").value = "";
      const created = state.melodias.find(melody => Number(melody.id) === Number(id));
      feedback.textContent = created ? `Creada: ${melodyName(created)}.` : "Creada.";
      refreshMediaMelodyOptions();
    } catch (error) {
      feedback.textContent = error.message;
    }
  });
}

// --- Eventos delegados (fichas, botóns e tarxetas) --------------------

function bindMelodyEvents() {
  document.addEventListener("click", async event => {
    const target = event.target;
    const card = target.closest("[data-open-melody]");
    if (card) {
      openMelodyDrawer(card.dataset.openMelody);
      return;
    }
    if (target.closest("[data-close-melody-drawer]")) {
      closeMelodyDrawer();
      return;
    }
    if (target.closest("[data-close-melody-modal]")) {
      closeMelodyModal();
      return;
    }
    const create = target.closest("[data-new-melody]");
    if (create) {
      openMelodyModal({ territoryId: create.dataset.newMelody });
      return;
    }
    const edit = target.closest("[data-edit-melody]");
    if (edit) {
      const id = Number(edit.dataset.editMelody);
      closeMelodyDrawer();
      openMelodyModal({ id });
      return;
    }
    const remove = target.closest("[data-delete-melody]");
    if (remove) {
      if (remove.dataset.confirming !== "true") {
        remove.dataset.confirming = "true";
        remove.textContent = "Confirmar borrado";
        window.setTimeout(() => {
          if (remove.isConnected) {
            delete remove.dataset.confirming;
            remove.textContent = "Borrar";
          }
        }, 4000);
        return;
      }
      remove.disabled = true;
      try {
        await removeMelody(Number(remove.dataset.deleteMelody));
        closeMelodyDrawer();
        rerenderMelodyViews();
      } catch (error) {
        remove.disabled = false;
        const feedback = $("#melodyDrawerFeedback");
        if (feedback) feedback.textContent = error.message;
      }
      return;
    }
    const withMedia = target.closest("[data-new-melody-media]");
    if (withMedia) {
      startMediaForMelody(Number(withMedia.dataset.newMelodyMedia));
      return;
    }
    const link = target.closest("[data-link-melody-media]");
    const unlink = target.closest("[data-unlink-melody-media]");
    if (link || unlink) {
      const drawer = $("#melodyDrawer");
      const melodyId = Number(drawer?.dataset.melodyId);
      const melody = state.melodias.find(item => Number(item.id) === melodyId);
      if (!melody) return;
      const feedback = $("#melodyDrawerFeedback");
      try {
        if (link) await linkMediaToMelody(Number(link.dataset.linkMelodyMedia), melodyId);
        else await unlinkMediaFromMelody(Number(unlink.dataset.unlinkMelodyMedia), melody);
        openMelodyDrawer(melodyId);
        rerenderMelodyViews();
      } catch (error) {
        if (feedback) feedback.textContent = error.message;
      }
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest?.("[data-open-melody]");
    if (!card || event.target !== card) return;
    event.preventDefault();
    openMelodyDrawer(card.dataset.openMelody);
  });
}

function closeMobileExplore() {
  const menu = $("#mobileExploreMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("#mobileExploreBtn")?.setAttribute("aria-expanded", "false");
}

function bindMobileExplore() {
  MOBILE_QUERY.addEventListener?.("change", () => renderView());
  const button = $("#mobileExploreBtn");
  const menu = $("#mobileExploreMenu");
  if (!button || !menu) return;
  button.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", event => {
    if (!event.target.closest(".mobile-nav-group")) closeMobileExplore();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeMobileExplore();
  });
}

// Historial: cada cambio de vista engade unha entrada (botón Atrás do navegador).
// As entradas propias levan `history.state.fv`; unha entrada sen marcar (p. ex. a
// que crea unha ligazón #/...) márcase en vez de duplicarse.

function routeUrl(keepHash) {
  return `${window.location.pathname}${window.location.search}${keepHash ? window.location.hash : ""}`;
}

function setView(viewName, { push = true } = {}) {
  const previousView = state.view;
  state.view = normalizeView(viewName);
  const hash = window.location.hash;
  const leavesAuthor = state.dataReady && state.view !== "pieces" && hash.startsWith("#/autoria/");
  const leavesPerson = state.view !== "people" && hash.startsWith("#/persoa/");
  const leavesPrivacy = state.view !== "about" && state.aboutPrivacy;
  if (leavesPrivacy) state.aboutPrivacy = false;
  const clearHash = leavesAuthor || leavesPerson || (leavesPrivacy && hash === "#/privacidade");
  if (state.historyReady) {
    const changed = state.view !== previousView;
    if (push && changed && history.state?.fv) history.pushState({ fv: state.view }, "", routeUrl(!clearHash));
    else if (push && changed) history.replaceState({ fv: state.view }, "", routeUrl(!clearHash));
    else if (clearHash) history.replaceState({ fv: state.view }, "", routeUrl(false));
  }
  all(".view").forEach(view => view.classList.toggle("active", view.id === `view-${state.view}`));
  all("[data-view]").forEach(button => button.classList.toggle("active", normalizeView(button.dataset.view) === state.view));
  $("#mobileExploreBtn")?.classList.toggle("active", ["pieces", "melodies", "media"].includes(state.view));
  closeMobileExplore();
  if (state.view !== previousView) resetInfiniteLists();
  renderView();
  if (state.view === "map" && state.map) window.setTimeout(() => state.map.invalidateSize(), 120);
}

function clearTerritory() {
  state.selectedTerritory = null;
  state.selectedCoplaId = null;
  state.territoryTab = "coplas";
  state.territoryCoplaQuery = "";
  $("#mapSearch").value = "";
  $("#mapResults").innerHTML = "";
  updateMapCard();
  state.layer?.eachLayer(layer => {
    const found = findTerritoryByFeature(layer.feature, state.layerType, state.territorios);
    layer.setStyle(styleFeature(false, Boolean(layer.feature?.properties?.part), territoryHasCoplas(found)));
  });
  if (state.layer) {
    try {
      state.map.fitBounds(state.layer.getBounds(), { padding: [24, 24] });
    } catch {}
  }
  if (state.view === "territory") renderTerritoryView();
  if (state.view === "coplas") renderCoplasView();
}

const MAP_INK = "#171717";
const MAP_PAPER = "#F7F7F2";
const MAP_ACCENT = "#C24330";

function styleFeature(selected = false, fragment = false, hasCoplas = false) {
  const base = selected
    ? { weight: 1.5, color: MAP_PAPER, fillColor: MAP_ACCENT, fillOpacity: 0.92 }
    : hasCoplas
      ? { weight: 1, color: MAP_PAPER, fillColor: MAP_INK, fillOpacity: 0.86 }
      : { weight: 1, color: MAP_PAPER, fillColor: MAP_INK, fillOpacity: 0.14 };
  return fragment ? { ...base, dashArray: "3 3" } : base;
}

async function loadLayer(type = state.layerType) {
  state.layerType = type;
  const layerSelect = $("#mapLayer");
  if (layerSelect) layerSelect.value = type;
  if (!state.map || !window.L) return;
  if (state.layer) state.layer.remove();
  const mapLoading = $("#mapLoading");
  const layerName = layerSelect?.selectedOptions?.[0]?.textContent?.toLowerCase() || "mapa";
  const loadingTimer = setTimeout(() => {
    if (!mapLoading) return;
    setLoading(mapLoading, `Cargando ${layerName}`);
    mapLoading.hidden = false;
  }, 150);
  let data;
  try {
    data = await geoLayerForMap(type);
  } finally {
    clearTimeout(loadingTimer);
    if (mapLoading) {
      mapLoading.hidden = true;
      mapLoading.innerHTML = "";
    }
  }
  state.layer = L.geoJSON(data, {
    style: feature => {
      const territory = findTerritoryByFeature(feature, type, state.territorios);
      return styleFeature(territory?.id === state.selectedTerritory?.id, Boolean(feature?.properties?.part), territoryHasCoplas(territory));
    },
    onEachFeature(feature, layer) {
      const territory = findTerritoryByFeature(feature, type, state.territorios);
      const part = feature?.properties?.part;
      const name = part ? `${feature.properties.COMARCA} \\ ${part}` : territory?.nome || getFeatureNome(feature, type);
      layer.bindTooltip(name, { sticky: true, direction: "auto" });
      layer.on("mouseover", () => {
        if (part) layer.setStyle({ weight: 1.5, fillOpacity: 0.55 });
        else if (territory?.id !== state.selectedTerritory?.id) layer.setStyle({ weight: 1.5, fillOpacity: territoryHasCoplas(territory) ? 0.7 : 0.32 });
      });
      layer.on("mouseout", () => state.layer?.resetStyle(layer));
      layer.on("click", () => {
        if (territory) selectTerritory(territory, { fit: false, openCard: true });
      });
    },
  }).addTo(state.map);
  try {
    state.map.fitBounds(state.layer.getBounds(), { padding: [24, 24] });
  } catch {}
}

async function selectTerritory(territory, options = {}) {
  if (state.selectedTerritory?.id !== territory.id) state.territoryCoplaQuery = "";
  state.selectedTerritory = territory;
  if (territory.tipo !== state.layerType) {
    await loadLayer(territory.tipo);
  }
  state.layer?.eachLayer(layer => {
    const found = findTerritoryByFeature(layer.feature, state.layerType, state.territorios);
    layer.setStyle(styleFeature(found?.id === territory.id, Boolean(layer.feature?.properties?.part), territoryHasCoplas(found)));
    if (found?.id === territory.id && options.fit !== false) {
      try {
        state.map.flyToBounds(layer.getBounds(), { padding: [40, 40], duration: 0.45 });
      } catch {}
    }
  });
  updateMapCard();
  if (state.view === "territory") renderTerritoryView();
  if (state.view === "coplas") renderCoplasView();
  if (options.openCard) updateMapCard();
}

function updateMapCard() {
  const territory = state.selectedTerritory;
  const ctx = placeContext(territory);
  const clearButton = $("#clearTerritory");
  if (clearButton) clearButton.hidden = !territory;
  const title = $("#mapCardTitle");
  const label = $("#mapCardLabel");
  const coplaCount = $("#mapCoplaCount");
  const pieceCount = $("#mapPieceCount");
  const melodyCount = $("#mapMelodyCount");
  if (!title || !coplaCount || !pieceCount || !melodyCount) return;
  title.textContent = territory?.nome || "Galiza";
  if (label) label.textContent = territory ? territoryLabel(territory) : "";
  coplaCount.textContent = territory ? ctx.coplas.length : state.coplas.length;
  pieceCount.textContent = territory ? ctx.pezas.length : state.pezas.length;
  melodyCount.textContent = territory ? ctx.melodias.length : state.melodias.length;
  const sil = $("#mapCardSil");
  if (sil) {
    sil.dataset.silhouetteHero = territory ? territory.id : "galiza";
    hydrateSilhouettes(sil.parentElement);
  }
}

function setMapCardCollapsed(collapsed) {
  const card = $(".map-card");
  const toggle = $("#mapCardToggle");
  if (!card || !toggle) return;
  card.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.textContent = collapsed ? "Mostrar información" : "Ocultar información";
}

function renderMapSearch(query = "") {
  const results = $("#mapResults");
  const q = query.trim();
  if (!q) {
    results.innerHTML = "";
    return;
  }
  const territoryHits = searchTerritories(state.territorios, q).slice(0, 7);
  const textQ = normalizeText(q);
  const coplaHits = state.coplas.filter(copla => normalizeText(coplaHaystack(copla)).includes(textQ)).slice(0, 5);
  results.innerHTML = `
    ${territoryHits.map(item => `
      <button type="button" data-territory-id="${item.id}">
        <strong>${escapeHtml(item.nome)}</strong>
        <span>${escapeHtml(territorySearchMeta(item))}</span>
      </button>
    `).join("")}
    ${coplaHits.map(item => `
      <button class="result-copla" type="button" data-copla-id="${item.id}">
        <strong>${escapeHtml(coplaTitle(item))}</strong>
        <span>Copla</span>
      </button>
    `).join("")}
    ${!territoryHits.length && !coplaHits.length ? `<p class="muted">Sen resultados.</p>` : ""}
  `;
  bindResultButtons(results);
}

function bindResultButtons(root = document) {
  all("[data-territory-id]", root).forEach(button => {
    button.addEventListener("click", () => {
      const territory = state.territorios.find(item => item.id === button.dataset.territoryId);
      if (territory) {
        if (button.closest("#territorySearchResults")) state.territoryQuery = "";
        closeCoplaDrawer();
        closeMelodyDrawer();
        selectTerritory(territory);
        setView("territory");
      }
    });
  });
  all("[data-copla-id]", root).forEach(button => {
    button.addEventListener("click", () => {
      state.selectedCoplaId = Number(button.dataset.coplaId);
      setView("coplas");
      openCoplaDrawer(state.selectedCoplaId);
    });
  });
}

function coplaSelectCheckbox(copla, options) {
  if (!options.selectMode) return "";
  return `<label class="select-check" title="Seleccionar"><input type="checkbox" data-select-copla="${copla.id}" ${options.selected ? "checked" : ""} aria-label="Seleccionar ${escapeHtml(coplaTitle(copla))}"><span class="select-box" aria-hidden="true"></span></label>`;
}

// --- Carga progresiva ------------------------------------------------
//
// As listaxes longas (coplas, recursos, melodías) pintan unha primeira
// páxina e engaden as seguintes cando a persoa chega ao fondo e segue
// baixando, como un feed. Así nunca hai miles de tarxetas no DOM de golpe.
// `key` identifica a consulta: se non cambia (por exemplo ao marcar unha
// copla) consérvase canto levaba cargado; se cambia, volve á primeira páxina.

const PAGE_SIZE = Number(window.FOL_E_AR_PAGE_SIZE) || 48;
const infiniteLists = new Map();

(() => {
  const prefs = loadViewPrefs();
  if (["gallery", "list", "incipits"].includes(prefs.coplas)) state.coplaViewMode = prefs.coplas;
  if (["grid", "rows"].includes(prefs.media)) state.mediaViewMode = prefs.media;
  if (["grid", "rows"].includes(prefs.melodies)) state.melodyViewMode = prefs.melodies;
  if (["grid", "rows"].includes(prefs.pieces)) state.pieceViewMode = prefs.pieces;
})();

function resetInfiniteLists() {
  infiniteLists.forEach(entry => entry.observer?.disconnect());
  infiniteLists.clear();
}

function mountInfiniteList(list, items, { renderItems, bind, key = "", empty = "", pageSize = PAGE_SIZE }) {
  if (!list) return;
  const previous = infiniteLists.get(list.id);
  previous?.observer?.disconnect();
  previous?.footer?.remove();
  const entry = { key, count: previous && previous.key === key ? Math.max(previous.count, pageSize) : pageSize, observer: null, footer: null };
  infiniteLists.set(list.id, entry);
  if (!items.length) {
    list.innerHTML = empty;
    return;
  }
  list.innerHTML = renderItems(items.slice(0, entry.count), null);
  bind?.(list);
  if (entry.count >= items.length) return;

  const footer = document.createElement("div");
  footer.className = "infinite-footer";
  footer.setAttribute("aria-live", "polite");
  list.insertAdjacentElement("afterend", footer);
  entry.footer = footer;
  const paint = () => {
    footer.innerHTML = `<span class="muted">Mostrando ${entry.count} de ${items.length}</span><button type="button" class="btn">Cargar máis</button>`;
  };
  const loadMore = () => {
    if (entry.count >= items.length) return;
    const previousItem = items[entry.count - 1];
    const next = items.slice(entry.count, entry.count + pageSize);
    entry.count += next.length;
    const holder = document.createElement("div");
    holder.innerHTML = renderItems(next, previousItem);
    bind?.(holder);
    list.append(...holder.childNodes);
    if (entry.count >= items.length) {
      entry.observer?.disconnect();
      footer.remove();
      return;
    }
    paint();
    // Volve observar para que, se o fondo segue á vista, cargue a seguinte.
    entry.observer?.unobserve(footer);
    entry.observer?.observe(footer);
  };
  paint();
  footer.addEventListener("click", event => {
    if (event.target.closest("button")) loadMore();
  });
  if (typeof IntersectionObserver !== "undefined") {
    entry.observer = new IntersectionObserver(entries => {
      if (entries.some(item => item.isIntersecting)) loadMore();
    }, { rootMargin: "0px 0px 120px 0px" });
    entry.observer.observe(footer);
  }
}

function coplaCard(copla, options = {}) {
  const versionCount = (copla.versions || []).length;
  const versionChip = versionCount ? `<span class="tag">${versionCount} variantes</span>` : "";
  const voltaChip = copla.is_volta ? `<span class="tag is-volta">Volta</span>` : "";
  const placeChip = `<span class="gallery-place${options.dimPlace ? " is-subtle" : ""}">${coplaPlaceChipsHtml(copla)}</span>`;
  const selectCheckbox = coplaSelectCheckbox(copla, options);
  const cardClass = options.selected ? " is-selected" : "";
  if (options.list) {
    return `
      <article class="gallery-card as-list${cardClass}" tabindex="0" role="button" data-open-copla="${copla.id}">
        <div class="gallery-top">
          ${selectCheckbox}
          <h2 class="gallery-title">${escapeHtml(coplaTitle(copla))}</h2>
          <button class="mini-add icon-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir á peza">+</button>
        </div>
        <div class="gallery-text">${nl2br(restOfText(copla.text || ""))}</div>
        <div class="gallery-bottom">
          <div class="meta">${placeChip}${voltaChip}${versionChip}</div>
        </div>
      </article>
    `;
  }
  return `
    <article class="gallery-card${cardClass}" tabindex="0" role="button" data-open-copla="${copla.id}">
      ${selectCheckbox}
      <button class="mini-add icon-add card-float-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir á peza">+</button>
      <div class="gallery-card-body">
        <h2 class="gallery-title">${escapeHtml(coplaTitle(copla))}</h2>
        <div class="gallery-text">${nl2br(restOfText(copla.text || ""))}</div>
      </div>
      <div class="gallery-bottom">
        <div class="meta">
          ${placeChip}
          ${voltaChip}
          ${versionChip}
        </div>
      </div>
    </article>
  `;
}

function coplaMatchesStateFilter(copla, filter) {
  if (filter === "assigned") return copla.territory_state === "assigned" || copla.territory_state === "general";
  if (filter === "unassigned") return copla.territory_state === "unassigned";
  return true;
}

function filteredCoplas() {
  const scoped = state.coplas;
  const q = normalizeText(state.coplaQuery);
  return scoped.filter(copla => {
    const stateMatches = state.coplaStateFilter === "all" || coplaMatchesStateFilter(copla, state.coplaStateFilter);
    return stateMatches && (!q || normalizeText(coplaHaystack(copla)).includes(q));
  });
}

const MOBILE_QUERY = window.matchMedia?.("(max-width: 920px)") || { matches: false };

// En pantallas pequenas a galería en grade non aporta nada (vai a unha
// columna, coma a lista), así que alí só hai lista e íncipits.
function currentCoplaViewMode() {
  return MOBILE_QUERY.matches && state.coplaViewMode === "gallery" ? "list" : state.coplaViewMode;
}

function coplaViewToggleMarkup() {
  const gridIcon = `<span class="grid-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
  return `
    <div class="view-toggle">
      <button class="chip icon-view ${currentCoplaViewMode() === "list" ? "active" : ""}" type="button" data-copla-view="list" title="Vista de lista" aria-label="Vista de lista">☰</button>
      <button class="chip icon-view ${currentCoplaViewMode() === "gallery" ? "active" : ""}" type="button" data-copla-view="gallery" title="Vista de galería" aria-label="Vista de galería">${gridIcon}</button>
      <button class="chip icon-view ${currentCoplaViewMode() === "incipits" ? "active" : ""}" type="button" data-copla-view="incipits" title="Vista de só íncipits" aria-label="Vista de só íncipits">━</button>
    </div>
  `;
}

function listViewToggleMarkup(attr, current) {
  const gridIcon = `<span class="grid-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
  return `
    <div class="view-toggle">
      <button class="chip icon-view ${current === "grid" ? "active" : ""}" type="button" ${attr}="grid" title="Vista de tarxetas" aria-label="Vista de tarxetas">${gridIcon}</button>
      <button class="chip icon-view ${current === "rows" ? "active" : ""}" type="button" ${attr}="rows" title="Vista compacta, unha liña por elemento" aria-label="Vista compacta">━</button>
    </div>
  `;
}

function coplaStreamClass() {
  const selecting = state.coplaSelectMode ? " is-selecting" : "";
  if (currentCoplaViewMode() === "list") return `copla-list${selecting}`;
  if (currentCoplaViewMode() === "incipits") return `copla-incipits${selecting}`;
  return `copla-gallery gallery-wide${selecting}`;
}

function coplaIncipitRow(copla, options = {}) {
  return `
    <article class="incipit-row${options.selected ? " is-selected" : ""}" tabindex="0" role="button" data-open-copla="${copla.id}">
      ${coplaSelectCheckbox(copla, options)}
      <span class="incipit-text">${escapeHtml(coplaTitle(copla))}</span>
      <span class="incipit-place${options.dimPlace ? " is-subtle" : ""}" title="${escapeHtml(coplaPlaceLabel(copla))}">${coplaPlaceTextHtml(copla)}</span>
    </article>
  `;
}

function renderCoplaItems(items) {
  const dimPlace = Boolean(state.selectedTerritory);
  const selectMode = state.coplaSelectMode;
  const isSelected = copla => state.coplaSelectedIds.includes(copla.id);
  if (currentCoplaViewMode() === "incipits") {
    return items.map(copla => coplaIncipitRow(copla, { dimPlace, selectMode, selected: isSelected(copla) })).join("") || `<p class="muted">Sen coplas para esta consulta.</p>`;
  }
  return items.map(copla => coplaCard(copla, { list: currentCoplaViewMode() === "list", dimPlace, selectMode, selected: isSelected(copla) })).join("") || `<p class="muted">Sen coplas para esta consulta.</p>`;
}

function coplaItemsMarkup(items) {
  return renderCoplaItems(items);
}

function mountCoplaList(list, items, key) {
  mountInfiniteList(list, items, {
    key,
    renderItems: slice => coplaItemsMarkup(slice),
    bind: bindCoplaActions,
    empty: `<p class="muted">Sen coplas para esta consulta.</p>`,
  });
}

function updateCoplasResults(root = $("#view-coplas")) {
  const items = filteredCoplas();
  const list = $("#coplaList", root);
  const count = $("#coplaResultCount", root);
  const scope = $("#coplaResultScope", root);
  if (count) count.textContent = `Mostrando ${items.length} coplas`;
  if (scope) scope.textContent = state.selectedTerritory ? "inclúe subterritorios" : "arquivo completo";
  if (list) {
    list.className = coplaStreamClass();
    mountCoplaList(list, items, `${state.coplaQuery}|${state.coplaStateFilter}`);
  }
  all("[data-copla-view]", root).forEach(button => button.classList.toggle("active", button.dataset.coplaView === currentCoplaViewMode()));
  all("[data-state-filter]", root).forEach(button => button.classList.toggle("active", button.dataset.stateFilter === state.coplaStateFilter));
  const allChip = $("[data-copla-total]", root);
  if (allChip) {
    allChip.textContent = `Todas \\ ${items.length}`;
    allChip.classList.toggle("active", state.coplaStateFilter === "all");
  }
  const toggleButton = $("#toggleCoplaSelect", root);
  if (toggleButton) {
    toggleButton.innerHTML = selectToggleInner();
    toggleButton.classList.toggle("active", state.coplaSelectMode);
    toggleButton.setAttribute("aria-pressed", String(state.coplaSelectMode));
  }
  const batchBar = $("#coplaBatchBar", root);
  if (batchBar) {
    batchBar.innerHTML = coplaBatchBarMarkup(items);
    bindCoplaBatchBar(root);
  }
}

function selectToggleInner() {
  return `<span class="select-toggle-icon" aria-hidden="true"></span>${state.coplaSelectMode ? "Saír da selección" : "Seleccionar varias"}`;
}

function setCoplaSelectMode(on) {
  state.coplaSelectMode = Boolean(on);
  if (!state.coplaSelectMode) {
    state.coplaSelectedIds = [];
    state.coplaLastSelectedId = null;
  }
  updateCoplasResults();
}

// Con `range` (Maiús + clic) marca ou desmarca todo o intervalo desde a
// última copla tocada ata esta, segundo a orde da consulta actual.
function toggleCoplaSelection(coplaId, { range = false } = {}) {
  const visible = filteredCoplas().map(copla => copla.id);
  const last = state.coplaLastSelectedId;
  const selecting = !state.coplaSelectedIds.includes(coplaId);
  if (range && last != null && visible.includes(last) && visible.includes(coplaId)) {
    const from = visible.indexOf(last);
    const to = visible.indexOf(coplaId);
    const span = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
    if (selecting) state.coplaSelectedIds = Array.from(new Set([...state.coplaSelectedIds, ...span]));
    else state.coplaSelectedIds = state.coplaSelectedIds.filter(id => !span.includes(id));
  } else if (selecting) {
    state.coplaSelectedIds.push(coplaId);
  } else {
    state.coplaSelectedIds = state.coplaSelectedIds.filter(id => id !== coplaId);
  }
  state.coplaLastSelectedId = coplaId;
  updateCoplasResults();
}

function coplaBatchBarMarkup(items) {
  if (!state.coplaSelectMode) return "";
  const count = state.coplaSelectedIds.length;
  const plural = count === 1 ? "" : "s";
  const everyVisible = items.length > 0 && items.every(copla => state.coplaSelectedIds.includes(copla.id));
  return `
    <div class="batch-dock${count ? " has-selection" : ""}" role="toolbar" aria-label="Edición en lote">
      <div class="batch-dock-count"><b>${count}</b><div><span>copla${plural} seleccionada${plural}</span><small>${count ? "" : "Toca as coplas para marcalas. "}<span class="hint-shift">Maiús + clic marca un intervalo.</span></small></div></div>
      <div class="batch-dock-tools">
        <button class="link-button" type="button" id="batchSelectAllVisible" ${everyVisible || !items.length ? "disabled" : ""}>Seleccionar as ${items.length} da consulta</button>
        <button class="link-button" type="button" id="batchClearSelection" ${count ? "" : "disabled"}>Baleirar</button>
      </div>
      <div class="batch-dock-actions">
        <button class="btn primary" type="button" id="openBatchAssign" ${count ? "" : "disabled"}>Asignar territorio...</button>
        <button class="btn danger" type="button" id="openBatchDelete" ${count ? "" : "disabled"}>Borrar</button>
        <button class="btn dock-close" type="button" id="batchExit" title="Saír da selección" aria-label="Saír da selección">×</button>
      </div>
    </div>
  `;
}

function bindCoplaBatchBar(root = $("#view-coplas")) {
  $("#batchExit", root)?.addEventListener("click", () => setCoplaSelectMode(false));
  $("#batchSelectAllVisible", root)?.addEventListener("click", () => {
    const ids = filteredCoplas().map(copla => copla.id);
    state.coplaSelectedIds = Array.from(new Set([...state.coplaSelectedIds, ...ids]));
    updateCoplasResults(root);
  });
  $("#batchClearSelection", root)?.addEventListener("click", () => {
    state.coplaSelectedIds = [];
    updateCoplasResults(root);
  });
  $("#openBatchAssign", root)?.addEventListener("click", () => {
    if (!state.coplaSelectedIds.length) return;
    state.batchAssignModalOpen = true;
    state.batchTerritoryIds = [];
    renderCoplasView();
  });
  $("#openBatchDelete", root)?.addEventListener("click", () => {
    if (!state.coplaSelectedIds.length) return;
    openDeleteConfirm([...state.coplaSelectedIds]);
  });
}

function renderCoplasView() {
  const view = $("#view-coplas");
  const items = filteredCoplas();
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Coplas</h1>
        </div>
        <button class="btn primary" type="button" data-view="submit">+ Nova copla</button>
      </div>
      <div class="toolbar">
        <div class="searchbox"><span>⌕</span><input id="coplaSearch" type="search" value="${escapeHtml(state.coplaQuery)}" placeholder="Buscar por verso, íncipit, territorio..."></div>
        ${coplaViewToggleMarkup()}
        <button class="btn select-toggle ${state.coplaSelectMode ? "active" : ""}" type="button" id="toggleCoplaSelect" aria-pressed="${state.coplaSelectMode}">${selectToggleInner()}</button>
      </div>
      <div class="chips">
        <button class="chip ${state.coplaStateFilter === "all" ? "active" : ""}" type="button" data-copla-total data-state-filter="all">Todas \\ ${items.length}</button>
        <button class="chip ${state.coplaStateFilter === "assigned" ? "active" : ""}" type="button" data-state-filter="assigned">Asignadas</button>
        <button class="chip ${state.coplaStateFilter === "unassigned" ? "active" : ""}" type="button" data-state-filter="unassigned">Sen asignar</button>
      </div>
      <div class="results-row"><span id="coplaResultCount" class="muted">Mostrando ${items.length} coplas</span><span id="coplaResultScope" class="muted">${state.coplaQuery ? "resultados da busca" : "arquivo completo"}</span></div>
      <div id="coplaList" class="${coplaStreamClass()}"></div>
      <div id="coplaBatchBar">${coplaBatchBarMarkup(items)}</div>
      ${state.batchAssignModalOpen ? batchAssignModalMarkup() : ""}
    </div>
  `;
  $("#coplaSearch")?.addEventListener("input", event => {
    state.coplaQuery = event.target.value;
    updateCoplasResults(view);
  });
  all("[data-copla-view]", view).forEach(button => button.addEventListener("click", () => {
    state.coplaViewMode = button.dataset.coplaView;
    saveViewPref("coplas", state.coplaViewMode);
    updateCoplasResults(view);
  }));
  all("[data-state-filter]", view).forEach(button => button.addEventListener("click", () => {
    state.coplaStateFilter = button.dataset.stateFilter;
    updateCoplasResults(view);
  }));
  $("#toggleCoplaSelect")?.addEventListener("click", () => setCoplaSelectMode(!state.coplaSelectMode));
  bindCoplaBatchBar(view);
  bindCoplaActions(view);
  mountCoplaList($("#coplaList", view), items, `${state.coplaQuery}|${state.coplaStateFilter}`);
  if (state.batchAssignModalOpen) bindBatchAssignModal(view);
}

function bindCoplaActions(root = document) {
  bindResultButtons(root);
  all("[data-open-copla]", root).forEach(card => {
    card.addEventListener("click", event => {
      if (event.target.closest("button, a, select, input, textarea")) return;
      if (state.coplaSelectMode) {
        toggleCoplaSelection(Number(card.dataset.openCopla), { range: event.shiftKey });
        return;
      }
      openCoplaDrawer(Number(card.dataset.openCopla));
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (state.coplaSelectMode) {
          toggleCoplaSelection(Number(card.dataset.openCopla));
          return;
        }
        openCoplaDrawer(Number(card.dataset.openCopla));
      }
    });
  });
  all("[data-select-copla]", root).forEach(checkbox => checkbox.addEventListener("click", event => {
    event.stopPropagation();
    toggleCoplaSelection(Number(checkbox.dataset.selectCopla), { range: event.shiftKey });
  }));
  all("[data-add-copla]", root).forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const copla = state.coplas.find(item => Number(item.id) === Number(button.dataset.addCopla));
    if (!copla) return;
    const draft = loadDraft();
    if (state.selectedTerritory && !draft.territoryId) draft.territoryId = state.selectedTerritory.id;
    const targetSection = (state.view === "pieces" && draft.sections.find(item => item.id === state.pieceAddTarget)) || draft.sections[0];
    targetSection.coplas.push({
      uid: `${copla.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      id: copla.id,
      incipit: copla.incipit || "",
      text: copla.text || "",
      territory: coplaPlaceLabel(copla),
      role: copla.is_volta ? "retrouso" : "copla",
    });
    saveDraft(draft);
    const original = button.dataset.originalText || button.textContent;
    button.dataset.originalText = original;
    button.textContent = original.trim() === "+" ? "+" : "Engadida";
    button.classList.add("is-added");
    window.setTimeout(() => {
      button.textContent = button.dataset.originalText;
      button.classList.remove("is-added");
    }, 1000);
    if (state.view === "pieces" && state.pieceTab === "workshop") {
      renderPiecesView();
    }
  }));
}

// Lista de coplas pola que se pode navegar coas frechas (a da consulta actual
// en «Coplas»). Só vale mentres a ficha está aberta.
let coplaNav = null;

function coplaPlacesMarkup(copla) {
  const territories = copla.territories || [];
  if (!territories.length) return `<span class="level-text level-empty">${escapeHtml(coplaPlaceLabel(copla))}</span>`;
  return territories.map(item => `<button type="button" class="place-link level-text level-${item.tipo}" data-territory-id="${item.id}" title="${escapeHtml(territorySearchMeta(item))}">${escapeHtml(item.nome)}</button>`).join("");
}

function drawerFold(title, count, body) {
  return `<details class="drawer-fold"><summary><span>${title}</span>${count ? `<small>${count}</small>` : ""}</summary><div class="drawer-fold-body">${body}</div></details>`;
}

function openCoplaDrawer(coplaId, options = {}) {
  const copla = state.coplas.find(item => Number(item.id) === Number(coplaId));
  const drawer = $("#coplaDrawer");
  if (!copla || !drawer) return;
  if (options.ids) coplaNav = { ids: options.ids };
  else if (!options.keepNav) coplaNav = state.view === "coplas" ? { ids: filteredCoplas().map(item => Number(item.id)) } : null;
  const position = coplaNav ? coplaNav.ids.indexOf(Number(copla.id)) : -1;
  const pager = position === -1 ? "" : `
      <div class="drawer-pager" role="group" aria-label="Navegar entre coplas">
        <button type="button" class="icon-btn" data-copla-step="-1" aria-label="Copla anterior" title="Anterior (←)" ${position === 0 ? "disabled" : ""}>‹</button>
        <span aria-live="polite">${position + 1} / ${coplaNav.ids.length}</span>
        <button type="button" class="icon-btn" data-copla-step="1" aria-label="Copla seguinte" title="Seguinte (→)" ${position === coplaNav.ids.length - 1 ? "disabled" : ""}>›</button>
      </div>`;
  const variants = copla.versions || [];
  const media = coplaMedia(copla);
  const variantsHtml = variants.map(version => `
    <div class="variant">
      <strong>${escapeHtml(version.label || version.incipit || "Variante")}</strong>
      <div>${nl2br(version.text || "")}</div>
      <p class="muted">${version.territory_mode === "custom" && (version.territories || []).length ? escapeHtml(version.territories.map(territoryDisplayName).join(" \\ ")) : "Mesma adscrición territorial ca copla principal"}</p>
      ${version.notes ? `<p class="muted">${escapeHtml(version.notes)}</p>` : ""}
    </div>`).join("");
  const folds = [
    variants.length ? drawerFold("Variantes", variants.length, variantsHtml) : "",
    media.length ? drawerFold("Media relacionada", media.length, `<div class="media-grid compact">${media.map(mediaCard).join("")}</div>`) : "",
    copla.notes ? drawerFold("Notas e fonte", "", `<p class="muted">${nl2br(escapeHtml(copla.notes))}</p>`) : "",
  ].join("");
  const stepClass = options.direction ? ` is-step-${options.direction > 0 ? "next" : "prev"}` : "";
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="drawer-scrim" data-close-drawer></div>
    <aside class="drawer-panel copla-sheet${stepClass}" role="dialog" aria-modal="true" aria-label="Ficha da copla: ${escapeHtml(coplaTitle(copla))}" data-sheet-copla="${copla.id}">
      <div class="drawer-bar">
        ${pager}
        <div class="drawer-tools">
          <button class="icon-btn drawer-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir a unha peza" title="Engadir a unha peza">+</button>
          <button class="card-close" type="button" data-close-drawer aria-label="Pechar">×</button>
        </div>
      </div>
      <div class="copla-hero">
        ${copla.is_volta ? `<span class="tag is-volta">Volta</span>` : ""}
        <div class="copla-hero-text">${nl2br(String(copla.text || "").trim())}</div>
      </div>
      <div class="copla-places">${coplaPlacesMarkup(copla)}</div>
      <div class="meta">${(copla.tags || []).map(tag => `<span class="tag" data-tag-name="${escapeHtml(tag)}">${escapeHtml(tag)}</span>`).join("")}</div>
      ${folds ? `<div class="drawer-folds">${folds}</div>` : ""}
      <div class="drawer-actions edit-only">
        <button class="btn" type="button" data-edit-copla="${copla.id}">Editar copla</button>
        <button class="btn danger" type="button" data-delete-copla="${copla.id}">Borrar copla</button>
      </div>
      ${pager ? `<p class="drawer-hint" aria-hidden="true">← → para cambiar de copla</p>` : ""}
    </aside>
  `;
  all("[data-close-drawer]", drawer).forEach(item => item.addEventListener("click", closeCoplaDrawer));
  all("[data-copla-step]", drawer).forEach(button => button.addEventListener("click", () => stepCoplaDrawer(Number(button.dataset.coplaStep))));
  $("[data-edit-copla]", drawer)?.addEventListener("click", () => startEditCopla(copla.id));
  $("[data-delete-copla]", drawer)?.addEventListener("click", () => openDeleteConfirm([copla.id]));
  bindResultButtons(drawer);
  bindCoplaActions(drawer);
}

function stepCoplaDrawer(delta) {
  if (!coplaNav) return false;
  const drawer = $("#coplaDrawer");
  const current = Number(drawer?.querySelector("[data-sheet-copla]")?.dataset.sheetCopla);
  const index = coplaNav.ids.indexOf(current) + delta;
  if (!current || index < 0 || index >= coplaNav.ids.length) return false;
  openCoplaDrawer(coplaNav.ids[index], { keepNav: true, direction: delta });
  // Deixa a lista de fondo na copla actual, para cando se peche a ficha.
  document.querySelector(`#coplaList [data-open-copla="${coplaNav.ids[index]}"]`)?.scrollIntoView?.({ block: "nearest" });
  return true;
}

function closeCoplaDrawer() {
  const drawer = $("#coplaDrawer");
  if (!drawer) return;
  coplaNav = null;
  drawer.hidden = true;
  drawer.innerHTML = "";
}

// Frechas do teclado e deslizamento táctil (esquerda = seguinte, dereita = anterior).
function bindCoplaDrawerNav() {
  document.addEventListener("keydown", event => {
    if (!coplaNav || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const drawer = $("#coplaDrawer");
    if (!drawer || drawer.hidden) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(node => node.getClientRects().length);
    const top = dialogs[dialogs.length - 1];
    if (top && !drawer.contains(top)) return;
    if (stepCoplaDrawer(event.key === "ArrowRight" ? 1 : -1)) event.preventDefault();
  });
  let start = null;
  document.addEventListener("touchstart", event => {
    const panel = event.target.closest?.("#coplaDrawer .copla-sheet");
    if (!panel || !coplaNav || event.touches.length !== 1 || event.target.closest(".media-grid, iframe, input, textarea")) { start = null; return; }
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  document.addEventListener("touchend", event => {
    if (!start || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    stepCoplaDrawer(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function batchAssignModalMarkup() {
  const count = state.coplaSelectedIds.length;
  const selectedTerritories = state.batchTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  return `
    <div class="media-modal batch-assign-modal" role="dialog" aria-modal="true" aria-label="Asignar territorio en lote">
      <div class="media-modal-backdrop" data-close-batch-assign></div>
      <div class="media-modal-panel">
        <div class="media-modal-head">
          <div><div class="eyebrow">Edición en lote</div><h2>Asignar territorio a ${count} copla${count === 1 ? "" : "s"}</h2></div>
          <button class="card-close" type="button" data-close-batch-assign aria-label="Pechar">×</button>
        </div>
        <div class="batch-assign-body formgrid">
          <div class="field full">
            <label>Territorios</label>
            <input id="batchTerritoryQuery" type="search" placeholder="Buscar parroquia, concello, comarca...">
            <div id="batchTerritoryResults" class="territory-results compact"></div>
          </div>
          <div class="field full"><div id="batchSelectedTerritoryChips" class="selected-chips">${selectedTerritories.map(item => selectedTerritoryChip(item, "batch")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`}</div></div>
          <p id="batchAssignFeedback" class="muted field full"></p>
          <div class="drawer-actions field full">
            <button class="btn" type="button" data-close-batch-assign>Cancelar</button>
            <button class="btn primary" type="button" id="applyBatchAssign" ${state.batchTerritoryIds.length ? "" : "disabled"}>Aplicar a ${count} copla${count === 1 ? "" : "s"}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function refreshBatchTerritoryChips() {
  const chips = $("#batchSelectedTerritoryChips");
  if (chips) {
    const selected = state.batchTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
    chips.innerHTML = selected.map(item => selectedTerritoryChip(item, "batch")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`;
    all("[data-remove-batch-territory]", chips).forEach(button => button.addEventListener("click", () => {
      state.batchTerritoryIds = state.batchTerritoryIds.filter(id => id !== button.dataset.removeBatchTerritory);
      refreshBatchTerritoryChips();
    }));
  }
  const applyButton = $("#applyBatchAssign");
  if (applyButton) applyButton.disabled = !state.batchTerritoryIds.length;
}

function bindBatchAssignModal(root = $("#view-coplas")) {
  all("[data-close-batch-assign]", root).forEach(el => el.addEventListener("click", () => {
    state.batchAssignModalOpen = false;
    renderCoplasView();
  }));
  refreshBatchTerritoryChips();
  const input = $("#batchTerritoryQuery", root);
  const results = $("#batchTerritoryResults", root);
  if (input && results) {
    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (!query) {
        results.innerHTML = "";
        return;
      }
      const matches = searchTerritories(state.territorios, query).slice(0, 12);
      results.innerHTML = matches.map(item => `
        <button type="button" data-pick-batch-territory="${item.id}">
          <strong>${escapeHtml(item.nome)}</strong>
          <span>${escapeHtml(territorySearchMeta(item))}</span>
        </button>
      `).join("") || `<p class="muted">Sen resultados.</p>`;
      all("[data-pick-batch-territory]", results).forEach(button => button.addEventListener("click", () => {
        const territory = state.territorios.find(item => item.id === button.dataset.pickBatchTerritory);
        if (!territory) return;
        if (!state.batchTerritoryIds.includes(territory.id)) state.batchTerritoryIds.push(territory.id);
        input.value = "";
        results.innerHTML = "";
        refreshBatchTerritoryChips();
      }));
    });
  }
  $("#applyBatchAssign", root)?.addEventListener("click", applyBatchTerritoryAssignment);
}

function coplaToEditPayload(copla, overrides = {}) {
  const territoryState = overrides.territory_state ?? copla.territory_state ?? "assigned";
  const territories = territoryState === "assigned"
    ? (overrides.territories ?? (copla.territories || []).map(item => ({ id: item.id })))
    : [];
  return {
    id: copla.id,
    text: copla.text || "",
    notes: copla.notes || "",
    status: copla.status || "published",
    territory_state: territoryState,
    territories,
    tags: copla.tags || [],
    is_volta: Boolean(copla.is_volta),
    versions: (copla.versions || []).map(version => ({
      label: version.label || null,
      text: version.text || "",
      notes: version.notes || "",
      territories: version.territory_mode === "custom" ? (version.territories || []).map(item => ({ id: item.id })) : [],
    })),
  };
}

async function applyBatchTerritoryAssignment() {
  const feedback = $("#batchAssignFeedback");
  if (!state.batchTerritoryIds.length || !state.coplaSelectedIds.length) return;
  const territories = state.batchTerritoryIds.map(id => ({ id }));
  const payloads = state.coplaSelectedIds
    .map(id => state.coplas.find(item => Number(item.id) === Number(id)))
    .filter(Boolean)
    .map(copla => coplaToEditPayload(copla, { territory_state: "assigned", territories }));
  if (!payloads.length) return;
  setLoading(feedback, "Aplicando");
  const button = $("#applyBatchAssign");
  if (button) button.disabled = true;
  try {
    const response = await fetch("../api/coplas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coplas: payloads }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido aplicar a asignación.");
    clearApiCache();
    state.coplas = await getCoplas();
    state.coplaSelectedIds = [];
    state.batchAssignModalOpen = false;
    state.batchTerritoryIds = [];
    renderCoplasView();
  } catch (error) {
    if (feedback) feedback.textContent = error.message || "Non se puido aplicar a asignación.";
    if (button) button.disabled = false;
  }
}

function deleteConfirmEntityLabel() {
  return state.deleteConfirmKind === "media" ? "recurso" : "copla";
}

function deleteConfirmNames() {
  if (state.deleteConfirmKind === "media") {
    return state.deleteConfirmIds
      .map(id => state.media.find(item => Number(item.id) === Number(id)))
      .filter(Boolean)
      .map(item => item.title || item.label || item.name || "Recurso sen título");
  }
  return state.deleteConfirmIds
    .map(id => state.coplas.find(item => Number(item.id) === Number(id)))
    .filter(Boolean)
    .map(copla => coplaTitle(copla));
}

function deleteConfirmModalMarkup() {
  const count = state.deleteConfirmIds.length;
  const label = deleteConfirmEntityLabel();
  const labelPlural = state.deleteConfirmKind === "media" ? "recursos" : "coplas";
  const names = deleteConfirmNames();
  const consequences = state.deleteConfirmKind === "media"
    ? `${count === 1 ? "este recurso" : "estes recursos"} da biblioteca de media, xunto cos seus vínculos con coplas, pezas e territorios`
    : `${count === 1 ? "esta copla" : "estas coplas"} do arquivo, xunto coas súas variantes, etiquetas, adscricións territoriais e vínculos con pezas e recursos multimedia`;
  return `
    <div class="media-modal delete-confirm-modal" role="dialog" aria-modal="true" aria-label="Confirmar borrado">
      <div class="media-modal-backdrop" data-close-delete-confirm></div>
      <div class="media-modal-panel">
        <div class="media-modal-head">
          <div><div class="eyebrow">Acción irreversible</div><h2>Borrar ${count} ${count === 1 ? label : labelPlural}?</h2></div>
          <button class="card-close" type="button" data-close-delete-confirm aria-label="Pechar">×</button>
        </div>
        <div class="formgrid">
          <p class="field full">Esta acción borra definitivamente ${consequences}. Non se pode desfacer.</p>
          ${names.length ? `<ul class="field full delete-confirm-list">${names.map(name => `<li>${escapeHtml(name)}</li>`).join("")}</ul>` : ""}
          <p id="deleteConfirmFeedback" class="muted field full"></p>
          <div class="drawer-actions field full">
            <button class="btn" type="button" data-close-delete-confirm ${state.deleteConfirmBusy ? "disabled" : ""}>Cancelar</button>
            <button class="btn danger" type="button" id="confirmDeleteAction" ${state.deleteConfirmBusy ? "disabled" : ""}>${state.deleteConfirmBusy ? loaderHtml("Borrando") : `Borrar definitivamente`}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderDeleteConfirmModal() {
  const container = $("#deleteConfirmModal");
  if (!container) return;
  container.hidden = !state.deleteConfirmOpen;
  container.innerHTML = state.deleteConfirmOpen ? deleteConfirmModalMarkup() : "";
  if (!state.deleteConfirmOpen) return;
  all("[data-close-delete-confirm]", container).forEach(el => el.addEventListener("click", () => {
    if (state.deleteConfirmBusy) return;
    closeDeleteConfirm();
  }));
  $("#confirmDeleteAction", container)?.addEventListener("click", confirmDelete);
}

function openDeleteConfirm(ids, kind = "coplas") {
  const uniqueIds = Array.from(new Set(ids.map(Number)));
  if (!uniqueIds.length) return;
  state.deleteConfirmIds = uniqueIds;
  state.deleteConfirmKind = kind;
  state.deleteConfirmOpen = true;
  state.deleteConfirmBusy = false;
  renderDeleteConfirmModal();
}

function closeDeleteConfirm() {
  state.deleteConfirmOpen = false;
  state.deleteConfirmIds = [];
  state.deleteConfirmBusy = false;
  renderDeleteConfirmModal();
}

async function confirmDelete() {
  const ids = state.deleteConfirmIds;
  const kind = state.deleteConfirmKind;
  if (!ids.length || state.deleteConfirmBusy) return;
  state.deleteConfirmBusy = true;
  renderDeleteConfirmModal();
  try {
    const response = await fetch(`../api/${kind}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido borrar.");
    clearApiCache();
    if (kind === "media") {
      state.media = await loadMedia();
    } else {
      state.coplas = await getCoplas();
      state.coplaSelectedIds = state.coplaSelectedIds.filter(id => !ids.includes(Number(id)));
      if (ids.includes(Number(state.selectedCoplaId))) {
        state.selectedCoplaId = null;
        closeCoplaDrawer();
      }
    }
    closeDeleteConfirm();
    renderView();
  } catch (error) {
    state.deleteConfirmBusy = false;
    renderDeleteConfirmModal();
    const feedback = $("#deleteConfirmFeedback");
    if (feedback) feedback.textContent = error.message || "Non se puido borrar.";
  }
}

function openPieceDrawer(pieceId) {
  const piece = state.pezas.find(item => Number(item.id) === Number(pieceId));
  const drawer = $("#pieceDrawer");
  if (!piece || !drawer) return;
  const author = pieceAuthorName(piece);
  const territory = piece.context_territory
    ? state.territorios.find(item => item.id === piece.context_territory.id) || piece.context_territory
    : state.territorios.find(item => item.id === piece.context_territory_id);
  const sections = pieceSections(piece);
  const authorTag = author === "Sen autoría"
    ? `<span class="tag place">${escapeHtml(author)}</span>`
    : `<button type="button" class="tag place as-link" data-piece-author="${escapeHtml(author)}" title="Ver as pezas de ${escapeHtml(author)}">${escapeHtml(author)}</button>`;
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="drawer-scrim" data-close-piece-drawer></div>
    <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="Ficha da peza">
      <button class="card-close" type="button" data-close-piece-drawer aria-label="Pechar">×</button>
      <div class="eyebrow">${piece.visibility === "private" ? "Peza privada" : "Peza gardada"}</div>
      <h2>${escapeHtml(piece.title || piece.titulo || "Peza sen título")}</h2>
      <div class="meta">
        ${authorTag}
        ${pieceOwnerLink(piece)}
        ${pieceTerritoryTag(piece)}
        ${pieceStatusTags(piece)}
      </div>
      ${piece.status === "hidden" && piece.mine ? `<p class="muted">Unha persoa guía agochou esta peza da biblioteca pública. Ti segues vendo e podes editala.</p>` : ""}
      ${piece.description ? `<p class="muted">${escapeHtml(piece.description)}</p>` : ""}
      <div class="drawer-section">
        <h3>Letra</h3>
        ${sections.map(section => `
          <div class="piece-drawer-section">
            <h4>${escapeHtml(section.label)}</h4>
            ${section.coplas.map(item => `
              <div class="piece-drawer-copla">
                ${item.role === "retrouso" ? `<span class="tag is-volta">Volta</span>` : ""}
                <div class="gallery-text">${nl2br(item.text || "")}</div>
              </div>
            `).join("") || `<p class="muted">Sen coplas nesta parte.</p>`}
          </div>
        `).join("") || `<p class="muted">Esta peza aínda non ten coplas gardadas.</p>`}
      </div>
      ${piece.notes ? `<div class="drawer-section"><h3>Notas</h3><p class="muted">${nl2br(escapeHtml(piece.notes))}</p></div>` : ""}
      ${pieceExtraLinks(piece).length ? `<div class="drawer-section"><h3>Ligazóns</h3>${linkRowsMarkup(pieceExtraLinks(piece))}</div>` : ""}
      <div class="drawer-section">
        <h3>Media relacionada</h3>
        <div class="media-grid compact">${pieceMedia(piece).map(item => mediaCard(item, { removeFromPiece: canManagePiece(piece) && String(item.piece_id) === String(piece.id) })).join("") || `<p class="muted">Sen recursos multimedia vinculados a esta peza.</p>`}</div>
        ${pieceResourceFormMarkup(piece)}
      </div>
      ${pieceManageMarkup(piece)}
      <div class="drawer-actions">
        ${pdfNeedsLogin()
          ? `<a class="btn primary" href="${escapeHtml(loginLink())}">Entra para descargar o PDF</a>`
          : `<button class="btn primary" type="button" data-download-piece-pdf="${piece.id}">Descargar PDF</button>`}
      </div>
    </aside>
  `;
  bindPieceManage(drawer, piece);
  all("[data-close-piece-drawer]", drawer).forEach(item => item.addEventListener("click", closePieceDrawer));
  bindPieceCardActions(drawer);
  $("[data-download-piece-pdf]", drawer)?.addEventListener("click", event => downloadPieceRecordPdf(piece, event.currentTarget));
  bindResourceForm("pm", drawer, { onEnter: () => linkMediaToPiece(piece, drawer) });
  $("#pieceMediaAdd", drawer)?.addEventListener("click", () => linkMediaToPiece(piece, drawer));
  bindResourceFolds(drawer);
  bindResultButtons(drawer);
  all("[data-territory-id]", drawer).forEach(button => button.addEventListener("click", closePieceDrawer));
  all("[data-remove-piece-resource]", drawer).forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    removePieceResource(piece, button.dataset.removePieceResource, drawer);
  }));
}

// Recursos que a peza ten pero que non saen en Media (base sen migrar ou exporte aínda sen
// actualizar): evita duplicar os que xa se ven como tarxetas.
function pieceExtraLinks(piece) {
  const media = pieceMedia(piece);
  return (piece.links || []).filter(link => !media.some(item => (link.media_id != null && String(item.id) === String(link.media_id)) || mediaUrl(item) === link.url));
}

// Quen pode engadir recursos: a dona (ou admin / guía nas editoriais) gardándoos coa peza; os
// guías, en pezas alleas, vinculando Media; en modo local (sen contas) igual.
function pieceResourceMode(piece) {
  if (canManagePiece(piece)) return "piece";
  if (!isGoogleMode() || isEditorAccount()) return "media";
  return "";
}

function pieceResourceFormMarkup(piece) {
  const mode = pieceResourceMode(piece);
  if (!mode) return "";
  if (mode === "piece" && (piece.links || []).length >= MAX_PIECE_RESOURCES) return `<p class="muted">Máximo de ${MAX_PIECE_RESOURCES} recursos por peza.</p>`;
  const where = mode === "piece"
    ? (piece.visibility === "private" ? "O recurso será privado: só o ves ti, igual que a peza." : "O recurso aparecerá en Media, ligado a esta peza.")
    : "";
  return `
    <details class="piece-media-form resources-fold" data-fold="drawer" ${state.drawerResourcesOpen ? "open" : ""}>
      <summary><span>Vincular un recurso</span></summary>
      ${resourceFormMarkup("pm")}
      <div><button class="btn" type="button" id="pieceMediaAdd">Vincular a esta peza</button></div>
      ${where ? `<p class="muted small-print">${escapeHtml(where)}</p>` : ""}
    </details>`;
}

async function removePieceResource(piece, mediaId, drawer) {
  const rest = (piece.links || []).filter(link => String(link.media_id) !== String(mediaId));
  const feedback = $("#pmFeedback", drawer);
  if (!window.confirm("Vas quitar este recurso da peza (e de Media). ¿Continuar?")) return;
  try {
    await pieceApi("/pieces/resources", "POST", { id: piece.id, links: rest.map(cleanResource) });
    await refreshPezas();
    openPieceDrawer(piece.id);
  } catch (error) {
    if (feedback) feedback.textContent = error.message || "Non se puido quitar o recurso.";
    else notify(error.message);
  }
}

function canManagePiece(piece) {
  if (!isAccount()) return false;
  if (piece.mine) return true;
  const info = authInfo();
  if (info.isAdmin?.()) return true;
  return Boolean(piece.editorial && info.canEdit?.());
}

function canModeratePiece(piece) {
  return isEditorAccount() && piece.visibility === "public" && !piece.mine;
}

// Publicar pezas na biblioteca (e dar de alta coplas no arquivo) é cousa de guías e admin.
function canPublishPieces() {
  return !isGoogleMode() || isEditorAccount();
}

function pieceManageMarkup(piece) {
  const manage = canManagePiece(piece);
  const moderate = canModeratePiece(piece);
  if (!manage && !moderate) return "";
  return `
    <div class="drawer-section piece-manage">
      <h3>${manage ? "Xestionar a peza" : "Moderación"}</h3>
      <div class="piece-manage-actions">
        ${manage ? `<button class="btn" type="button" data-edit-piece="${piece.id}">Editar no obradoiro</button>` : ""}
        ${manage && (piece.visibility !== "private" || canPublishPieces()) ? `<button class="btn" type="button" data-toggle-piece-visibility="${piece.id}">${piece.visibility === "private" ? "Publicar na biblioteca" : "Facela privada"}</button>` : ""}
        ${manage && isEditorAccount() && (piece.coplas || []).some(item => item.id == null) ? `<button class="btn" type="button" data-register-piece-coplas="${piece.id}" title="Dá de alta no arquivo as coplas soltas desta peza, co seu territorio e lugar">Dar de alta as coplas no arquivo</button>` : ""}
        ${moderate ? `<button class="btn" type="button" data-moderate-piece="${piece.id}">${piece.status === "hidden" ? "Amosar de novo" : "Agochar da biblioteca"}</button>` : ""}
        ${manage ? `<button class="btn danger" type="button" data-delete-piece="${piece.id}">Borrar</button>` : ""}
      </div>
      ${manage && piece.visibility === "private" ? `<p class="muted small-print">Só a ves ti. Se a publicas, aparece na biblioteca e (se tes perfil público) co teu nome.</p>` : ""}
      <p id="pieceManageStatus" class="muted" role="status"></p>
    </div>`;
}

function bindPieceManage(drawer, piece) {
  const status = $("#pieceManageStatus", drawer);
  const fail = error => {
    if (status) status.textContent = error.message || "Non se puido completar a acción.";
    else notify(error.message);
  };
  $("[data-edit-piece]", drawer)?.addEventListener("click", () => {
    if (!editPieceInWorkshop(piece)) return;
    closePieceDrawer();
    state.pieceTab = "workshop";
    setView("pieces");
  });
  $("[data-toggle-piece-visibility]", drawer)?.addEventListener("click", async () => {
    const next = piece.visibility === "private" ? "public" : "private";
    if (next === "public" && !window.confirm("A peza vai aparecer na biblioteca pública e calquera persoa poderá lela. ¿Publicala?")) return;
    try {
      await pieceApi("/pieces/visibility", "POST", { id: piece.id, visibility: next });
      await refreshPezas();
      notify(next === "public" ? "Peza publicada na biblioteca." : "A peza é agora privada.");
      openPieceDrawer(piece.id);
    } catch (error) { fail(error); }
  });
  $("[data-register-piece-coplas]", drawer)?.addEventListener("click", async () => {
    try {
      const result = await pieceApi("/pieces/register-coplas", "POST", { id: piece.id });
      clearApiCache();
      state.coplas = await getCoplas();
      await refreshPezas();
      notify(result.registered ? `${result.registered} copla${result.registered === 1 ? "" : "s"} nova${result.registered === 1 ? "" : "s"} no arquivo.` : "As coplas xa estaban no arquivo: ligáronse á peza.");
      openPieceDrawer(piece.id);
    } catch (error) { fail(error); }
  });
  $("[data-moderate-piece]", drawer)?.addEventListener("click", async () => {
    try {
      await pieceApi("/pieces/moderate", "POST", { id: piece.id, hidden: piece.status !== "hidden" });
      await refreshPezas();
      notify(piece.status === "hidden" ? "Peza amosada de novo." : "Peza agochada da biblioteca pública.");
      openPieceDrawer(piece.id);
    } catch (error) { fail(error); }
  });
  $("[data-delete-piece]", drawer)?.addEventListener("click", async () => {
    if (!window.confirm(`Vas borrar «${piece.title || "esta peza"}». Non se pode desfacer. ¿Continuar?`)) return;
    try {
      await pieceApi("/pieces", "DELETE", { id: piece.id });
      closePieceDrawer();
      await refreshPezas();
      notify("Peza borrada.");
    } catch (error) { fail(error); }
  });
}

// Pasa unha peza gardada ao obradoiro para editala (garda sobre a mesma peza).
function editPieceInWorkshop(piece) {
  const current = loadDraft();
  if (draftCount(current) && current.editingPieceId !== piece.id
      && !window.confirm("O obradoiro ten unha peza sen gardar. ¿Substituíla pola peza que vas editar?")) return false;
  const draft = defaultDraft();
  draft.title = piece.title || "";
  draft.author = pieceAuthorName(piece) === "Sen autoría" ? "" : pieceAuthorName(piece);
  draft.notes = piece.notes || "";
  draft.territoryId = piece.context_territory?.id || piece.context_territory_id || "";
  draft.lugar = piece.lugar || "";
  draft.links = (piece.links || []).map(cleanResource);
  draft.editingPieceId = piece.id;
  draft.visibility = piece.visibility === "public" ? "public" : "private";
  draft.sections = pieceSections(piece).map((section, index) => ({
    id: `parte-${index + 1}`,
    label: section.label === "Parte" ? "" : section.label,
    coplas: section.coplas.map(item => {
      const entry = draftCoplaItem({ id: item.id, text: item.text || "", role: item.role || "copla", notes: item.notes || "" });
      if ((item.text || "").trim()) entry.text = String(item.text).trim();
      return entry;
    }),
  }));
  if (!draft.sections.length) draft.sections = defaultDraft().sections;
  saveDraft(draft);
  return true;
}

async function linkMediaToPiece(piece, drawer) {
  const feedback = $("#pmFeedback", drawer);
  const link = readResourceForm("pm", drawer);
  if (!link) return;
  const mode = pieceResourceMode(piece);
  if (!mode) return;
  setLoading(feedback, "Gardando");
  try {
    if (mode === "piece") {
      const current = (piece.links || []).map(cleanResource);
      if (current.length >= MAX_PIECE_RESOURCES) throw new Error(`Unha peza non pode ter máis de ${MAX_PIECE_RESOURCES} recursos.`);
      if (current.some(item => item.url === link.url)) throw new Error("Ese recurso xa está ligado á peza.");
      await pieceApi("/pieces/resources", "POST", { id: piece.id, links: [...current, link] });
      await refreshPezas();
    } else {
      const response = await fetch("../api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media: [{
            provider: link.media_kind,
            media_kind: link.media_kind,
            title: link.title,
            url: link.url,
            description: link.description,
            author_or_source: link.author_or_source,
            thumbnail_url: link.thumbnail_url,
            status: "published",
            links: [{ entity_type: "piece", entity_id: piece.id, relation_type: link.role }],
          }],
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Non se puido vincular o recurso.");
      clearApiCache();
      state.media = await loadMedia();
    }
    openPieceDrawer(piece.id);
  } catch (error) {
    if (feedback) feedback.textContent = error.message || "Non se puido vincular o recurso.";
  }
}

function closePieceDrawer() {
  const drawer = $("#pieceDrawer");
  if (!drawer) return;
  drawer.hidden = true;
  drawer.innerHTML = "";
}

async function downloadPieceRecordPdf(piece, button) {
  if (button) {
    button.disabled = true;
    button.innerHTML = loaderHtml("Xerando PDF");
  }
  try {
    const response = await fetch(`../api/pieces/${piece.id}/pdf`);
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).error || "";
      } catch {
        detail = await response.text();
      }
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (blob.type && blob.type !== "application/pdf") {
      throw new Error(`Resposta inesperada: ${blob.type}`);
    }
    const filename = filenameFromResponse(response, `fol-e-ar-${slugify(piece.title || piece.titulo || "peza")}.pdf`);
    openPdfViewer(blob, filename);
  } catch (error) {
    console.error("Erro xerando PDF da peza", error);
    notify(pdfErrorMessage(error));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Descargar PDF";
    }
  }
}

function pieceTerritory() {
  const draft = loadDraft();
  return state.territorios.find(item => item.id === draft.territoryId) || state.selectedTerritory || null;
}

function territoryContextTitle(territory) {
  if (!territory) return "";
  const hierarchy = buildHierarchy(territory, state.territorios);
  const parentConcello = hierarchy.find(item => item.tipo === "con" && item.id !== territory.id);
  if (territory.tipo === "par" && parentConcello) return `${territory.nome} - ${parentConcello.nome}`;
  const parentComarca = hierarchy.find(item => item.tipo === "com" && item.id !== territory.id);
  if (territory.tipo === "con" && parentComarca) return territory.nome;
  return territory.nome;
}

function filteredPieceLibrary() {
  const territory = pieceTerritory();
  const scoped = territory ? filterCoplasByTerritory(state.coplas, getDescendantIds(territory, state.territorios)) : state.coplas;
  const q = normalizeText(state.pieceLibraryQuery);
  return scoped.filter(copla => !q || normalizeText(coplaHaystack(copla)).includes(q)).slice(0, 80);
}

function pieceAuthorName(piece) {
  return piece.author || piece.autoria || piece.creator || "Sen autoría";
}

function pieceHaystack(piece) {
  return [
    piece.title,
    piece.titulo,
    piece.author,
    piece.autoria,
    piece.description,
    piece.notes,
    piece.context,
    piece.territory_id,
    piece.context_territory_id,
    piece.lugar,
    territoryTreeNames(piece.context_territory),
  ].join(" ");
}

function filteredPieceRepository() {
  const territory = pieceTerritory();
  const scoped = territory ? filterPiecesByTerritory(state.pezas, getDescendantIds(territory, state.territorios), state.coplas) : state.pezas;
  const q = normalizeText(state.pieceRepositoryQuery);
  const rhythm = normalizeText(state.pieceRhythmQuery);
  const authorFilter = normalizeText(state.pieceAuthorFilter || "");
  const onlyMine = state.pieceScope === "mine" && isAccount();
  return scoped.filter(piece => {
    if (onlyMine && !piece.mine) return false;
    const matchesText = !q || normalizeText(pieceHaystack(piece)).includes(q);
    const sections = piece.sections || piece.parts || piece.coplas || [];
    const matchesRhythm = !rhythm || sections.some(item => normalizeText(item.label || item.section_label || item.rhythm || "").includes(rhythm));
    const matchesAuthor = !authorFilter || normalizeText(pieceAuthorName(piece)) === authorFilter;
    return matchesText && matchesRhythm && matchesAuthor;
  });
}

function pieceSections(piece) {
  const structured = piece.sections || piece.parts;
  if (Array.isArray(structured) && structured.length && structured[0] && (structured[0].coplas || structured[0].items)) {
    return structured.map(section => ({ label: section.label || section.section_label || "Parte", coplas: section.coplas || section.items || [] }));
  }
  const sections = [];
  (piece.coplas || []).forEach(item => {
    const label = item.section_label || item.label || "Parte";
    const last = sections[sections.length - 1];
    if (last && last.label === label) {
      last.coplas.push(item);
    } else {
      sections.push({ label, coplas: [item] });
    }
  });
  return sections;
}

function pieceMedia(piece) {
  return state.media.filter(item => (item.links || []).some(link => link.entity_type === "piece" && String(link.entity_id) === String(piece.id)));
}

// --- Autorías ---------------------------------------------------------------
// A autoría é o nome que se escribe na peza (grupo, artista, unha persoa...).
// Agrúpase sen ter en conta maiúsculas nin acentos; a ficha reúne as pezas e os
// recursos que hai desa autoría na plataforma.

function authorKey(name) {
  return normalizeText(name || "");
}

function hasAuthor(piece) {
  const name = pieceAuthorName(piece);
  return Boolean(authorKey(name)) && authorKey(name) !== authorKey("Sen autoría");
}

// Nome para amosar: a variante máis usada; en empate, a que ten máis maiúsculas.
function authorDisplayName(variants) {
  const counts = new Map();
  variants.forEach(name => counts.set(name, (counts.get(name) || 0) + 1));
  const upper = name => (name.match(/\p{Lu}/gu) || []).length;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || upper(b[0]) - upper(a[0]) || a[0].localeCompare(b[0], "gl"))[0][0];
}

function authorDirectory() {
  const groups = new Map();
  state.pezas.filter(hasAuthor).forEach(piece => {
    const key = authorKey(pieceAuthorName(piece));
    const entry = groups.get(key) || { key, variants: [], count: 0 };
    entry.variants.push(pieceAuthorName(piece).trim().replace(/\s+/g, " "));
    entry.count += 1;
    groups.set(key, entry);
  });
  return [...groups.values()]
    .map(entry => ({ key: entry.key, name: authorDisplayName(entry.variants), count: entry.count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "gl"));
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function linkRowsMarkup(links) {
  const rows = links.map(link => {
    const href = safeUrl(link.url);
    if (!href) return "";
    const host = new URL(href).hostname.replace(/^www\./, "");
    return `<a class="link-row" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(link.title || host)}</strong><span>${escapeHtml(host)}${link.pieceTitle ? ` \\ ${escapeHtml(link.pieceTitle)}` : ""}</span></a>`;
  }).join("");
  return rows ? `<div class="link-list">${rows}</div>` : "";
}

function openAuthor(name) {
  closePieceDrawer();
  state.pieceAuthorFilter = name;
  state.pieceTab = "library";
  state.pieceScope = "all";
  state.pieceRepositoryQuery = "";
  state.pieceRhythmQuery = "";
  history.pushState({ fv: "pieces" }, "", `${window.location.pathname}${window.location.search}#/autoria/${slugify(name)}`);
  if (state.view === "pieces") renderPiecesView(); else setView("pieces", { push: false });
  window.scrollTo(0, 0);
}

function closeAuthor() {
  state.pieceAuthorFilter = "";
  if (window.location.hash.startsWith("#/autoria/")) history.pushState({ fv: "pieces" }, "", routeUrl(false));
  renderPiecesView();
}

// Ligazón directa #/autoria/<nome-en-slug>: busca a autoría cando xa hai pezas.
function applyAuthorHash() {
  const match = window.location.hash.match(/^#\/autoria\/([^/]+)$/);
  if (!match) return false;
  const found = authorDirectory().find(entry => slugify(entry.name) === match[1]);
  state.pieceAuthorFilter = found ? found.name : match[1].replace(/-/g, " ");
  state.pieceTab = "library";
  return true;
}

function authorFichaMarkup() {
  const filter = state.pieceAuthorFilter;
  if (!filter) return "";
  const pieces = state.pezas.filter(piece => hasAuthor(piece) && authorKey(pieceAuthorName(piece)) === authorKey(filter));
  const name = pieces.length ? authorDisplayName(pieces.map(piece => pieceAuthorName(piece).trim().replace(/\s+/g, " "))) : filter;
  const links = pieces.flatMap(piece => pieceExtraLinks(piece).map(link => ({ ...link, pieceTitle: piece.title })));
  const seen = new Set();
  const media = pieces.flatMap(pieceMedia).filter(item => (seen.has(item.id) ? false : seen.add(item.id)));
  const owners = new Map();
  pieces.forEach(piece => {
    if (piece.owner?.handle && authorKey(piece.owner.display_name) === authorKey(name)) owners.set(piece.owner.handle, piece.owner);
  });
  const resourceTotal = links.length + media.length;
  return `
    <section class="panel author-ficha">
      <p><button class="btn" type="button" id="clearPieceAuthorFilter">← Todas as pezas</button></p>
      <div class="eyebrow">Autoría</div>
      <h2 class="author-name">${escapeHtml(name)}</h2>
      <p class="muted">${pieces.length} peza${pieces.length === 1 ? "" : "s"} \\ ${resourceTotal} recurso${resourceTotal === 1 ? "" : "s"}</p>
      ${[...owners.values()].map(owner => `<p>Ten perfil na plataforma: <a href="#/persoa/${escapeHtml(owner.handle)}">${escapeHtml(owner.display_name)}</a></p>`).join("")}
      ${pieces.length ? "" : `<p class="muted">Non hai pezas con esta autoría.</p>`}
      ${resourceTotal ? `
        <h3 class="sub-title">Recursos</h3>
        ${linkRowsMarkup(links)}
        ${media.length ? `<div class="media-grid compact">${media.map(mediaCard).join("")}</div>` : ""}` : ""}
    </section>`;
}

// Autorías: as máis activas en chips e o resto a un clic (busca ou directorio completo).
// Pensado para que siga servindo con centos de autorías.
const AUTHOR_CHIPS = 6;

function authorEntries() {
  return authorDirectory().map(entry => ({ name: entry.name, count: entry.count }));
}

function authorStripMarkup() {
  const authors = authorDirectory();
  if (!authors.length) return "";
  return `
    <div class="author-strip-wrap">
      <span class="author-strip-label">Máis activas</span>
      <div id="authorStrip" class="author-strip">${authors.slice(0, AUTHOR_CHIPS).map(entry => `<button type="button" class="chip-link" data-piece-author="${escapeHtml(entry.name)}" title="Ver as pezas e recursos de ${escapeHtml(entry.name)}">${escapeHtml(entry.name)} <span class="muted">${entry.count}</span></button>`).join("")}</div>
      ${authors.length > AUTHOR_CHIPS ? `<button type="button" class="link-button author-strip-toggle" id="authorDirectoryOpen">Todas as ${authors.length} autorías</button>` : ""}
    </div>`;
}

function pieceOwnerLink(piece) {
  if (!piece.owner?.handle || piece.mine) return "";
  return `<a class="tag place as-link piece-owner" href="#/persoa/${escapeHtml(piece.owner.handle)}" title="Ver o perfil de ${escapeHtml(piece.owner.display_name)}">por ${escapeHtml(piece.owner.display_name)}</a>`;
}

function pieceStatusTags(piece) {
  const tags = [];
  if (piece.status === "hidden") tags.push(`<span class="tag is-hidden-piece">Agochada</span>`);
  if (piece.mine) tags.push(piece.visibility === "private" ? `<span class="tag is-private">Privada</span>` : `<span class="tag is-public">Pública</span>`);
  else if (piece.visibility === "private") tags.push(`<span class="tag is-private">Privada</span>`);
  return tags.join("");
}

// Territorio (e, se hai, lugar) dunha peza: etiqueta clicable que leva ao territorio.
function pieceTerritoryOf(piece) {
  const id = piece.context_territory?.id || piece.context_territory_id || piece.territory_id;
  return id ? (state.territorios.find(item => item.id === id) || piece.context_territory || null) : null;
}

function pieceTerritoryTag(piece) {
  const territory = pieceTerritoryOf(piece);
  const lugar = String(piece.lugar || "").trim();
  if (!territory) return lugar ? `<span class="tag place">${escapeHtml(lugar)}</span>` : "";
  const label = lugar ? `${lugar}, ${territory.nome}` : territory.nome;
  return territory.id
    ? `<button type="button" class="tag place as-link" data-territory-id="${escapeHtml(territory.id)}" title="Ver ${escapeHtml(territory.nome)} no arquivo">${escapeHtml(label)}</button>`
    : `<span class="tag place">${escapeHtml(label)}</span>`;
}

function pieceCard(piece) {
  const title = piece.title || piece.titulo || "Peza sen título";
  const author = pieceAuthorName(piece);
  const sections = pieceSections(piece);
  const coplaTotal = piece.copla_count ?? (piece.coplas || []).length;
  const authorTag = author === "Sen autoría"
    ? `<span class="tag place">${escapeHtml(author)}</span>`
    : `<button type="button" class="tag place as-link" data-piece-author="${escapeHtml(author)}" title="Ver as pezas de ${escapeHtml(author)}">${escapeHtml(author)}</button>`;
  return `
    <article class="piece-card${piece.mine ? " is-mine" : ""}" tabindex="0" role="button" data-open-piece="${piece.id}">
      <div>
        <div class="eyebrow">${piece.visibility === "private" ? "Peza privada" : "Peza gardada"}</div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(piece.description || piece.notes || "Mapa de referencias de coplas preparado para consulta e exportación.")}</p>
      </div>
      <div class="meta">
        ${authorTag}
        ${pieceTerritoryTag(piece)}
        ${pieceOwnerLink(piece)}
        <span class="tag">${coplaTotal || 0} coplas</span>
        ${sections.length ? `<span class="tag">${sections.length} partes</span>` : ""}
        ${pieceStatusTags(piece)}
      </div>
    </article>
  `;
}

function pieceRow(piece) {
  const title = piece.title || piece.titulo || "Peza sen título";
  const author = pieceAuthorName(piece);
  const sections = pieceSections(piece);
  const coplaTotal = piece.copla_count ?? (piece.coplas || []).length;
  const authorCell = author === "Sen autoría"
    ? `<span class="muted">${escapeHtml(author)}</span>`
    : `<button type="button" class="tag place as-link" data-piece-author="${escapeHtml(author)}" title="Ver as pezas de ${escapeHtml(author)}">${escapeHtml(author)}</button>`;
  const description = piece.description || piece.notes || "";
  return `
    <article class="piece-row${piece.mine ? " is-mine" : ""}" tabindex="0" role="button" data-open-piece="${piece.id}" aria-label="${escapeHtml(title)}">
      <span class="row-title"><strong>${escapeHtml(title)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span>
      <span class="row-author">${authorCell}</span>
      <span class="row-count">${coplaTotal || 0} coplas${sections.length ? ` \\ ${sections.length} partes` : ""}</span>
      <span class="row-tags">${pieceTerritoryTag(piece)}${pieceOwnerLink(piece)}${pieceStatusTags(piece)}</span>
    </article>`;
}

function pieceListClass() {
  return state.pieceViewMode === "rows" ? "piece-rows" : "piece-grid";
}

function pieceItemsMarkup(pieces) {
  if (!pieces.length) return pieceEmptyMarkup();
  return pieces.map(state.pieceViewMode === "rows" ? pieceRow : pieceCard).join("");
}

function renderPieceTerritoryResults(root = $("#view-pieces")) {
  const results = $("#pieceTerritoryResults", root);
  if (!results) return;
  const query = state.pieceTerritoryQuery.trim();
  if (!query) {
    results.innerHTML = "";
    return;
  }
  const matches = searchTerritories(state.territorios, query).slice(0, 10);
  results.innerHTML = matches.map(item => `
    <button type="button" data-piece-territory="${item.id}">
      <strong>${escapeHtml(item.nome)}</strong>
      <span>${escapeHtml(territorySearchMeta(item))}</span>
    </button>
  `).join("") || `<p class="muted">Sen resultados.</p>`;
  all("[data-piece-territory]", results).forEach(button => button.addEventListener("click", async () => {
    const territory = state.territorios.find(item => item.id === button.dataset.pieceTerritory);
    if (!territory) return;
    const draft = loadDraft();
    draft.territoryId = territory.id;
    saveDraft(draft);
    state.pieceTerritoryQuery = "";
    await selectTerritory(territory);
    renderPiecesView();
  }));
}

function updatePieceLibrary(root = $("#view-pieces")) {
  const library = filteredPieceLibrary();
  const list = $("#pieceLibraryList", root);
  const count = $("#pieceLibraryCount", root);
  if (count) count.textContent = `${library.length} coplas`;
  if (!list) return;
  list.innerHTML = library.map(copla => `
    <article class="mini-copla">
      <h3>${escapeHtml(coplaTitle(copla))}</h3>
      <p>${nl2br(restOfText(copla.text || ""))}</p>
      <div class="mini-bottom">
        <span class="tag place">${escapeHtml(coplaPlaceLabel(copla))}</span>
        ${copla.is_volta ? `<span class="tag is-volta">Volta</span>` : ""}
        <button class="mini-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir á peza">${uiIcon("plus", 16)}</button>
      </div>
    </article>
  `).join("") || `<p class="muted">Sen coplas no repertorio.</p>`;
  bindCoplaActions(list);
}

function bindPieceCardActions(root = $("#view-pieces")) {
  bindResultButtons(root);
  all("[data-piece-author]", root).forEach(button => button.addEventListener("click", () => openAuthor(button.dataset.pieceAuthor)));
  all("[data-open-piece]", root).forEach(card => {
    card.addEventListener("click", event => {
      if (event.target.closest("button, a, select, input, textarea")) return;
      openPieceDrawer(Number(card.dataset.openPiece));
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPieceDrawer(Number(card.dataset.openPiece));
      }
    });
  });
}

function updatePieceRepository(root = $("#view-pieces")) {
  const repo = filteredPieceRepository();
  const list = $("#pieceRepositoryList", root);
  const count = $("#pieceRepositoryCount", root);
  if (count) count.textContent = `${repo.length} pezas`;
  if (!list) return;
  list.className = pieceListClass();
  list.innerHTML = pieceItemsMarkup(repo);
  bindPieceCardActions(list);
}

function pieceEntryModalMarkup(draft) {
  if (!state.pieceEntryModal) return "";
  const sectionOptions = draft.sections.map((section, index) => `<option value="${escapeHtml(section.id)}" ${section.id === state.pieceAddTarget ? "selected" : ""}>${escapeHtml(section.label || `Parte ${index + 1}`)}</option>`).join("");
  const close = `<button class="card-close" type="button" data-close-piece-entry aria-label="Pechar">×</button>`;
  if (state.pieceEntryModal === "write") {
    return `
      <div class="media-modal piece-entry-modal" role="dialog" aria-modal="true" aria-label="Escribir copla">
        <div class="media-modal-backdrop" data-close-piece-entry></div>
        <div class="media-modal-panel piece-entry-panel">
          <div class="media-modal-head"><div><h2>Escribir copla</h2></div>${close}</div>
          <div class="piece-entry-body formgrid">
            <div class="field full"><label>Texto</label><textarea id="writtenCoplaText" rows="7" placeholder="Un verso por liña"></textarea></div>
            <div class="field"><label>Parte</label><select id="writtenCoplaSection">${sectionOptions}<option value="new">Nova parte...</option></select></div>
            <div class="field" id="writtenNewSectionFields" hidden><label>Ritmo da nova parte</label><select id="writtenCoplaRhythm"><option value="">Seleccionar ritmo</option>${RHYTHMS.map(value => `<option value="${value}">${value}</option>`).join("")}</select></div>
            <div class="field"><label>Función</label><select id="writtenCoplaRole"><option value="copla">Copla</option><option value="retrouso">Volta</option></select></div>
            <div class="field full"><label>Nota opcional</label><input id="writtenCoplaNotes" type="text" placeholder="Fonte ou indicación para esta aparición"></div>
          </div>
          <div class="piece-entry-footer"><p id="pieceEntryFeedback" class="muted"></p><button class="btn primary" type="button" id="addWrittenCopla">Engadir á peza</button></div>
        </div>
      </div>`;
  }
  return `
    <div class="media-modal piece-entry-modal" role="dialog" aria-modal="true" aria-label="Importar peza">
      <div class="media-modal-backdrop" data-close-piece-entry></div>
      <div class="media-modal-panel piece-entry-panel">
        <div class="media-modal-head"><div><h2>Importar peza</h2></div>${close}</div>
        <div class="piece-entry-body">
          ${draftCount(draft) ? `<p class="inline-notice">O borrador actual ten ${draftCount(draft)} ${draftCount(draft) === 1 ? "copla" : "coplas"}. Ao importar, substituirase polo contido do ficheiro.</p>` : ""}
          <div class="piece-import-drop">
            <input id="pieceImportFile" class="visually-hidden" type="file" accept="text/plain,.txt,application/json,.json">
            <label class="btn primary" for="pieceImportFile">Escoller TXT ou JSON</label>
            <span id="pieceImportFilename" class="muted">Ningún ficheiro seleccionado</span>
          </div>
          <details class="import-help">
            <summary>Modelos de ficheiro</summary>
            <p class="muted">Descarga un modelo, complétao no teu editor e impórtao aquí. No TXT, escribe as voltas/retrousos entre &gt; e &lt;. Ao importar, as coplas incorpóranse á base de datos e a peza queda lista para revisar e gardar.</p>
            <div class="gallery-actions"><button class="btn" type="button" id="downloadPieceTxtTemplate">Modelo TXT</button><button class="btn" type="button" id="downloadPieceJsonTemplate">Modelo JSON</button></div>
          </details>
        </div>
        <div class="piece-entry-footer"><p id="pieceEntryFeedback" class="muted"></p><button class="btn primary" type="button" id="importPieceFile">Levar ao obradoiro</button></div>
      </div>
    </div>`;
}

function openPieceEntryModal(kind) {
  state.pieceEntryModal = kind;
  renderPiecesView();
}

function closePieceEntryModal() {
  state.pieceEntryModal = "";
  renderPiecesView();
}

function draftCoplaItem({ id = null, text = "", territory = "", role = "copla", notes = "" }) {
  const numericId = Number(id);
  const corpusCopla = Number.isInteger(numericId) && numericId > 0 ? state.coplas.find(item => Number(item.id) === numericId) : null;
  if (corpusCopla) {
    return {
      uid: `${corpusCopla.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      id: corpusCopla.id,
      incipit: corpusCopla.incipit || firstLine(corpusCopla.text),
      text: corpusCopla.text || "",
      territory: coplaPlaceLabel(corpusCopla),
      role,
      notes,
    };
  }
  return {
    uid: `inline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    id: null,
    incipit: firstLine(text),
    text: text.trim(),
    territory,
    role,
    notes,
  };
}

function addWrittenCopla() {
  const feedback = $("#pieceEntryFeedback");
  const text = $("#writtenCoplaText")?.value.trim() || "";
  if (!text) {
    feedback.textContent = "Escribe o texto antes de engadilo.";
    return;
  }
  const draft = loadDraft();
  let section = draft.sections.find(item => item.id === $("#writtenCoplaSection").value);
  if (!section) {
    section = { id: `section-${Date.now()}`, label: $("#writtenCoplaRhythm").value || "", coplas: [] };
    draft.sections.push(section);
  }
  section.coplas.push(draftCoplaItem({
    text,
    territory: pieceTerritory()?.nome || "",
    role: $("#writtenCoplaRole").value,
    notes: $("#writtenCoplaNotes").value.trim(),
  }));
  saveDraft(draft);
  state.pieceEntryModal = "";
  state.pieceNotice = "Copla escrita engadida ao borrador.";
  renderPiecesView();
}

function territoryIdFromImportedValue(value) {
  if (!value) return "";
  const direct = state.territorios.find(item => item.id === value);
  if (direct) return direct.id;
  const normalized = normalizeText(value);
  const exact = state.territorios.filter(item => normalizeText(item.nome) === normalized);
  return exact.length === 1 ? exact[0].id : "";
}

function normalizeImportedPiece(source, fallbackTitle = "Peza importada") {
  const piece = source?.pieces?.[0] || source;
  if (!piece || typeof piece !== "object") throw new Error("O ficheiro non contén unha peza válida.");
  let rawSections = Array.isArray(piece.sections) ? piece.sections : [];
  if (!rawSections.length && Array.isArray(piece.coplas)) {
    const grouped = new Map();
    [...piece.coplas].sort((a, b) => (a.position || 0) - (b.position || 0)).forEach(item => {
      const label = item.section_label || "Parte";
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(item);
    });
    rawSections = [...grouped].map(([label, coplas]) => ({ label, coplas }));
  }
  const sections = rawSections.map((section, sectionIndex) => ({
    id: `import-${Date.now()}-${sectionIndex}`,
    label: section.label || section.rhythm || "",
    coplas: (section.coplas || section.items || []).map(item => draftCoplaItem({
      id: item.copla_id ?? item.id,
      text: item.text || "",
      territory: item.territory || "",
      role: item.role || "copla",
      notes: item.notes || "",
    })).filter(item => item.text),
  })).filter(section => section.coplas.length);
  if (!sections.length) throw new Error("Non se atoparon coplas no ficheiro.");
  return {
    title: piece.title || piece.titulo || fallbackTitle,
    author: piece.author || piece.autoria || "",
    status: piece.status === "published" ? "published" : "draft",
    territoryId: territoryIdFromImportedValue(piece.context_territory_id || piece.territory || piece.territorio),
    sections,
  };
}

function parsePieceTxt(text, filename) {
  const normalizedText = text.replace(/\r\n?/g, "\n").trim();
  if (!normalizedText) throw new Error("O ficheiro TXT está baleiro.");
  const metadata = {};
  const bodyLines = [];
  for (const line of normalizedText.split("\n")) {
    const match = line.match(/^\s*(t[ií]tulo|autor[ií]a|territorio)\s*:\s*(.+)\s*$/i);
    if (match) metadata[normalizeText(match[1])] = match[2].trim();
    else bodyLines.push(line);
  }
  const sections = [];
  let current = { label: "", coplas: [] };
  const rhythmByName = new Map(RHYTHMS.map(rhythm => [normalizeText(rhythm), rhythm]));
  for (const block of bodyLines.join("\n").split(/\n\s*\n+/).map(value => value.trim()).filter(Boolean)) {
    const rhythm = rhythmByName.get(normalizeText(block));
    if (rhythm) {
      if (current.coplas.length) sections.push(current);
      current = { label: rhythm, coplas: [] };
      continue;
    }
    const bracketVolta = block.startsWith(">") && block.endsWith("<");
    const prefixVolta = /^retrouso\s*:/i.test(block);
    const isRefrain = bracketVolta || prefixVolta;
    let coplaText = block;
    if (bracketVolta) coplaText = block.slice(1, -1).trim();
    else if (prefixVolta) coplaText = block.replace(/^retrouso\s*:\s*/i, "").trim();
    current.coplas.push({ text: coplaText, role: isRefrain ? "retrouso" : "copla" });
  }
  if (current.coplas.length) sections.push(current);
  const fallbackTitle = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return normalizeImportedPiece({
    title: metadata.titulo || fallbackTitle,
    author: metadata.autoria || "",
    territory: metadata.territorio || "",
    sections,
  }, fallbackTitle);
}

async function importPieceFile() {
  const feedback = $("#pieceEntryFeedback");
  const file = $("#pieceImportFile")?.files?.[0];
  if (!file) {
    feedback.textContent = "Escolle primeiro un ficheiro TXT ou JSON.";
    return;
  }
  try {
    setLoading(feedback, "Preparando a peza");
    const text = await file.text();
    const draft = file.name.toLowerCase().endsWith(".json")
      ? normalizeImportedPiece(JSON.parse(text), file.name.replace(/\.[^.]+$/, ""))
      : parsePieceTxt(text, file.name);
    saveDraft(draft);
    state.pieceEntryModal = "";
    state.pieceNotice = `Peza importada desde ${file.name}. Revisa a estrutura antes de gardar.`;
    if (draft.territoryId) state.selectedTerritory = state.territorios.find(item => item.id === draft.territoryId) || state.selectedTerritory;
    renderPiecesView();
  } catch (error) {
    feedback.textContent = error instanceof SyntaxError ? "O JSON non ten un formato válido." : error.message;
    feedback.classList.add("is-error");
  }
}

function downloadPieceTxtTemplate() {
  const template = `Título: Peza de exemplo\nAutoría: Nome da persoa creadora\nTerritorio: Pazos de Borbén\n\nXota\n\nPrimeiro verso\nSegundo verso\nTerceiro verso\nCuarto verso\n\n>Ai, la la, la\nai, la la, la<\n\nMuiñeira\n\nPrimeiro verso da muiñeira\nSegundo verso\nTerceiro verso\nCuarto verso`;
  downloadText("fol-e-ar-modelo-peza.txt", template);
}

function downloadPieceJsonTemplate() {
  const template = {
    title: "Peza de exemplo",
    author: "Nome da persoa creadora",
    territory: "Pazos de Borbén",
    sections: [
      { label: "Xota", coplas: [{ text: "Primeiro verso\nSegundo verso\nTerceiro verso\nCuarto verso", role: "copla" }, { text: "Ai, la la, la\nai, la la, la", role: "retrouso" }] },
      { label: "Muiñeira", coplas: [{ text: "Primeiro verso\nSegundo verso\nTerceiro verso\nCuarto verso", role: "copla" }] },
    ],
  };
  downloadText("fol-e-ar-modelo-peza.json", JSON.stringify(template, null, 2), "application/json");
}

function workshopPartsMarkup(draft, rhythmOptions) {
  return draft.sections.map((section, index) => `
    <article class="builder-section" data-section-id="${section.id}">
      <div class="section-line">
        <select class="part-rhythm" data-section-label="${section.id}" aria-label="Ritmo da parte ${index + 1}">${rhythmOptions}</select>
        <span class="part-actions">
          <button class="icon-btn" type="button" data-add-to-section="${section.id}" aria-label="Engadir copla a esta parte">${uiIcon("plus")}</button>
          ${draft.sections.length > 1 ? `<button class="icon-btn icon-trash" type="button" data-remove-section="${section.id}" aria-label="Eliminar parte">${uiIcon("trash")}</button>` : ""}
        </span>
      </div>
      <div class="sequence-list" data-drop-section="${section.id}">
        ${section.coplas.map(item => {
          const uid = escapeHtml(item.uid || item.id);
          const isVolta = (item.role || "copla") === "retrouso";
          const rows = Math.max(2, String(item.text || "").split("\n").length);
          return `
          <article class="seq-item ${isVolta ? "is-retrouso" : ""}" draggable="true" data-drag-copla="${uid}" data-section="${section.id}">
            <div class="drag" aria-hidden="true">${uiIcon("grip", 16)}</div>
            <div class="seq-body">
              <textarea class="seq-edit-text" rows="${rows}" data-edit-item="${uid}" aria-label="Texto usado nesta peza (non altera a copla orixinal)" placeholder="${escapeHtml(item.incipit || "Copla sen texto")}">${escapeHtml(item.text || "")}</textarea>
              ${item.territory ? `<div class="meta"><span class="tag place">${escapeHtml(item.territory)}</span></div>` : ""}
            </div>
            <div class="seq-tools">
              <select aria-label="Tipo textual" data-item-role="${uid}">
                <option value="copla" ${!isVolta ? "selected" : ""}>Copla</option>
                <option value="retrouso" ${isVolta ? "selected" : ""}>Volta</option>
              </select>
              <button class="icon-btn" type="button" data-remove-cart="${uid}" aria-label="Quitar da peza">${uiIcon("close", 16)}</button>
            </div>
          </article>`;
        }).join("") || `<button class="drop-empty" type="button" data-add-to-section="${section.id}">${uiIcon("plus", 16)} Engadir copla</button>`}
      </div>
    </article>
  `).join("");
}

function workshopLibraryMarkup(library, draft) {
  const target = draft.sections.find(item => item.id === state.pieceAddTarget);
  const targetIndex = draft.sections.indexOf(target);
  const targetName = target ? (target.label || `Parte ${targetIndex + 1}`) : "";
  return `
    <aside class="library-sheet" aria-label="Repertorio">
      <div class="library-sheet-head">
        <div class="searchbox"><input id="pieceSearch" type="search" value="${escapeHtml(state.pieceLibraryQuery)}" placeholder="Buscar coplas${targetName ? ` para ${escapeHtml(targetName)}` : ""}…" aria-label="Buscar coplas para engadir"></div>
        <button class="icon-btn" type="button" id="closePieceLibrary" aria-label="Pechar repertorio">${uiIcon("close")}</button>
      </div>
      <div class="library-sheet-count"><span id="pieceLibraryCount">${library.length} coplas</span></div>
      <div id="pieceLibraryList" class="library-list">
        ${library.map(copla => `
          <article class="mini-copla">
            <h3>${escapeHtml(coplaTitle(copla))}</h3>
            <p>${nl2br(restOfText(copla.text || ""))}</p>
            <div class="mini-bottom">
              <span class="tag place">${escapeHtml(coplaPlaceLabel(copla))}</span>
              ${copla.is_volta ? `<span class="tag is-volta">Volta</span>` : ""}
              <button class="mini-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir á peza">${uiIcon("plus", 16)}</button>
            </div>
          </article>
        `).join("") || `<p class="muted">Sen coplas no repertorio.</p>`}
      </div>
    </aside>`;
}

function workshopAddMenuMarkup(draft) {
  const target = draft.sections.find(item => item.id === state.pieceAddTarget);
  const targetName = target ? (target.label || `Parte ${draft.sections.indexOf(target) + 1}`) : "";
  return `
    <div class="add-menu-backdrop" data-close-add-menu></div>
    <div class="add-menu" role="menu" aria-label="Engadir á peza">
      ${targetName ? `<div class="add-menu-target">${escapeHtml(targetName)}</div>` : ""}
      <button type="button" role="menuitem" id="focusPieceLibrary">${uiIcon("book")}<span>Do repertorio</span></button>
      <button type="button" role="menuitem" id="openPieceWriter">${uiIcon("pen")}<span>Escribir copla</span></button>
      <button type="button" role="menuitem" id="openPieceImport">${uiIcon("file")}<span>Importar ficheiro</span></button>
    </div>`;
}

function pieceScopeMarkup() {
  const info = authInfo();
  if (isAccount()) {
    const mine = state.pezas.filter(piece => piece.mine).length;
    return `
      <div class="territory-tabs piece-scope" role="tablist" aria-label="Que pezas ver">
        <button type="button" class="${state.pieceScope !== "mine" ? "active" : ""}" data-piece-scope="all">Todas</button>
        <button type="button" class="${state.pieceScope === "mine" ? "active" : ""}" data-piece-scope="mine">As miñas (${mine})</button>
      </div>`;
  }
  if (isGoogleMode() && info.ready) {
    return `<p class="piece-login-note muted">Para gardar as túas pezas (privadas ou na biblioteca) e velas no teu perfil, <a href="${escapeHtml(loginLink())}" id="pieceLoginToSave">entra con Google</a>. Podes compoñelas sen conta; para exportalas en PDF tamén tes que entrar.</p>`;
  }
  return "";
}

function pieceEmptyMarkup() {
  if (state.pieceScope === "mine" && isAccount()) {
    return `<article class="panel empty-panel"><p class="muted">Aínda non gardaches ningunha peza. Compón unha no obradoiro e gárdaa: será privada ata que decidas publicala.</p><p><button class="btn primary" type="button" id="pieceGoWorkshop">Ir ao obradoiro</button></p></article>`;
  }
  return `<article class="panel empty-panel"><p class="muted">Sen pezas gardadas.</p></article>`;
}

// --- Recursos ligados a unha peza ---------------------------------------------
// Cada recurso é unha entrada de Media (pública ou privada segundo a peza). O formulario é o
// mesmo que o de «Novo recurso»: URL + «Obter datos» le título, plataforma, tipo, fonte...

const RESOURCE_KINDS = ["youtube", "spotify", "soundcloud", "audio", "video", "image", "pdf", "web"];
const MAX_PIECE_RESOURCES = 10;

function resourceFormMarkup(prefix) {
  return `
    <div class="resource-form" data-resource-form="${prefix}">
      <div class="input-action">
        <input id="${prefix}Url" type="url" placeholder="https://... (YouTube, Spotify, audio, web...)" aria-label="URL do recurso" autocomplete="off">
        <button class="btn" type="button" id="${prefix}Fetch">Obter datos</button>
      </div>
      <div class="resource-fields">
        <label class="field"><span>Título</span><input id="${prefix}Title" type="text" maxlength="120" placeholder="Intérprete - tema, gravación do grupo..."></label>
        <label class="field"><span>Tipo</span><select id="${prefix}Kind">${RESOURCE_KINDS.map(value => `<option value="${value}">${escapeHtml(mediaLabel(value))}</option>`).join("")}</select></label>
        <label class="field"><span>Uso no arquivo</span><select id="${prefix}Role"><option value="documental">Media documental</option><option value="melody">Melodía / recurso musical</option><option value="mixed">Ambas cousas</option></select></label>
        <label class="field"><span>Fonte ou autoría</span><input id="${prefix}Source" type="text" maxlength="160" placeholder="Canle, intérprete, arquivo..."></label>
      </div>
      <input id="${prefix}Thumb" type="hidden">
      <input id="${prefix}Desc" type="hidden">
      <div id="${prefix}Preview" class="resource-preview" hidden></div>
      <p id="${prefix}Feedback" class="muted resource-feedback" role="status"></p>
    </div>`;
}

function resourceEls(prefix, root = document) {
  const q = suffix => $(`#${prefix}${suffix}`, root);
  return { url: q("Url"), title: q("Title"), kind: q("Kind"), role: q("Role"), source: q("Source"), thumb: q("Thumb"), desc: q("Desc"), preview: q("Preview"), feedback: q("Feedback"), fetch: q("Fetch") };
}

function paintResourcePreview(els) {
  if (!els.preview) return;
  const url = els.url.value.trim();
  const thumb = safeUrl(els.thumb.value);
  const desc = els.desc.value.trim();
  if (!url || (!thumb && !desc && !els.title.value.trim())) { els.preview.hidden = true; els.preview.innerHTML = ""; return; }
  els.preview.hidden = false;
  els.preview.innerHTML = `${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : ""}<div><strong>${escapeHtml(els.title.value.trim() || "Sen título")}</strong><span>${escapeHtml(mediaLabel(els.kind.value))}${els.source.value.trim() ? ` \\ ${escapeHtml(els.source.value.trim())}` : ""}</span>${desc ? `<small>${escapeHtml(desc.slice(0, 160))}</small>` : ""}</div>`;
}

async function fetchResourceMeta(prefix, root = document, { silent = false } = {}) {
  const els = resourceEls(prefix, root);
  const url = els.url?.value.trim();
  if (!url) {
    if (!silent && els.feedback) els.feedback.textContent = "Pega primeiro unha URL.";
    return;
  }
  if (!safeUrl(url)) {
    if (!silent && els.feedback) els.feedback.textContent = "Escribe unha URL completa que empece por http:// ou https://.";
    return;
  }
  const kind = mediaKind({ url });
  if (kind !== "web" && kind !== "media") els.kind.value = kind;
  if (els.feedback && !silent) setLoading(els.feedback, "Lendo metadatos da ligazón");
  if (els.fetch) els.fetch.disabled = true;
  try {
    const response = await fetch(`../api/link-preview?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Non se puideron ler metadatos.");
    if (result.title && !els.title.value.trim()) els.title.value = String(result.title).slice(0, 120);
    if (result.description && !els.desc.value.trim()) els.desc.value = String(result.description).slice(0, 500);
    if (result.thumbnail_url && !els.thumb.value.trim()) els.thumb.value = result.thumbnail_url;
    if (!els.source.value.trim()) els.source.value = String(result.author_or_source || result.provider || "").slice(0, 160);
    if (MUSICAL_MEDIA_KINDS.has(els.kind.value)) els.role.value = "mixed";
    if (els.feedback) els.feedback.textContent = "Datos incorporados. Revísaos antes de engadir.";
  } catch (error) {
    if (els.feedback && !silent) els.feedback.textContent = `${error.message} Podes completar os campos a man.`;
  } finally {
    if (els.fetch) els.fetch.disabled = false;
  }
  paintResourcePreview(els);
}

function bindResourceForm(prefix, root = document, { onEnter } = {}) {
  const els = resourceEls(prefix, root);
  if (!els.url) return;
  els.fetch?.addEventListener("click", () => fetchResourceMeta(prefix, root));
  els.url.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (els.title.value.trim() && onEnter) onEnter(); else fetchResourceMeta(prefix, root);
  });
  els.url.addEventListener("input", () => {
    const kind = mediaKind({ url: els.url.value.trim() });
    if (kind !== "web" && kind !== "media") els.kind.value = kind;
  });
  els.url.addEventListener("blur", () => {
    if (els.url.value.trim() && !els.title.value.trim()) fetchResourceMeta(prefix, root, { silent: true });
  });
  [els.title, els.source, els.kind].forEach(node => node.addEventListener("change", () => paintResourcePreview(els)));
}

// Le o formulario: devolve o recurso listo para gardar ou null (con aviso no formulario).
function readResourceForm(prefix, root = document) {
  const els = resourceEls(prefix, root);
  const href = safeUrl(els.url?.value.trim());
  if (!href) {
    if (els.feedback) els.feedback.textContent = "Escribe unha URL completa que empece por http:// ou https://.";
    return null;
  }
  const kind = RESOURCE_KINDS.includes(els.kind.value) ? els.kind.value : mediaKind({ url: href });
  return {
    title: (els.title.value.trim() || new URL(href).hostname.replace(/^www\./, "")).slice(0, 120),
    url: href,
    media_kind: kind,
    role: ["documental", "melody", "mixed"].includes(els.role.value) ? els.role.value : "documental",
    author_or_source: els.source.value.trim().slice(0, 160) || null,
    description: els.desc.value.trim().slice(0, 500) || null,
    thumbnail_url: safeUrl(els.thumb.value) || null,
  };
}

// Forma que viaxa ao servidor (e que se garda no borrador do obradoiro).
function cleanResource(link) {
  const href = safeUrl(link.url);
  return {
    title: String(link.title || (href ? new URL(href).hostname.replace(/^www\./, "") : "")).slice(0, 120),
    url: href || String(link.url || ""),
    media_kind: RESOURCE_KINDS.includes(link.media_kind) ? link.media_kind : mediaKind({ url: link.url }),
    role: ["documental", "melody", "mixed"].includes(link.role) ? link.role : "documental",
    author_or_source: link.author_or_source || null,
    description: link.description || null,
    thumbnail_url: link.thumbnail_url || null,
  };
}

function resourceChipMarkup(link, index, attr) {
  const item = cleanResource(link);
  return `<div class="workshop-link-item">
    <span class="resource-chip-kind">${mediaKindIconSvg(mediaKind(item))}<span>${escapeHtml(mediaLabel(item.media_kind))}</span></span>
    <span class="resource-chip-main"><a href="${escapeHtml(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a><small>${escapeHtml(mediaRoleLabel(item.role))}${item.author_or_source ? ` \\ ${escapeHtml(item.author_or_source)}` : ""}</small></span>
    <button type="button" class="btn" ${attr}="${index}" aria-label="Quitar ${escapeHtml(item.title)}">Quitar</button>
  </div>`;
}

function workshopLinksMarkup(draft) {
  if (!isAccount()) return "";
  const links = draft.links || [];
  return `
    <details class="workshop-links resources-fold" id="workshopLinks" ${state.resourcesOpen ? "open" : ""}>
      <summary><span>Recursos ligados${links.length ? ` (${links.length})` : ""}</span><small>opcional: gravación, vídeo, partitura...</small></summary>
      <p class="muted workshop-links-note">Van a Media, ligados á peza, ao seu territorio e ás súas coplas: públicos se a peza é pública e privados (só os ves ti) se a gardas privada.</p>
      ${links.map((link, index) => resourceChipMarkup(link, index, "data-remove-piece-link")).join("")}
      ${links.length < MAX_PIECE_RESOURCES ? `
      ${resourceFormMarkup("pl")}
      <div><button class="btn" type="button" id="addPieceLink">Engadir recurso</button></div>` : `<p class="muted">Máximo de ${MAX_PIECE_RESOURCES} recursos por peza.</p>`}
    </details>`;
}

// Os formularios de recursos van pregados; lémbrase se a persoa os abriu para non pechalos ao redibuxar.
function bindResourceFolds(root) {
  all(".resources-fold", root).forEach(fold => fold.addEventListener("toggle", () => { if (fold.dataset.fold === "drawer") state.drawerResourcesOpen = fold.open; else state.resourcesOpen = fold.open; }));
}

function addPieceLink() {
  const link = readResourceForm("pl");
  if (!link) return;
  const draft = loadDraft();
  draft.links = draft.links || [];
  if (draft.links.length >= MAX_PIECE_RESOURCES) return;
  if (!draft.links.some(item => item.url === link.url)) draft.links.push(link);
  state.resourcesOpen = true;
  saveDraft(draft);
  renderPiecesView();
}

function workshopNoticeMarkup(draft) {
  if (!isGoogleMode() || !authInfo().ready) return "";
  if (!isAccount()) {
    return `
      <div class="workshop-notice" role="note">
        <div><strong>Estás compoñendo sen conta</strong>
        <span>Podes escribir a peza e exportala en PDF. Para gardala e velá na túa biblioteca e no teu perfil, entra con Google: o borrador non se perde.</span></div>
        <a class="btn primary" id="pieceLoginToSave" href="${escapeHtml(loginLink())}">Entrar con Google</a>
      </div>`;
  }
  if (draft.editingPieceId) {
    return `
      <div class="workshop-notice is-editing" role="note">
        <div><strong>Editando unha peza gardada</strong>
        <span>Ao gardar actualízase a peza existente (ao gardar podes escoller facer unha copia).</span></div>
        <button class="btn" type="button" id="stopEditingPiece">Empezar unha peza nova</button>
      </div>`;
  }
  return `
    <div class="workshop-notice" role="note">
      <div><strong>A túa peza gárdase na túa conta</strong>
      <span>Ao gardar escolles se é privada (só ti) ou se aparece na biblioteca pública.</span></div>
    </div>`;
}

function rememberWorkshopForLogin() {
  storageSet(RESUME_KEY, "pieces-workshop");
}

function renderPiecesView() {
  const view = $("#view-pieces");
  const keepScrollY = window.scrollY;
  const keepListScroll = $("#pieceLibraryList", view)?.scrollTop || 0;
  const draft = loadDraft();
  const library = filteredPieceLibrary();
  const repo = filteredPieceRepository();
  const total = draftCount(draft);
  const territory = pieceTerritory();
  const rhythmOptions = `<option value="">Ritmo…</option>${RHYTHMS.map(value => `<option value="${value}">${value}</option>`).join("")}`;
  const workshop = state.pieceTab === "workshop";
  view.innerHTML = `
    <div class="page ${workshop ? "workshop-page" : ""} ${workshop && state.pieceLibraryOpen ? "has-sheet" : ""}">
      <div class="page-head piece-head">
        <h1 class="visually-hidden">Pezas</h1>
        <div class="section-tabs piece-tabs">
          <button class="${state.pieceTab === "library" ? "active" : ""}" type="button" data-piece-tab="library">Biblioteca</button>
          <button class="${state.pieceTab === "workshop" ? "active" : ""}" type="button" data-piece-tab="workshop">Obradoiro <b class="cart-count" data-cart-count ${total ? "" : "hidden"}>${total}</b></button>
        </div>
        ${workshop ? `
          <div class="header-actions">
            <button class="btn" type="button" id="clearPiece">Baleirar</button>
            <button class="btn" type="button" id="savePieceDirect">${draft.editingPieceId && isAccount() ? "Gardar cambios" : "Gardar peza"}</button>
            <button class="btn primary" type="button" id="openA4" ${state.pdfBusy ? "disabled" : ""}>${state.pdfBusy ? loaderHtml("Xerando PDF") : "Exportar PDF"}</button>
          </div>
        ` : ""}
      </div>
      ${state.pieceTab === "library" ? `
        ${authorFichaMarkup()}
        <section class="panel piece-repository">
          <div class="section-title"><h2>${state.pieceAuthorFilter ? "Pezas desta autoría" : state.pieceScope === "mine" && isAccount() ? "As miñas pezas" : "Pezas gardadas"}</h2><span id="pieceRepositoryCount" class="muted">${repo.length} pezas</span></div>
          ${pieceScopeMarkup()}
          <div class="toolbar piece-filters">
            <div class="searchbox"><span>⌕</span><input id="pieceRepositorySearch" type="search" value="${escapeHtml(state.pieceRepositoryQuery)}" placeholder="Buscar por título, creador ou contexto..."></div>
            <select id="pieceRhythmFilter" aria-label="Filtrar por ritmo">
              <option value="">Todos os ritmos</option>
              ${RHYTHMS.map(value => `<option value="${value}" ${state.pieceRhythmQuery === value ? "selected" : ""}>${value}</option>`).join("")}
            </select>
            ${authorDirectory().length ? `<div class="searchbox author-search"><span>♪</span><input id="pieceAuthorSearch" type="search" placeholder="Buscar autoría..." aria-label="Buscar unha autoría"></div>` : ""}
            ${listViewToggleMarkup("data-piece-view", state.pieceViewMode)}
          </div>
          ${state.pieceAuthorFilter ? "" : authorStripMarkup()}
          <div id="pieceRepositoryList" class="${pieceListClass()}">
            ${pieceItemsMarkup(repo)}
          </div>
        </section>
      ` : `
        ${workshopNoticeMarkup(draft)}
        <div id="pieceExportStatus" class="export-status" role="status" aria-live="polite">${escapeHtml(state.pieceNotice)}</div>
        <section class="workshop">
          <header class="workshop-head">
            <input id="pieceTitle" class="workshop-title" type="text" value="${escapeHtml(draft.title || "")}" placeholder="${escapeHtml(territoryContextTitle(territory) || "Título da peza")}" aria-label="Título da peza">
            <div class="workshop-meta">
              <input id="pieceAuthor" class="workshop-author" type="text" value="${escapeHtml(draft.author || "")}" placeholder="Autoría (grupo, artista, ti...)" aria-label="Autoría" maxlength="120">
              ${territory
                ? `<button class="chip-btn" type="button" id="clearPieceTerritory" aria-label="Quitar territorio ${escapeHtml(territory.nome)}"><span>${escapeHtml(territory.nome)}</span>${uiIcon("close", 14)}</button>`
                : `<div class="searchbox workshop-territory"><input id="pieceTerritorySearch" type="search" value="${escapeHtml(state.pieceTerritoryQuery)}" placeholder="Territorio…" aria-label="Centrar peza nun territorio"></div>`}
              <input id="pieceLugar" class="workshop-author workshop-lugar" type="text" list="pieceLugarList" maxlength="80" value="${escapeHtml(draft.lugar || "")}" placeholder="Lugar (ex.: Laxoso)" aria-label="Lugar dentro da parroquia" title="Lugar dentro da parroquia, se o coñeces (ex.: Laxoso)" autocomplete="off">
              <datalist id="pieceLugarList">${territory ? lugarOptionsMarkup([territory.id]) : ""}</datalist>
            </div>
            <div id="pieceTerritoryResults" class="territory-results compact"></div>
            <textarea id="pieceNotes" class="workshop-notes" rows="1" placeholder="Notas para imprimir…" aria-label="Notas da peza">${escapeHtml(draft.notes || "")}</textarea>
          </header>
          <div class="builder-sections">
            ${workshopPartsMarkup(draft, rhythmOptions)}
          </div>
          <button class="add-part" type="button" id="addSection">${uiIcon("plus", 16)} Parte</button>
          ${workshopLinksMarkup(draft)}
        </section>
        <div class="add-fab">
          <button class="fab" type="button" id="pieceAddToggle" aria-expanded="${state.pieceAddMenu ? "true" : "false"}">${uiIcon("plus")}<span>Engadir</span></button>
        </div>
        ${state.pieceAddMenu ? workshopAddMenuMarkup(draft) : ""}
        ${state.pieceLibraryOpen ? workshopLibraryMarkup(library, draft) : ""}
        ${pieceEntryModalMarkup(draft)}
      `}
    </div>
  `;
  if (workshop) {
    window.scrollTo(0, keepScrollY);
    const list = $("#pieceLibraryList", view);
    if (list) list.scrollTop = keepListScroll;
  }
  all("[data-piece-tab]", view).forEach(button => button.addEventListener("click", () => {
    state.pieceTab = button.dataset.pieceTab;
    state.pieceAddMenu = false;
    state.pieceLibraryOpen = false;
    renderPiecesView();
  }));
  draft.sections.forEach(section => {
    const select = $(`[data-section-label="${section.id}"]`, view);
    if (select) select.value = section.label;
  });
  $("#pieceSearch")?.addEventListener("input", event => {
    state.pieceLibraryQuery = event.target.value;
    updatePieceLibrary(view);
  });
  $("#pieceRepositorySearch")?.addEventListener("input", event => {
    state.pieceRepositoryQuery = event.target.value;
    updatePieceRepository(view);
  });
  all("[data-piece-view]", view).forEach(button => button.addEventListener("click", () => {
    state.pieceViewMode = button.dataset.pieceView;
    saveViewPref("pieces", state.pieceViewMode);
    all("[data-piece-view]", view).forEach(item => item.classList.toggle("active", item === button));
    updatePieceRepository(view);
  }));
  window.folearAuthorBox?.attach($("#pieceAuthorSearch", view), { items: authorEntries, onPick: openAuthor, free: false });
  $("#authorDirectoryOpen")?.addEventListener("click", () => window.folearAuthorBox?.openDirectory({ items: authorEntries, onPick: openAuthor }));
  $("#pieceRhythmFilter")?.addEventListener("change", event => {
    state.pieceRhythmQuery = event.target.value;
    updatePieceRepository(view);
  });
  bindPieceCardActions(view);
  $("#clearPieceAuthorFilter")?.addEventListener("click", closeAuthor);
  all("[data-piece-scope]", view).forEach(button => button.addEventListener("click", () => {
    state.pieceScope = button.dataset.pieceScope;
    renderPiecesView();
  }));
  $("#pieceGoWorkshop")?.addEventListener("click", () => {
    state.pieceTab = "workshop";
    renderPiecesView();
  });
  $("#stopEditingPiece")?.addEventListener("click", () => {
    saveDraft(defaultDraft());
    state.pieceNotice = "";
    renderPiecesView();
  });
  $("#pieceLoginToSave")?.addEventListener("click", rememberWorkshopForLogin);
  $("#pieceTerritorySearch")?.addEventListener("input", event => {
    state.pieceTerritoryQuery = event.target.value;
    renderPieceTerritoryResults(view);
  });
  $("#clearPieceTerritory")?.addEventListener("click", () => {
    const next = loadDraft();
    next.territoryId = "";
    saveDraft(next);
    state.selectedTerritory = null;
    state.pieceTerritoryQuery = "";
    renderPiecesView();
  });
  $("#pieceTitle")?.addEventListener("input", event => saveDraft({ ...loadDraft(), title: event.target.value }));
  $("#pieceAuthor")?.addEventListener("input", event => saveDraft({ ...loadDraft(), author: event.target.value }));
  $("#pieceLugar")?.addEventListener("input", event => saveDraft({ ...loadDraft(), lugar: event.target.value }));
  window.folearAuthorBox?.attach($("#pieceAuthor", view), { items: authorEntries, free: true });
  $("#pieceNotes")?.addEventListener("input", event => saveDraft({ ...loadDraft(), notes: event.target.value }));
  $("#pieceAddToggle")?.addEventListener("click", () => {
    state.pieceAddMenu = !state.pieceAddMenu;
    if (state.pieceAddMenu) state.pieceAddTarget = "";
    renderPiecesView();
  });
  all("[data-add-to-section]", view).forEach(button => button.addEventListener("click", () => {
    state.pieceAddTarget = button.dataset.addToSection;
    state.pieceAddMenu = true;
    renderPiecesView();
  }));
  all("[data-close-add-menu]", view).forEach(item => item.addEventListener("click", () => {
    state.pieceAddMenu = false;
    renderPiecesView();
  }));
  $("#focusPieceLibrary")?.addEventListener("click", () => {
    state.pieceAddMenu = false;
    state.pieceLibraryOpen = true;
    renderPiecesView();
    $("#pieceSearch")?.focus();
  });
  $("#closePieceLibrary")?.addEventListener("click", () => {
    state.pieceLibraryOpen = false;
    state.pieceAddTarget = "";
    renderPiecesView();
  });
  $("#openPieceWriter")?.addEventListener("click", () => { state.pieceAddMenu = false; openPieceEntryModal("write"); });
  $("#openPieceImport")?.addEventListener("click", () => { state.pieceAddMenu = false; openPieceEntryModal("import"); });
  all("[data-close-piece-entry]", view).forEach(button => button.addEventListener("click", closePieceEntryModal));
  $("#addWrittenCopla")?.addEventListener("click", addWrittenCopla);
  $("#writtenCoplaSection")?.addEventListener("change", event => {
    if ($("#writtenNewSectionFields")) $("#writtenNewSectionFields").hidden = event.target.value !== "new";
  });
  $("#pieceImportFile")?.addEventListener("change", event => {
    const filename = event.target.files?.[0]?.name || "Ningún ficheiro seleccionado";
    if ($("#pieceImportFilename")) $("#pieceImportFilename").textContent = filename;
  });
  $("#importPieceFile")?.addEventListener("click", importPieceFile);
  $("#downloadPieceTxtTemplate")?.addEventListener("click", downloadPieceTxtTemplate);
  $("#downloadPieceJsonTemplate")?.addEventListener("click", downloadPieceJsonTemplate);
  $("#addSection")?.addEventListener("click", () => {
    const next = loadDraft();
    next.sections.push({ id: `section-${Date.now()}`, label: "", coplas: [] });
    saveDraft(next);
    renderPiecesView();
  });
  $("#clearPiece")?.addEventListener("click", () => {
    saveDraft(defaultDraft());
    renderPiecesView();
  });
  $("#savePieceDirect")?.addEventListener("click", savePieceDirect);
  $("#addPieceLink")?.addEventListener("click", addPieceLink);
  bindResourceFolds(view);
  bindResourceForm("pl", view, { onEnter: addPieceLink });
  all("[data-remove-piece-link]", view).forEach(button => button.addEventListener("click", () => {
    const next = loadDraft();
    next.links = (next.links || []).filter((_, index) => index !== Number(button.dataset.removePieceLink));
    saveDraft(next);
    renderPiecesView();
  }));
  $("#openA4")?.addEventListener("click", exportPiecePdf);
  all("[data-section-label]", view).forEach(select => select.addEventListener("change", () => {
    const next = loadDraft();
    const section = next.sections.find(item => item.id === select.dataset.sectionLabel);
    if (section) section.label = select.value;
    saveDraft(next);
    renderPiecesView();
  }));
  all("[data-remove-section]", view).forEach(button => button.addEventListener("click", () => {
    const next = loadDraft();
    if (next.sections.length > 1) next.sections = next.sections.filter(item => item.id !== button.dataset.removeSection);
    saveDraft(next);
    renderPiecesView();
  }));
  all("[data-remove-cart]", view).forEach(button => button.addEventListener("click", () => {
    const next = loadDraft();
    next.sections.forEach(section => {
      section.coplas = section.coplas.filter(item => String(item.uid || item.id) !== String(button.dataset.removeCart));
    });
    saveDraft(next);
    renderPiecesView();
  }));
  all("[data-item-role]", view).forEach(select => select.addEventListener("change", () => {
    const next = loadDraft();
    next.sections.forEach(section => {
      section.coplas.forEach(item => {
        if (String(item.uid || item.id) === String(select.dataset.itemRole)) item.role = select.value;
      });
    });
    saveDraft(next);
  }));
  all("[data-edit-item]", view).forEach(textarea => {
    textarea.addEventListener("input", () => {
      const next = loadDraft();
      next.sections.forEach(section => {
        section.coplas.forEach(item => {
          if (String(item.uid || item.id) === String(textarea.dataset.editItem)) item.text = textarea.value;
        });
      });
      saveDraft(next);
    });
  });
  fitTextareas(view);
  bindCoplaActions(view);
  bindPieceDrag(view);
}

function fitTextareas(root) {
  all(".seq-edit-text, .workshop-notes", root).forEach(area => {
    const fit = () => {
      if (!area.scrollHeight) return;
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };
    fit();
    area.addEventListener("input", fit);
  });
}

function moveDraftCopla(coplaUid, targetSectionId, beforeCoplaUid = null) {
  const draft = loadDraft();
  let moving = null;
  draft.sections.forEach(section => {
    const index = section.coplas.findIndex(item => String(item.uid || item.id) === String(coplaUid));
    if (index >= 0) [moving] = section.coplas.splice(index, 1);
  });
  if (!moving) return;
  const target = draft.sections.find(section => section.id === targetSectionId) || draft.sections[0];
  const beforeIndex = beforeCoplaUid ? target.coplas.findIndex(item => String(item.uid || item.id) === String(beforeCoplaUid)) : -1;
  if (beforeIndex >= 0) target.coplas.splice(beforeIndex, 0, moving);
  else target.coplas.push(moving);
  saveDraft(draft);
  renderPiecesView();
}

function bindPieceDrag(root) {
  all("[data-drag-copla]", root).forEach(card => {
    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", card.dataset.dragCopla);
      event.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      all(".drop-before, .drop-after", root).forEach(item => item.classList.remove("drop-before", "drop-after"));
    });
    card.addEventListener("dragover", event => {
      event.preventDefault();
      const box = card.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      card.classList.toggle("drop-before", !after);
      card.classList.toggle("drop-after", after);
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
    card.addEventListener("drop", event => {
      event.preventDefault();
      const coplaUid = event.dataTransfer.getData("text/plain");
      if (!coplaUid || String(coplaUid) === String(card.dataset.dragCopla)) return;
      const box = card.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      const nextCard = after ? card.nextElementSibling?.closest?.("[data-drag-copla]") : card;
      moveDraftCopla(coplaUid, card.dataset.section, nextCard?.dataset.dragCopla || null);
    });
  });
  all("[data-drop-section]", root).forEach(stack => {
    stack.addEventListener("dragover", event => {
      event.preventDefault();
      stack.classList.add("drop-target");
    });
    stack.addEventListener("dragleave", () => stack.classList.remove("drop-target"));
    stack.addEventListener("drop", event => {
      event.preventDefault();
      stack.classList.remove("drop-target");
      const coplaUid = event.dataTransfer.getData("text/plain");
      if (coplaUid) moveDraftCopla(coplaUid, stack.dataset.dropSection);
    });
  });
}

function buildPiecePayload() {
  const draft = loadDraft();
  let position = 0;
  return {
    title: draft.title || "Peza sen título",
    slug: slugify(draft.title || "peza"),
    author: draft.author || "Sen autoría",
    context_territory_id: draft.territoryId || state.selectedTerritory?.id || null,
    sections: draft.sections.map(section => ({
      label: section.label || "Parte",
      coplas: section.coplas.map(copla => {
        position += 1;
        const numericId = Number(copla.id);
        return {
          copla_id: Number.isInteger(numericId) && numericId > 0 ? numericId : null,
          text: copla.text || "",
          incipit: copla.incipit || firstLine(copla.text),
          territory: copla.territory || "",
          position,
          section_label: section.label || "Parte",
          role: copla.role || "copla",
        };
      }),
    })),
  };
}

function buildPieceDbPayload(overrides = {}) {
  const draft = loadDraft();
  const coplas = [];
  let position = 0;
  draft.sections.forEach(section => {
    section.coplas.forEach(copla => {
      position += 1;
      const numericId = Number(copla.id);
      const hasId = Number.isInteger(numericId) && numericId > 0;
      coplas.push({
        copla_id: hasId ? numericId : null,
        text: (copla.text || "").trim(),
        position,
        section_label: section.label || "Parte",
        role: copla.role || "copla",
        notes: copla.notes || null,
      });
    });
  });
  if (!coplas.length) {
    throw new Error("Engade polo menos unha copla á peza antes de gardala.");
  }
  const title = overrides.title || draft.title || territoryContextTitle(pieceTerritory()) || "Peza sen título";
  const author = overrides.author !== undefined ? overrides.author : draft.author;
  return {
    pieces: [{
      ...(overrides.id ? { id: overrides.id } : {}),
      ...(isAccount() ? { links: (draft.links || []).map(cleanResource) } : {}),
      ...(overrides.visibility ? { visibility: overrides.visibility } : {}),
      title,
      slug: slugify(`${title}-${Date.now()}`),
      author: author || "Sen autoría",
      context_territory_id: draft.territoryId || state.selectedTerritory?.id || null,
      lugar: (draft.lugar || "").trim() || null,
      description: "",
      notes: draft.notes || "",
      status: "published",
      coplas,
    }],
  };
}

async function materializeDraftCoplas(draft) {
  const pending = [];
  draft.sections.forEach(section => {
    section.coplas.forEach(item => {
      const numericId = Number(item.id);
      if (!Number.isInteger(numericId) || numericId <= 0) pending.push(item);
    });
  });
  if (!pending.length) return draft;
  const territoryState = draft.territoryId ? "assigned" : "unassigned";
  const territories = draft.territoryId ? [{ id: draft.territoryId }] : [];
  const groups = new Map();
  pending.forEach(item => {
    const key = `${item.role === "retrouso" ? "v" : "c"}::${(item.text || "").trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const uniqueEntries = [...groups.entries()];
  const payload = {
    coplas: uniqueEntries.map(([, items]) => ({
      text: (items[0].text || "").trim(),
      status: "published",
      territory_state: territoryState,
      territories,
      tags: [],
      is_volta: items[0].role === "retrouso",
      ...((draft.lugar || "").trim() ? { lugar: draft.lugar.trim() } : {}),
      versions: [],
    })),
  };
  const response = await fetch("../api/coplas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Non se puideron incorporar as coplas soltas da peza á base de datos.");
  uniqueEntries.forEach(([, items], index) => {
    const newId = result.ids[index];
    items.forEach(item => { item.id = newId; });
  });
  clearApiCache();
  state.coplas = await getCoplas();
  return draft;
}

// Con login (modo google) gardar é cousa de contas: a peza queda na conta da
// persoa, privada ou pública. Sen conta só se pode compoñer o borrador.
function promptLoginToSave() {
  rememberWorkshopForLogin();
  const status = $("#pieceExportStatus");
  if (status) {
    status.classList.add("is-error");
    status.innerHTML = `Para gardar a peza precisas unha conta. O borrador non se perde. <a href="${escapeHtml(loginLink())}">Entrar con Google</a>`;
  }
  status?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

async function savePieceAsAccount() {
  const draft = loadDraft();
  if (!draftCount(draft)) {
    setExportStatus("Engade polo menos unha copla á peza antes de gardala.", true);
    return;
  }
  const suggestedTitle = draft.title || territoryContextTitle(pieceTerritory()) || "";
  const choice = window.folearProfile?.askPieceSave
    ? await window.folearProfile.askPieceSave({
      title: suggestedTitle,
      author: draft.author || "",
      visibility: draft.visibility || "private",
      editing: draft.editingPieceId ? { id: draft.editingPieceId } : null,
    })
    : { title: suggestedTitle, author: draft.author || "", visibility: "private", asCopy: false };
  if (!choice) return;
  const feedback = $("#pieceExportStatus");
  try {
    const editingId = draft.editingPieceId && !choice.asCopy ? draft.editingPieceId : null;
    const payload = buildPieceDbPayload({ id: editingId, visibility: choice.visibility, title: choice.title, author: choice.author });
    setLoading(feedback, "Gardando a peza");
    const result = await pieceApi("/pieces", "POST", payload);
    const next = loadDraft();
    next.title = choice.title;
    next.author = choice.author;
    next.visibility = choice.visibility;
    next.editingPieceId = result.ids[0];
    saveDraft(next);
    state.pieceNotice = "";
    state.pieceTab = "library";
    state.pieceScope = "mine";
    await refreshPezas({ render: false });
    renderPiecesView();
    notify(choice.visibility === "public" ? "Peza gardada e publicada na biblioteca." : "Peza gardada como privada.");
  } catch (error) {
    if (error.status === 404 && draft.editingPieceId) {
      const next = loadDraft();
      delete next.editingPieceId;
      saveDraft(next);
      setExportStatus("Non podes actualizar esa peza (xa non existe ou non é túa). Preme de novo en gardar para gardala como nova.", true);
    } else {
      setExportStatus(error.message || "Non se puido gardar a peza.", true);
    }
  }
}

async function savePieceDirect() {
  if (window.folearAuth && !window.folearAuth.ready) {
    setExportStatus("Comprobando a sesión... téntao de novo nun momento.", true);
    return;
  }
  if (isGoogleMode()) {
    if (!isAccount()) return promptLoginToSave();
    return savePieceAsAccount();
  }
  const feedback = $("#pieceExportStatus");
  try {
    let draft = loadDraft();
    const hasPending = draft.sections.some(section => section.coplas.some(item => {
      const numericId = Number(item.id);
      return !Number.isInteger(numericId) || numericId <= 0;
    }));
    if (hasPending) {
      setLoading(feedback, "Incorporando as coplas soltas á base de datos");
      draft = await materializeDraftCoplas(draft);
      saveDraft(draft);
    }
    const payload = buildPieceDbPayload();
    setLoading(feedback, "Gardando peza");
    const response = await fetch("../api/pieces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido gardar a peza.");
    if (feedback) feedback.textContent = `Peza gardada. ID: ${result.ids.join(", ")}`;
    clearApiCache();
    state.pezas = await getPezas();
    state.pieceTab = "library";
    renderPiecesView();
  } catch (error) {
    if (feedback) {
      feedback.textContent = error.message;
      feedback.classList.add("is-error");
    }
  }
}

function filenameFromResponse(response, fallback) {
  const header = response.headers.get("Content-Disposition") || "";
  const match = header.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (match?.[1]) return decodeURIComponent(match[1].replace(/"/g, ""));
  return fallback;
}

function setExportStatus(message, isError = false) {
  const status = $("#pieceExportStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function closePdfViewer() {
  const viewer = $("#pdfViewer");
  if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
  state.pdfUrl = "";
  state.pdfFilename = "";
  if (viewer) {
    viewer.hidden = true;
    viewer.innerHTML = "";
  }
}

function openPdfViewer(blob, filename) {
  closePdfViewer();
  state.pdfUrl = URL.createObjectURL(blob);
  state.pdfFilename = filename;
  const viewer = $("#pdfViewer");
  if (!viewer) return;
  viewer.innerHTML = `
    <div class="pdf-backdrop" data-close-pdf></div>
    <section class="pdf-panel" role="dialog" aria-modal="true" aria-label="Previsualización PDF">
      <header class="pdf-head">
        <div>
          <div class="eyebrow">Previsualización</div>
          <h2>${escapeHtml(filename)}</h2>
        </div>
        <button class="drawer-close" type="button" data-close-pdf aria-label="Pechar">×</button>
      </header>
      <object class="pdf-frame" data="${state.pdfUrl}" type="application/pdf" aria-label="Previsualización PDF">
        <p>Non foi posíbel previsualizar o PDF neste navegador. Podes descargalo co botón inferior.</p>
      </object>
      <footer class="pdf-actions">
        <a class="btn primary" id="downloadGeneratedPdf" href="${state.pdfUrl}" download="${escapeHtml(filename)}">Descargar PDF</a>
        <button class="btn" type="button" data-close-pdf>Pechar</button>
      </footer>
    </section>
  `;
  viewer.hidden = false;
  all("[data-close-pdf]", viewer).forEach(button => button.addEventListener("click", closePdfViewer));
}

async function exportPiecePdf() {
  if (state.pdfBusy) return;
  if (pdfNeedsLogin()) {
    rememberWorkshopForLogin();
    const status = $("#pieceExportStatus");
    if (status) {
      status.classList.add("is-error");
      status.innerHTML = `Para exportar en PDF tes que entrar con Google. O borrador non se perde. <a href="${escapeHtml(loginLink())}">Entrar con Google</a>`;
    }
    return;
  }
  const button = $("#openA4");
  state.pdfBusy = true;
  if (button) {
    button.disabled = true;
    button.innerHTML = loaderHtml("Xerando PDF");
  }
  setExportStatus("");
  try {
    const response = await fetch("../api/pdf/piece-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPiecePayload()),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).error || "";
      } catch {
        detail = await response.text();
      }
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (blob.type && blob.type !== "application/pdf") {
      throw new Error(`Resposta inesperada: ${blob.type}`);
    }
    const filename = filenameFromResponse(response, `fol-e-ar-${slugify(loadDraft().title || "peza")}.pdf`);
    openPdfViewer(blob, filename);
    setExportStatus("");
  } catch (error) {
    console.error("Erro xerando PDF", error);
    setExportStatus(pdfErrorMessage(error), true);
  } finally {
    state.pdfBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Exportar PDF";
    }
  }
}

function renderTerritorySearchResults(root = $("#view-territory")) {
  const results = $("#territorySearchResults", root);
  if (!results) return;
  const query = state.territoryQuery.trim();
  if (!query) {
    results.innerHTML = "";
    return;
  }
  const matches = searchTerritories(state.territorios, query).slice(0, 30);
  results.innerHTML = matches.map(item => `<button type="button" data-territory-id="${item.id}"><strong>${escapeHtml(item.nome)}</strong><span>${escapeHtml(territorySearchMeta(item))}</span></button>`).join("") || `<p class="muted">Sen resultados.</p>`;
  bindResultButtons(results);
}

function breadcrumbTrail(territory, ctx) {
  if (!territory) return "";
  return ctx.hierarchy.map(item => `
    <button type="button" data-territory-id="${item.id}">${escapeHtml(item.nome)}</button>
  `).join(`<span>/</span>`);
}

function updateTerritoryTabPanel(root = $("#view-territory")) {
  const panel = $("#territoryTabPanel", root);
  if (!panel) return;
  panel.innerHTML = renderTerritoryTab(state.selectedTerritory, placeContext(state.selectedTerritory));
  bindTerritoryTabs(root);
  bindResultButtons(panel);
  bindCoplaActions(panel);
  bindMediaCards(panel);
  bindTerritoryCoplaSearch(panel);
  bindTerritoryCoplaViewToggle(panel);
  bindTerritorySummaryCard(panel);
  hydrateTerritoryLists(root);
}

// Pinta (con carga progresiva) as listaxes longas da pestana aberta.
function hydrateTerritoryLists(root = $("#view-territory")) {
  const territory = state.selectedTerritory;
  if ($("#territoryCoplaList", root)) updateTerritoryCoplaResults(root);
  const mediaList = $("#territoryMediaList", root);
  if (mediaList) {
    mountInfiniteList(mediaList, territoryMediaItems(territory, placeContext(territory)), {
      key: territory ? territory.id : "galiza",
      renderItems: slice => slice.map(item => mediaCard(item)).join(""),
      bind: bindMediaCards,
      empty: `<article class="panel"><p class="muted">Aínda non hai media documental neste territorio.</p></article>`,
    });
  }
  const melodyList = $("#territoryMelodyList", root);
  if (melodyList) mountMelodyList(melodyList, placeContext(territory).melodias, territory ? territory.id : "galiza", territory?.id);
}

function bindTerritoryCoplaSearch(root = $("#view-territory")) {
  const input = $("#territoryCoplaSearch", root);
  if (!input) return;
  input.addEventListener("input", () => {
    state.territoryCoplaQuery = input.value;
    updateTerritoryCoplaResults(root);
  });
}

function bindTerritoryCoplaViewToggle(root = $("#view-territory")) {
  all("[data-copla-view]", root).forEach(button => {
    button.addEventListener("click", () => {
      state.coplaViewMode = button.dataset.coplaView;
      updateTerritoryCoplaResults(root);
    });
  });
}

function updateTerritoryCoplaResults(root = $("#view-territory")) {
  const territory = state.selectedTerritory;
  const ctx = placeContext(territory);
  const list = $("#territoryCoplaList", root);
  const count = $("#territoryCoplaCount", root);
  let items;
  if (territory) {
    const tq = normalizeText(state.territoryCoplaQuery || "");
    items = ctx.coplas.filter(copla => !tq || normalizeText(coplaHaystack(copla)).includes(tq));
    if (count) count.textContent = `${items.length} de ${ctx.coplas.length} resultados`;
  } else {
    items = ctx.coplas;
  }
  if (list) {
    list.className = `${coplaStreamClass()}${currentCoplaViewMode() === "gallery" ? " territory-copla-grid" : ""}`;
    mountCoplaList(list, items, `${territory ? territory.id : "galiza"}|${state.territoryCoplaQuery || ""}`);
  }
  all("[data-copla-view]", root).forEach(button => button.classList.toggle("active", button.dataset.coplaView === currentCoplaViewMode()));
}

function bindTerritoryTabs(root = $("#view-territory")) {
  all("[data-territory-tab]", root).forEach(button => {
    button.classList.toggle("active", button.dataset.territoryTab === state.territoryTab);
    if (button.dataset.boundTerritoryTab) return;
    button.dataset.boundTerritoryTab = "true";
    button.addEventListener("click", () => {
      state.territoryTab = button.dataset.territoryTab;
      updateTerritoryTabPanel(root);
    });
  });
}

const CHILD_LABELS = { prov: "Comarcas", com: "Concellos", con: "Parroquias" };

function territoryChildrenMarkup(territory, ctx) {
  const children = [...ctx.children].sort((a, b) => Number(territoryHasCoplas(b)) - Number(territoryHasCoplas(a)) || a.nome.localeCompare(b.nome, "gl"));
  if (!children.length) return "";
  const label = territory ? (CHILD_LABELS[territory.tipo] || "Subterritorios") : "Provincias";
  return `
    <section class="territory-children is-collapsed" id="territoryChildren" aria-label="${label}">
      <div class="territory-children-head"><span class="eyebrow">${label} \\ ${children.length}</span></div>
      <div class="chip-row">${children.map(territoryChipMarkup).join("")}</div>
      <button class="chip-more" type="button" id="toggleTerritoryChildren" aria-expanded="false" hidden></button>
    </section>
  `;
}

/* Recolle os chips en 2 filas (móbil) ou 3 (escritorio) e engade «Ver máis» só se non caben. */
function fitTerritoryChildren(root = $("#view-territory")) {
  const box = $("#territoryChildren", root);
  const row = box && $(".chip-row", box);
  const more = box && $("#toggleTerritoryChildren", box);
  if (!box || !row || !more) return;
  const open = box.dataset.open === "true";
  box.classList.add("is-collapsed");
  const limit = row.clientHeight;
  const overflow = row.scrollHeight > limit + 2;
  const hidden = overflow ? all(".chip-territory", row).filter(chip => chip.offsetTop >= limit - 4).length : 0;
  more.hidden = !overflow;
  box.classList.toggle("is-collapsed", overflow && !open);
  more.textContent = open ? "Ver menos" : `Ver máis \\ ${hidden}`;
  more.setAttribute("aria-expanded", open ? "true" : "false");
}

let childrenResizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(childrenResizeTimer);
  childrenResizeTimer = window.setTimeout(() => fitTerritoryChildren(), 120);
});

function renderTerritoryView() {
  const view = $("#view-territory");
  const territory = state.selectedTerritory;
  const query = state.territoryQuery;
  const ctx = placeContext(territory);
  const direct = territory ? ctx.coplas.filter(copla => (copla.territories || []).some(item => item.id === territory.id)).length : ctx.coplas.length;
  const tabs = [
    ["coplas", "Coplas"],
    ["pieces", "Pezas"],
    ["melodies", "Melodías"],
    ["media", "Media"],
    ["summary", "Resumo"],
  ];
  if (!tabs.some(([key]) => key === state.territoryTab)) state.territoryTab = "coplas";
  view.innerHTML = `
    <div class="page territory-page">
      <div class="page-head page-head-bare">
        <button class="btn primary" type="button" data-view="map">Ver no mapa</button>
      </div>
      <div class="toolbar">
        <div class="searchbox"><span>⌕</span><input id="territorySearch" type="search" value="${escapeHtml(query)}" placeholder="Buscar parroquia, concello, comarca..."></div>
      </div>
      <div id="territorySearchResults" class="territory-results"></div>
      <div class="territory-hero">
        <section class="territory-card">
          ${territory ? `<div class="breadcrumbs">${breadcrumbTrail(territory, ctx)}</div>` : ""}
          <div class="eyebrow">${escapeHtml(territory ? territoryLabel(territory) : "País")}</div>
          <h1>${territory ? escapeHtml(territory.nome) : "Galiza"}</h1>
          ${territory ? `<p>${direct} coplas directas e ${Math.max(ctx.coplas.length - direct, 0)} herdadas dos subterritorios.</p>` : ""}
          <div class="stats">
            <div class="stat"><b>${ctx.coplas.length}</b><span>coplas</span></div>
            <div class="stat"><b>${ctx.pezas.length}</b><span>pezas</span></div>
            <div class="stat"><b>${ctx.media.length}</b><span>media</span></div>
            <div class="stat"><b>${ctx.melodias.length}</b><span>melodías</span></div>
          </div>
        </section>
        <div class="territory-silhouette" id="territorySilhouette" data-silhouette-hero="${territory ? territory.id : "galiza"}"></div>
      </div>
      ${territoryChildrenMarkup(territory, ctx)}
      <div class="territory-tabs">
        ${tabs.map(([key, label]) => `<button class="${state.territoryTab === key ? "active" : ""}" type="button" data-territory-tab="${key}">${label}</button>`).join("")}
      </div>
      <div id="territoryTabPanel">${renderTerritoryTab(territory, ctx)}</div>
    </div>
  `;
  $("#territorySearch")?.addEventListener("input", event => {
    state.territoryQuery = event.target.value;
    renderTerritorySearchResults(view);
  });
  $("#toggleTerritoryChildren")?.addEventListener("click", () => {
    const box = $("#territoryChildren", view);
    box.dataset.open = box.dataset.open === "true" ? "false" : "true";
    fitTerritoryChildren(view);
  });
  bindTerritoryTabs(view);
  bindResultButtons(view);
  bindCoplaActions(view);
  bindTerritoryCoplaSearch(view);
  bindTerritoryCoplaViewToggle(view);
  bindTerritorySummaryCard(view);
  hydrateTerritoryLists(view);
  renderTerritorySearchResults(view);
  fitTerritoryChildren(view);
  document.fonts?.ready.then(() => fitTerritoryChildren(view));
  hydrateSilhouettes(view);
}

function territoryOwnTraits(territory) {
  return territory ? (territory.traits || []) : [];
}

function territoryInheritedTraits(territory) {
  const scopeIds = territory
    ? getDescendantIds(territory, state.territorios).filter(id => id !== territory.id)
    : state.territorios.map(item => item.id);
  const rows = [];
  scopeIds.forEach(id => {
    const item = state.territorios.find(candidate => candidate.id === id);
    if (!item || !(item.traits || []).length) return;
    item.traits.forEach(trait => rows.push({ territory: item, trait }));
  });
  return rows;
}

function traitChipMarkup(trait, extra = "") {
  return `<span class="tag trait-chip">${escapeHtml(trait.trait)}${trait.category ? ` <small>${escapeHtml(trait.category)}</small>` : ""}${extra}</span>`;
}

function territorySummaryCard(territory, ctx) {
  const ownTraits = territoryOwnTraits(territory);
  const inherited = territoryInheritedTraits(territory);
  const grouped = new Map();
  inherited.forEach(({ territory: source, trait }) => {
    if (!grouped.has(source.id)) grouped.set(source.id, { territory: source, traits: [] });
    grouped.get(source.id).traits.push(trait);
  });
  return `
    <section class="panel territory-identity-card">
      <div class="section-title">
        <h2>Identidade e trazos</h2>
        ${territory ? `<button class="btn" type="button" id="addTerritoryTrait">+ Engadir trazo</button>` : ""}
      </div>
      ${territory ? `
        <div id="territoryTraitForm" class="territory-trait-form" hidden>
          <input id="territoryTraitInput" type="text" placeholder="Trazo (ex.: tócase lata, báilase maneo, gheada...)">
          <input id="territoryTraitCategory" type="text" placeholder="Categoría opcional (instrumento, baile, fala...)">
          <div class="form-actions">
            <button class="btn primary" type="button" id="saveTerritoryTrait">Gardar trazo</button>
            <button class="btn" type="button" id="cancelTerritoryTrait">Cancelar</button>
          </div>
          <p id="territoryTraitFeedback" class="muted"></p>
        </div>
      ` : ""}
      <div class="territory-trait-own">
        ${ownTraits.length
          ? `<div class="trait-chips">${ownTraits.map(trait => traitChipMarkup(trait, `<button type="button" data-remove-trait="${trait.id}" aria-label="Eliminar trazo">×</button>`)).join("")}</div>`
          : `<p class="muted">${territory ? "Aínda non hai trazos documentados directamente para este territorio." : "Aínda non hai trazos documentados para Galiza no seu conxunto."}</p>`}
      </div>
      ${grouped.size ? `
        <div class="territory-trait-inherited">
          <h3>Herdado dos subterritorios</h3>
          <div class="trait-inherited-list">
            ${Array.from(grouped.values()).map(group => `
              <div class="trait-inherited-group">
                <strong>${escapeHtml(group.territory.nome)}</strong>
                <div class="trait-chips">${group.traits.map(trait => traitChipMarkup(trait)).join("")}</div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

function bindTerritorySummaryCard(root = $("#view-territory")) {
  const form = $("#territoryTraitForm", root);
  $("#addTerritoryTrait", root)?.addEventListener("click", () => { if (form) form.hidden = !form.hidden; });
  $("#cancelTerritoryTrait", root)?.addEventListener("click", () => { if (form) form.hidden = true; });
  $("#saveTerritoryTrait", root)?.addEventListener("click", () => saveTerritoryTrait(root));
  all("[data-remove-trait]", root).forEach(button => button.addEventListener("click", () => removeTerritoryTrait(Number(button.dataset.removeTrait), root)));
}

async function saveTerritoryTrait(root = $("#view-territory")) {
  const territory = state.selectedTerritory;
  const feedback = $("#territoryTraitFeedback", root);
  const input = $("#territoryTraitInput", root);
  const categoryInput = $("#territoryTraitCategory", root);
  if (!territory) return;
  const traitText = input?.value.trim();
  if (!traitText) {
    if (feedback) feedback.textContent = "Escribe o trazo antes de gardar.";
    return;
  }
  setLoading(feedback, "Gardando");
  try {
    const response = await fetch("../api/territory-traits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traits: [{ territory_id: territory.id, trait: traitText, category: categoryInput?.value.trim() || null }] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido gardar o trazo.");
    clearApiCache();
    state.territorios = await getTerritorios();
    state.selectedTerritory = state.territorios.find(item => item.id === territory.id) || state.selectedTerritory;
    updateTerritoryTabPanel(root);
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
  }
}

async function removeTerritoryTrait(traitId, root = $("#view-territory")) {
  try {
    const response = await fetch("../api/territory-traits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traits: [{ id: traitId, _delete: true }] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido eliminar o trazo.");
    clearApiCache();
    state.territorios = await getTerritorios();
    if (state.selectedTerritory) state.selectedTerritory = state.territorios.find(item => item.id === state.selectedTerritory.id) || null;
    updateTerritoryTabPanel(root);
  } catch (error) {
    console.error(error);
  }
}

// Tamén entran os recursos nos que aparece unha melodía deste territorio
// (ou dos seus subterritorios), sexa cal sexa o seu "uso no arquivo".
function territoryMediaItems(territory, ctx) {
  const scopeMelodies = new Set(ctx.melodias.map(melody => String(melody.id)));
  return ctx.media.filter(item => ["documental", "mixed"].includes(mediaRole(item))
    || (item.links || []).some(link => link.entity_type === "melody" && scopeMelodies.has(String(link.entity_id))));
}

function renderTerritoryTab(territory, ctx) {
  if (!territory) {
    if (state.territoryTab === "coplas") {
      return `
        <div class="section-title"><h2>Coplas de Galiza</h2><span class="muted">${ctx.coplas.length} no arquivo</span></div>
        <div class="toolbar toolbar-end">${coplaViewToggleMarkup()}</div>
        <div id="territoryCoplaList" class="${coplaStreamClass()}${currentCoplaViewMode() === "gallery" ? " territory-copla-grid" : ""}"></div>
      `;
    }
    if (state.territoryTab === "melodies") return melodiesTabMarkup(null, ctx);
    if (["pieces", "media"].includes(state.territoryTab)) {
      return `
        <section class="panel territory-limit-panel">
          <h2>Escolle un territorio menor</h2>
        </section>
      `;
    }
    return territorySummaryCard(null, ctx);
  }
  if (state.territoryTab === "coplas") {
    const tq = normalizeText(state.territoryCoplaQuery || "");
    const filteredTerritoryCoplas = ctx.coplas.filter(copla => !tq || normalizeText(coplaHaystack(copla)).includes(tq));
    return `
      <div class="section-title"><h2>Coplas de ${escapeHtml(territory.nome)}</h2><span class="muted" id="territoryCoplaCount">${filteredTerritoryCoplas.length} de ${ctx.coplas.length} resultados</span></div>
      <div class="toolbar">
        <div class="searchbox"><span>⌕</span><input id="territoryCoplaSearch" type="search" value="${escapeHtml(state.territoryCoplaQuery || '')}" placeholder="Buscar texto nas coplas deste territorio..."></div>
        ${coplaViewToggleMarkup()}
      </div>
      <div id="territoryCoplaList" class="${coplaStreamClass()}${currentCoplaViewMode() === "gallery" ? " territory-copla-grid" : ""}"></div>
    `;
  }
  if (state.territoryTab === "pieces") {
    return `
      <div class="section-title"><h2>Pezas relacionadas</h2><span class="muted">${ctx.pezas.length} resultados</span></div>
      <div class="copla-gallery">${ctx.pezas.map(piece => `
        <article class="gallery-card">
          <div><div class="eyebrow">Peza</div><h2>${escapeHtml(piece.title || piece.titulo || "Peza sen título")}</h2><p>${escapeHtml(piece.description || piece.notes || "Sen descrición.")}</p></div>
          <div class="meta"><span class="tag place">${escapeHtml(territory.nome)}</span></div>
        </article>
      `).join("") || `<p class="muted">Aínda non hai pezas neste territorio.</p>`}</div>
    `;
  }
  if (state.territoryTab === "media") {
    const media = territoryMediaItems(territory, ctx);
    return `
      <div class="section-title"><h2>Media relacionada</h2><button class="btn" type="button" data-view="media" data-media-role="documental">+ Novo recurso</button><span class="muted">${media.length} recursos</span></div>
      <div id="territoryMediaList" class="media-grid"></div>
    `;
  }
  if (state.territoryTab === "melodies") return melodiesTabMarkup(territory, ctx);
  return territorySummaryCard(territory, ctx);
}

function renderSubmitView() {
  const view = $("#view-submit");
  if (!state.submitTerritoryIds.length && state.submitTerritoryId) state.submitTerritoryIds = [state.submitTerritoryId];
  if (!state.submitEditingId && !state.submitTerritoryIds.length && state.selectedTerritory) state.submitTerritoryIds = [state.selectedTerritory.id];
  const selectedTerritories = state.submitTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  const editing = state.submitEditingSnapshot;
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>${editing ? "Editar copla" : "Nova copla"}</h1>
        </div>
        ${editing ? `<div class="header-actions"><button class="btn" type="button" id="cancelEdit">Cancelar edición</button></div>` : ""}
      </div>
      <section class="panel submit-copla-panel">
        <div class="formgrid">
            <div class="field full">
              <label>Texto da copla</label>
              <textarea id="newText" rows="7" placeholder="Escribe a copla conservando os saltos de verso...">${escapeHtml(editing?.text || "")}</textarea>
              <div id="duplicateSuggestions" class="duplicate-suggestions" hidden></div>
            </div>
            <div class="field checkbox-field"><label><input id="newIsVolta" type="checkbox" ${editing?.is_volta ? "checked" : ""}> Úsase como volta</label></div>
            <div id="mainTerritoryFields" class="field full territory-field-group">
              <label>Territorio</label>
              <input id="territoryQuery" type="search" placeholder="Sen asignar. Escribe para buscar parroquia, concello, comarca ou provincia...">
              <div id="territoryPickerResults" class="territory-results compact"></div>
              <div id="mainTerritoryChips"><div id="selectedTerritoryChips" class="selected-chips">${
                state.submitGeneral
                  ? `<span class="selected-chip">Galiza enteira <small>Xeral</small><button type="button" id="clearGeneralTerritory" aria-label="Retirar Galiza enteira">×</button></span>`
                  : (selectedTerritories.map(item => selectedTerritoryChip(item, "copla")).join("") || `<p class="muted">Sen asignar.</p>`)
              }</div></div>
              <button class="link-button" type="button" id="markGeneralTerritory">Marcar coma "Galiza enteira" (sen territorio concreto)</button>
            </div>
            <div class="field full">
              <label for="newLugar">Lugar (opcional, dentro da parroquia)</label>
              <input id="newLugar" type="text" list="lugarList" maxlength="80" value="${escapeHtml(editing?.lugar || "")}" placeholder="Ex.: Laxoso, se a copla é dese lugar da parroquia" autocomplete="off">
              <datalist id="lugarList">${state.submitGeneral ? "" : lugarOptionsMarkup(state.submitTerritoryIds)}</datalist>
            </div>
            <details class="advanced-fields field full">
              <summary>Axustes avanzados</summary>
              <div class="formgrid">
                <div class="field"><label>Perfil lingüístico</label><select id="newLanguage"><option value="">Sen marcar</option><option value="lingua-galego">Galego</option><option value="lingua-castelan">Castelán</option><option value="lingua-castrapo">Castrapo / mestura</option></select></div>
                <div class="field"><label>Etiquetas</label><input id="newTags" type="text" value="${escapeHtml((editing?.tags || []).join(", "))}" placeholder="amor, romaría, traballo..."></div>
                <div class="field full"><label>Notas</label><textarea id="newNotes" rows="3" placeholder="Fonte, contexto, dúbidas editoriais...">${escapeHtml(editing?.notes || "")}</textarea></div>
              </div>
            </details>
            ${editing ? `
            <div class="field full">
              <label>Media relacionada <span class="muted">(xa gardada na BD)</span></label>
              <div id="coplaMediaLinks" class="selected-chips">
                ${coplaMedia(editing).map(item => `
                  <span class="selected-chip">
                    ${escapeHtml(item.title || "Recurso sen título")} <small>${escapeHtml(mediaLabel(mediaKind(item)))}</small>
                    <button type="button" data-unlink-copla-media="${item.id}" aria-label="Retirar ${escapeHtml(item.title || "recurso")}">×</button>
                  </span>
                `).join("") || `<p class="muted">Sen recursos multimedia vinculados.</p>`}
              </div>
              <input id="coplaMediaQuery" type="search" placeholder="Buscar media xa gardada (título, URL, fonte...)">
              <div id="coplaMediaResults" class="territory-results compact"></div>
              <p id="coplaMediaFeedback" class="muted"></p>
            </div>
            ` : ""}
        </div>
        <div class="variants-block">
          <div class="section-title"><div><h2>Variantes</h2><p class="muted">Numéranse automaticamente pola orde en que se engaden e parten do texto principal.</p></div><button class="btn" type="button" id="addVersion">+ Engadir variante</button></div>
          <div id="versionRows" class="version-rows"></div>
        </div>
          <div class="form-actions submit-primary-actions">
            ${editing
              ? `<button class="btn primary" type="button" id="saveDirect">Gardar cambios</button>`
              : `<button class="btn" type="button" id="queueCopla">+ Engadir á lista</button>
                 <button class="btn primary" type="button" id="saveDirect">${state.submitBatch.length ? `Gardar todas (${state.submitBatch.length})` : "Gardar copla"}</button>`}
          </div>
          <p id="submitFeedback" class="muted"></p>
      </section>
      ${!editing ? submitBatchQueueMarkup() : ""}
      ${!editing ? pasteBlockPanelMarkup() : ""}
      <details class="panel batch-import-panel compact-import">
        <summary>Importar varias coplas desde JSON</summary>
        <div class="compact-import-body">
          <p class="muted">Escolle un ficheiro co formato de Fol e ar. A importación gárdao e actualiza o repertorio.</p>
          <div class="compact-import-actions">
            <div class="file-picker">
              <input id="coplaJsonFile" class="visually-hidden" type="file" accept="application/json,.json">
              <label class="btn" for="coplaJsonFile">Escoller ficheiro</label>
              <span id="coplaJsonFilename" class="muted">Ningún ficheiro seleccionado</span>
            </div>
            <button class="btn primary" type="button" id="importCoplaJson">Importar ficheiro</button>
            <button class="btn" type="button" id="downloadCoplaTemplate">Descargar modelo JSON</button>
          </div>
          <p id="jsonImportFeedback" class="muted"></p>
        </div>
      </details>
    </div>
  `;
  bindTerritoryPicker();
  bindSelectedTerritoryChips(view);
  bindGeneralTerritoryToggle();
  $("#addVersion")?.addEventListener("click", () => addVersionRow());
  $("#saveDirect")?.addEventListener("click", saveCoplaDirect);
  $("#queueCopla")?.addEventListener("click", queueCoplaFromForm);
  bindPasteBlock();
  $("#cancelEdit")?.addEventListener("click", cancelEditCopla);
  all("[data-remove-batch]", view).forEach(button => button.addEventListener("click", () => removeQueuedCopla(Number(button.dataset.removeBatch))));
  all("[data-remove-lot]", view).forEach(button => button.addEventListener("click", () => removeQueuedLot(Number(button.dataset.removeLot))));
  $("#importCoplaJson")?.addEventListener("click", importCoplaJson);
  $("#downloadCoplaTemplate")?.addEventListener("click", downloadCoplaTemplate);
  $("#coplaJsonFile")?.addEventListener("change", event => {
    const filename = event.target.files?.[0]?.name || "Ningún ficheiro seleccionado";
    $("#coplaJsonFilename").textContent = filename;
  });
  let duplicateCheckTimer = null;
  $("#newText")?.addEventListener("input", () => {
    window.clearTimeout(duplicateCheckTimer);
    duplicateCheckTimer = window.setTimeout(renderDuplicateSuggestions, 250);
  });
  if (editing) {
    (editing.versions || []).forEach(version => {
      addVersionRow({
        text: version.text,
        notes: version.notes,
        territoryIds: (version.territories || []).map(item => item.id),
      });
    });
    bindCoplaMediaLinker(editing);
  }
}

function mediaFullPayload(media, links) {
  return {
    id: media.id,
    provider: media.provider,
    media_kind: media.media_kind,
    title: media.title,
    url: media.url,
    description: media.description,
    author_or_source: media.author_or_source,
    thumbnail_url: media.thumbnail_url,
    status: media.status || "published",
    links,
  };
}

async function postMediaUpdate(payload) {
  const response = await fetch("../api/media", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ media: [payload] }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Non se puido actualizar a media.");
  clearApiCache();
  state.media = await loadMedia();
}

async function linkMediaToCopla(mediaId, coplaId) {
  const media = state.media.find(item => Number(item.id) === Number(mediaId));
  if (!media) return;
  const already = (media.links || []).some(link => link.entity_type === "copla" && String(link.entity_id) === String(coplaId));
  if (already) return;
  const links = [...(media.links || []), { entity_type: "copla", entity_id: coplaId, relation_type: "documental" }];
  await postMediaUpdate(mediaFullPayload(media, links));
}

async function unlinkMediaFromCopla(mediaId, coplaId) {
  const media = state.media.find(item => Number(item.id) === Number(mediaId));
  if (!media) return;
  const links = (media.links || []).filter(link => !(link.entity_type === "copla" && String(link.entity_id) === String(coplaId)));
  if (!links.length) {
    throw new Error("Esta media quedaría sen ningunha ligazón. Retíraa dende a vista de Media se queres eliminala.");
  }
  await postMediaUpdate(mediaFullPayload(media, links));
}

function bindCoplaMediaLinker(copla) {
  const view = $("#view-submit");
  const feedback = $("#coplaMediaFeedback", view);
  all("[data-unlink-copla-media]", view).forEach(button => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await unlinkMediaFromCopla(Number(button.dataset.unlinkCoplaMedia), copla.id);
      renderSubmitView();
    } catch (error) {
      if (feedback) feedback.textContent = error.message || "Non se puido retirar a ligazón.";
      button.disabled = false;
    }
  }));
  const input = $("#coplaMediaQuery", view);
  const results = $("#coplaMediaResults", view);
  if (input && results) {
    input.addEventListener("input", () => {
      const query = normalizeText(input.value.trim());
      if (!query) {
        results.innerHTML = "";
        return;
      }
      const linkedIds = new Set(coplaMedia(copla).map(item => item.id));
      const matches = state.media
        .filter(item => !linkedIds.has(item.id))
        .filter(item => normalizeText([item.title, item.url, item.author_or_source, item.provider].join(" ")).includes(query))
        .slice(0, 10);
      results.innerHTML = matches.map(item => `
        <button type="button" data-link-copla-media="${item.id}">
          <strong>${escapeHtml(item.title || "Recurso sen título")}</strong>
          <span>${escapeHtml(mediaLabel(mediaKind(item)))} \\ ${escapeHtml(item.url || "")}</span>
        </button>
      `).join("") || `<p class="muted">Sen resultados.</p>`;
      all("[data-link-copla-media]", results).forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await linkMediaToCopla(Number(button.dataset.linkCoplaMedia), copla.id);
          renderSubmitView();
        } catch (error) {
          if (feedback) feedback.textContent = error.message || "Non se puido vincular a media.";
          button.disabled = false;
        }
      }));
    });
  }
}

function addVersionRow(options = {}) {
  const mainText = $("#newText")?.value || "";
  const inheritedTerritories = Array.from(new Set(state.submitTerritoryIds)).map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  const inheritedLabel = inheritedTerritories.length
    ? inheritedTerritories.map(item => item.nome).join(", ")
    : (state.submitGeneral ? "Galiza xeral" : "Sen asignar");
  const explicitIds = options.territoryIds || [];
  const territoryValue = explicitIds.length
    ? explicitIds.map(id => state.territorios.find(item => item.id === id)?.nome).filter(Boolean).join(", ")
    : inheritedLabel;
  const row = document.createElement("div");
  row.className = "version-row";
  row.dataset.territoryIds = JSON.stringify(explicitIds);
  row.innerHTML = `
    <div class="version-row-head"><strong>Variante</strong><button class="icon-button" type="button" data-remove-version aria-label="Eliminar variante" title="Eliminar variante">×</button></div>
    <div class="formgrid">
      <div class="field full"><label>Texto</label><textarea class="version-text" rows="4" placeholder="Escribe a variante...">${escapeHtml(options.text != null ? options.text : mainText)}</textarea></div>
      <div class="field full version-territory-field">
        <label>Territorio</label>
        <input class="version-territory-input" type="text" value="${escapeHtml(territoryValue)}" placeholder="Escribe para cambiar o territorio...">
        <div class="version-territory-suggestions territory-results compact"></div>
      </div>
      <div class="field full"><label>Notas opcionais</label><input class="version-notes" type="text" value="${escapeHtml(options.notes || "")}" placeholder="Fonte ou particularidades desta variante"></div>
    </div>`;
  $("#versionRows").appendChild(row);
  bindVersionRow(row);
  renumberVersionRows();
  return row;
}

function renumberVersionRows() {
  all("#versionRows .version-row").forEach((row, index) => {
    const head = $(".version-row-head strong", row);
    if (head) head.textContent = `Variante ${index + 1}`;
  });
}

function versionTerritoryIds(row) {
  try { return JSON.parse(row.dataset.territoryIds || "[]"); } catch { return []; }
}

function bindVersionRow(row) {
  const input = $(".version-territory-input", row);
  const suggestions = $(".version-territory-suggestions", row);
  input.addEventListener("input", () => {
    const query = input.value.trim();
    if (!query) {
      row.dataset.territoryIds = "[]";
      suggestions.innerHTML = "";
      return;
    }
    const matches = searchTerritories(state.territorios, query).slice(0, 8);
    suggestions.innerHTML = matches.map(item => `<button type="button" data-pick-version-territory="${item.id}"><strong>${escapeHtml(item.nome)}</strong><span>${escapeHtml(territorySearchMeta(item))}</span></button>`).join("") || `<p class="muted">Sen resultados.</p>`;
    all("[data-pick-version-territory]", suggestions).forEach(button => button.addEventListener("click", () => {
      const territory = state.territorios.find(item => item.id === button.dataset.pickVersionTerritory);
      if (!territory) return;
      row.dataset.territoryIds = JSON.stringify([territory.id]);
      input.value = territory.nome;
      suggestions.innerHTML = "";
    }));
  });
  $("[data-remove-version]", row).addEventListener("click", () => { row.remove(); renumberVersionRows(); });
}

function selectedTerritoryChip(territory, kind) {
  return `
    <span class="selected-chip">
      ${escapeHtml(territory.nome)} <small class="level-badge level-${territory.tipo}">${escapeHtml(territoryLabel(territory))}</small>
      <button type="button" data-remove-${kind}-territory="${territory.id}" aria-label="Retirar ${escapeHtml(territory.nome)}">×</button>
    </span>
  `;
}

function selectedCoplaChip(copla) {
  return `
    <span class="selected-chip">
      ${escapeHtml(coplaTitle(copla))} <small>${escapeHtml(coplaPlaceLabel(copla))}</small>
      <button type="button" data-remove-media-copla="${copla.id}" aria-label="Retirar copla">×</button>
    </span>
  `;
}

// A dona dun recurso de peza (sen ser guía/admin) só edita os datos do recurso.
function ownerMediaMode() {
  return Boolean(state.mediaEditingSnapshot && ownPieceResource(state.mediaEditingSnapshot));
}

function mediaFormMarkup(selectedMediaTerritories, selectedMediaCoplas) {
  const editing = state.mediaEditingSnapshot;
  const defaultRole = editing ? mediaRole(editing) : (state.mediaDefaultRole || (state.territoryTab === "melodies" ? "melody" : "documental"));
  const kind = editing ? mediaKind(editing) : "youtube";
  return `
    <section class="panel submit-media-panel">
      <div class="section-title"><h2>${editing ? "Editar recurso" : "Novo recurso"}</h2><span class="muted">Documental, melodía ou ambos</span></div>
      <div class="formgrid">
        <div class="field"><label>Título</label><input id="mediaTitle" type="text" value="${escapeHtml(editing?.title || "")}" placeholder="Xota 1, Muiñeira de Sequeiros..."></div>
        <div class="field"><label>Tipo</label><select id="mediaKind">${["youtube", "spotify", "soundcloud", "audio", "video", "image", "pdf", "web"].map(value => `<option value="${value}" ${kind === value ? "selected" : ""}>${escapeHtml(mediaLabel(value))}</option>`).join("")}</select></div>
        <div class="field"><label>Uso no arquivo</label><select id="mediaRole"><option value="documental" ${defaultRole === "documental" ? "selected" : ""}>Media documental</option><option value="melody" ${defaultRole === "melody" ? "selected" : ""}>Melodía / recurso musical</option><option value="mixed" ${defaultRole === "mixed" ? "selected" : ""}>Ambas cousas</option></select></div>
        <div class="field full"><label>URL</label><div class="input-action"><input id="mediaUrl" type="url" value="${escapeHtml(editing?.url || "")}" placeholder="https://..."><button class="btn" type="button" id="fetchMediaMeta">Obter datos</button></div></div>
        <div class="field"><label>Fonte ou autoría</label><input id="mediaSource" type="text" value="${escapeHtml(editing?.author_or_source || "")}" placeholder="Canle, intérprete, arquivo..."></div>
        <div class="field"><label>Miniatura opcional</label><input id="mediaThumb" type="url" value="${escapeHtml(editing?.thumbnail_url || "")}" placeholder="https://..."></div>
        <div class="field full"><label>Descrición</label><textarea id="mediaDescription" rows="3" placeholder="Contexto, relación coa melodía, observacións...">${escapeHtml(editing?.description || "")}</textarea></div>
        ${ownerMediaMode() ? `<p class="muted field full">Este recurso vai ligado a unha peza túa e, a través dela, ao seu territorio e ás súas coplas. Se o borras, desvincúlase de todo.</p>` : `
        <div class="field"><label>Territorios vinculados</label><input id="mediaTerritoryQuery" type="search" placeholder="Buscar e engadir territorios..."></div>
        <div class="field full"><div id="mediaTerritoryResults" class="territory-results compact"></div></div>
        <div class="field full"><div id="selectedMediaTerritoryChips" class="selected-chips">${selectedMediaTerritories.map(item => selectedTerritoryChip(item, "media")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`}</div></div>
        <div class="field full"><label>Coplas vinculadas (opcional)</label><input id="mediaCoplaQuery" type="search" placeholder="Buscar coplas polo texto..."></div>
        <div class="field full"><div id="mediaCoplaResults" class="territory-results compact"></div></div>
        <div class="field full"><div id="selectedMediaCoplaChips" class="selected-chips">${selectedMediaCoplas.map(item => selectedCoplaChip(item)).join("") || `<p class="muted">Sen coplas seleccionadas.</p>`}</div></div>
        ${mediaMelodyFieldMarkup()}`}
      </div>
      <div class="gallery-actions">
        <button class="btn primary" type="button" id="saveMediaDirect">${editing ? "Gardar cambios" : "Gardar recurso"}</button>
        <p id="mediaFeedback" class="muted"></p>
      </div>
    </section>
  `;
}

function mediaModalMarkup(selectedMediaTerritories, selectedMediaCoplas) {
  if (!state.mediaModalOpen) return "";
  const editing = state.mediaEditingSnapshot;
  return `
    <div class="media-modal" id="mediaModal" role="dialog" aria-modal="true" aria-label="${editing ? "Editar recurso" : "Novo recurso"}">
      <div class="media-modal-backdrop" data-close-media-modal></div>
      <div class="media-modal-panel">
        <div class="media-modal-head">
          <div>
            <div class="eyebrow">${editing ? "Edición de media" : "Alta de media"}</div>
            <h2>${editing ? "Editar recurso" : "Novo recurso"}</h2>
          </div>
          <button class="card-close" type="button" data-close-media-modal aria-label="Pechar">×</button>
        </div>
        ${mediaFormMarkup(selectedMediaTerritories, selectedMediaCoplas)}
      </div>
    </div>
  `;
}

function openMediaModal(role = "", preset = {}) {
  state.mediaDefaultRole = role || "";
  state.mediaEditingId = null;
  state.mediaEditingSnapshot = null;
  state.mediaEditingPieceLinks = [];
  state.mediaTerritoryIds = [...(preset.territoryIds || [])];
  state.mediaCoplaIds = [];
  state.mediaMelodyIds = [...(preset.melodyIds || [])];
  state.mediaModalOpen = true;
  renderMediaView();
}

function startEditMedia(mediaId) {
  const media = state.media.find(item => Number(item.id) === Number(mediaId));
  if (!media) return;
  state.mediaEditingId = media.id;
  state.mediaEditingSnapshot = media;
  state.mediaEditingPieceLinks = (media.links || []).filter(link => link.entity_type === "piece");
  state.mediaTerritoryIds = mediaTerritories(media).map(item => item.id);
  state.mediaCoplaIds = mediaCoplas(media).map(item => item.id);
  state.mediaMelodyIds = mediaMelodies(media).map(item => item.id);
  state.mediaDefaultRole = "";
  state.mediaModalOpen = true;
  renderMediaView();
}

function closeMediaModal() {
  state.mediaModalOpen = false;
  state.mediaDefaultRole = "";
  state.mediaEditingId = null;
  state.mediaEditingSnapshot = null;
  state.mediaEditingPieceLinks = [];
  state.mediaTerritoryIds = [];
  state.mediaCoplaIds = [];
  state.mediaMelodyIds = [];
  renderMediaView();
}

function refreshSelectedTerritoryChips() {
  const coplaChips = $("#selectedTerritoryChips");
  if (coplaChips) {
    if (state.submitGeneral) {
      coplaChips.innerHTML = `<span class="selected-chip">Galiza enteira <small>Xeral</small><button type="button" id="clearGeneralTerritory" aria-label="Retirar Galiza enteira">×</button></span>`;
    } else {
      const selected = state.submitTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
      coplaChips.innerHTML = selected.map(item => selectedTerritoryChip(item, "copla")).join("") || `<p class="muted">Sen asignar.</p>`;
    }
    bindGeneralTerritoryToggle();
  }
  const mediaChips = $("#selectedMediaTerritoryChips");
  if (mediaChips) {
    const selected = state.mediaTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
    mediaChips.innerHTML = selected.map(item => selectedTerritoryChip(item, "media")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`;
  }
  const mediaCoplaChips = $("#selectedMediaCoplaChips");
  if (mediaCoplaChips) {
    const selectedCoplas = state.mediaCoplaIds.map(id => state.coplas.find(item => Number(item.id) === Number(id))).filter(Boolean);
    mediaCoplaChips.innerHTML = selectedCoplas.map(selectedCoplaChip).join("") || `<p class="muted">Sen coplas seleccionadas.</p>`;
  }
  refreshMediaMelodyOptions();
  bindSelectedTerritoryChips();
  refreshLugarOptions();
  // O lote pegado copia o lugar do formulario mentres non teña o seu propio.
  if (!state.pastePlace && $("#pasteTerritoryChips")) {
    paintPastePlace();
    updatePasteBlockPreview({ keepDupes: true });
  }
}

function bindSelectedTerritoryChips(root = document) {
  all("[data-remove-copla-territory]", root).forEach(button => button.addEventListener("click", () => {
    state.submitTerritoryIds = state.submitTerritoryIds.filter(id => id !== button.dataset.removeCoplaTerritory);
    state.submitTerritoryId = state.submitTerritoryIds[0] || "";
    refreshSelectedTerritoryChips();
  }));
  all("[data-remove-media-territory]", root).forEach(button => button.addEventListener("click", () => {
    state.mediaTerritoryIds = state.mediaTerritoryIds.filter(id => id !== button.dataset.removeMediaTerritory);
    refreshSelectedTerritoryChips();
  }));
  all("[data-remove-media-copla]", root).forEach(button => button.addEventListener("click", () => {
    state.mediaCoplaIds = state.mediaCoplaIds.filter(id => Number(id) !== Number(button.dataset.removeMediaCopla));
    refreshSelectedTerritoryChips();
  }));
}

function bindTerritoryPicker() {
  const input = $("#territoryQuery");
  const results = $("#territoryPickerResults");
  if (!input || !results) return;
  input.addEventListener("input", () => {
    const query = input.value.trim();
    if (!query) {
      results.innerHTML = "";
      return;
    }
    const matches = searchTerritories(state.territorios, query).slice(0, 12);
    results.innerHTML = matches.map(item => `
      <button type="button" data-pick-territory="${item.id}">
        <strong>${escapeHtml(item.nome)}</strong>
        <span>${escapeHtml(territorySearchMeta(item))}</span>
      </button>
    `).join("") || `<p class="muted">Sen resultados.</p>`;
    all("[data-pick-territory]", results).forEach(button => button.addEventListener("click", () => {
      const territory = state.territorios.find(item => item.id === button.dataset.pickTerritory);
      if (!territory) return;
      state.submitGeneral = false;
      if (!state.submitTerritoryIds.includes(territory.id)) state.submitTerritoryIds.push(territory.id);
      state.submitTerritoryId = state.submitTerritoryIds[0] || "";
      input.value = "";
      results.innerHTML = "";
      refreshSelectedTerritoryChips();
    }));
  });
}

function bindGeneralTerritoryToggle(root = document) {
  $("#markGeneralTerritory", root)?.addEventListener("click", () => {
    state.submitGeneral = true;
    state.submitTerritoryIds = [];
    state.submitTerritoryId = "";
    refreshSelectedTerritoryChips();
  });
  $("#clearGeneralTerritory", root)?.addEventListener("click", () => {
    state.submitGeneral = false;
    refreshSelectedTerritoryChips();
  });
}

function bindMediaCoplaPicker() {
  const input = $("#mediaCoplaQuery");
  const results = $("#mediaCoplaResults");
  if (!input || !results) return;
  input.addEventListener("input", () => {
    const query = normalizeText(input.value.trim());
    if (!query) {
      results.innerHTML = "";
      return;
    }
    const matches = state.coplas.filter(copla => normalizeText(coplaHaystack(copla)).includes(query)).slice(0, 12);
    results.innerHTML = matches.map(item => `
      <button type="button" data-pick-media-copla="${item.id}">
        <strong>${escapeHtml(coplaTitle(item))}</strong>
        <span>${escapeHtml(coplaPlaceLabel(item))}</span>
      </button>
    `).join("") || `<p class="muted">Sen resultados.</p>`;
    all("[data-pick-media-copla]", results).forEach(button => button.addEventListener("click", () => {
      const id = Number(button.dataset.pickMediaCopla);
      if (!state.mediaCoplaIds.some(existing => Number(existing) === id)) state.mediaCoplaIds.push(id);
      input.value = "";
      results.innerHTML = "";
      refreshSelectedTerritoryChips();
    }));
  });
}

function bindMediaTerritoryPicker() {
  const input = $("#mediaTerritoryQuery");
  const results = $("#mediaTerritoryResults");
  if (!input || !results) return;
  input.addEventListener("input", () => {
    const query = input.value.trim();
    if (!query) {
      results.innerHTML = "";
      return;
    }
    const matches = searchTerritories(state.territorios, query).slice(0, 12);
    results.innerHTML = matches.map(item => `
      <button type="button" data-pick-media-territory="${item.id}">
        <strong>${escapeHtml(item.nome)}</strong>
        <span>${escapeHtml(territorySearchMeta(item))}</span>
      </button>
    `).join("") || `<p class="muted">Sen resultados.</p>`;
    all("[data-pick-media-territory]", results).forEach(button => button.addEventListener("click", () => {
      const territory = state.territorios.find(item => item.id === button.dataset.pickMediaTerritory);
      if (!territory) return;
      if (!state.mediaTerritoryIds.includes(territory.id)) state.mediaTerritoryIds.push(territory.id);
      input.value = "";
      results.innerHTML = "";
      refreshSelectedTerritoryChips();
    }));
  });
}

function buildCoplaPayloadFromForm() {
  const text = $("#newText").value.trim();
  const feedback = $("#submitFeedback");
  if (!text) {
    feedback.textContent = "Escribe o texto da copla antes de gardar.";
    return null;
  }
  const territoryIds = Array.from(new Set(state.submitTerritoryIds));
  const territoryState = state.submitGeneral ? "general" : (territoryIds.length ? "assigned" : "unassigned");
  const versionRows = all("#versionRows .version-row");
  const versions = versionRows.map((row, index) => ({
    label: `Variante ${index + 1}`,
    text: $(".version-text", row).value,
    notes: $(".version-notes", row).value,
    territories: versionTerritoryIds(row).map(id => ({ id })),
  })).filter(item => item.text.trim());
  const languageTag = $("#newLanguage")?.value || "";
  const tags = $("#newTags").value.split(",").map(item => normalizeText(item)).filter(Boolean);
  if (languageTag) tags.push(languageTag);
  const payload = {
    text,
    notes: $("#newNotes").value,
    status: "published",
    territory_state: territoryState,
    territories: territoryState === "assigned" ? territoryIds.map(id => ({ id })) : [],
    tags: Array.from(new Set(tags)),
    is_volta: Boolean($("#newIsVolta")?.checked),
    lugar: $("#newLugar")?.value.trim() || null,
    versions,
  };
  if (state.submitEditingId) payload.id = state.submitEditingId;
  return payload;
}

async function importCoplaJson() {
  const feedback = $("#jsonImportFeedback");
  const file = $("#coplaJsonFile")?.files?.[0];
  try {
    if (!file) throw new Error("Escolle primeiro un ficheiro JSON.");
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!payload || !Array.isArray(payload.coplas)) throw new Error("O JSON debe ter a forma { \"coplas\": [...] }.");
    setLoading(feedback, "Importando coplas");
    const response = await fetch("../api/coplas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido importar o JSON.");
    if (feedback) feedback.textContent = `Importación completada. IDs afectados: ${result.ids.join(", ")}`;
    clearApiCache();
    state.coplas = await getCoplas();
    $("#coplaJsonFile").value = "";
    if ($("#coplaJsonFilename")) $("#coplaJsonFilename").textContent = "Ningún ficheiro seleccionado";
  } catch (error) {
    if (feedback) {
      feedback.textContent = error.message;
      feedback.classList.add("is-error");
    }
  }
}

function downloadCoplaTemplate() {
  const template = {
    _instructions: "Substitúe os textos e IDs de exemplo. Nas variantes, territories: [] herda os territorios da copla principal; indica IDs para asignarlle outros.",
    coplas: [{
      text: "Primeiro verso\nSegundo verso\nTerceiro verso\nCuarto verso",
      territory_state: "assigned",
      territories: [{ id: "con:00000" }],
      tags: ["lingua-galego"],
      notes: "Fonte ou contexto opcional",
      status: "published",
      versions: [{
        label: "Variante 1",
        text: "Primeiro verso da variante\nSegundo verso\nTerceiro verso\nCuarto verso",
        notes: "Notas opcionais da variante",
        territories: [],
      }],
    }],
  };
  downloadText("fol-e-ar-plantilla-coplas.json", JSON.stringify(template, null, 2), "application/json");
}

function buildMediaPayloadFromForm() {
  const feedback = $("#mediaFeedback");
  const title = $("#mediaTitle").value.trim();
  const url = $("#mediaUrl").value.trim();
  const kind = $("#mediaKind").value;
  const role = $("#mediaRole")?.value || "documental";
  const territoryIds = Array.from(new Set(state.mediaTerritoryIds));
  const coplaIds = Array.from(new Set(state.mediaCoplaIds.map(Number)));
  const preservedPieceLinks = state.mediaEditingPieceLinks || [];
  const melodyIds = Array.from(new Set((state.mediaMelodyIds || []).map(Number)));
  if (!title || !url) {
    feedback.textContent = "Indica título e URL.";
    return null;
  }
  if (ownerMediaMode()) {
    if (!safeUrl(url)) {
      feedback.textContent = "Escribe unha URL completa que empece por http:// ou https://.";
      return null;
    }
    return { media: [{
      id: state.mediaEditingId, title, url, media_kind: kind, role,
      description: $("#mediaDescription").value.trim() || null,
      author_or_source: $("#mediaSource").value.trim() || null,
      thumbnail_url: $("#mediaThumb").value.trim() || null,
    }] };
  }
  if (!territoryIds.length && !coplaIds.length && !preservedPieceLinks.length && !melodyIds.length) {
    feedback.textContent = "Selecciona polo menos un territorio ou unha copla para vincular este recurso.";
    return null;
  }
  const entry = {
    provider: kind,
    media_kind: kind,
    title,
    url,
    description: $("#mediaDescription").value.trim() || null,
    author_or_source: $("#mediaSource").value.trim() || null,
    thumbnail_url: $("#mediaThumb").value.trim() || null,
    status: "published",
    links: [
      ...territoryIds.map(id => ({ entity_type: "territory", entity_id: id, relation_type: role })),
      ...coplaIds.map(id => ({ entity_type: "copla", entity_id: id, relation_type: role })),
      ...melodyIds.map(id => ({ entity_type: "melody", entity_id: id, relation_type: role })),
      ...preservedPieceLinks.map(link => ({ entity_type: "piece", entity_id: link.entity_id, relation_type: link.relation_type || "documental" })),
    ],
  };
  if (state.mediaEditingId) entry.id = state.mediaEditingId;
  return { media: [entry] };
}

async function saveCoplaDirect() {
  const feedback = $("#submitFeedback");
  let payloads;
  if (state.submitEditingId) {
    const payload = buildCoplaPayloadFromForm();
    if (!payload) return;
    payloads = [payload];
  } else {
    const pending = parseCoplaPasteBlock(state.pasteDraft).length;
    if (pending) {
      const message = `Hai ${pending} copla${pending === 1 ? "" : "s"} pegada${pending === 1 ? "" : "s"} sen engadir á lista. Preme «Engadir lote á lista» (ou limpa o texto) antes de gardar.`;
      if (feedback) feedback.textContent = message;
      const pasteFeedback = $("#pasteBlockFeedback");
      if (pasteFeedback) pasteFeedback.textContent = message;
      return;
    }
    payloads = state.submitBatch.map(item => item.payload);
    const currentText = $("#newText")?.value.trim();
    if (currentText) {
      const current = buildCoplaPayloadFromForm();
      if (!current) return;
      payloads = [...payloads, current];
    }
    if (!payloads.length) {
      feedback.textContent = "Escribe o texto da copla antes de gardar.";
      return;
    }
  }
  setLoading(feedback, "Gardando");
  try {
    const response = await fetch("../api/coplas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coplas: payloads }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido gardar.");
    feedback.textContent = `Gardado. IDs afectados: ${result.ids.join(", ")}`;
    clearApiCache();
    state.coplas = await getCoplas();
    const returnView = state.submitReturnView;
    state.submitBatch = [];
    state.pastePlace = null;
    state.pasteLugar = "";
    state.pasteLotSeq = 0;
    state.pasteFeedback = "";
    state.submitEditingId = null;
    state.submitEditingSnapshot = null;
    state.submitReturnView = null;
    state.submitTerritoryIds = [];
    state.submitTerritoryId = "";
    state.submitGeneral = false;
    if (returnView) {
      state.selectedTerritory = returnView.selectedTerritory;
      state.coplaQuery = returnView.coplaQuery;
      state.coplaStateFilter = returnView.coplaStateFilter;
      setView(returnView.view);
    } else {
      const lastPayload = payloads[payloads.length - 1];
      const firstTerritoryId = lastPayload.territories[0]?.id;
      state.selectedTerritory = firstTerritoryId ? state.territorios.find(item => item.id === firstTerritoryId) || state.selectedTerritory : state.selectedTerritory;
      state.coplaQuery = firstLine(lastPayload.text);
      state.coplaStateFilter = "all";
      setView("coplas");
    }
  } catch (error) {
    feedback.textContent = `${error.message} Comproba que abriste Fol e ar con ./serve.sh.`;
  }
}

function resetCoplaFormForNextEntry() {
  if ($("#newText")) $("#newText").value = "";
  if ($("#newIsVolta")) $("#newIsVolta").checked = false;
  if ($("#newLanguage")) $("#newLanguage").value = "";
  if ($("#newTags")) $("#newTags").value = "";
  if ($("#newNotes")) $("#newNotes").value = "";
  if ($("#versionRows")) $("#versionRows").innerHTML = "";
  hideDuplicateSuggestions();
}

function queueCoplaFromForm() {
  const payload = buildCoplaPayloadFromForm();
  if (!payload) return;
  const territories = payload.territories.map(item => state.territorios.find(t => t.id === item.id)).filter(Boolean);
  state.submitBatch.push({
    payload,
    placeLabel: coplaPlaceLabel({ territories, territory_state: payload.territory_state, lugar: payload.lugar }),
    preview: firstLine(payload.text) || "Copla sen íncipit",
    versionCount: payload.versions.length,
    isVolta: payload.is_volta,
  });
  resetCoplaFormForNextEntry();
  const feedback = $("#submitFeedback");
  if (feedback) feedback.textContent = "Engadida á lista. Segue escribindo a seguinte copla ou preme «Gardar todas» para rematar.";
  renderSubmitView();
}

function removeQueuedCopla(index) {
  state.submitBatch.splice(index, 1);
  renderSubmitView();
}

function removeQueuedLot(lot) {
  state.submitBatch = state.submitBatch.filter(item => item.lot !== lot);
  renderSubmitView();
}

function submitBatchQueueMarkup() {
  if (!state.submitBatch.length) return "";
  const perPlace = new Map();
  state.submitBatch.forEach(item => perPlace.set(item.placeLabel, (perPlace.get(item.placeLabel) || 0) + 1));
  const lotSizes = new Map();
  state.submitBatch.forEach(item => { if (item.lot) lotSizes.set(item.lot, (lotSizes.get(item.lot) || 0) + 1); });
  let lastLot = null;
  const rows = state.submitBatch.map((item, index) => {
    let head = "";
    if (item.lot && item.lot !== lastLot) {
      const size = lotSizes.get(item.lot);
      head = `<div class="submit-batch-lot"><strong>Lote ${item.lot}</strong><span class="muted">${escapeHtml(item.placeLabel)} \\ ${size} copla${size === 1 ? "" : "s"}</span><button class="link-button" type="button" data-remove-lot="${item.lot}">Quitar lote</button></div>`;
    }
    lastLot = item.lot || null;
    return `${head}
          <article class="submit-batch-item">
            <div>
              <strong>${escapeHtml(item.preview)}</strong>
              <span class="muted">${escapeHtml(item.placeLabel)}${item.versionCount ? ` \\ ${item.versionCount} variante(s)` : ""}${item.isVolta ? " \\ Volta" : ""}</span>
            </div>
            <button class="icon-button" type="button" data-remove-batch="${index}" aria-label="Retirar da lista" title="Retirar da lista">×</button>
          </article>`;
  }).join("");
  return `
    <section class="panel submit-batch-panel">
      <div class="section-title"><h2>Coplas pendentes de gardar</h2><span class="muted">${state.submitBatch.length}</span></div>
      <p class="submit-batch-summary muted">${[...perPlace].map(([label, count]) => `${escapeHtml(label)}: ${count}`).join(" \\ ")}</p>
      <div class="submit-batch-list">
        ${rows}
      </div>
    </section>
  `;
}

function normalizeForMatch(text = "") {
  return normalizeText(text)
    .replace(/[.,;:!?¡¿"'«»“”()\-–—]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    const curr = new Array(bl + 1);
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[bl];
}

function textSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function coplaMatchLines(copla) {
  const lines = String(copla.text || "").split(/\r?\n/).map(normalizeForMatch).filter(Boolean);
  (copla.versions || []).forEach(version => {
    String(version.text || "").split(/\r?\n/).map(normalizeForMatch).filter(Boolean).forEach(line => lines.push(line));
  });
  return lines;
}

function similarCoplaMatches(text) {
  const typedLines = String(text || "").split(/\r?\n/).map(normalizeForMatch).filter(line => line.length >= 6);
  const typedWhole = normalizeForMatch(text);
  if (!typedLines.length && typedWhole.length < 6) return [];
  const results = [];
  for (const copla of state.coplas) {
    if (state.submitEditingId && Number(copla.id) === Number(state.submitEditingId)) continue;
    const candidateLines = coplaMatchLines(copla);
    let best = 0;
    typedLines.forEach(typedLine => {
      candidateLines.forEach(candidateLine => {
        const score = textSimilarity(typedLine, candidateLine);
        if (score > best) best = score;
      });
    });
    const wholeScore = textSimilarity(typedWhole, normalizeForMatch(copla.text));
    if (wholeScore > best) best = wholeScore;
    if (best >= 0.82) results.push({ copla, score: best });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 4).map(item => item.copla);
}

function renderDuplicateSuggestions() {
  const box = $("#duplicateSuggestions");
  const textarea = $("#newText");
  if (!box || !textarea) return;
  const matches = similarCoplaMatches(textarea.value);
  if (!matches.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <p class="muted">Xa hai coplas parecidas no arquivo. Podes velas ou, se é a mesma copla escrita doutro xeito, engadir o teu texto coma variante súa:</p>
    ${matches.map(copla => `
      <div class="duplicate-suggestion">
        <div class="duplicate-suggestion-info">
          <strong>${escapeHtml(coplaTitle(copla))}</strong>
          <span>${escapeHtml(coplaPlaceLabel(copla))}</span>
        </div>
        <div class="duplicate-suggestion-actions">
          <button type="button" class="btn" data-view-duplicate="${copla.id}">Ver</button>
          <button type="button" class="btn" data-use-as-variant="${copla.id}">Usar como variante</button>
        </div>
      </div>
    `).join("")}
  `;
  all("[data-view-duplicate]", box).forEach(button => button.addEventListener("click", () => {
    openCoplaDrawer(Number(button.dataset.viewDuplicate));
  }));
  all("[data-use-as-variant]", box).forEach(button => button.addEventListener("click", () => {
    useCoplaAsVariant(Number(button.dataset.useAsVariant));
  }));
}

function hideDuplicateSuggestions() {
  const box = $("#duplicateSuggestions");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function useCoplaAsVariant(coplaId) {
  const target = state.coplas.find(item => Number(item.id) === Number(coplaId));
  if (!target) return;
  const typedText = $("#newText")?.value.trim() || "";
  startEditCopla(target.id);
  if (typedText) addVersionRow({ text: typedText });
  const feedback = $("#submitFeedback");
  if (feedback) feedback.textContent = "Cargouse a copla orixinal para editar, co teu texto engadido coma variante nova. Revisa e garda os cambios para confirmalo.";
}

function parseCoplaPasteBlock(raw) {
  return String(raw || "")
    .split(/\r?\n\s*\r?\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const isVolta = block.startsWith(">") && block.endsWith("<");
      const text = (isVolta ? block.slice(1, -1) : block).trim();
      return { text, isVolta };
    })
    .filter(item => item.text);
}

function serializePasteBlock(stanzas) {
  return stanzas.map(item => (item.isVolta ? `>${item.text}<` : item.text)).join("\n\n");
}

// Lugar e estado co que se engadirán as coplas pegadas. Cada lote ten o seu lugar (escóllese
// no propio panel); mentres non se toca, copia o do formulario de arriba.
function pasteDestination() {
  const place = state.pastePlace || { ids: state.submitTerritoryIds, general: state.submitGeneral };
  const territoryIds = Array.from(new Set(place.ids));
  const territoryState = place.general ? "general" : (territoryIds.length ? "assigned" : "unassigned");
  const territories = territoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  return { territoryIds, territoryState, territories, lugar: state.pasteLugar.trim(), label: coplaPlaceLabel({ territories, territory_state: territoryState, lugar: state.pasteLugar.trim() }) };
}

function ownPastePlace() {
  if (!state.pastePlace) state.pastePlace = { ids: [...new Set(state.submitTerritoryIds)], general: state.submitGeneral };
  return state.pastePlace;
}

function paintPastePlace() {
  const chips = $("#pasteTerritoryChips");
  if (!chips) return;
  const { territoryState, territories } = pasteDestination();
  const lugarList = $("#pasteLugarList");
  if (lugarList) lugarList.innerHTML = territoryState === "assigned" ? lugarOptionsMarkup(territories.map(item => item.id)) : "";
  chips.innerHTML = territoryState === "general"
    ? `<span class="selected-chip">Galiza enteira <small>Xeral</small><button type="button" data-remove-paste-territory="__general" aria-label="Retirar Galiza enteira">×</button></span>`
    : (territories.map(item => `<span class="selected-chip">${escapeHtml(item.nome)} <small class="level-badge level-${item.tipo}">${escapeHtml(territoryLabel(item))}</small><button type="button" data-remove-paste-territory="${escapeHtml(item.id)}" aria-label="Retirar ${escapeHtml(item.nome)}">×</button></span>`).join("")
      || `<p class="muted">Sen asignar.</p>`);
  all("[data-remove-paste-territory]", chips).forEach(button => button.addEventListener("click", () => {
    const place = ownPastePlace();
    if (button.dataset.removePasteTerritory === "__general") place.general = false;
    else place.ids = place.ids.filter(id => id !== button.dataset.removePasteTerritory);
    paintPastePlace();
    updatePasteBlockPreview({ keepDupes: true });
  }));
}

function bindPastePlacePicker() {
  const input = $("#pasteTerritoryQuery");
  const results = $("#pasteTerritoryResults");
  if (!input || !results) return;
  input.addEventListener("input", () => {
    const query = input.value.trim();
    if (!query) { results.innerHTML = ""; return; }
    const matches = searchTerritories(state.territorios, query).slice(0, 8);
    results.innerHTML = matches.map(item => `
      <button type="button" data-paste-pick-territory="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.nome)}</strong>
        <span>${escapeHtml(territorySearchMeta(item))}</span>
      </button>`).join("") || `<p class="muted">Sen resultados.</p>`;
    all("[data-paste-pick-territory]", results).forEach(button => button.addEventListener("click", () => {
      const territory = state.territorios.find(item => item.id === button.dataset.pastePickTerritory);
      if (!territory) return;
      const place = ownPastePlace();
      place.general = false;
      if (!place.ids.includes(territory.id)) place.ids.push(territory.id);
      input.value = "";
      results.innerHTML = "";
      paintPastePlace();
      updatePasteBlockPreview({ keepDupes: true });
    }));
  });
  $("#pasteMarkGeneral")?.addEventListener("click", () => {
    const place = ownPastePlace();
    place.general = true;
    place.ids = [];
    paintPastePlace();
    updatePasteBlockPreview({ keepDupes: true });
  });
  $("#pasteLugar")?.addEventListener("input", event => {
    state.pasteLugar = event.target.value;
    updatePasteBlockPreview({ keepDupes: true });
  });
  paintPastePlace();
}

function pasteBlockPanelMarkup() {
  const count = parseCoplaPasteBlock(state.pasteDraft).length;
  return `
    <details class="panel paste-panel"${count || state.pasteFeedback || state.submitBatch.length ? " open" : ""}>
      <summary>
        <span class="paste-summary-title">Pegar varias coplas dun golpe</span>
        <span class="paste-summary-sub">Unha liña en branco separa as coplas \\ as voltas van entre &gt; e &lt; \\ podes pegar varios lotes, cada un co seu territorio e lugar</span>
        <span class="paste-badge" id="pasteBadge"${count ? "" : " hidden"}>${count}</span>
      </summary>
      <div class="paste-body">
        <div class="paste-editor">
          <label for="pasteBlock">Texto do lote</label>
          <textarea id="pasteBlock" rows="14" spellcheck="false" placeholder="Pega aquí as coplas...&#10;&#10;Cada copla separada da seguinte por unha liña en branco.&#10;&#10;&gt;Esta enteira é unha volta&#10;e remata así&lt;">${escapeHtml(state.pasteDraft)}</textarea>
          <div class="paste-legend">
            <span><kbd>liña en branco</kbd>separa unha copla da seguinte</span>
            <span><kbd>&gt; ... &lt;</kbd>marca a copla enteira como volta</span>
          </div>
          <div class="paste-place field">
            <label for="pasteTerritoryQuery">Territorio deste lote</label>
            <input id="pasteTerritoryQuery" type="search" placeholder="Sen asignar. Escribe para buscar parroquia, concello, comarca..." autocomplete="off">
            <div id="pasteTerritoryResults" class="territory-results compact"></div>
            <div id="pasteTerritoryChips" class="selected-chips"></div>
            <button class="link-button" type="button" id="pasteMarkGeneral">Marcar coma "Galiza enteira"</button>
            <label for="pasteLugar">Lugar (opcional, dentro da parroquia)</label>
            <input id="pasteLugar" type="text" list="pasteLugarList" maxlength="80" value="${escapeHtml(state.pasteLugar)}" placeholder="Ex.: Laxoso" autocomplete="off">
            <datalist id="pasteLugarList"></datalist>
          </div>
        </div>
        <div class="paste-preview" aria-live="polite">
          <div class="paste-preview-head">
            <strong id="pasteSummary"></strong>
            <button class="link-button" type="button" id="pasteCheckDupes">Buscar parecidas no arquivo</button>
          </div>
          <ol id="pasteList" class="paste-list"></ol>
          <p class="paste-dest">Este lote engadirase en <b id="pasteDest"></b>. Despois podes pegar outro lote con outro territorio ou lugar.</p>
        </div>
      </div>
      <div class="paste-actions">
        <button class="btn" type="button" id="clearPasteBlock">Limpar</button>
        <button class="btn primary" type="button" id="parsePasteBlock" disabled>Engadir lote á lista</button>
        <button class="btn" type="button" id="pasteSaveAll"${state.submitBatch.length ? "" : " hidden"}>Gardar todas (${state.submitBatch.length})</button>
      </div>
      <p id="pasteBlockFeedback" class="muted">${escapeHtml(state.pasteFeedback || "")}</p>
    </details>
  `;
}

function updatePasteBlockPreview({ keepDupes = false } = {}) {
  const textarea = $("#pasteBlock");
  const list = $("#pasteList");
  if (!textarea || !list) return;
  state.pasteDraft = textarea.value;
  if (!keepDupes) state.pasteDupes = null;
  const stanzas = parseCoplaPasteBlock(textarea.value);
  const voltas = stanzas.filter(item => item.isVolta).length;
  const plural = stanzas.length === 1 ? "" : "s";
  $("#pasteSummary").textContent = stanzas.length
    ? `${stanzas.length} copla${plural} detectada${plural}${voltas ? ` \\ ${voltas} volta${voltas === 1 ? "" : "s"}` : ""}`
    : "Aínda non hai nada que repartir";
  const destination = pasteDestination();
  $("#pasteDest").textContent = destination.label;
  const badge = $("#pasteBadge");
  if (badge) {
    badge.textContent = String(stanzas.length);
    badge.hidden = !stanzas.length;
  }
  $("#parsePasteBlock").disabled = !stanzas.length;
  $("#parsePasteBlock").textContent = stanzas.length ? `Engadir ${stanzas.length} copla${plural} (${destination.label}) á lista` : "Engadir lote á lista";
  $("#pasteCheckDupes").hidden = !stanzas.length;
  list.innerHTML = stanzas.map((item, index) => {
    const lines = item.text.split(/\r?\n/).filter(line => line.trim());
    const dupe = state.pasteDupes?.[index];
    // Só as voltas levan etiqueta; nas demais o botón de marcar volta aparece ao pasar por riba.
    const voltaControl = item.isVolta
      ? `<button type="button" class="paste-volta is-on" data-paste-volta="${index}" aria-pressed="true" title="Quitar a marca de volta"><span class="tag is-volta">Volta</span></button>`
      : `<button type="button" class="paste-volta" data-paste-volta="${index}" aria-pressed="false" title="Marcar como volta">Marcar volta</button>`;
    return `
      <li class="paste-item${item.isVolta ? " is-volta" : ""}">
        <span class="paste-num">${index + 1}</span>
        <div class="paste-item-text">
          <strong>${escapeHtml(lines[0] || "")}</strong>
          <span>${lines.length} verso${lines.length === 1 ? "" : "s"}${lines[1] ? ` \\ ${escapeHtml(lines[1].length > 60 ? `${lines[1].slice(0, 57)}…` : lines[1])}` : ""}</span>
          ${dupe ? `<span class="paste-dupe">Parecida a <button type="button" class="link-button" data-paste-view-dupe="${dupe.id}">${escapeHtml(coplaTitle(dupe))}</button></span>` : ""}
        </div>
        <div class="paste-item-actions">
          ${voltaControl}
          <button type="button" class="paste-remove" data-paste-remove="${index}" aria-label="Quitar a copla ${index + 1}" title="Quitar">×</button>
        </div>
      </li>`;
  }).join("");
  all("[data-paste-volta]", list).forEach(button => button.addEventListener("click", () => {
    const current = parseCoplaPasteBlock(textarea.value);
    const target = current[Number(button.dataset.pasteVolta)];
    if (!target) return;
    target.isVolta = !target.isVolta;
    textarea.value = serializePasteBlock(current);
    updatePasteBlockPreview({ keepDupes: true });
  }));
  all("[data-paste-remove]", list).forEach(button => button.addEventListener("click", () => {
    const current = parseCoplaPasteBlock(textarea.value);
    current.splice(Number(button.dataset.pasteRemove), 1);
    textarea.value = serializePasteBlock(current);
    updatePasteBlockPreview();
  }));
  all("[data-paste-view-dupe]", list).forEach(button => button.addEventListener("click", () => openCoplaDrawer(Number(button.dataset.pasteViewDupe))));
}

function bindPasteBlock() {
  const textarea = $("#pasteBlock");
  if (!textarea) return;
  textarea.addEventListener("input", () => {
    state.pasteFeedback = "";
    const feedback = $("#pasteBlockFeedback");
    if (feedback) feedback.textContent = "";
    updatePasteBlockPreview();
  });
  $("#clearPasteBlock")?.addEventListener("click", () => {
    textarea.value = "";
    state.pasteFeedback = "";
    $("#pasteBlockFeedback").textContent = "";
    updatePasteBlockPreview();
    textarea.focus();
  });
  $("#pasteCheckDupes")?.addEventListener("click", () => {
    const stanzas = parseCoplaPasteBlock(textarea.value).slice(0, 60);
    state.pasteDupes = stanzas.map(item => similarCoplaMatches(item.text)[0] || null);
    const found = state.pasteDupes.filter(Boolean).length;
    $("#pasteBlockFeedback").textContent = found ? `${found} das coplas lémbranse a outras que xa están no arquivo. Revísaas antes de engadir.` : "Non se atopou ningunha parecida no arquivo.";
    updatePasteBlockPreview({ keepDupes: true });
  });
  $("#parsePasteBlock")?.addEventListener("click", queuePasteBlock);
  $("#pasteSaveAll")?.addEventListener("click", saveCoplaDirect);
  bindPastePlacePicker();
  updatePasteBlockPreview({ keepDupes: true });
}

// Pasa o lote pegado á lista de pendentes co seu lugar e deixa o panel listo para o seguinte
// lote (texto baleiro e lugar sen escoller). Todo se garda xunto con «Gardar todas».
function queuePasteBlock() {
  const textarea = $("#pasteBlock");
  const feedback = $("#pasteBlockFeedback");
  if (!textarea) return;
  const stanzas = parseCoplaPasteBlock(textarea.value);
  if (!stanzas.length) {
    if (feedback) feedback.textContent = "Pega polo menos unha copla antes de repartir.";
    return;
  }
  const { territoryIds, territoryState, territories, label, lugar } = pasteDestination();
  const lot = ++state.pasteLotSeq;
  stanzas.forEach(({ text, isVolta }) => {
    const payload = {
      text,
      notes: "",
      status: "published",
      territory_state: territoryState,
      territories: territoryState === "assigned" ? territoryIds.map(id => ({ id })) : [],
      tags: [],
      is_volta: isVolta,
      lugar: lugar || null,
      versions: [],
    };
    state.submitBatch.push({
      payload,
      placeLabel: coplaPlaceLabel({ territories, territory_state: territoryState, lugar }),
      preview: firstLine(text) || "Copla sen íncipit",
      versionCount: 0,
      isVolta,
      lot,
    });
  });
  const voltaCount = stanzas.filter(item => item.isVolta).length;
  state.pasteDraft = "";
  state.pasteDupes = null;
  state.pastePlace = { ids: [], general: false };
  state.pasteLugar = "";
  state.pasteFeedback = `Lote engadido: ${stanzas.length} copla${stanzas.length === 1 ? "" : "s"} en ${label}${voltaCount ? ` (${voltaCount} volta${voltaCount === 1 ? "" : "s"})` : ""}. Pega outro lote con outro territorio ou lugar ou preme «Gardar todas (${state.submitBatch.length})».`;
  renderSubmitView();
  // Fica no panel de pegar para continuar co seguinte lote (a lista de pendentes está enriba).
  $(".paste-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function startEditCopla(coplaId) {
  const copla = state.coplas.find(item => Number(item.id) === Number(coplaId));
  if (!copla) return;
  state.submitReturnView = {
    view: state.view,
    selectedTerritory: state.selectedTerritory,
    coplaQuery: state.coplaQuery,
    coplaStateFilter: state.coplaStateFilter,
  };
  state.submitEditingId = copla.id;
  state.submitEditingSnapshot = copla;
  state.submitBatch = [];
  state.submitTerritoryIds = (copla.territories || []).map(item => item.id);
  state.submitTerritoryId = state.submitTerritoryIds[0] || "";
  state.submitGeneral = copla.territory_state === "general";
  closeCoplaDrawer();
  setView("submit");
}

function cancelEditCopla() {
  state.submitEditingId = null;
  state.submitEditingSnapshot = null;
  state.submitReturnView = null;
  state.submitTerritoryIds = [];
  state.submitTerritoryId = "";
  state.submitGeneral = false;
  renderSubmitView();
}

async function fetchMediaMetadata(options = {}) {
  const feedback = $("#mediaFeedback");
  const url = $("#mediaUrl")?.value.trim();
  if (!url) {
    if (!options.silent && feedback) feedback.textContent = "Pega primeiro unha URL.";
    return;
  }
  if (feedback && !options.silent) setLoading(feedback, "Lendo metadatos da ligazón");
  try {
    const kind = mediaKind({ url });
    if ($("#mediaKind") && kind !== "web" && kind !== "media") $("#mediaKind").value = kind;
    const response = await fetch(`../api/link-preview?url=${encodeURIComponent(url)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puideron ler metadatos.");
    if (result.title && !$("#mediaTitle").value.trim()) $("#mediaTitle").value = result.title;
    if (result.description && !$("#mediaDescription").value.trim()) $("#mediaDescription").value = result.description;
    if (result.thumbnail_url && !$("#mediaThumb").value.trim()) $("#mediaThumb").value = result.thumbnail_url;
    if (!$("#mediaSource").value.trim()) $("#mediaSource").value = result.author_or_source || result.provider || "";
    if (MUSICAL_MEDIA_KINDS.has(kind) && $("#mediaRole")) $("#mediaRole").value = "mixed";
    if (feedback) feedback.textContent = "Metadatos incorporados.";
  } catch (error) {
    if (feedback && !options.silent) feedback.textContent = `${error.message} Podes completar os campos manualmente.`;
  }
}

async function saveMediaDirect() {
  const payload = buildMediaPayloadFromForm();
  if (!payload) return;
  const wasEditing = Boolean(state.mediaEditingId);
  const feedback = $("#mediaFeedback");
  setLoading(feedback, wasEditing ? "Gardando cambios" : "Gardando recurso");
  try {
    const response = await fetch("../api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido gardar a media.");
    feedback.textContent = wasEditing ? "Cambios gardados." : `Media gardada. IDs afectados: ${result.ids.join(", ")}`;
    clearApiCache();
    state.media = await loadMedia();
    if (!wasEditing) {
      const firstTerritoryId = payload.media[0].links.find(link => link.entity_type === "territory")?.entity_id;
      if (firstTerritoryId) state.selectedTerritory = state.territorios.find(item => item.id === firstTerritoryId) || state.selectedTerritory;
    }
    state.mediaModalOpen = false;
    state.mediaDefaultRole = "";
    state.mediaEditingId = null;
    state.mediaEditingSnapshot = null;
    state.mediaEditingPieceLinks = [];
    state.mediaTerritoryIds = [];
    state.mediaCoplaIds = [];
    state.mediaMelodyIds = [];
    state.mediaQuery = "";
    state.mediaKindFilter = "";
    state.mediaRoleFilter = "";
    renderMediaView();
  } catch (error) {
    feedback.textContent = `${error.message} Comproba que estás usando ./serve.sh 8765.`;
  }
}

function renderMediaView() {
  const view = $("#view-media");
  if (!state.mediaTerritoryIds.length && state.selectedTerritory) state.mediaTerritoryIds = [state.selectedTerritory.id];
  const selectedMediaTerritories = state.mediaTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  const selectedMediaCoplas = state.mediaCoplaIds.map(id => state.coplas.find(item => Number(item.id) === Number(id))).filter(Boolean);
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Media</h1>
        </div>
        <button class="btn primary" type="button" id="openMediaModal">+ Novo recurso</button>
      </div>
      <div class="toolbar media-toolbar">
        <div class="searchbox"><span>⌕</span><input id="mediaSearch" type="search" value="${escapeHtml(state.mediaQuery)}" placeholder="Buscar por título, fonte, territorio..."></div>
        <select id="mediaKindFilter" aria-label="Filtrar tipo de media">
          <option value="">Todos os tipos</option>
          ${["youtube", "spotify", "soundcloud", "audio", "video", "image", "pdf", "web"].map(kind => `<option value="${kind}" ${state.mediaKindFilter === kind ? "selected" : ""}>${mediaLabel(kind)}</option>`).join("")}
        </select>
        <select id="mediaRoleFilter" aria-label="Filtrar uso">
          <option value="">Todos os usos</option>
          ${["documental", "melody", "mixed"].map(role => `<option value="${role}" ${state.mediaRoleFilter === role ? "selected" : ""}>${mediaRoleLabel(role)}</option>`).join("")}
        </select>
        ${listViewToggleMarkup("data-media-view", state.mediaViewMode)}
      </div>
      <div id="mediaList" class="${state.mediaViewMode === "rows" ? "media-rows" : "media-grid"}">
      </div>
      ${mediaModalMarkup(selectedMediaTerritories, selectedMediaCoplas)}
    </div>
  `;
  $("#openMediaModal")?.addEventListener("click", () => openMediaModal());
  $("#mediaSearch")?.addEventListener("input", event => {
    state.mediaQuery = event.target.value;
    updateMediaResults(view);
  });
  $("#mediaKindFilter")?.addEventListener("change", event => {
    state.mediaKindFilter = event.target.value;
    updateMediaResults(view);
  });
  $("#mediaRoleFilter")?.addEventListener("change", event => {
    state.mediaRoleFilter = event.target.value;
    updateMediaResults(view);
  });
  all("[data-media-view]", view).forEach(button => button.addEventListener("click", () => {
    state.mediaViewMode = button.dataset.mediaView;
    saveViewPref("media", state.mediaViewMode);
    all("[data-media-view]", view).forEach(item => item.classList.toggle("active", item === button));
    updateMediaResults(view);
  }));
  all("[data-close-media-modal]", view).forEach(item => item.addEventListener("click", closeMediaModal));
  bindMediaTerritoryPicker();
  bindMediaCoplaPicker();
  bindMediaMelodyPicker();
  bindSelectedTerritoryChips(view);
  bindMediaCards(view);
  updateMediaResults(view);
  $("#saveMediaDirect")?.addEventListener("click", saveMediaDirect);
  $("#fetchMediaMeta")?.addEventListener("click", fetchMediaMetadata);
  $("#mediaUrl")?.addEventListener("blur", () => {
    if (!$("#mediaTitle")?.value.trim()) fetchMediaMetadata({ silent: true });
  });
}

function filteredMediaItems() {
  const baseItems = state.media;
  const query = normalizeText(state.mediaQuery);
  return baseItems.filter(item => {
    const matchesKind = !state.mediaKindFilter || mediaKind(item) === state.mediaKindFilter;
    const role = mediaRole(item);
    const matchesRole = !state.mediaRoleFilter || role === state.mediaRoleFilter || (state.mediaRoleFilter !== "mixed" && role === "mixed");
    const territories = mediaTerritories(item);
    const territoryContext = territories.flatMap(territory => buildHierarchy(territory, state.territorios))
      .map(territory => `${territory.nome} ${territorySearchMeta(territory)}`);
    const matchesText = !query || normalizeText([
      item.title,
      item.description,
      item.author_or_source,
      item.provider,
      item.url,
      mediaRoleLabel(role),
      mediaLabel(mediaKind(item)),
      territoryContext.join(" "),
      (item.links || []).map(link => `${link.entity_type} ${link.entity_id} ${link.relation_type}`).join(" "),
      mediaMelodies(item).map(melodyName).join(" "),
      mediaPieceTitle(item),
      item.visibility === "private" ? "privada" : "",
    ].join(" ")).includes(query);
    return matchesKind && matchesRole && matchesText;
  });
}

function bindMediaCardActions(root) {
  bindMediaCards(root);
  all("[data-edit-media]", root).forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    startEditMedia(Number(button.dataset.editMedia));
  }));
  all("[data-delete-media]", root).forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    openDeleteConfirm([Number(button.dataset.deleteMedia)], "media");
  }));
}

function updateMediaResults(root = $("#view-media")) {
  const list = $("#mediaList", root);
  if (!list) return;
  list.className = state.mediaViewMode === "rows" ? "media-rows" : "media-grid";
  mountInfiniteList(list, filteredMediaItems(), {
    key: `${state.mediaQuery}|${state.mediaKindFilter}|${state.mediaRoleFilter}|${state.mediaViewMode}`,
    renderItems: slice => slice.map(item => (state.mediaViewMode === "rows" ? mediaRow(item, { editable: true }) : mediaCard(item, { editable: true }))).join(""),
    bind: bindMediaCardActions,
    empty: `<article class="panel"><p class="muted">Aínda non hai recursos multimedia para mostrar.</p></article>`,
  });
}

function renderAboutTerritoryResults(root = $("#view-about")) {
  const results = $("#aboutTerritoryResults", root);
  if (!results) return;
  const query = state.aboutTerritoryQuery.trim();
  if (!query) {
    results.innerHTML = "";
    return;
  }
  const matches = searchTerritories(state.territorios, query).slice(0, 12);
  results.innerHTML = matches.map(item => `
    <button type="button" data-about-territory="${item.id}">
      <strong>${escapeHtml(item.nome)}</strong>
      <span>${escapeHtml(territorySearchMeta(item))}</span>
    </button>
  `).join("") || `<p class="muted">Sen resultados.</p>`;
  all("[data-about-territory]", results).forEach(button => button.addEventListener("click", () => {
    const territory = state.territorios.find(item => item.id === button.dataset.aboutTerritory);
    if (!territory) return;
    state.aboutTerritoryId = territory.id;
    state.aboutTerritoryQuery = territory.nome;
    const input = $("#aboutTerritorySearch", root);
    const label = $("#aboutTerritorySelected", root);
    if (input) input.value = territory.nome;
    if (label) label.textContent = `${territory.nome} \\ ${territorySearchMeta(territory)}`;
    results.innerHTML = "";
  }));
}

function submitAboutCopla(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const territory = state.territorios.find(item => item.id === state.aboutTerritoryId);
  const mediaFile = data.get("media_file");
  const payload = {
    text: String(data.get("text") || "").trim(),
    territory_id: territory?.id || "",
    territory_name: territory?.nome || String(data.get("territory_query") || "").trim(),
    source: String(data.get("source") || "").trim(),
    media_url: String(data.get("media_url") || "").trim(),
    media_file_name: mediaFile && typeof mediaFile === "object" ? mediaFile.name : "",
    notes: String(data.get("notes") || "").trim(),
  };
  const body = [
    "Nova copla enviada desde Fol e Ar",
    "",
    "Texto:",
    payload.text,
    "",
    `Territorio: ${payload.territory_name || "sen indicar"}`,
    `ID territorio: ${payload.territory_id || "sen confirmar"}`,
    `Fonte: ${payload.source || "sen indicar"}`,
    `Media/link: ${payload.media_url || "sen indicar"}`,
    payload.media_file_name ? `Arquivo mencionado: ${payload.media_file_name}` : "",
    "",
    "Notas:",
    payload.notes || "sen notas",
    "",
    "Payload para revisión:",
    JSON.stringify(payload, null, 2),
  ].filter(line => line !== "").join("\n");
  const subject = `Nova copla para Fol e Ar${payload.territory_name ? ` \\ ${payload.territory_name}` : ""}`;
  window.location.href = `mailto:folear3@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

const ABOUT_NAV = [
  { view: "map", name: "Mapa", text: "Toca un territorio para ver as súas coplas, melodías e recursos. As parroquias están dentro dos concellos, e estes dentro das comarcas." },
  { view: "territory", name: "Territorios", text: "Busca un territorio polo nome e móvete pola súa xerarquía: parroquia, concello, comarca e provincia." },
  { view: "coplas", name: "Coplas", text: "Procura por verso, íncipit, territorio, lugar ou etiqueta. Cada ficha amosa as variantes e os recursos relacionados." },
  { view: "melodies", name: "Melodías", text: "O inventario de melodías, agrupadas por ritmo e territorio, cos recursos onde se poden escoitar." },
  { view: "pieces", name: "Pezas", text: "A biblioteca de pezas montadas con coplas do arquivo e o obradoiro para compoñer as túas." },
  { view: "media", name: "Media", text: "Gravacións, vídeos, imaxes e documentos ligados ás coplas, ás melodías e ás pezas." },
  { view: "people", name: "Persoas", text: "O directorio de quen decidiu amosar o seu perfil, coas pezas que publicou.", accountsOnly: true },
];

function aboutAccountsMarkup() {
  if (!isGoogleMode()) return "";
  const cta = isAccount()
    ? `<button class="btn primary" type="button" data-view="profile">Ir ao meu espazo</button>`
    : `<a class="btn primary" href="${escapeHtml(loginLink())}">Entrar con Google</a>`;
  return `
    <section class="about-section">
      <div class="about-section-head"><div class="eyebrow">Contas</div><h2>Para consultar non fai falta conta</h2></div>
      <div class="about-cards">
        <article class="panel"><h3>Sen conta</h3><p>Podes consultar todo o arquivo e compoñer pezas no obradoiro. Non se che pide ningún dato. Para descargar un PDF hai que entrar.</p></article>
        <article class="panel"><h3>Con conta</h3><p>Entrando con Google tes o teu espazo e podes descargar PDFs (ata 15 ao día): favoritos de coplas, territorios, etiquetas, recursos, melodías e pezas; un perfil, se queres, para que che atopen; e podes seguir a outras persoas.</p></article>
        <article class="panel"><h3>Roles</h3><p>A maioría das contas son foleantes. As persoas guía axudan a editar o arquivo e a coidar a biblioteca de pezas; a administración xestiona os roles.</p></article>
      </div>
      <p class="about-cta">${cta}</p>
    </section>
    <section class="about-section">
      <div class="about-section-head"><div class="eyebrow">Pezas</div><h2>Gardar unha peza pide conta</h2></div>
      <p class="about-lead">Compoñer está ao alcance de todas as persoas. Gardar unha peza require conta, para que quede no teu perfil. As pezas son <strong>privadas</strong> (só as ves ti). Só as persoas guía ou admin poden facelas <strong>públicas</strong> (aparecen na biblioteca, abertas a calquera) e, ao gardalas, as súas coplas soltas pasan ao arquivo co territorio e o lugar da peza. Podes editar ou borrar as túas pezas cando queiras; se unha peza pública dá problemas, unha persoa guía pode agochala.</p>
    </section>
    <section class="about-section">
      <div class="about-section-head"><div class="eyebrow">PDF</div><h2>Para xerar un PDF pedimos que entres</h2></div>
      <p class="about-lead">Os PDFs de pezas e de territorios fanse cun servizo que ten unha cota diaria gratuíta. Pedir que a persoa estea logueada protexe esa cota de abusos e permite manter o arquivo aberto e gratuíto. Cada persoa pode descargar ata 15 PDFs ao día; consultar, buscar e compoñer non teñen límite nin piden conta.</p>
    </section>`;
}

function aboutMarkup() {
  const accounts = isGoogleMode();
  return `
    <div class="page about-page">
      <div class="page-head about-hero">
        <div>
          <div class="eyebrow">Sobre o arquivo</div>
          <h1 class="wordmark" aria-label="Fol e ar">f<svg class="wordmark-o" viewBox="0 0 60 54" aria-hidden="true" focusable="false"><path d="M49.56 21.27A20.45 20.45 0 1 1 35.98 7.69"/><circle cx="49.52" cy="7.73" r="5.6"/></svg>l e ar</h1>
          <p>Arquivo dixital para conservar, consultar e montar repertorio tradicional galego desde o territorio e desde o texto.</p>
        </div>
      </div>

      <section class="about-section">
        <div class="about-section-head"><div class="eyebrow">Como funciona</div><h2>Entrar polo territorio, polo texto ou polo son</h2></div>
        <p class="about-lead">O arquivo reúne coplas e repertorio tradicional galego e ligaos entre si. Podes comezar por onde che pete (un territorio no mapa, un verso, unha melodía) e ir saltando dunha cousa a outra seguindo esas relacións.</p>
        <div class="about-cards about-relations">
          <article class="panel"><h3>Copla</h3><p>É a peza básica: o texto, o seu íncipit (o primeiro verso), notas e etiquetas. Pode ter varias variantes e estar ligada a un ou varios territorios e, dentro dunha parroquia, a un lugar concreto (Laxoso...).</p></article>
          <article class="panel"><h3>Territorio</h3><p>Onde se canta ou se recolleu. Os territorios van en niveis (provincia, comarca, concello e parroquia) e cada un contén os de abaixo: ao abrir un concello ves tamén as coplas, melodías e recursos das súas parroquias.</p></article>
          <article class="panel"><h3>Lugar</h3><p>Opcional e máis fino ca o territorio: o nome dun lugar dentro dunha parroquia (Laxoso, por exemplo), que non ten mapa propio. Escríbese libremente, aparece diante do territorio e tamén se busca.</p></article>
          <article class="panel"><h3>Melodía</h3><p>O inventario de melodías, agrupadas por ritmo e territorio. Unha melodía pode servir a moitas coplas e levar un ou varios recursos onde escoitala.</p></article>
          <article class="panel"><h3>Recurso (media)</h3><p>Gravacións, vídeos, imaxes e documentos. Cada recurso pode estar ligado a unha copla, a unha melodía ou a unha peza, e así levarte de unha ao outro.</p></article>
          <article class="panel"><h3>Peza</h3><p>Unha selección ordenada de coplas, por voltas, para cantar ou ensaiar. Pode ser un repertorio propio ou o arranxo dun grupo ou artista; todas as pezas dunha mesma autoría xúntanse na súa ficha.</p></article>
          ${accounts ? `<article class="panel"><h3>Persoa</h3><p>Quen usa o arquivo con conta. Pode ter un perfil público co seu username, as súas pezas publicadas e os seus favoritos (se quere amosalos).</p></article>` : ""}
        </div>
      </section>

      <section class="about-section">
        <div class="about-section-head"><div class="eyebrow">Que podes facer</div><h2>Consultar, escoitar e montar repertorio</h2></div>
        <ul class="about-list">
          <li><strong>Consultar.</strong> Busca coplas por verso, íncipit, territorio, lugar ou etiqueta; filtra por territorio no mapa ou no listado de territorios; abre unha ficha para ver variantes, melodía e recursos.</li>
          <li><strong>Escoitar.</strong> Desde unha copla, unha melodía ou unha peza chegas aos recursos ligados: gravacións, vídeos e documentos.</li>
          <li><strong>Montar pezas.</strong> Con «Seleccionar varias» marcas coplas das listas e levas a unha peza; no obradoiro ordénalas por voltas, engade notas e, se queres, pega ou escribe coplas novas.${accounts ? " Sen conta podes compoñer; para gardar a peza hai que entrar." : ""}</li>
          <li><strong>Levar o repertorio en papel.</strong> Unha peza ou un territorio saen en PDF coas coplas completas, pensado para imprimir.${accounts ? " Para xerar o PDF pedimos que a persoa estea logueada." : ""}</li>
          <li><strong>Achegar.</strong> Se tes unha copla que falta ou unha corrección, usa o formulario de máis abaixo.</li>
        </ul>
      </section>

      <section class="about-section">
        <div class="about-section-head"><div class="eyebrow">Código de cores</div><h2>A cor di de que nivel é o territorio</h2></div>
        <p class="about-lead">Nas coplas, listas e fichas, cada territorio aparece cun punto e o seu nome na cor do seu nivel. A cor só indica a escala do lugar, non a cantidade nin a calidade das coplas.</p>
        <ul class="about-legend">
          <li><span class="level-text level-par">Parroquia</span><span>O territorio máis concreto: onde se cantou ou se recolleu a copla.</span></li>
          <li><span class="level-text level-con">Concello</span><span>Agrupa parroquias.</span></li>
          <li><span class="level-text level-com">Comarca</span><span>Agrupa concellos.</span></li>
          <li><span class="level-text level-prov">Provincia</span><span>O nivel máis xeral.</span></li>
          <li><span class="level-text level-empty">Sen territorio</span><span>Unha copla cuxo territorio aínda non se coñece. En gris, sen punto de cor.</span></li>
        </ul>
      </section>

      <section class="about-section">
        <div class="about-section-head"><div class="eyebrow">Como moverse</div><h2>As partes do arquivo</h2></div>
        <div class="about-nav">
          ${ABOUT_NAV.filter(item => !item.accountsOnly || accounts).map((item, index) => `
            <button type="button" class="about-nav-row" data-view="${item.view}">
              <span class="about-nav-num">${String(index + 1).padStart(2, "0")}</span>
              <span class="about-nav-body"><strong>${item.name}</strong><span>${item.text}</span></span>
              <span class="about-nav-go" aria-hidden="true">→</span>
            </button>`).join("")}
        </div>
      </section>

      ${aboutAccountsMarkup()}

      <section class="about-section">
        <div class="about-section-head"><div class="eyebrow">Contacto</div><h2>Dúbidas, correccións ou coplas para achegar</h2></div>
        <p class="about-lead">Escríbenos a <a href="mailto:folear3@gmail.com">folear3@gmail.com</a>, ou envía unha copla co formulario de abaixo para que a revise o equipo editorial.</p>
      </section>

      <section class="panel public-submit">
        <div class="section-title"><h2>Enviar unha copla</h2><span class="muted">Achega para revisión editorial</span></div>
        <form id="publicCoplaForm" class="formgrid">
          <div class="field full">
            <label>Texto da copla</label>
            <textarea name="text" rows="6" required placeholder="Escribe a copla conservando os saltos de verso..."></textarea>
          </div>
          <div class="field">
            <label>Territorio</label>
            <input id="aboutTerritorySearch" name="territory_query" type="search" value="${escapeHtml(state.aboutTerritoryQuery)}" placeholder="Buscar parroquia, concello...">
            <small id="aboutTerritorySelected">${state.aboutTerritoryId ? escapeHtml(state.territorios.find(item => item.id === state.aboutTerritoryId)?.nome || "") : "Podes deixalo sen confirmar se non o sabes."}</small>
            <div id="aboutTerritoryResults" class="territory-results compact"></div>
          </div>
          <div class="field">
            <label>Fonte</label>
            <input name="source" type="text" placeholder="Persoa, libro, recollida, memoria familiar...">
          </div>
          <div class="field">
            <label>Media ou ligazón</label>
            <input name="media_url" type="url" placeholder="YouTube, Spotify, web, arquivo publicado...">
          </div>
          <div class="field">
            <label>Arquivo local</label>
            <input name="media_file" type="file" accept="audio/*,video/*,image/*">
            <small>O navegador non pode anexalo automaticamente; o correo lembrará o nome do ficheiro.</small>
          </div>
          <div class="field full">
            <label>Notas</label>
            <textarea name="notes" rows="3" placeholder="Contexto, dúbidas, variante, quen a cantaba..."></textarea>
          </div>
          <div class="form-actions full">
            <button class="btn primary" type="submit">Enviar</button>
          </div>
        </form>
      </section>

      <footer class="about-foot">
        <svg class="isotipo about-foot-mark" viewBox="8 9 48 50" aria-hidden="true" focusable="false"><path d="M50.79 27.16A20 20 0 1 1 38.84 15.21"/><circle cx="51.1" cy="14.9" r="4.2"/></svg>
        <span class="about-foot-text">fol e ar \\ arquivo e repertorio</span>
        <a class="about-foot-link" href="./privacidade.html" data-privacy-link>Privacidade</a>
      </footer>
    </div>
  `;
}

async function renderAboutPrivacy() {
  const view = $("#view-about");
  view.innerHTML = `<div class="page about-page privacy-page"><p><button class="btn" type="button" data-privacy-back>← Sobre o arquivo</button></p><p class="muted">Cargando...</p></div>`;
  $("[data-privacy-back]", view)?.addEventListener("click", closeAboutPrivacy);
  let body = "";
  try {
    const response = await fetch("./privacidade.html", { cache: "no-cache" });
    if (!response.ok) throw new Error("non dispoñible");
    const doc = new DOMParser().parseFromString(await response.text(), "text/html");
    const main = doc.querySelector("main");
    main?.querySelectorAll(".back").forEach(node => node.remove());
    body = main ? main.innerHTML : "";
  } catch {
    body = `<p class="muted">Non se puido cargar a política agora mesmo. Ábrea en <a href="./privacidade.html">privacidade.html</a>.</p>`;
  }
  if (state.view !== "about" || !state.aboutPrivacy) return;
  view.innerHTML = `
    <div class="page about-page privacy-page">
      <p><button class="btn" type="button" data-privacy-back>← Sobre o arquivo</button></p>
      <div class="privacy-doc">${body}</div>
    </div>`;
  $("[data-privacy-back]", view)?.addEventListener("click", closeAboutPrivacy);
  window.scrollTo(0, 0);
}

function openAboutPrivacy() {
  state.aboutPrivacy = true;
  if (window.location.hash !== "#/privacidade") history.pushState({ fv: "about" }, "", `${window.location.pathname}${window.location.search}#/privacidade`);
  if (state.view === "about") renderAboutView(); else setView("about", { push: false });
}

function openAboutPrivacyFromRoute() {
  state.aboutPrivacy = true;
  if (state.view === "about") renderAboutView(); else setView("about", { push: false });
}

function closeAboutPrivacy() {
  state.aboutPrivacy = false;
  if (window.location.hash === "#/privacidade") history.pushState({ fv: "about" }, "", routeUrl(false));
  renderAboutView();
  window.scrollTo(0, 0);
}

function renderAboutView() {
  if (state.aboutPrivacy) {
    renderAboutPrivacy();
    return;
  }
  $("#view-about").innerHTML = aboutMarkup();
  $("#aboutTerritorySearch")?.addEventListener("input", event => {
    state.aboutTerritoryQuery = event.target.value;
    state.aboutTerritoryId = "";
    renderAboutTerritoryResults();
  });
  $("#publicCoplaForm")?.addEventListener("submit", submitAboutCopla);
  renderAboutTerritoryResults();
}

function downloadText(filename, text, type = "text/plain") {
  const blob = new Blob([`${text}\n`], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderView() {
  if (state.view === "coplas") renderCoplasView();
  if (state.view === "melodies") renderMelodiesView();
  if (state.view === "pieces") renderPiecesView();
  if (state.view === "territory") renderTerritoryView();
  if (state.view === "submit") renderSubmitView();
  if (state.view === "media") renderMediaView();
  if (state.view === "about") renderAboutView();
  if (state.view === "profile") window.folearProfile?.renderProfile();
  if (state.view === "people") window.folearProfile?.renderPeople();
}

function bindGlobalEvents() {
  bindMelodyEvents();
  bindMobileExplore();
  // «Privacidade» (pé de «Sobre o arquivo», perfil...) abre a política dentro da aplicación.
  document.addEventListener("click", event => {
    if (!event.target.closest("[data-privacy-link]")) return;
    event.preventDefault();
    openAboutPrivacy();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !state.coplaSelectMode || state.view !== "coplas") return;
    if (state.batchAssignModalOpen || state.deleteConfirmOpen || !$("#coplaDrawer")?.hidden) return;
    const field = document.activeElement;
    if (field && ["INPUT", "TEXTAREA", "SELECT"].includes(field.tagName) && field.type !== "checkbox") return;
    setCoplaSelectMode(false);
  });
  window.addEventListener("hashchange", () => {
    if (!history.state?.fv) history.replaceState({ fv: state.view }, "", window.location.href);
    if (window.location.hash === "#/privacidade" && !state.aboutPrivacy) openAboutPrivacyFromRoute();
    else if (window.location.hash.startsWith("#/autoria/") && state.dataReady && applyAuthorHash()) {
      closePieceDrawer();
      if (state.view === "pieces") renderPiecesView(); else setView("pieces", { push: false });
    }
  });
  // Botón Atrás/Adiante: a URL e o estado da entrada mandan.
  window.addEventListener("popstate", event => {
    if (!state.historyReady || !state.dataReady) return;
    const hash = window.location.hash;
    if (hash.startsWith("#/autoria/")) applyAuthorHash();
    else state.pieceAuthorFilter = "";
    state.aboutPrivacy = hash === "#/privacidade";
    closeCoplaDrawer();
    closePieceDrawer();
    closeMelodyDrawer();
    closePdfViewer();
    const view = event.state?.fv
      || (hash.startsWith("#/autoria/") ? "pieces" : hash === "#/privacidade" ? "about" : hash.startsWith("#/persoa/") ? "people" : state.view);
    setView(view, { push: false });
  });
  document.addEventListener("click", event => {
    const nav = event.target.closest("[data-view]");
    if (nav) {
      if (normalizeView(nav.dataset.view) === "media" && nav.dataset.mediaRole) {
        state.mediaDefaultRole = nav.dataset.mediaRole;
        state.mediaModalOpen = true;
      }
      if (normalizeView(nav.dataset.view) === "territory") {
        state.selectedTerritory = null;
        state.territoryTab = "coplas";
        state.territoryQuery = "";
        state.territoryCoplaQuery = "";
      }
      if (normalizeView(nav.dataset.view) === "submit") {
        state.submitEditingId = null;
        state.submitEditingSnapshot = null;
      }
      setView(nav.dataset.view);
    }
  });
  $("#collapseBtn")?.addEventListener("click", () => {
    const sidebar = $("#sidebar");
    sidebar.classList.toggle("collapsed");
    const icon = $("#collapseBtn .nav-icon");
    const label = $("#collapseBtn span:last-child");
    if (icon) icon.textContent = sidebar.classList.contains("collapsed") ? "›" : "‹";
    if (label) label.textContent = sidebar.classList.contains("collapsed") ? "Abrir" : "Contraer";
    window.setTimeout(() => state.map?.invalidateSize(), 250);
  });
  $("#clearTerritory")?.addEventListener("click", clearTerritory);
  $("#resetMapViewBtn")?.addEventListener("click", clearTerritory);
  $("#mapCardToggle")?.addEventListener("click", () => {
    setMapCardCollapsed(!$(".map-card")?.classList.contains("is-collapsed"));
  });
  $("#mapLayer")?.addEventListener("change", event => loadLayer(event.target.value));
  $("#mapSearch")?.addEventListener("input", event => renderMapSearch(event.target.value));
  $("#mapSearchBtn")?.addEventListener("click", () => {
    const query = $("#mapSearch").value;
    const firstTerritory = searchTerritories(state.territorios, query)[0];
    if (firstTerritory) selectTerritory(firstTerritory);
    else {
      state.coplaQuery = query;
      setView("coplas");
    }
  });
  $("#mapSearch")?.addEventListener("keydown", event => {
    if (event.key === "Enter") $("#mapSearchBtn").click();
  });
  all("[data-map-action]").forEach(button => button.addEventListener("click", () => {
    setView(button.dataset.mapAction === "territory" ? "territory" : "coplas");
  }));
  if (window.matchMedia?.("(max-width: 920px)").matches) setMapCardCollapsed(true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (state.melodyModal) {
        closeMelodyModal();
        return;
      }
      if (!$("#melodyDrawer")?.hidden) {
        closeMelodyDrawer();
        return;
      }
      if (state.mediaModalOpen) {
        closeMediaModal();
        return;
      }
      if (state.view === "pieces" && state.pieceTab === "workshop" && (state.pieceEntryModal || state.pieceAddMenu)) {
        state.pieceEntryModal = "";
        state.pieceAddMenu = false;
        renderPiecesView();
        return;
      }
      closeCoplaDrawer();
      if (state.selectedTerritory && state.view === "map") clearTerritory();
    }
  });
}

async function init() {
  bindGlobalEvents();
  bindCoplaDrawerNav();
  updateCartBadges();
  setView(normalizeView(new URL(window.location.href).searchParams.get("mode") || new URL(window.location.href).searchParams.get("view") || "map"));

  const [territorios, coplas, pezas, media, melodias] = await Promise.allSettled([
    getTerritorios(),
    getCoplas(),
    getPezas({ account: isAccount(), moderator: isEditorAccount() }),
    loadMedia(),
    getMelodias(),
  ]);
  state.territorios = territorios.status === "fulfilled" ? territorios.value : [];
  state.coplas = coplas.status === "fulfilled" ? coplas.value : [];
  state.pezas = pezas.status === "fulfilled" ? pezas.value : [];
  state.media = media.status === "fulfilled" ? media.value : [];
  state.melodias = melodias.status === "fulfilled" ? melodias.value : [];
  state.dataReady = true;
  // Se a sesión se resolveu mentres cargaba, completa as pezas da persoa.
  if ((isAccount() || isEditorAccount()) && !state.pezas.some(piece => piece.mine)) await refreshPezas({ render: false });
  initPdfThumbs();

  if (window.L) {
    state.map = L.map("map", { zoomControl: false, attributionControl: false, zoomSnap: 0.25 }).setView([42.8, -8.2], 8);
    L.control.zoom({ position: "bottomleft" }).addTo(state.map);
    try {
      await loadLayer("con");
    } catch (error) {
      console.error(error);
      $("#map").insertAdjacentHTML("beforeend", `<div class="map-load-error">Non se puido cargar a capa territorial.</div>`);
    }
  } else {
    $("#map").innerHTML = `<div class="map-fallback"><h2>Non se puido cargar Leaflet</h2><p>Comproba a conexión ou serve a libraría localmente.</p></div>`;
  }

  document.getElementById("global-loading")?.setAttribute("hidden", "");

  const params = new URL(window.location.href).searchParams;
  const territoryId = params.get("territory_id") || params.get("id");
  const coplaId = params.get("copla_id");
  if (territoryId) {
    const territory = state.territorios.find(item => item.id === territoryId);
    if (territory) await selectTerritory(territory);
  }
  if (coplaId) state.selectedCoplaId = Number(coplaId);

  if (window.location.hash === "#/privacidade") state.aboutPrivacy = true;
  const authorRoute = !coplaId && applyAuthorHash();
  updateMapCard();
  setView(coplaId ? "coplas" : authorRoute ? "pieces" : window.location.hash === "#/privacidade" ? "about" : state.resumeWorkshop ? "pieces" : normalizeView(params.get("mode") || params.get("view") || "map"));
  history.replaceState({ fv: state.view }, "", window.location.href);
  state.historyReady = true;
  if (coplaId) openCoplaDrawer(Number(coplaId));
}

// Ganchos para js/profile.js (espazo persoal): reutiliza o apertado de resultados.
window.folearApp = {
  bindResultButtons,
  pieces: () => state.pezas,
  media: () => state.media,
  melodies: () => state.melodias,
  refreshPezas,
  openAuthor,
  authors: () => authorDirectory().map(entry => entry.name),
  authorEntries,
  openPrivacy: openAboutPrivacy,
  openPiece(id) { openPieceDrawer(Number(id)); },
  openMelody(id) { openMelodyDrawer(Number(id)); },
  searchCoplas(query) {
    state.coplaQuery = String(query || "");
    state.coplaStateFilter = "all";
    closePieceDrawer();
    setView("coplas");
  },
  editPiece(id) {
    const piece = state.pezas.find(item => Number(item.id) === Number(id));
    if (!piece || !editPieceInWorkshop(piece)) return;
    state.pieceTab = "workshop";
    setView("pieces");
  },
  newPiece() {
    state.pieceTab = "workshop";
    setView("pieces");
  },
};

// A sesión resólvese despois de cargar a aplicación: ao entrar ou saír, as
// pezas da persoa (privadas) aparecen ou desaparecen da biblioteca.
let lastAuthKey = null;
function onAuthChange() {
  const key = isAccount() ? `${authInfo().user.id ?? authInfo().user.email}|${authInfo().user.role}` : "anon";
  if (key === lastAuthKey) return;
  lastAuthKey = key;
  if (state.dataReady) refreshPezas();
  if (state.view === "about" && !state.aboutPrivacy) renderAboutView();
  if (isAccount() && storageGet(RESUME_KEY) === "pieces-workshop") {
    storageSet(RESUME_KEY, "");
    state.pieceTab = "workshop";
    if (state.dataReady) setView("pieces");
    else state.resumeWorkshop = true;
  }
}
window.addEventListener("folear:auth", onAuthChange);
if (window.folearAuth?.ready) onAuthChange();

init().catch(error => {
  console.error(error);
  document.getElementById("global-loading")?.setAttribute("hidden", "");
  const active = $(".view.active");
  if (active) {
    active.insertAdjacentHTML("afterbegin", `<div class="runtime-warning">Erro parcial ao cargar: ${escapeHtml(error.message)}</div>`);
  }
});
