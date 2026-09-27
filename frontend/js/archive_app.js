import { clearApiCache, getCoplas, getGeoLayer, getMedia, getPezas, getTerritorios } from "./api.js";
import { escapeHtml, nl2br, normalizeText, slugify } from "./utils.js";
import {
  TYPE_LABELS,
  buildHierarchy,
  filterCoplasByTerritory,
  filterMediaByContext,
  filterPiecesByTerritory,
  findTerritoryByFeature,
  getChildren,
  getDescendantIds,
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
const VIEWS = ["map", "coplas", "pieces", "territory", "submit", "media", "about"];

const state = {
  territorios: [],
  coplas: [],
  pezas: [],
  media: [],
  map: null,
  layer: null,
  layerType: "con",
  selectedTerritory: null,
  selectedCoplaId: null,
  miniMap: null,
  miniLayer: null,
  view: "map",
  territoryTab: "summary",
  coplaViewMode: "gallery",
  pieceTab: "library",
  coplaQuery: "",
  coplaStateFilter: "all",
  territoryQuery: "",
  territoryCoplaQuery: "",
  pieceLibraryQuery: "",
  pieceTerritoryQuery: "",
  pieceRepositoryQuery: "",
  pieceRhythmQuery: "",
  pieceAuthorFilter: "",
  pieceEntryModal: "",
  pieceNotice: "",
  mediaQuery: "",
  mediaKindFilter: "",
  mediaRoleFilter: "",
  mediaModalOpen: false,
  mediaDefaultRole: "",
  aboutTerritoryQuery: "",
  aboutTerritoryId: "",
  submitTerritoryId: "",
  submitTerritoryIds: [],
  submitEditingId: null,
  submitEditingSnapshot: null,
  submitBatch: [],
  mediaTerritoryIds: [],
  mediaCoplaIds: [],
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
  };
  return aliases[view] || (VIEWS.includes(view) ? view : "map");
}

function defaultDraft() {
  return {
    title: "",
    author: "",
    notes: "",
    status: "draft",
    territoryId: "",
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

function territoryLabel(territory) {
  return territory ? (TYPE_LABELS[territory.tipo] || territory.tipo || "Territorio") : "Territorio";
}

function parentCouncil(territory) {
  if (!territory || territory.tipo !== "par") return null;
  return state.territorios.find(item => item.tipo === "con" && item.cod === territory.con) || null;
}

function territoryChildButton(item) {
  const full = territoryHasCoplas(item);
  return `<button type="button" class="${full ? "has-coplas" : ""}" data-territory-id="${item.id}"><strong>${escapeHtml(item.nome)}</strong><span>${escapeHtml(territorySearchMeta(item))}</span></button>`;
}

function territorySearchMeta(territory) {
  const council = parentCouncil(territory);
  return council ? `${territoryLabel(territory)} · ${council.nome}` : territoryLabel(territory);
}

function territoryDisplayName(territory) {
  const council = parentCouncil(territory);
  return council ? `${territory.nome} · ${council.nome}` : territory.nome;
}

function coplaPlaceLabel(copla) {
  if ((copla.territories || []).length) return copla.territories.map(item => territoryDisplayName(item)).join(", ");
  if (copla.territory_state === "general") return "Galiza xeral";
  if (copla.territory_state === "unassigned") return "Lugar descoñecido";
  return "Sen territorio";
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
    };
  }
  const descendantIds = getDescendantIds(territory, state.territorios);
  const coplas = filterCoplasByTerritory(state.coplas, descendantIds);
  const pezas = filterPiecesByTerritory(state.pezas, descendantIds, coplas);
  const media = filterMediaByContext(state.media, descendantIds, coplas, pezas);
  return {
    hierarchy: buildHierarchy(territory, state.territorios),
    children: getChildren(territory, state.territorios),
    descendantIds,
    coplas,
    pezas,
    media,
  };
}

function coplaHaystack(copla) {
  return [
    copla.text,
    copla.incipit,
    copla.notes,
    copla.territory_state,
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

function mediaCard(item) {
  const url = mediaUrl(item);
  const kind = mediaKind(item);
  const title = item.title || item.label || item.name || "Recurso sen título";
  const description = item.description || item.notes || item.artist || item.context || "";
  const role = mediaRole(item);
  const territoryLinks = mediaTerritories(item).map(territory => territory.nome);
  const linkedCoplas = mediaCoplas(item);
  const yt = kind === "youtube" ? youtubeId(url) : "";
  let preview = `<div class="media-preview is-${kind}"><span>${escapeHtml(mediaLabel(kind))}</span></div>`;
  if (item.thumbnail_url) preview = `<img class="media-preview" src="${escapeHtml(item.thumbnail_url)}" alt="">`;
  if (kind === "image" && url) preview = `<img class="media-preview" src="${escapeHtml(url)}" alt="">`;
  if (kind === "youtube" && yt) preview = `<img class="media-preview" src="https://img.youtube.com/vi/${escapeHtml(yt)}/hqdefault.jpg" alt="">`;
  if (kind === "audio" && url) preview = `<div class="media-preview is-audio"><span>Audio</span><audio controls src="${escapeHtml(url)}"></audio></div>`;
  if (kind === "video" && url) preview = `<video class="media-preview" controls src="${escapeHtml(url)}"></video>`;
  return `
    <article class="media-card" tabindex="${url ? "0" : "-1"}" role="${url ? "link" : "article"}" data-open-media="${escapeHtml(url)}" aria-label="${escapeHtml(title)}">
      ${preview}
      <div class="media-body">
        <div class="eyebrow">${escapeHtml(mediaLabel(kind))}</div>
        <h2>${escapeHtml(title)}</h2>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
        <div class="meta">
          <span class="tag">${escapeHtml(mediaRoleLabel(role))}</span>
          ${territoryLinks.length ? `<span class="tag place">${escapeHtml(territoryLinks.slice(0, 2).join(" · "))}</span>` : ""}
          ${linkedCoplas.length ? `<span class="tag">${linkedCoplas.length} copla${linkedCoplas.length === 1 ? "" : "s"}</span>` : ""}
        </div>
        ${url ? "" : `<p class="muted">Sen ligazón pública.</p>`}
      </div>
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

function setView(viewName) {
  state.view = normalizeView(viewName);
  all(".view").forEach(view => view.classList.toggle("active", view.id === `view-${state.view}`));
  all("[data-view]").forEach(button => button.classList.toggle("active", normalizeView(button.dataset.view) === state.view));
  renderView();
  if (state.view === "map" && state.map) window.setTimeout(() => state.map.invalidateSize(), 120);
}

function clearTerritory() {
  state.selectedTerritory = null;
  state.selectedCoplaId = null;
  state.territoryTab = "summary";
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

function styleFeature(selected = false, fragment = false, hasCoplas = false) {
  const base = selected
    ? { weight: 2.5, color: "#F8FCFF", fillColor: "#1F90C9", fillOpacity: 0.78 }
    : hasCoplas
      ? { weight: 1.4, color: "#0B3D68", fillColor: "#49BDF7", fillOpacity: 0.78 }
      : { weight: 1, color: "#0B3D68", fillColor: "#0B3D68", fillOpacity: 0.55 };
  return fragment ? { ...base, weight: selected ? 2.2 : 1.2, dashArray: "3 3" } : base;
}

async function loadLayer(type = state.layerType) {
  state.layerType = type;
  const layerSelect = $("#mapLayer");
  if (layerSelect) layerSelect.value = type;
  if (!state.map || !window.L) return;
  if (state.layer) state.layer.remove();
  let data = await geoLayerForMap(type);
  state.layer = L.geoJSON(data, {
    style: feature => {
      const territory = findTerritoryByFeature(feature, type, state.territorios);
      return styleFeature(territory?.id === state.selectedTerritory?.id, Boolean(feature?.properties?.part), territoryHasCoplas(territory));
    },
    onEachFeature(feature, layer) {
      const territory = findTerritoryByFeature(feature, type, state.territorios);
      const part = feature?.properties?.part;
      const name = part ? `${feature.properties.COMARCA} · ${part}` : territory?.nome || getFeatureNome(feature, type);
      layer.bindTooltip(name, { sticky: true, direction: "auto" });
      layer.on("mouseover", () => {
        if (part) layer.setStyle({ weight: 2, fillOpacity: 0.88 });
        else if (territory?.id !== state.selectedTerritory?.id) layer.setStyle({ weight: 2, fillOpacity: 0.88 });
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
  const text = $("#mapCardText");
  const coplaCount = $("#mapCoplaCount");
  const pieceCount = $("#mapPieceCount");
  const territoryCount = $("#mapTerritoryCount");
  if (!title || !text || !coplaCount || !pieceCount || !territoryCount) return;
  title.textContent = territory?.nome || "Galiza";
  text.textContent = territory
    ? `${territoryLabel(territory)} con ${ctx.coplas.length} coplas asociadas, directas ou herdadas dos seus subterritorios.`
    : "Explora o corpus territorialmente ou emprega a busca para localizar unha parroquia, concello, copla ou peza.";
  coplaCount.textContent = territory ? ctx.coplas.length : state.coplas.length;
  pieceCount.textContent = territory ? ctx.pezas.length : state.pezas.length;
  territoryCount.textContent = territory ? ctx.children.length : state.territorios.length;
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

function coplaCard(copla, options = {}) {
  const versionCount = (copla.versions || []).length;
  const versionChip = versionCount ? `<span class="tag">${versionCount} variantes</span>` : "";
  const voltaChip = copla.is_volta ? `<span class="tag is-volta">Volta</span>` : "";
  const placeChip = `<span class="gallery-place${options.dimPlace ? " is-subtle" : ""}">${escapeHtml(coplaPlaceLabel(copla))}</span>`;
  if (options.list) {
    return `
      <article class="gallery-card as-list" tabindex="0" role="button" data-open-copla="${copla.id}">
        <div class="gallery-top">
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
    <article class="gallery-card" tabindex="0" role="button" data-open-copla="${copla.id}">
      <div>
        <div class="gallery-top align-end">
          <button class="mini-add icon-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir á peza">+</button>
        </div>
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

function filteredCoplas() {
  const scoped = state.selectedTerritory ? placeContext().coplas : state.coplas;
  const q = normalizeText(state.coplaQuery);
  return scoped.filter(copla => {
    const stateMatches = state.coplaStateFilter === "all" || copla.territory_state === state.coplaStateFilter;
    return stateMatches && (!q || normalizeText(coplaHaystack(copla)).includes(q));
  });
}

function coplaViewToggleMarkup() {
  const gridIcon = `<span class="grid-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
  return `
    <div class="view-toggle">
      <button class="chip icon-view ${state.coplaViewMode === "list" ? "active" : ""}" type="button" data-copla-view="list" title="Vista de lista" aria-label="Vista de lista">☰</button>
      <button class="chip icon-view ${state.coplaViewMode === "gallery" ? "active" : ""}" type="button" data-copla-view="gallery" title="Vista de galería" aria-label="Vista de galería">${gridIcon}</button>
      <button class="chip icon-view ${state.coplaViewMode === "incipits" ? "active" : ""}" type="button" data-copla-view="incipits" title="Vista de só íncipits" aria-label="Vista de só íncipits">━</button>
    </div>
  `;
}

function coplaStreamClass() {
  if (state.coplaViewMode === "list") return "copla-list";
  if (state.coplaViewMode === "incipits") return "copla-incipits";
  return "copla-gallery gallery-wide";
}

function coplaIncipitRow(copla, options = {}) {
  return `
    <article class="incipit-row" tabindex="0" role="button" data-open-copla="${copla.id}">
      <span class="incipit-text">${escapeHtml(coplaTitle(copla))}</span>
      <span class="incipit-place${options.dimPlace ? " is-subtle" : ""}">${escapeHtml(coplaPlaceLabel(copla))}</span>
    </article>
  `;
}

function renderCoplaItems(items) {
  const dimPlace = Boolean(state.selectedTerritory);
  if (state.coplaViewMode === "incipits") {
    return items.map(copla => coplaIncipitRow(copla, { dimPlace })).join("") || `<p class="muted">Sen coplas para esta consulta.</p>`;
  }
  return items.map(copla => coplaCard(copla, { list: state.coplaViewMode === "list", dimPlace })).join("") || `<p class="muted">Sen coplas para esta consulta.</p>`;
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
    list.innerHTML = renderCoplaItems(items);
    bindCoplaActions(list);
  }
  all("[data-copla-view]", root).forEach(button => button.classList.toggle("active", button.dataset.coplaView === state.coplaViewMode));
  all("[data-state-filter]", root).forEach(button => button.classList.toggle("active", button.dataset.stateFilter === state.coplaStateFilter));
  const allChip = $("[data-copla-total]", root);
  if (allChip) {
    allChip.textContent = `Todas · ${items.length}`;
    allChip.classList.toggle("active", state.coplaStateFilter === "all");
  }
}

function renderCoplasView() {
  const view = $("#view-coplas");
  const items = filteredCoplas();
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Corpus</div>
          <h1>${state.selectedTerritory ? `Coplas de ${escapeHtml(state.selectedTerritory.nome)}` : "Coplas"}</h1>
          <p>Consulta transversal do repertorio. A lista serve para ler rápido; a galería abre unha lectura máis pausada.</p>
        </div>
        <button class="btn primary" type="button" data-view="submit">+ Nova copla</button>
      </div>
      <div class="toolbar">
        <div class="searchbox"><span>⌕</span><input id="coplaSearch" type="search" value="${escapeHtml(state.coplaQuery)}" placeholder="Buscar por verso, íncipit, territorio..."></div>
        <select id="coplaScope">
          <option value="current" ${state.selectedTerritory ? "selected" : ""}>Ámbito actual</option>
          <option value="all" ${state.selectedTerritory ? "" : "selected"}>Todo o corpus</option>
        </select>
        ${coplaViewToggleMarkup()}
      </div>
      <div class="chips">
        <button class="chip ${state.coplaStateFilter === "all" ? "active" : ""}" type="button" data-copla-total data-state-filter="all">Todas · ${items.length}</button>
        <button class="chip ${state.coplaStateFilter === "assigned" ? "active" : ""}" type="button" data-state-filter="assigned">Asignadas</button>
        <button class="chip ${state.coplaStateFilter === "general" ? "active" : ""}" type="button" data-state-filter="general">Galiza xeral</button>
      </div>
      <div class="results-row"><span id="coplaResultCount" class="muted">Mostrando ${items.length} coplas</span><span id="coplaResultScope" class="muted">${state.selectedTerritory ? "inclúe subterritorios" : "arquivo completo"}</span></div>
      <div id="coplaList" class="${coplaStreamClass()}">
        ${renderCoplaItems(items)}
      </div>
    </div>
  `;
  $("#coplaSearch")?.addEventListener("input", event => {
    state.coplaQuery = event.target.value;
    updateCoplasResults(view);
  });
  $("#coplaScope")?.addEventListener("change", event => {
    if (event.target.value === "all") state.selectedTerritory = null;
    renderCoplasView();
  });
  all("[data-copla-view]", view).forEach(button => button.addEventListener("click", () => {
    state.coplaViewMode = button.dataset.coplaView;
    updateCoplasResults(view);
  }));
  all("[data-state-filter]", view).forEach(button => button.addEventListener("click", () => {
    state.coplaStateFilter = button.dataset.stateFilter;
    updateCoplasResults(view);
  }));
  bindCoplaActions(view);
}

function bindCoplaActions(root = document) {
  bindResultButtons(root);
  all("[data-open-copla]", root).forEach(card => {
    card.addEventListener("click", event => {
      if (event.target.closest("button, a, select, input, textarea")) return;
      openCoplaDrawer(Number(card.dataset.openCopla));
    });
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openCoplaDrawer(Number(card.dataset.openCopla));
      }
    });
  });
  all("[data-add-copla]", root).forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    const copla = state.coplas.find(item => Number(item.id) === Number(button.dataset.addCopla));
    if (!copla) return;
    const draft = loadDraft();
    if (state.selectedTerritory && !draft.territoryId) draft.territoryId = state.selectedTerritory.id;
    draft.sections[0].coplas.push({
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

function openCoplaDrawer(coplaId) {
  const copla = state.coplas.find(item => Number(item.id) === Number(coplaId));
  const drawer = $("#coplaDrawer");
  if (!copla || !drawer) return;
  const territories = (copla.territories || []);
  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="drawer-scrim" data-close-drawer></div>
    <aside class="drawer-panel" role="dialog" aria-modal="true" aria-label="Ficha da copla">
      <button class="card-close" type="button" data-close-drawer aria-label="Pechar">×</button>
      <div class="eyebrow">Ficha textual${copla.is_volta ? ` · <span class="tag is-volta">Volta</span>` : ""}</div>
      <h2>${escapeHtml(coplaTitle(copla))}</h2>
      <div class="gallery-text">${nl2br(restOfText(copla.text || ""))}</div>
      <div class="drawer-section">
        <h3>Territorio</h3>
        <div class="territory-links">
          ${territories.map(item => `
            <button type="button" data-territory-id="${item.id}">
              <strong>${escapeHtml(item.nome)}</strong>
              <span>${escapeHtml(territorySearchMeta(item))}</span>
            </button>
          `).join("") || `<p class="muted">${escapeHtml(coplaPlaceLabel(copla))}</p>`}
        </div>
      </div>
      <div class="drawer-section">
        <h3>Variantes</h3>
        ${(copla.versions || []).map(version => `
          <div class="variant">
            <strong>${escapeHtml(version.label || version.incipit || "Variante")}</strong>
            <div>${nl2br(version.text || "")}</div>
            <p class="muted">${version.territory_mode === "custom" && (version.territories || []).length ? escapeHtml(version.territories.map(territoryDisplayName).join(" · ")) : "Mesma adscrición territorial ca copla principal"}</p>
            ${version.notes ? `<p class="muted">${escapeHtml(version.notes)}</p>` : ""}
          </div>
        `).join("") || `<p class="muted">Sen variantes rexistradas.</p>`}
      </div>
      <div class="drawer-section">
        <h3>Media relacionada</h3>
        <div class="media-grid compact">${coplaMedia(copla).map(mediaCard).join("") || `<p class="muted">Sen recursos multimedia vinculados a esta copla.</p>`}</div>
      </div>
      <div class="drawer-section">
        <h3>Notas e fonte</h3>
        <p class="muted">${escapeHtml(copla.notes || "Sen notas rexistradas.")}</p>
      </div>
      <div class="meta">${(copla.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="drawer-actions">
        <button class="btn" type="button" data-edit-copla="${copla.id}">Editar copla</button>
        <button class="btn primary drawer-add" type="button" data-add-copla="${copla.id}" aria-label="Engadir á peza">+</button>
      </div>
    </aside>
  `;
  all("[data-close-drawer]", drawer).forEach(item => item.addEventListener("click", closeCoplaDrawer));
  $("[data-edit-copla]", drawer)?.addEventListener("click", () => startEditCopla(copla.id));
  bindResultButtons(drawer);
  bindCoplaActions(drawer);
}

function closeCoplaDrawer() {
  const drawer = $("#coplaDrawer");
  if (!drawer) return;
  drawer.hidden = true;
  drawer.innerHTML = "";
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
      <div class="eyebrow">Peza gardada</div>
      <h2>${escapeHtml(piece.title || piece.titulo || "Peza sen título")}</h2>
      <div class="meta">
        ${authorTag}
        ${territory ? `<span class="tag place">${escapeHtml(territory.nome)}</span>` : ""}
      </div>
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
      <div class="drawer-section">
        <h3>Media relacionada</h3>
        <div class="media-grid compact">${pieceMedia(piece).map(mediaCard).join("") || `<p class="muted">Sen recursos multimedia vinculados a esta peza.</p>`}</div>
        <form id="pieceMediaForm" class="piece-media-form">
          <input id="pieceMediaTitle" type="text" placeholder="Título do recurso (ex.: intérprete - tema)" required>
          <input id="pieceMediaUrl" type="url" placeholder="URL (Spotify, YouTube, audio...)" required>
          <button class="btn" type="submit">Vincular media a esta peza</button>
          <p id="pieceMediaFeedback" class="muted"></p>
        </form>
      </div>
      <div class="drawer-actions">
        <button class="btn primary" type="button" data-download-piece-pdf="${piece.id}">Descargar PDF</button>
      </div>
    </aside>
  `;
  all("[data-close-piece-drawer]", drawer).forEach(item => item.addEventListener("click", closePieceDrawer));
  bindPieceCardActions(drawer);
  $("[data-download-piece-pdf]", drawer)?.addEventListener("click", event => downloadPieceRecordPdf(piece, event.currentTarget));
  $("#pieceMediaForm", drawer)?.addEventListener("submit", event => {
    event.preventDefault();
    linkMediaToPiece(piece, drawer);
  });
}

async function linkMediaToPiece(piece, drawer) {
  const feedback = $("#pieceMediaFeedback", drawer);
  const title = $("#pieceMediaTitle", drawer)?.value.trim();
  const url = $("#pieceMediaUrl", drawer)?.value.trim();
  if (!title || !url) {
    if (feedback) feedback.textContent = "Indica título e URL.";
    return;
  }
  if (feedback) feedback.textContent = "Gardando...";
  const kind = mediaKind({ url });
  try {
    const response = await fetch("../api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media: [{
          provider: kind,
          media_kind: kind,
          title,
          url,
          description: null,
          author_or_source: null,
          thumbnail_url: null,
          status: "published",
          links: [{ entity_type: "piece", entity_id: piece.id, relation_type: "documental" }],
        }],
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido vincular o recurso.");
    clearApiCache();
    state.media = await getMedia();
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
    button.textContent = "Xerando PDF...";
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
    const localHint = location.hostname.includes("localhost") || location.hostname === "127.0.0.1"
      ? "Non foi posíbel xerar o PDF desta peza."
      : "A exportación PDF require abrir Fol e Ar co servidor local.";
    window.alert(localHint);
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
  ].join(" ");
}

function filteredPieceRepository() {
  const territory = pieceTerritory();
  const scoped = territory ? filterPiecesByTerritory(state.pezas, getDescendantIds(territory, state.territorios), state.coplas) : state.pezas;
  const q = normalizeText(state.pieceRepositoryQuery);
  const rhythm = normalizeText(state.pieceRhythmQuery);
  const authorFilter = normalizeText(state.pieceAuthorFilter || "");
  return scoped.filter(piece => {
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

function pieceCard(piece) {
  const title = piece.title || piece.titulo || "Peza sen título";
  const author = pieceAuthorName(piece);
  const sections = pieceSections(piece);
  const coplaTotal = piece.copla_count ?? (piece.coplas || []).length;
  const authorTag = author === "Sen autoría"
    ? `<span class="tag place">${escapeHtml(author)}</span>`
    : `<button type="button" class="tag place as-link" data-piece-author="${escapeHtml(author)}" title="Ver as pezas de ${escapeHtml(author)}">${escapeHtml(author)}</button>`;
  return `
    <article class="piece-card" tabindex="0" role="button" data-open-piece="${piece.id}">
      <div>
        <div class="eyebrow">Peza gardada</div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(piece.description || piece.notes || "Mapa de referencias de coplas preparado para consulta e exportación.")}</p>
      </div>
      <div class="meta">
        ${authorTag}
        <span class="tag">${coplaTotal || 0} coplas</span>
        ${sections.length ? `<span class="tag">${sections.length} partes</span>` : ""}
      </div>
    </article>
  `;
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
        <button class="mini-add" type="button" data-add-copla="${copla.id}">+</button>
      </div>
    </article>
  `).join("") || `<p class="muted">Sen coplas no repertorio.</p>`;
  bindCoplaActions(list);
}

function bindPieceCardActions(root = $("#view-pieces")) {
  all("[data-piece-author]", root).forEach(button => button.addEventListener("click", () => {
    state.pieceAuthorFilter = button.dataset.pieceAuthor;
    state.pieceTab = "library";
    renderPiecesView();
  }));
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
  list.innerHTML = repo.map(pieceCard).join("") || `<article class="panel empty-panel"><p class="muted">Aínda non hai pezas gardadas neste ámbito. Cando se publique unha peza, aparecerá aquí como mapa de referencias.</p></article>`;
  bindPieceCardActions(list);
}

function pieceEntryModalMarkup(draft) {
  if (!state.pieceEntryModal) return "";
  const sectionOptions = draft.sections.map((section, index) => `<option value="${escapeHtml(section.id)}">${escapeHtml(section.label || `Parte ${index + 1}`)}</option>`).join("");
  const close = `<button class="card-close" type="button" data-close-piece-entry aria-label="Pechar">×</button>`;
  if (state.pieceEntryModal === "write") {
    return `
      <div class="media-modal piece-entry-modal" role="dialog" aria-modal="true" aria-label="Escribir copla">
        <div class="media-modal-backdrop" data-close-piece-entry></div>
        <div class="media-modal-panel piece-entry-panel">
          <div class="media-modal-head"><div><div class="eyebrow">Obradoiro</div><h2>Escribir copla</h2></div>${close}</div>
          <div class="piece-entry-body formgrid">
            <div class="field full"><label>Texto</label><textarea id="writtenCoplaText" rows="7" placeholder="Escribe a copla conservando os saltos de verso..."></textarea></div>
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
        <div class="media-modal-head"><div><div class="eyebrow">Obradoiro</div><h2>Importar peza</h2><p>O ficheiro converterase nun borrador visual antes de gardalo.</p></div>${close}</div>
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
    feedback.textContent = "Preparando a peza...";
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

function renderPiecesView() {
  const view = $("#view-pieces");
  const draft = loadDraft();
  const library = filteredPieceLibrary();
  const repo = filteredPieceRepository();
  const total = draftCount(draft);
  const territory = pieceTerritory();
  const rhythmOptions = `<option value="">Seleccionar ritmo</option>${RHYTHMS.map(value => `<option value="${value}">${value}</option>`).join("")}`;
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Pezas</div>
          <h1>${state.pieceTab === "workshop" ? "Obradoiro" : "Biblioteca de pezas"}</h1>
          <p>${state.pieceTab === "workshop" ? "Engade coplas mentres exploras e constrúe aquí unha peza con partes, ritmo, orde e saída para canto." : "Repositorio de pezas publicadas ou gardadas como mapas de coplas, filtrábeis por territorio, creador e ritmo."}</p>
        </div>
        ${state.pieceTab === "workshop" ? `
          <div class="header-actions">
            <button class="btn" type="button" id="clearPiece">Baleirar</button>
            <button class="btn" type="button" id="savePieceDirect">Gardar peza</button>
            <button class="btn" type="button" id="downloadPiece">Descargar estrutura</button>
            <button class="btn primary" type="button" id="openA4" ${state.pdfBusy ? "disabled" : ""}>${state.pdfBusy ? "Xerando PDF..." : "Exportar PDF"}</button>
          </div>
        ` : ""}
      </div>
      <div class="section-tabs piece-tabs">
        <button class="${state.pieceTab === "library" ? "active" : ""}" type="button" data-piece-tab="library">Biblioteca</button>
        <button class="${state.pieceTab === "workshop" ? "active" : ""}" type="button" data-piece-tab="workshop">Obradoiro <b class="cart-count" data-cart-count ${total ? "" : "hidden"}>${total}</b></button>
      </div>
      ${state.pieceTab === "library" ? `
        <section class="panel piece-repository">
          <div class="section-title"><h2>${state.pieceAuthorFilter ? `Pezas de ${escapeHtml(state.pieceAuthorFilter)}` : "Pezas gardadas"}</h2><span id="pieceRepositoryCount" class="muted">${repo.length} pezas</span></div>
          ${state.pieceAuthorFilter ? `<p class="muted">Só as pezas gardadas con esta autoría. <button class="btn" type="button" id="clearPieceAuthorFilter">Ver todas as pezas</button></p>` : ""}
          <div class="toolbar piece-filters">
            <div class="searchbox"><span>⌕</span><input id="pieceRepositorySearch" type="search" value="${escapeHtml(state.pieceRepositoryQuery)}" placeholder="Buscar por título, creador ou contexto..."></div>
            <select id="pieceRhythmFilter" aria-label="Filtrar por ritmo">
              <option value="">Todos os ritmos</option>
              ${RHYTHMS.map(value => `<option value="${value}" ${state.pieceRhythmQuery === value ? "selected" : ""}>${value}</option>`).join("")}
            </select>
          </div>
          <div id="pieceRepositoryList" class="piece-grid">
            ${repo.map(pieceCard).join("") || `<article class="panel empty-panel"><p class="muted">Aínda non hai pezas gardadas neste ámbito. Cando se publique unha peza, aparecerá aquí como mapa de referencias.</p></article>`}
          </div>
        </section>
        <section class="panel creator-note">
          <div>
            <div class="eyebrow">Creadoras e artistas</div>
            <h2>Páxinas de autoría</h2>
            <p class="muted">Toca o nome dunha autoría en calquera peza para abrir a súa páxina, cos arranxos e seleccións que ten gardados.</p>
          </div>
        </section>
      ` : `
        <div id="pieceExportStatus" class="export-status" role="status" aria-live="polite">${escapeHtml(state.pieceNotice)}</div>
        <div class="piece-entry-bar" aria-label="Formas de engadir contido á peza">
          <span>Engadir á peza</span>
          <button class="btn" type="button" id="focusPieceLibrary">Do repertorio</button>
          <button class="btn" type="button" id="openPieceWriter">Escribir copla</button>
          <button class="btn" type="button" id="openPieceImport">Importar ficheiro</button>
        </div>
        <div class="toolbar piece-scopebar">
          <div class="searchbox"><span>⌕</span><input id="pieceTerritorySearch" type="search" value="${escapeHtml(state.pieceTerritoryQuery)}" placeholder="Centrar peza nun territorio..."></div>
          ${territory ? `<button class="btn" type="button" id="clearPieceTerritory">Limpar territorio: ${escapeHtml(territory.nome)}</button>` : `<span class="muted">Sen territorio de traballo.</span>`}
        </div>
        <div id="pieceTerritoryResults" class="territory-results compact"></div>
        <div class="piece-layout">
          <section class="panel">
            <div class="section-title"><h2>Repertorio</h2><span id="pieceLibraryCount" class="muted">${library.length} coplas</span></div>
            <div class="toolbar"><div class="searchbox"><span>⌕</span><input id="pieceSearch" type="search" value="${escapeHtml(state.pieceLibraryQuery)}" placeholder="Buscar coplas para engadir..."></div></div>
            <div id="pieceLibraryList" class="library-list">
              ${library.map(copla => `
                <article class="mini-copla">
                  <h3>${escapeHtml(coplaTitle(copla))}</h3>
                  <p>${nl2br(restOfText(copla.text || ""))}</p>
                  <div class="mini-bottom">
                    <span class="tag place">${escapeHtml(coplaPlaceLabel(copla))}</span>
                    ${copla.is_volta ? `<span class="tag is-volta">Volta</span>` : ""}
                    <button class="mini-add" type="button" data-add-copla="${copla.id}">+</button>
                  </div>
                </article>
              `).join("") || `<p class="muted">Sen coplas no repertorio.</p>`}
            </div>
          </section>
          <section class="piece-editor">
            <div class="formgrid">
              <div class="field full"><label>Título da peza</label><input id="pieceTitle" type="text" value="${escapeHtml(draft.title || "")}" placeholder="${escapeHtml(territoryContextTitle(territory) || "Xota de Cerdedo")}"></div>
              <div class="field full"><label>Notas da peza <span class="muted">(opcional, para imprimir)</span></label><textarea id="pieceNotes" rows="2" placeholder="Xota curta; muiñeira empuñada; toque a man aberta...">${escapeHtml(draft.notes || "")}</textarea></div>
              <div class="field"><label>Autoría</label><input id="pieceAuthor" type="text" value="${escapeHtml(draft.author || "")}" placeholder="Nome"></div>
            </div>
            <div class="sequence">
              <div class="sequence-head"><div><div class="eyebrow">Estrutura</div><h2>Partes e ritmos</h2></div><button class="btn" type="button" id="addSection">Engadir parte</button></div>
              <div class="builder-sections">
                ${draft.sections.map(section => `
                  <article class="builder-section" data-section-id="${section.id}">
                    <div class="section-line">
                      <select data-section-label="${section.id}" aria-label="Ritmo da parte">${rhythmOptions}</select>
                      <button class="icon-trash" type="button" data-remove-section="${section.id}" aria-label="Eliminar parte">🗑</button>
                    </div>
                    <div class="sequence-list" data-drop-section="${section.id}">
                      ${section.coplas.map(item => `
                        <article class="seq-item ${(item.role || "copla") === "retrouso" ? "is-retrouso" : ""}" draggable="true" data-drag-copla="${escapeHtml(item.uid || item.id)}" data-section="${section.id}">
                          <div class="drag">☷</div>
                          <div>
                            <div class="seq-text">${escapeHtml(firstLine(item.text) || item.incipit || "Copla sen íncipit")}</div>
                            <textarea class="seq-edit-text" rows="3" data-edit-item="${escapeHtml(item.uid || item.id)}" aria-label="Texto usado nesta peza (non altera a copla orixinal)">${escapeHtml(item.text || "")}</textarea>
                            <div class="meta"><span class="tag place">${escapeHtml(item.territory || "")}</span></div>
                          </div>
                          <div class="seq-tools">
                            <select aria-label="Tipo textual" data-item-role="${escapeHtml(item.uid || item.id)}">
                              <option value="copla" ${(item.role || "copla") === "copla" ? "selected" : ""}>Copla</option>
                              <option value="retrouso" ${item.role === "retrouso" ? "selected" : ""}>Volta</option>
                            </select>
                            <button type="button" data-remove-cart="${escapeHtml(item.uid || item.id)}">×</button>
                          </div>
                        </article>
                      `).join("") || `<p class="muted">Engade coplas ou arrastra aquí desde outra parte.</p>`}
                    </div>
                  </article>
                `).join("")}
              </div>
            </div>
          </section>
        </div>
        ${pieceEntryModalMarkup(draft)}
      `}
    </div>
  `;
  all("[data-piece-tab]", view).forEach(button => button.addEventListener("click", () => {
    state.pieceTab = button.dataset.pieceTab;
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
  $("#pieceRhythmFilter")?.addEventListener("change", event => {
    state.pieceRhythmQuery = event.target.value;
    updatePieceRepository(view);
  });
  bindPieceCardActions(view);
  $("#clearPieceAuthorFilter")?.addEventListener("click", () => {
    state.pieceAuthorFilter = "";
    renderPiecesView();
  });
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
  $("#pieceNotes")?.addEventListener("input", event => saveDraft({ ...loadDraft(), notes: event.target.value }));
  $("#focusPieceLibrary")?.addEventListener("click", () => {
    $("#pieceSearch")?.focus();
    $("#pieceLibraryList")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#openPieceWriter")?.addEventListener("click", () => openPieceEntryModal("write"));
  $("#openPieceImport")?.addEventListener("click", () => openPieceEntryModal("import"));
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
  $("#downloadPiece")?.addEventListener("click", () => {
    downloadText("peza.json", JSON.stringify(buildPiecePayload(), null, 2), "application/json");
  });
  $("#savePieceDirect")?.addEventListener("click", savePieceDirect);
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
    textarea.addEventListener("blur", () => renderPiecesView());
  });
  bindCoplaActions(view);
  bindPieceDrag(view);
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

function buildPieceDbPayload() {
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
  const title = draft.title || territoryContextTitle(pieceTerritory()) || "Peza sen título";
  return {
    pieces: [{
      title,
      slug: slugify(`${title}-${Date.now()}`),
      author: draft.author || "Sen autoría",
      context_territory_id: draft.territoryId || state.selectedTerritory?.id || null,
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

async function savePieceDirect() {
  const feedback = $("#pieceExportStatus");
  try {
    let draft = loadDraft();
    const hasPending = draft.sections.some(section => section.coplas.some(item => {
      const numericId = Number(item.id);
      return !Number.isInteger(numericId) || numericId <= 0;
    }));
    if (hasPending) {
      if (feedback) feedback.textContent = "Incorporando as coplas soltas á base de datos...";
      draft = await materializeDraftCoplas(draft);
      saveDraft(draft);
    }
    const payload = buildPieceDbPayload();
    if (feedback) feedback.textContent = "Gardando peza na base local...";
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
  const button = $("#openA4");
  state.pdfBusy = true;
  if (button) {
    button.disabled = true;
    button.textContent = "Xerando PDF...";
  }
  setExportStatus("Xerando PDF...");
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
    const localHint = location.hostname.includes("localhost") || location.hostname === "127.0.0.1"
      ? "Non foi posíbel xerar o PDF."
      : "A exportación PDF require abrir Fol e Ar co servidor local.";
    setExportStatus(localHint, true);
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
  if (!territory) return "Galiza";
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
    items = ctx.coplas.slice(0, 24);
  }
  if (list) {
    list.className = `${coplaStreamClass()}${state.coplaViewMode === "gallery" ? " territory-copla-grid" : ""}`;
    list.innerHTML = renderCoplaItems(items);
    bindCoplaActions(list);
  }
  all("[data-copla-view]", root).forEach(button => button.classList.toggle("active", button.dataset.coplaView === state.coplaViewMode));
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

function renderTerritoryView() {
  const view = $("#view-territory");
  const territory = state.selectedTerritory;
  const query = state.territoryQuery;
  const ctx = placeContext(territory);
  const direct = territory ? ctx.coplas.filter(copla => (copla.territories || []).some(item => item.id === territory.id)).length : ctx.coplas.length;
  const tabs = [
    ["summary", "Resumo"],
    ["coplas", "Coplas"],
    ["pieces", "Pezas"],
    ["melodies", "Melodías"],
    ["media", "Media"],
    ...(territory?.tipo === "par" ? [] : [["children", "Subterritorios"]]),
  ];
  if (territory?.tipo === "par" && state.territoryTab === "children") state.territoryTab = "summary";
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Territorios</div>
          <h1>${territory ? escapeHtml(territory.nome) : "Galiza"}</h1>
          <p>${territory ? "Xerarquía, coplas directas, material herdado, pezas e media." : "Visión xeral do arquivo. Para media, melodías e navegación fina escolle unha provincia, comarca, concello ou parroquia."}</p>
        </div>
        <button class="btn primary" type="button" data-view="map">Ver no mapa</button>
      </div>
      <div class="toolbar">
        <div class="searchbox"><span>⌕</span><input id="territorySearch" type="search" value="${escapeHtml(query)}" placeholder="Buscar parroquia, concello, comarca..."></div>
      </div>
      <div id="territorySearchResults" class="territory-results"></div>
      <div class="territory-hero">
        <section class="territory-card">
          <div class="breadcrumbs">${breadcrumbTrail(territory, ctx)}</div>
          <div class="eyebrow">${escapeHtml(territory ? territoryLabel(territory) : "País")}</div>
          <h1>${territory ? escapeHtml(territory.nome) : "Galiza"}</h1>
          <p>${territory ? `${direct} coplas directas e ${Math.max(ctx.coplas.length - direct, 0)} herdadas dos subterritorios.` : `${ctx.coplas.length} coplas no conxunto do arquivo. A vista xeral amosa unha mostra e deixa a exploración completa para territorios menores.`}</p>
          <div class="stats">
            <div class="stat"><b>${ctx.coplas.length}</b><span>coplas</span></div>
            <div class="stat"><b>${ctx.pezas.length}</b><span>pezas</span></div>
            <div class="stat"><b>${ctx.media.length}</b><span>media</span></div>
          </div>
        </section>
        <section class="territory-mini-map-wrap">
          <div id="territoryMiniMap" class="territory-mini-map"></div>
        </section>
      </div>
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
  bindTerritoryTabs(view);
  bindResultButtons(view);
  bindCoplaActions(view);
  bindTerritoryCoplaSearch(view);
  bindTerritoryCoplaViewToggle(view);
  bindTerritorySummaryCard(view);
  renderTerritorySearchResults(view);
  renderTerritoryMiniMap(territory);
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
  if (feedback) feedback.textContent = "Gardando...";
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

function renderTerritoryTab(territory, ctx) {
  if (!territory) {
    if (state.territoryTab === "coplas") {
      const sample = ctx.coplas.slice(0, 24);
      return `
        <div class="section-title"><h2>Coplas de Galiza</h2><span class="muted">${ctx.coplas.length} no arquivo</span></div>
        <div class="territory-limit">Mostrando unha mostra inicial. Para traballar con todas as coplas dun ámbito concreto, escolle unha provincia, comarca, concello ou parroquia.</div>
        <div class="toolbar toolbar-end">${coplaViewToggleMarkup()}</div>
        <div id="territoryCoplaList" class="${coplaStreamClass()}${state.coplaViewMode === "gallery" ? " territory-copla-grid" : ""}">${renderCoplaItems(sample)}</div>
      `;
    }
    if (["pieces", "melodies", "media"].includes(state.territoryTab)) {
      return `
        <section class="panel territory-limit-panel">
          <h2>Escolle un territorio menor</h2>
          <p class="muted">Para evitar unha pantalla inmanexable, as pezas, melodías e recursos multimedia explóranse desde provincia, comarca, concello ou parroquia.</p>
        </section>
      `;
    }
    return `
      <div class="section-title"><h2>Resumo</h2><button class="btn" type="button" data-territory-tab="coplas">Ver coplas</button></div>
      <div class="territory-limit">Galiza funciona aquí como vista xeral. Baixa a unha entidade territorial para consultar media, melodías e pezas con precisión.</div>
      ${territorySummaryCard(null, ctx)}
      <div class="section-title"><h2>Provincias</h2></div>
      <div class="territory-results">${ctx.children.map(territoryChildButton).join("")}</div>
    `;
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
      <div id="territoryCoplaList" class="${coplaStreamClass()}${state.coplaViewMode === "gallery" ? " territory-copla-grid" : ""}">${renderCoplaItems(filteredTerritoryCoplas)}</div>
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
    const media = ctx.media.filter(item => ["documental", "mixed"].includes(mediaRole(item)));
    return `
      <div class="section-title"><h2>Media relacionada</h2><button class="btn" type="button" data-view="media" data-media-role="documental">+ Novo recurso</button><span class="muted">${media.length} recursos</span></div>
      <div class="media-grid">${media.map(mediaCard).join("") || `<article class="panel"><p class="muted">Aínda non hai media documental neste territorio.</p></article>`}</div>
    `;
  }
  if (state.territoryTab === "melodies") {
    const melodies = ctx.media.filter(item => ["melody", "mixed"].includes(mediaRole(item)));
    return `
      <div class="section-title"><h2>Melodías</h2><button class="btn" type="button" data-view="media" data-media-role="melody">+ Novo recurso</button><span class="muted">${melodies.length} recursos sonoros</span></div>
      <div class="media-grid">${melodies.map(mediaCard).join("") || `<article class="panel"><p class="muted">Aínda non hai melodías rexistradas neste territorio. A pantalla xa admite audio local, vídeo, YouTube e Spotify cando se dean de alta.</p></article>`}</div>
    `;
  }
  if (state.territoryTab === "children") {
    return `
      <div class="section-title"><h2>Subterritorios</h2><span class="muted">${ctx.children.length} elementos</span></div>
      <div class="territory-results">${ctx.children.map(territoryChildButton).join("") || `<p class="muted">Sen subterritorios neste nivel.</p>`}</div>
    `;
  }
  return `
    <div class="section-title"><h2>Resumo</h2><button class="btn" type="button" data-territory-tab="coplas">Ver coplas</button></div>
    ${territorySummaryCard(territory, ctx)}
    <div class="section-title"><h2>Subterritorios</h2></div>
    <div class="territory-results">${ctx.children.slice(0, 18).map(territoryChildButton).join("") || `<p class="muted">Sen subterritorios neste nivel.</p>`}</div>
  `;
}

async function renderTerritoryMiniMap(territory) {
  const el = $("#territoryMiniMap");
  if (!el) return;
  if (!window.L) {
    el.innerHTML = `<div class="map-fallback"><p>Mini-mapa non dispoñible.</p></div>`;
    return;
  }
  if (state.miniMap) {
    state.miniMap.remove();
    state.miniMap = null;
    state.miniLayer = null;
  }
  state.miniMap = L.map(el, {
    attributionControl: false,
    zoomControl: true,
    scrollWheelZoom: false,
  }).setView([42.8, -8.2], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, opacity: 0.6 }).addTo(state.miniMap);
  if (!territory) {
    try {
      let data = await geoLayerForMap("prov");
      state.miniLayer = L.geoJSON(data, {
        style: { weight: 1.4, color: "#0B3D68", fillColor: "#0B3D68", fillOpacity: 0.5 },
      }).addTo(state.miniMap);
      window.setTimeout(() => {
        state.miniMap.invalidateSize();
        try {
          state.miniMap.fitBounds(state.miniLayer.getBounds(), { padding: [18, 18] });
        } catch {}
      }, 80);
    } catch {
      window.setTimeout(() => state.miniMap.invalidateSize(), 80);
    }
    return;
  }
  try {
    let data = await geoLayerForMap(territory.tipo);
    const activeBounds = [];
    state.miniLayer = L.geoJSON(data, {
      style: feature => {
        const item = findTerritoryByFeature(feature, territory.tipo, state.territorios);
        const active = item?.id === territory.id;
        const full = !active && territoryHasCoplas(item);
        return {
          weight: active ? 2.4 : full ? 1.6 : 0.8,
          color: active ? "#0F1722" : "#0B3D68",
          fillColor: active ? "#1F90C9" : full ? "#49BDF7" : "#0B3D68",
          fillOpacity: active ? 0.7 : full ? 0.72 : 0.5,
          dashArray: feature?.properties?.part ? "3 3" : null,
        };
      },
      onEachFeature: (feature, layer) => {
        const item = findTerritoryByFeature(feature, territory.tipo, state.territorios);
        if (item?.id === territory.id) activeBounds.push(layer.getBounds());
        if (!item) return;
        const council = parentCouncil(item);
        layer.bindTooltip(`${item.nome}${item.tipo === "par" && council?.nome ? ` · ${council.nome}` : ""}`, { sticky: true });
        layer.on("click", async () => {
          await selectTerritory(item);
          renderTerritoryView();
        });
        layer.on("mouseover", () => layer.setStyle({ fillOpacity: item.id === territory.id ? 0.85 : 0.8, weight: item.id === territory.id ? 2.4 : 1.4 }));
        layer.on("mouseout", () => state.miniLayer?.resetStyle(layer));
      },
    }).addTo(state.miniMap);
    window.setTimeout(() => {
      state.miniMap.invalidateSize();
      try {
        const bounds = activeBounds[0] || state.miniLayer.getBounds();
        state.miniMap.fitBounds(bounds, { padding: [50, 50], maxZoom: territory.tipo === "par" ? 13 : 10 });
      } catch {}
    }, 80);
  } catch {
    el.innerHTML = `<span>Non se puido cargar a xeometría.</span>`;
  }
}

function renderSubmitView() {
  const view = $("#view-submit");
  if (!state.submitTerritoryIds.length && state.submitTerritoryId) state.submitTerritoryIds = [state.submitTerritoryId];
  if (!state.submitEditingId && !state.submitTerritoryIds.length && state.selectedTerritory) state.submitTerritoryIds = [state.selectedTerritory.id];
  const selectedTerritories = state.submitTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  const editing = state.submitEditingSnapshot;
  const defaultState = editing ? editing.territory_state : "unassigned";
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Alta</div>
          <h1>${editing ? "Editar copla" : "Nova copla"}</h1>
          <p>${editing ? "Modifica o texto, as variantes, o territorio ou o uso como volta desta copla." : "Incorpora unha ou varias coplas ao arquivo, coas súas variantes, nun só proceso."}</p>
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
            <div class="field"><label>Estado territorial</label><select id="newState">
              <option value="unassigned" ${defaultState === "unassigned" ? "selected" : ""}>Sen asignar</option>
              <option value="assigned" ${defaultState === "assigned" ? "selected" : ""}>Asignada a lugar</option>
              <option value="general" ${defaultState === "general" ? "selected" : ""}>Galiza xeral</option>
            </select></div>
            <div id="mainTerritoryFields" class="field territory-field-group">
              <label>Territorios</label>
              <input id="territoryQuery" type="search" placeholder="Buscar parroquia, concello, comarca...">
              <div id="territoryPickerResults" class="territory-results compact"></div>
            </div>
            <div id="mainTerritoryChips" class="field full"><div id="selectedTerritoryChips" class="selected-chips">${selectedTerritories.map(item => selectedTerritoryChip(item, "copla")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`}</div></div>
            <details class="advanced-fields field full">
              <summary>Axustes avanzados</summary>
              <div class="formgrid">
                <div class="field"><label>Perfil lingüístico</label><select id="newLanguage"><option value="">Sen marcar</option><option value="lingua-galego">Galego</option><option value="lingua-castelan">Castelán</option><option value="lingua-castrapo">Castrapo / mestura</option></select></div>
                <div class="field"><label>Etiquetas</label><input id="newTags" type="text" value="${escapeHtml((editing?.tags || []).join(", "))}" placeholder="amor, romaría, traballo..."></div>
                <div class="field full"><label>Notas</label><textarea id="newNotes" rows="3" placeholder="Fonte, contexto, dúbidas editoriais...">${escapeHtml(editing?.notes || "")}</textarea></div>
              </div>
            </details>
        </div>
        <div class="variants-block">
          <div class="section-title"><div><h2>Variantes</h2><p class="muted">Numéranse automaticamente pola orde en que se engaden e parten do texto principal.</p></div><button class="btn" type="button" id="addVersion">+ Engadir variante</button></div>
          <div id="versionRows" class="version-rows"></div>
        </div>
          <div class="form-actions submit-primary-actions">
            ${editing
              ? `<button class="btn primary" type="button" id="saveDirect">Gardar cambios</button>`
              : `<button class="btn" type="button" id="queueCopla">+ Engadir á lista</button>
                 <button class="btn primary" type="button" id="saveDirect">${state.submitBatch.length ? `Gardar todas (${state.submitBatch.length})` : "Gardar na base local"}</button>`}
          </div>
          <p id="submitFeedback" class="muted"></p>
      </section>
      ${!editing ? submitBatchQueueMarkup() : ""}
      ${!editing ? pasteBlockPanelMarkup() : ""}
      <details class="panel batch-import-panel compact-import">
        <summary>Importar varias coplas desde JSON</summary>
        <div class="compact-import-body">
          <p class="muted">Escolle un ficheiro co formato de Fol e ar. A importación gárdao na base local e actualiza o repertorio.</p>
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
  $("#newState")?.addEventListener("change", updateSubmitTerritoryVisibility);
  updateSubmitTerritoryVisibility();
  $("#addVersion")?.addEventListener("click", () => addVersionRow());
  $("#saveDirect")?.addEventListener("click", saveCoplaDirect);
  $("#queueCopla")?.addEventListener("click", queueCoplaFromForm);
  $("#parsePasteBlock")?.addEventListener("click", queuePasteBlock);
  $("#cancelEdit")?.addEventListener("click", cancelEditCopla);
  all("[data-remove-batch]", view).forEach(button => button.addEventListener("click", () => removeQueuedCopla(Number(button.dataset.removeBatch))));
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
  }
}

function addVersionRow(options = {}) {
  const mainText = $("#newText")?.value || "";
  const inheritedTerritories = Array.from(new Set(state.submitTerritoryIds)).map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  const inheritedLabel = inheritedTerritories.length
    ? inheritedTerritories.map(item => item.nome).join(", ")
    : ($("#newState")?.value === "general" ? "Galiza xeral" : "Sen asignar");
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

function updateSubmitTerritoryVisibility() {
  const assigned = $("#newState")?.value === "assigned";
  if ($("#mainTerritoryFields")) $("#mainTerritoryFields").hidden = !assigned;
  if ($("#mainTerritoryChips")) $("#mainTerritoryChips").hidden = !assigned;
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
      ${escapeHtml(territory.nome)} <small>${escapeHtml(territoryLabel(territory))}</small>
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

function mediaFormMarkup(selectedMediaTerritories, selectedMediaCoplas) {
  const defaultRole = state.mediaDefaultRole || (state.territoryTab === "melodies" ? "melody" : "documental");
  return `
    <section class="panel submit-media-panel">
      <div class="section-title"><h2>Novo recurso</h2><span class="muted">Documental, melodía ou ambos</span></div>
      <div class="formgrid">
        <div class="field"><label>Título</label><input id="mediaTitle" type="text" placeholder="Xota 1, Muiñeira de Sequeiros..."></div>
        <div class="field"><label>Tipo</label><select id="mediaKind"><option value="youtube">YouTube</option><option value="spotify">Spotify</option><option value="soundcloud">SoundCloud</option><option value="audio">Audio</option><option value="video">Vídeo</option><option value="image">Imaxe</option><option value="web">Web</option></select></div>
        <div class="field"><label>Uso no arquivo</label><select id="mediaRole"><option value="documental" ${defaultRole === "documental" ? "selected" : ""}>Media documental</option><option value="melody" ${defaultRole === "melody" ? "selected" : ""}>Melodía / recurso musical</option><option value="mixed">Ambas cousas</option></select></div>
        <div class="field full"><label>URL</label><div class="input-action"><input id="mediaUrl" type="url" placeholder="https://..."><button class="btn" type="button" id="fetchMediaMeta">Obter datos</button></div></div>
        <div class="field"><label>Fonte ou autoría</label><input id="mediaSource" type="text" placeholder="Canle, intérprete, arquivo..."></div>
        <div class="field"><label>Miniatura opcional</label><input id="mediaThumb" type="url" placeholder="https://..."></div>
        <div class="field full"><label>Descrición</label><textarea id="mediaDescription" rows="3" placeholder="Contexto, relación coa melodía, observacións..."></textarea></div>
        <div class="field"><label>Territorios vinculados</label><input id="mediaTerritoryQuery" type="search" placeholder="Buscar e engadir territorios..."></div>
        <div class="field full"><div id="mediaTerritoryResults" class="territory-results compact"></div></div>
        <div class="field full"><div id="selectedMediaTerritoryChips" class="selected-chips">${selectedMediaTerritories.map(item => selectedTerritoryChip(item, "media")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`}</div></div>
        <div class="field full"><label>Coplas vinculadas (opcional)</label><input id="mediaCoplaQuery" type="search" placeholder="Buscar coplas polo texto..."></div>
        <div class="field full"><div id="mediaCoplaResults" class="territory-results compact"></div></div>
        <div class="field full"><div id="selectedMediaCoplaChips" class="selected-chips">${selectedMediaCoplas.map(item => selectedCoplaChip(item)).join("") || `<p class="muted">Sen coplas seleccionadas.</p>`}</div></div>
      </div>
      <div class="gallery-actions">
        <button class="btn primary" type="button" id="saveMediaDirect">Gardar media na base local</button>
        <p id="mediaFeedback" class="muted"></p>
      </div>
    </section>
  `;
}

function mediaModalMarkup(selectedMediaTerritories, selectedMediaCoplas) {
  if (!state.mediaModalOpen) return "";
  return `
    <div class="media-modal" id="mediaModal" role="dialog" aria-modal="true" aria-label="Novo recurso">
      <div class="media-modal-backdrop" data-close-media-modal></div>
      <div class="media-modal-panel">
        <div class="media-modal-head">
          <div>
            <div class="eyebrow">Alta de media</div>
            <h2>Novo recurso</h2>
          </div>
          <button class="card-close" type="button" data-close-media-modal aria-label="Pechar">×</button>
        </div>
        ${mediaFormMarkup(selectedMediaTerritories, selectedMediaCoplas)}
      </div>
    </div>
  `;
}

function openMediaModal(role = "") {
  state.mediaDefaultRole = role || "";
  state.mediaModalOpen = true;
  renderMediaView();
}

function closeMediaModal() {
  state.mediaModalOpen = false;
  state.mediaDefaultRole = "";
  renderMediaView();
}

function refreshSelectedTerritoryChips() {
  const coplaChips = $("#selectedTerritoryChips");
  if (coplaChips) {
    const selected = state.submitTerritoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
    coplaChips.innerHTML = selected.map(item => selectedTerritoryChip(item, "copla")).join("") || `<p class="muted">Sen territorio seleccionado.</p>`;
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
  bindSelectedTerritoryChips();
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
      if (!state.submitTerritoryIds.includes(territory.id)) state.submitTerritoryIds.push(territory.id);
      state.submitTerritoryId = state.submitTerritoryIds[0] || "";
      input.value = "";
      results.innerHTML = "";
      refreshSelectedTerritoryChips();
    }));
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
  const territoryState = $("#newState").value;
  const territoryIds = Array.from(new Set(state.submitTerritoryIds));
  if (territoryState === "assigned" && !territoryIds.length) {
    feedback.textContent = "Busca e selecciona polo menos un territorio, ou cambia o estado territorial.";
    return null;
  }
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
    if (feedback) feedback.textContent = "Importando coplas...";
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
  if (!title || !url) {
    feedback.textContent = "Indica título e URL.";
    return null;
  }
  if (!territoryIds.length && !coplaIds.length) {
    feedback.textContent = "Selecciona polo menos un territorio ou unha copla para vincular este recurso.";
    return null;
  }
  return {
    media: [{
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
      ],
    }],
  };
}

async function saveCoplaDirect() {
  const feedback = $("#submitFeedback");
  let payloads;
  if (state.submitEditingId) {
    const payload = buildCoplaPayloadFromForm();
    if (!payload) return;
    payloads = [payload];
  } else {
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
  feedback.textContent = "Gardando na base local...";
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
    const lastPayload = payloads[payloads.length - 1];
    const firstTerritoryId = lastPayload.territories[0]?.id;
    state.selectedTerritory = firstTerritoryId ? state.territorios.find(item => item.id === firstTerritoryId) || state.selectedTerritory : state.selectedTerritory;
    state.coplaQuery = firstLine(lastPayload.text);
    state.coplaStateFilter = "all";
    state.submitBatch = [];
    state.submitEditingId = null;
    state.submitEditingSnapshot = null;
    state.submitTerritoryIds = [];
    state.submitTerritoryId = "";
    setView("coplas");
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
    placeLabel: coplaPlaceLabel({ territories, territory_state: payload.territory_state }),
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

function submitBatchQueueMarkup() {
  if (!state.submitBatch.length) return "";
  return `
    <section class="panel submit-batch-panel">
      <div class="section-title"><h2>Coplas pendentes de gardar</h2><span class="muted">${state.submitBatch.length}</span></div>
      <div class="submit-batch-list">
        ${state.submitBatch.map((item, index) => `
          <article class="submit-batch-item">
            <div>
              <strong>${escapeHtml(item.preview)}</strong>
              <span class="muted">${escapeHtml(item.placeLabel)}${item.versionCount ? ` · ${item.versionCount} variante(s)` : ""}${item.isVolta ? " · Volta" : ""}</span>
            </div>
            <button class="icon-button" type="button" data-remove-batch="${index}" aria-label="Retirar da lista" title="Retirar da lista">×</button>
          </article>
        `).join("")}
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

function pasteBlockPanelMarkup() {
  return `
    <details class="panel batch-import-panel compact-import">
      <summary>Pegar varias coplas dun golpe (voltas entre &gt; e &lt;)</summary>
      <div class="compact-import-body">
        <p class="muted">Pega aquí varias coplas separadas por unha liña en branco. Para marcar unha delas como volta, escríbea enteira entre <code>&gt;</code> e <code>&lt;</code>. Engádense como coplas a coplas e como voltas a voltas, no territorio e estado escollidos arriba.</p>
        <textarea id="pasteBlock" rows="8" placeholder="Escribe ou pega aquí varias coplas separadas por unha liña en branco..."></textarea>
        <div class="compact-import-actions">
          <button class="btn primary" type="button" id="parsePasteBlock">Repartir e engadir á lista</button>
        </div>
        <p id="pasteBlockFeedback" class="muted"></p>
      </div>
    </details>
  `;
}

function queuePasteBlock() {
  const textarea = $("#pasteBlock");
  const feedback = $("#pasteBlockFeedback");
  if (!textarea) return;
  const stanzas = parseCoplaPasteBlock(textarea.value);
  if (!stanzas.length) {
    if (feedback) feedback.textContent = "Pega polo menos unha copla antes de repartir.";
    return;
  }
  const territoryState = $("#newState")?.value || "unassigned";
  const territoryIds = Array.from(new Set(state.submitTerritoryIds));
  if (territoryState === "assigned" && !territoryIds.length) {
    if (feedback) feedback.textContent = "Busca e selecciona polo menos un territorio, ou cambia o estado territorial, antes de repartir a lista.";
    return;
  }
  const territories = territoryIds.map(id => state.territorios.find(item => item.id === id)).filter(Boolean);
  stanzas.forEach(({ text, isVolta }) => {
    const payload = {
      text,
      notes: "",
      status: "published",
      territory_state: territoryState,
      territories: territoryState === "assigned" ? territoryIds.map(id => ({ id })) : [],
      tags: [],
      is_volta: isVolta,
      versions: [],
    };
    state.submitBatch.push({
      payload,
      placeLabel: coplaPlaceLabel({ territories, territory_state: territoryState }),
      preview: firstLine(text) || "Copla sen íncipit",
      versionCount: 0,
      isVolta,
    });
  });
  textarea.value = "";
  const voltaCount = stanzas.filter(item => item.isVolta).length;
  if (feedback) feedback.textContent = `Engadidas ${stanzas.length} coplas á lista (${voltaCount} volta${voltaCount === 1 ? "" : "s"}). Revisa a lista de pendentes e preme «Gardar todas» cando remates.`;
  renderSubmitView();
}

function startEditCopla(coplaId) {
  const copla = state.coplas.find(item => Number(item.id) === Number(coplaId));
  if (!copla) return;
  state.submitEditingId = copla.id;
  state.submitEditingSnapshot = copla;
  state.submitBatch = [];
  state.submitTerritoryIds = (copla.territories || []).map(item => item.id);
  state.submitTerritoryId = state.submitTerritoryIds[0] || "";
  closeCoplaDrawer();
  setView("submit");
}

function cancelEditCopla() {
  state.submitEditingId = null;
  state.submitEditingSnapshot = null;
  state.submitTerritoryIds = [];
  state.submitTerritoryId = "";
  renderSubmitView();
}

async function fetchMediaMetadata(options = {}) {
  const feedback = $("#mediaFeedback");
  const url = $("#mediaUrl")?.value.trim();
  if (!url) {
    if (!options.silent && feedback) feedback.textContent = "Pega primeiro unha URL.";
    return;
  }
  if (feedback && !options.silent) feedback.textContent = "Lendo metadatos da ligazón...";
  try {
    const kind = mediaKind({ url });
    if ($("#mediaKind") && kind !== "web" && kind !== "media") $("#mediaKind").value = kind;
    const response = await fetch(`../api/link-preview?url=${encodeURIComponent(url)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puideron ler metadatos.");
    if (result.title && !$("#mediaTitle").value.trim()) $("#mediaTitle").value = result.title;
    if (result.description && !$("#mediaDescription").value.trim()) $("#mediaDescription").value = result.description;
    if (result.thumbnail_url && !$("#mediaThumb").value.trim()) $("#mediaThumb").value = result.thumbnail_url;
    if (result.provider && !$("#mediaSource").value.trim()) $("#mediaSource").value = result.provider;
    if (feedback) feedback.textContent = "Metadatos incorporados.";
  } catch (error) {
    if (feedback && !options.silent) feedback.textContent = `${error.message} Podes completar os campos manualmente.`;
  }
}

async function saveMediaDirect() {
  const payload = buildMediaPayloadFromForm();
  if (!payload) return;
  const feedback = $("#mediaFeedback");
  feedback.textContent = "Gardando media na base local...";
  try {
    const response = await fetch("../api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Non se puido gardar a media.");
    feedback.textContent = `Media gardada. IDs afectados: ${result.ids.join(", ")}`;
    clearApiCache();
    state.media = await getMedia();
    const firstTerritoryId = payload.media[0].links[0]?.entity_id;
    if (firstTerritoryId) state.selectedTerritory = state.territorios.find(item => item.id === firstTerritoryId) || state.selectedTerritory;
    state.mediaModalOpen = false;
    state.mediaDefaultRole = "";
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
  const items = filteredMediaItems();
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Media</div>
          <h1>Media</h1>
          <p>Biblioteca global de audio, vídeo, documentos e ligazóns. O formulario lembra o territorio activo para axilizar a alta.</p>
        </div>
        <button class="btn primary" type="button" id="openMediaModal">+ Novo recurso</button>
      </div>
      <div class="toolbar media-toolbar">
        <div class="searchbox"><span>⌕</span><input id="mediaSearch" type="search" value="${escapeHtml(state.mediaQuery)}" placeholder="Buscar por título, fonte, territorio..."></div>
        <select id="mediaKindFilter" aria-label="Filtrar tipo de media">
          <option value="">Todos os tipos</option>
          ${["youtube", "spotify", "soundcloud", "audio", "video", "image", "web"].map(kind => `<option value="${kind}" ${state.mediaKindFilter === kind ? "selected" : ""}>${mediaLabel(kind)}</option>`).join("")}
        </select>
        <select id="mediaRoleFilter" aria-label="Filtrar uso">
          <option value="">Todos os usos</option>
          ${["documental", "melody", "mixed"].map(role => `<option value="${role}" ${state.mediaRoleFilter === role ? "selected" : ""}>${mediaRoleLabel(role)}</option>`).join("")}
        </select>
      </div>
      <div id="mediaList" class="media-grid">
        ${items.map(mediaCard).join("") || `<article class="panel"><p class="muted">Aínda non hai recursos multimedia para mostrar.</p></article>`}
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
  all("[data-close-media-modal]", view).forEach(item => item.addEventListener("click", closeMediaModal));
  bindMediaTerritoryPicker();
  bindMediaCoplaPicker();
  bindSelectedTerritoryChips(view);
  bindMediaCards(view);
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
    ].join(" ")).includes(query);
    return matchesKind && matchesRole && matchesText;
  });
}

function updateMediaResults(root = $("#view-media")) {
  const list = $("#mediaList", root);
  if (!list) return;
  const items = filteredMediaItems();
  list.innerHTML = items.map(mediaCard).join("") || `<article class="panel"><p class="muted">Aínda non hai recursos multimedia para mostrar.</p></article>`;
  bindMediaCards(root);
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
    if (label) label.textContent = `${territory.nome} · ${territorySearchMeta(territory)}`;
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
  const subject = `Nova copla para Fol e Ar${payload.territory_name ? ` · ${payload.territory_name}` : ""}`;
  window.location.href = `mailto:folear3@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function renderAboutView() {
  $("#view-about").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="eyebrow">Proxecto</div>
          <h1>Sobre Fol e ar</h1>
          <p>Arquivo dixital para conservar, consultar e montar repertorio tradicional galego desde o territorio e desde o texto.</p>
        </div>
      </div>
      <div class="about-grid">
        <article class="panel"><h2>Explorar</h2><p>Mapa e territorios para descubrir repertorio sen coñecer previamente o corpus.</p></article>
        <article class="panel"><h2>Consultar</h2><p>Coplas en grade, lista ou galería, con procura textual e lectura de variantes.</p></article>
        <article class="panel"><h2>Construír</h2><p>Pezas como carriño editorial: escoller, ordenar, separar por ritmos e exportar para cantar.</p></article>
        <article class="panel"><h2>Contacto</h2><p>Dúbidas, correccións ou coplas para achegar: escríbenos a <a href="mailto:folear3@gmail.com">folear3@gmail.com</a>.</p></article>
      </div>
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
    </div>
  `;
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
  if (state.view === "pieces") renderPiecesView();
  if (state.view === "territory") renderTerritoryView();
  if (state.view === "submit") renderSubmitView();
  if (state.view === "media") renderMediaView();
  if (state.view === "about") renderAboutView();
}

function bindGlobalEvents() {
  document.addEventListener("click", event => {
    const nav = event.target.closest("[data-view]");
    if (nav) {
      if (normalizeView(nav.dataset.view) === "media" && nav.dataset.mediaRole) {
        state.mediaDefaultRole = nav.dataset.mediaRole;
        state.mediaModalOpen = true;
      }
      if (normalizeView(nav.dataset.view) === "territory") {
        state.selectedTerritory = null;
        state.territoryTab = "summary";
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
      if (state.mediaModalOpen) {
        closeMediaModal();
        return;
      }
      closeCoplaDrawer();
      if (state.selectedTerritory && state.view === "map") clearTerritory();
    }
  });
}

async function init() {
  bindGlobalEvents();
  updateCartBadges();
  setView(normalizeView(new URL(window.location.href).searchParams.get("mode") || new URL(window.location.href).searchParams.get("view") || "map"));

  const [territorios, coplas, pezas, media] = await Promise.allSettled([
    getTerritorios(),
    getCoplas(),
    getPezas(),
    getMedia(),
  ]);
  state.territorios = territorios.status === "fulfilled" ? territorios.value : [];
  state.coplas = coplas.status === "fulfilled" ? coplas.value : [];
  state.pezas = pezas.status === "fulfilled" ? pezas.value : [];
  state.media = media.status === "fulfilled" ? media.value : [];

  if (window.L) {
    state.map = L.map("map", { zoomControl: false }).setView([42.8, -8.2], 8);
    L.control.zoom({ position: "bottomleft" }).addTo(state.map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      opacity: 0.6,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.map);
    try {
      await loadLayer("con");
    } catch (error) {
      console.error(error);
      $("#map").insertAdjacentHTML("beforeend", `<div class="map-load-error">Non se puido cargar a capa territorial.</div>`);
    }
  } else {
    $("#map").innerHTML = `<div class="map-fallback"><h2>Non se puido cargar Leaflet</h2><p>Comproba a conexión ou serve a libraría localmente.</p></div>`;
  }

  const params = new URL(window.location.href).searchParams;
  const territoryId = params.get("territory_id") || params.get("id");
  const coplaId = params.get("copla_id");
  if (territoryId) {
    const territory = state.territorios.find(item => item.id === territoryId);
    if (territory) await selectTerritory(territory);
  }
  if (coplaId) state.selectedCoplaId = Number(coplaId);

  updateMapCard();
  setView(coplaId ? "coplas" : normalizeView(params.get("mode") || params.get("view") || "map"));
  if (coplaId) openCoplaDrawer(Number(coplaId));
}

init().catch(error => {
  console.error(error);
  const active = $(".view.active");
  if (active) {
    active.insertAdjacentHTML("afterbegin", `<div class="runtime-warning">Erro parcial ao cargar: ${escapeHtml(error.message)}</div>`);
  }
});
