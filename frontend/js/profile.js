// Espazo persoal: perfil, directorio de persoas e favoritos.
//
// Módulo autónomo (ver index.html), no mesmo estilo ca js/auth.js:
//   - "O meu espazo" (vista `profile`): nome que se amosa, enderezo curto,
//     lugar, presentación, perfil público opcional e lista de favoritos.
//   - "Persoas" (vista `people`): directorio dos perfís públicos e páxina de
//     cada persoa (#/persoa/<enderezo>).
//   - Estrelas de favorito en coplas e lugares, inxectadas no DOM sen tocar
//     o resto da aplicación.
//
// O servidor é quen decide: aquí só se debuxa. Todo o personal é privado ata
// que a persoa activa o perfil público. Ver privacidade.html.

const API = "../api";
const DATA = "./data/exports";
const KIND_LABELS = { copla: "Coplas", territory: "Lugares", tag: "Etiquetas", media: "Recursos", melody: "Melodías", piece: "Pezas" };
const FAV_HEADINGS = {
  copla: "Coplas favoritas", territory: "Lugares favoritos", tag: "Etiquetas favoritas",
  media: "Recursos favoritos", melody: "Melodías favoritas", piece: "Pezas favoritas",
};
const KIND_EMPTY = { copla: "coplas", territory: "lugares", tag: "etiquetas", media: "recursos", melody: "melodías", piece: "pezas" };
const TERRITORY_TYPES = { prov: "provincia", com: "comarca", con: "concello", par: "parroquia" };

const S = {
  favorites: { copla: new Set(), territory: new Set(), tag: new Set(), media: new Set(), melody: new Set(), piece: new Set() },
  favEnabled: false,
  favTab: "copla",
  personHandle: "",
  data: null,
  following: new Set(),
  followingList: [],
  followsEnabled: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function auth() {
  return window.folearAuth || { mode: "offline", user: null, ready: false };
}

function loggedIn() {
  const a = auth();
  return a.mode === "google" && Boolean(a.user) && !a.user.open;
}

function toast(message) {
  if (window.folearAuth?.toast) window.folearAuth.toast(message);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.ok === false) {
    const error = new Error((data && data.error) || `Erro ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function normalize(text) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// --- Datos públicos (os mesmos exportes cacheados que usa a aplicación) --

async function loadData() {
  if (S.data) return S.data;
  const optional = path => fetch(`${DATA}/${path}`).then(response => (response.ok ? response.json() : [])).catch(() => []);
  const [coplas, territorios, media, melodias] = await Promise.all([
    fetch(`${DATA}/coplas/coplas.json`).then(response => response.json()),
    fetch(`${DATA}/territorios/territorios.json`).then(response => response.json()),
    optional("media/media.json"),
    optional("melodias/melodias.json"),
  ]);
  const territoryById = new Map(territorios.map(item => [item.id, item]));
  const coplaById = new Map(coplas.map(item => [String(item.id), item]));
  const mediaById = new Map((Array.isArray(media) ? media : []).map(item => [String(item.id), item]));
  const melodyById = new Map((Array.isArray(melodias) ? melodias : []).map(item => [String(item.id), item]));
  const tagCounts = new Map();
  coplas.forEach(copla => (copla.tags || []).forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)));
  S.data = { coplas, territorios, territoryById, coplaById, mediaById, melodyById, tagCounts };
  return S.data;
}

// Pezas: as que xa ten a aplicación (públicas + as da persoa). Se aínda non
// cargaron, o exporte público.
async function loadPieces() {
  const fromApp = window.folearApp?.pieces?.() || [];
  if (fromApp.length) return fromApp;
  try {
    const list = await fetch(`${DATA}/pezas/pezas.json`).then(response => (response.ok ? response.json() : []));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function coplaTitleOf(copla) {
  const first = String(copla.incipit || copla.text || "").split("\n").find(line => line.trim()) || "";
  return first.trim() || `Copla ${copla.id}`;
}

function territoryMeta(territory) {
  return TERRITORY_TYPES[territory.tipo] || territory.tipo || "";
}

// --- Favoritos -----------------------------------------------------------

async function loadFollows() {
  S.following.clear();
  S.followingList = [];
  S.followsEnabled = false;
  if (!loggedIn()) return;
  try {
    const data = await api("/me/follows");
    S.followingList = data.following || [];
    S.followingList.forEach(person => S.following.add(person.handle));
    S.followsEnabled = true;
  } catch {
    S.followsEnabled = false; // sen migración 0005
  }
}

async function loadFavorites() {
  for (const set of Object.values(S.favorites)) set.clear();
  S.favEnabled = false;
  if (!loggedIn()) return;
  try {
    const data = await api("/me/favorites");
    for (const [kind, refs] of Object.entries(data.favorites || {})) {
      if (S.favorites[kind]) refs.forEach(ref => S.favorites[kind].add(String(ref)));
    }
    S.favEnabled = true;
  } catch {
    S.favEnabled = false; // sen migración 0004 ou sen API: sen estrelas
  }
}

function isFav(kind, ref) {
  return Boolean(S.favorites[kind]?.has(String(ref)));
}

function favGlyph(on) {
  return on ? "★" : "☆";
}

function favButtonMarkup(kind, ref, { label = false, compact = false } = {}) {
  const on = isFav(kind, ref);
  const title = on ? "Quitar dos favoritos" : "Gardar nos favoritos";
  return `<button type="button" class="fav-btn${label ? " has-label" : ""}${compact ? " is-compact" : ""}${on ? " is-on" : ""}" data-fav-kind="${esc(kind)}" data-fav-ref="${esc(ref)}" aria-pressed="${on}" title="${title}" aria-label="${title}"><span aria-hidden="true">${favGlyph(on)}</span>${label ? `<span class="fav-label">${on ? "Gardado" : "Gardar"}</span>` : ""}</button>`;
}

function refreshFavButtons(kind, ref) {
  const selector = `.fav-btn[data-fav-kind="${CSS.escape(kind)}"][data-fav-ref="${CSS.escape(String(ref))}"]`;
  document.querySelectorAll(selector).forEach(button => {
    const on = isFav(kind, ref);
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
    const title = on ? "Quitar dos favoritos" : "Gardar nos favoritos";
    button.title = title;
    button.setAttribute("aria-label", title);
    const glyph = button.querySelector("span[aria-hidden]");
    if (glyph) glyph.textContent = favGlyph(on);
    const label = button.querySelector(".fav-label");
    if (label) label.textContent = on ? "Gardado" : "Gardar";
  });
}

async function toggleFavorite(kind, ref) {
  const wasOn = isFav(kind, ref);
  const set = S.favorites[kind];
  if (wasOn) set.delete(String(ref)); else set.add(String(ref));
  refreshFavButtons(kind, ref);
  try {
    await api("/me/favorites", { method: "POST", body: JSON.stringify({ kind, ref: String(ref), on: !wasOn }) });
    if (document.querySelector("#view-profile.active")) renderProfile();
  } catch (error) {
    if (wasOn) set.add(String(ref)); else set.delete(String(ref));
    refreshFavButtons(kind, ref);
    toast(error.message || "Non se puido gardar o favorito.");
  }
}

function territoryIdFrom(selector) {
  const id = document.querySelector(selector)?.dataset.silhouetteHero || "";
  return id && id !== "galiza" ? id : "";
}

// Engade as estrelas ao que xa está debuxado. Idempotente e barato: só toca
// nodos que aínda non levan estrela.
function decorate() {
  if (!S.favEnabled) return;

  document.querySelectorAll(".gallery-card[data-open-copla]:not([data-fav-done]), .incipit-row[data-open-copla]:not([data-fav-done])").forEach(card => {
    card.dataset.favDone = "1";
    const wrapper = document.createElement("span");
    wrapper.className = "fav-slot";
    wrapper.innerHTML = favButtonMarkup("copla", card.dataset.openCopla);
    if (card.classList.contains("incipit-row")) {
      card.append(wrapper);
    } else if (card.classList.contains("as-list")) {
      const top = card.querySelector(".gallery-top");
      (top || card).append(wrapper);
      wrapper.classList.add("in-top");
    } else {
      card.append(wrapper);
      wrapper.classList.add("is-float");
    }
  });

  document.querySelectorAll(".piece-card[data-open-piece]:not([data-fav-done])").forEach(card => {
    card.dataset.favDone = "1";
    appendMetaStar(card, "piece", card.dataset.openPiece);
  });
  document.querySelectorAll(".media-card[data-media-id]:not([data-fav-done]), .media-row[data-media-id]:not([data-fav-done])").forEach(card => {
    card.dataset.favDone = "1";
    appendMetaStar(card, "media", card.dataset.mediaId);
  });
  document.querySelectorAll(".melody-card[data-open-melody]:not([data-fav-done]), .melody-row[data-open-melody]:not([data-fav-done])").forEach(card => {
    card.dataset.favDone = "1";
    appendMetaStar(card, "melody", card.dataset.openMelody);
  });
  document.querySelectorAll("#coplaDrawer .meta .tag[data-tag-name]:not([data-fav-done])").forEach(tag => {
    tag.dataset.favDone = "1";
    tag.classList.add("has-star");
    tag.insertAdjacentHTML("beforeend", favButtonMarkup("tag", tag.dataset.tagName, { compact: true }));
  });
  document.querySelectorAll("#pieceDrawer .drawer-actions:not([data-fav-done])").forEach(actions => {
    actions.dataset.favDone = "1";
    const id = actions.querySelector("[data-download-piece-pdf]")?.dataset.downloadPiecePdf;
    if (id) actions.insertAdjacentHTML("afterbegin", favButtonMarkup("piece", id, { label: true }));
  });

  document.querySelectorAll("#coplaDrawer .drawer-actions:not([data-fav-done])").forEach(actions => {
    actions.dataset.favDone = "1";
    const id = actions.querySelector("[data-add-copla]")?.dataset.addCopla;
    if (id) actions.insertAdjacentHTML("afterbegin", favButtonMarkup("copla", id, { label: true }));
  });

  const heroId = territoryIdFrom("#territorySilhouette");
  document.querySelectorAll("#view-territory .territory-card:not([data-fav-done])").forEach(card => {
    card.dataset.favDone = "1";
    if (!heroId) return;
    const heading = card.querySelector("h1");
    if (heading) heading.insertAdjacentHTML("afterend", `<div class="fav-row">${favButtonMarkup("territory", heroId, { label: true })}</div>`);
  });

  const mapId = territoryIdFrom("#mapCardSil");
  const title = document.getElementById("mapCardTitle");
  if (title) {
    let row = document.getElementById("mapFavRow");
    if (!row) {
      title.insertAdjacentHTML("afterend", `<div class="fav-row" id="mapFavRow"></div>`);
      row = document.getElementById("mapFavRow");
    }
    const current = row.querySelector(".fav-btn")?.dataset.favRef || "";
    if (current !== mapId) row.innerHTML = mapId ? favButtonMarkup("territory", mapId, { label: true }) : "";
  }
}

function appendMetaStar(card, kind, ref) {
  const meta = card.querySelector(".meta") || card;
  const wrapper = document.createElement("span");
  wrapper.className = "fav-slot in-meta";
  wrapper.innerHTML = favButtonMarkup(kind, ref);
  meta.append(wrapper);
}

function startObserver() {
  const root = document.querySelector(".main") || document.body;
  let queued = false;
  const run = () => {
    queued = false;
    decorate();
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-silhouette-hero"] });
  decorate();
}

// --- O meu espazo --------------------------------------------------------

function avatarHtml(name, picture) {
  const initial = esc((name || "?").trim().charAt(0).toUpperCase());
  return picture
    ? `<span class="account-avatar is-large"><img src="${esc(picture)}" alt="" referrerpolicy="no-referrer"></span>`
    : `<span class="account-avatar is-large">${initial}</span>`;
}

function publicUrl(handle) {
  return `${window.location.origin}${window.location.pathname}#/persoa/${handle}`;
}

async function renderProfile() {
  const view = document.getElementById("view-profile");
  if (!view) return;
  if (!auth().ready) {
    view.innerHTML = `<div class="page profile-page"><p class="muted">Cargando...</p></div>`;
    return;
  }
  if (!loggedIn()) {
    view.innerHTML = `
      <div class="page profile-page">
        <div class="page-head"><div><div class="eyebrow">O meu espazo</div><h1>Entra para ter o teu espazo</h1>
        <p>Con unha conta de Google tes o teu espazo: favoritos de coplas, lugares, etiquetas, recursos e melodías; as túas pezas (privadas ou na biblioteca pública); seguir a outras persoas e, se queres, un perfil público. Consultar o arquivo non require conta.</p></div></div>
        <p><a class="btn primary" href="${esc(window.folearAuth?.loginUrl?.() || "#")}">Entrar con Google</a></p>
        <p class="muted small-print"><a href="./privacidade.html" data-privacy-link>Como tratamos os teus datos</a></p>
      </div>`;
    return;
  }

  let me;
  try {
    me = await api("/me/profile");
  } catch (error) {
    view.innerHTML = `<div class="page profile-page"><div class="page-head"><div><div class="eyebrow">O meu espazo</div><h1>O meu espazo</h1></div></div><p class="muted">${esc(error.message)}</p></div>`;
    return;
  }
  const profile = me.profile;
  const user = auth().user;
  const shownName = profile.display_name || me.account.google_name || user.name || "";
  let data = null;
  try { data = await loadData(); } catch { /* o formulario funciona igual */ }
  const allPieces = await loadPieces();
  const myPieces = allPieces.filter(piece => piece.mine);
  await loadFollows();

  view.innerHTML = `
    <div class="page profile-page">
      <div class="page-head">
        <div class="profile-id">
          ${avatarHtml(shownName, me.account.picture)}
          <div>
            <div class="eyebrow">O meu espazo</div>
            <h1>${esc(shownName || "O meu espazo")}</h1>
            <p>${profile.is_public && profile.handle ? `Perfil público · <a href="#/persoa/${esc(profile.handle)}" data-person-link="${esc(profile.handle)}">ver como o ven as outras persoas</a>` : "O teu perfil é privado: ninguén máis o ve."}</p>
          </div>
        </div>
      </div>

      <section class="panel profile-form-panel">
        <div class="section-title"><h2>Perfil</h2></div>
        <form id="profileForm" class="profile-form" autocomplete="off" novalidate>
          <div class="field">
            <label for="pfName">Nome que se amosa</label>
            <input id="pfName" name="display_name" maxlength="60" value="${esc(profile.display_name)}" placeholder="${esc(me.account.google_name || "O teu nome")}">
            <small>Non se usa o teu nome de Google a non ser que o escribas aquí. O teu correo non se amosa nunca.</small>
          </div>
          <div class="field">
            <label for="pfHandle">Enderezo curto</label>
            <input id="pfHandle" name="handle" maxlength="30" value="${esc(profile.handle)}" placeholder="por exemplo: maria-de-lugo" autocapitalize="none" spellcheck="false">
            <small>Só minúsculas sen acentos, números e guións (3-30). A túa páxina sería <code>#/persoa/<span id="pfHandlePreview">${esc(profile.handle || "o-teu-enderezo")}</span></code>.</small>
          </div>
          <div class="field">
            <label for="pfPlace">Lugar (opcional)</label>
            <div class="place-pick">
              <input id="pfPlace" type="search" value="${esc(profile.territory_name)}" placeholder="Busca un concello, parroquia ou comarca" data-territory="${esc(profile.territory_id)}">
              <button class="btn" type="button" id="pfPlaceClear" ${profile.territory_id ? "" : "hidden"}>Quitar</button>
            </div>
            <div id="pfPlaceResults" class="place-results" hidden></div>
          </div>
          <div class="field full">
            <label for="pfBio">Presentación (opcional)</label>
            <textarea id="pfBio" name="bio" rows="3" maxlength="280" placeholder="Unhas liñas sobre ti, a túa relación coa música tradicional...">${esc(profile.bio)}</textarea>
            <small><span id="pfBioCount">${profile.bio.length}</span>/280</small>
          </div>
          <label class="check-row">
            <input type="checkbox" name="is_public" ${profile.is_public ? "checked" : ""}>
            <span><strong>Perfil público</strong><small>Aparece no directorio «Persoas» e calquera pode ver o teu nome, lugar e presentación. Precisa nome e enderezo. Podes desactivalo cando queiras.</small></span>
          </label>
          <label class="check-row">
            <input type="checkbox" name="show_favorites" ${profile.show_favorites ? "checked" : ""}>
            <span><strong>Amosar os meus favoritos no perfil público</strong><small>Só se ve se o perfil é público. Por defecto os favoritos son privados.</small></span>
          </label>
          <div class="form-actions">
            <button class="btn primary" type="submit">Gardar perfil</button>
            <span id="pfStatus" class="muted" role="status"></span>
          </div>
        </form>
      </section>

      <section class="panel profile-pieces">
        <div class="section-title"><h2>As miñas pezas <span class="muted">${myPieces.length}</span></h2><button class="btn" type="button" id="newPieceBtn">Nova peza</button></div>
        ${myPiecesHtml(myPieces)}
        <p class="muted small-print">Gárdanse desde Pezas \\ Obradoiro. Privadas, só as ves ti; públicas, aparecen na biblioteca${profile.is_public ? " co teu nome" : " (o teu perfil é privado, así que sen o teu nome)"}.</p>
      </section>

      <section class="panel profile-favs">
        <div class="section-title"><h2>Os meus favoritos</h2></div>
        <div class="territory-tabs fav-tabs" id="favTabs">
          ${Object.entries(KIND_LABELS).map(([kind, label]) => `<button type="button" class="${S.favTab === kind ? "active" : ""}" data-fav-tab="${kind}">${label} (${S.favorites[kind].size})</button>`).join("")}
        </div>
        ${S.favTab === "tag" ? tagPickerHtml() : ""}
        <div id="favList" class="fav-list">${favoritesListHtml(S.favTab, [...S.favorites[S.favTab]], data, { pieces: allPieces })}</div>
        <p class="muted small-print">Gárdanse co botón ☆ de cada copla, lugar, etiqueta, recurso, melodía e peza.</p>
      </section>

      ${S.followsEnabled ? followingPanelHtml(allPieces) : ""}

      <section class="panel profile-danger">
        <div class="section-title"><h2>A miña conta</h2></div>
        <p class="muted">Podes borrar a túa conta cando queiras: elimínanse o teu perfil, os teus favoritos, as túas pezas e a túa sesión. Non se borra nada do arquivo. <a href="./privacidade.html" data-privacy-link>Política de privacidade</a>.</p>
        <button class="btn danger" type="button" id="deleteAccount">Borrar a miña conta</button>
      </section>
    </div>`;

  bindProfileForm(view, profile, data);
  bindFavList(view, data, allPieces);
  bindMyPieces(view);
  bindFollowing(view);
}

function visibilityLabel(piece) {
  if (piece.status === "hidden") return "Agochada";
  return piece.visibility === "private" ? "Privada" : "Pública";
}

function myPiecesHtml(pieces) {
  if (!pieces.length) return `<p class="muted">Aínda non gardaches ningunha peza. Compón unha no obradoiro: podes deixala privada ou publicala na biblioteca.</p>`;
  return `<div class="fav-list">${pieces.map(piece => `
    <div class="fav-item piece-row" data-piece-row="${esc(piece.id)}">
      <button type="button" class="fav-open" data-open-piece-id="${esc(piece.id)}"><strong>${esc(piece.title || "Peza sen título")}</strong><span>${piece.copla_count || (piece.coplas || []).length} coplas</span></button>
      <span class="piece-vis is-${piece.status === "hidden" ? "hidden" : piece.visibility}">${visibilityLabel(piece)}</span>
      <button type="button" class="btn" data-edit-piece-id="${esc(piece.id)}">Editar</button>
      <button type="button" class="btn" data-vis-piece-id="${esc(piece.id)}" data-vis-next="${piece.visibility === "private" ? "public" : "private"}">${piece.visibility === "private" ? "Publicar" : "Facer privada"}</button>
    </div>`).join("")}</div>`;
}

function bindMyPieces(view) {
  view.querySelector("#newPieceBtn")?.addEventListener("click", () => window.folearApp?.newPiece?.());
  view.querySelectorAll("[data-open-piece-id]").forEach(button => button.addEventListener("click", () => window.folearApp?.openPiece?.(button.dataset.openPieceId)));
  view.querySelectorAll("[data-edit-piece-id]").forEach(button => button.addEventListener("click", () => window.folearApp?.editPiece?.(button.dataset.editPieceId)));
  view.querySelectorAll("[data-vis-piece-id]").forEach(button => button.addEventListener("click", async () => {
    const next = button.dataset.visNext;
    if (next === "public" && !window.confirm("A peza vai aparecer na biblioteca pública e calquera persoa poderá lela. ¿Publicala?")) return;
    button.disabled = true;
    try {
      await api("/pieces/visibility", { method: "POST", body: JSON.stringify({ id: Number(button.dataset.visPieceId), visibility: next }) });
      await window.folearApp?.refreshPezas?.({ render: true });
      toast(next === "public" ? "Peza publicada na biblioteca." : "A peza é agora privada.");
      renderProfile();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  }));
}

function followingPanelHtml(allPieces) {
  const handles = new Set(S.following);
  const recent = allPieces
    .filter(piece => piece.owner && handles.has(piece.owner.handle) && piece.status !== "hidden")
    .slice(0, 8);
  const people = S.followingList.length
    ? `<div class="people-chips">${S.followingList.map(person => `<a class="chip-link" href="#/persoa/${esc(person.handle)}" data-person-link="${esc(person.handle)}">${esc(person.display_name)}</a>`).join("")}</div>`
    : `<p class="muted">Aínda non segues a ninguén. Mira o <a href="#" data-go-people>directorio de persoas</a> e segue a quen publique pezas que che interesen.</p>`;
  const news = S.followingList.length
    ? (recent.length
      ? `<h3 class="sub-title">Pezas recentes</h3><div class="fav-list">${recent.map(piece => `<div class="fav-item"><button type="button" class="fav-open" data-open-piece-id="${esc(piece.id)}"><strong>${esc(piece.title)}</strong><span>${esc(piece.owner.display_name)}</span></button></div>`).join("")}</div>`
      : `<p class="muted small-print">As persoas que segues aínda non publicaron pezas.</p>`)
    : "";
  return `<section class="panel profile-following"><div class="section-title"><h2>Persoas que sigo <span class="muted">${S.followingList.length}</span></h2></div>${people}${news}</section>`;
}

function bindFollowing(view) {
  view.querySelectorAll("[data-go-people]").forEach(link => link.addEventListener("click", event => {
    event.preventDefault();
    document.querySelector('[data-view="people"]')?.click();
  }));
}

function tagPickerHtml() {
  return `<div class="tag-picker"><input id="tagPickInput" type="search" list="tagPickList" placeholder="Buscar unha etiqueta para gardala..." autocomplete="off"><datalist id="tagPickList">${[...(S.data?.tagCounts?.keys() || [])].sort((a, b) => a.localeCompare(b, "gl")).map(tag => `<option value="${esc(tag)}"></option>`).join("")}</datalist><button class="btn" type="button" id="tagPickAdd">Gardar etiqueta</button></div>`;
}

function favoritesListHtml(kind, refs, data, { stars = true, pieces = [] } = {}) {
  if (!refs.length) return `<p class="muted">Aínda non tes ${KIND_EMPTY[kind] || "favoritos"} gardados.</p>`;
  if (!data) return `<p class="muted">Non se puido cargar o arquivo para amosar os favoritos.</p>`;
  const row = (open, star) => `<div class="fav-item">${open}${stars ? star : ""}</div>`;
  const rows = refs.map(ref => {
    if (kind === "copla") {
      const copla = data.coplaById.get(String(ref));
      if (!copla) return "";
      return row(`<button type="button" class="fav-open" data-copla-id="${esc(copla.id)}"><strong>${esc(coplaTitleOf(copla))}</strong></button>`, favButtonMarkup("copla", copla.id));
    }
    if (kind === "territory") {
      const territory = data.territoryById.get(String(ref));
      if (!territory) return "";
      return row(`<button type="button" class="fav-open" data-territory-id="${esc(territory.id)}"><strong>${esc(territory.nome)}</strong><span>${esc(territoryMeta(territory))}</span></button>`, favButtonMarkup("territory", territory.id));
    }
    if (kind === "tag") {
      const count = data.tagCounts?.get(ref);
      return row(`<button type="button" class="fav-open" data-tag-search="${esc(ref)}"><strong>${esc(ref)}</strong><span>${count ? `${count} copla${count === 1 ? "" : "s"}` : "etiqueta"}</span></button>`, favButtonMarkup("tag", ref));
    }
    if (kind === "media") {
      const item = data.mediaById?.get(String(ref));
      if (!item) return "";
      return row(`<button type="button" class="fav-open" data-media-url="${esc(item.url || "")}"><strong>${esc(item.title || "Recurso")}</strong><span>${esc(item.media_kind || item.provider || "")}</span></button>`, favButtonMarkup("media", item.id));
    }
    if (kind === "melody") {
      const melody = data.melodyById?.get(String(ref));
      if (!melody) return "";
      return row(`<button type="button" class="fav-open" data-melody-id="${esc(melody.id)}"><strong>${esc(melody.name || `${melody.rhythm} ${melody.number}`)}</strong><span>${esc(melody.rhythm || "")}</span></button>`, favButtonMarkup("melody", melody.id));
    }
    if (kind === "piece") {
      const piece = pieces.find(item => String(item.id) === String(ref));
      if (!piece) return "";
      return row(`<button type="button" class="fav-open" data-open-piece-id="${esc(piece.id)}"><strong>${esc(piece.title || "Peza")}</strong><span>${esc(piece.author && piece.author !== "Sen autoría" ? piece.author : "")}</span></button>`, favButtonMarkup("piece", piece.id));
    }
    return "";
  }).join("");
  return rows || `<p class="muted">Eses favoritos xa non existen no arquivo.</p>`;
}

function bindOpenButtons(view) {
  view.querySelectorAll("[data-open-piece-id]").forEach(button => button.addEventListener("click", () => window.folearApp?.openPiece?.(button.dataset.openPieceId)));
  view.querySelectorAll("[data-tag-search]").forEach(button => button.addEventListener("click", () => window.folearApp?.searchCoplas?.(button.dataset.tagSearch)));
  view.querySelectorAll("[data-melody-id]").forEach(button => button.addEventListener("click", () => window.folearApp?.openMelody?.(button.dataset.melodyId)));
  view.querySelectorAll("[data-media-url]").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.mediaUrl) window.open(button.dataset.mediaUrl, "_blank", "noopener");
  }));
}

function bindFavList(view, data, allPieces) {
  view.querySelectorAll("[data-fav-tab]").forEach(button => button.addEventListener("click", () => {
    S.favTab = button.dataset.favTab;
    renderProfile();
  }));
  window.folearApp?.bindResultButtons?.(view);
  bindOpenButtons(view);
  view.querySelectorAll("[data-person-link]").forEach(link => link.addEventListener("click", () => {
    S.personHandle = link.dataset.personLink;
  }));
  const input = view.querySelector("#tagPickInput");
  view.querySelector("#tagPickAdd")?.addEventListener("click", async () => {
    const tag = input.value.trim();
    if (!tag) return;
    if (!data?.tagCounts?.has(tag)) { toast("Esa etiqueta non existe no arquivo."); return; }
    if (!isFav("tag", tag)) await toggleFavorite("tag", tag);
    renderProfile();
  });
}

function bindProfileForm(view, profile, data) {
  const form = view.querySelector("#profileForm");
  const status = view.querySelector("#pfStatus");
  const nameInput = view.querySelector("#pfName");
  const handleInput = view.querySelector("#pfHandle");
  const preview = view.querySelector("#pfHandlePreview");
  const bio = view.querySelector("#pfBio");
  const place = view.querySelector("#pfPlace");
  const results = view.querySelector("#pfPlaceResults");
  const clear = view.querySelector("#pfPlaceClear");

  handleInput.addEventListener("input", () => {
    handleInput.value = handleInput.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    preview.textContent = handleInput.value || "o-teu-enderezo";
  });
  bio.addEventListener("input", () => { view.querySelector("#pfBioCount").textContent = String(bio.value.length); });

  const setPlace = (id, label) => {
    place.dataset.territory = id;
    place.value = label;
    clear.hidden = !id;
    results.hidden = true;
  };
  place.addEventListener("input", () => {
    place.dataset.territory = "";
    clear.hidden = true;
    const query = normalize(place.value).trim();
    if (query.length < 2 || !data) { results.hidden = true; return; }
    const hits = data.territorios
      .filter(item => normalize(item.search || item.nome).includes(query) || normalize(item.nome).includes(query))
      .sort((a, b) => ["con", "par", "com", "prov"].indexOf(a.tipo) - ["con", "par", "com", "prov"].indexOf(b.tipo) || a.nome.localeCompare(b.nome, "gl"))
      .slice(0, 8);
    results.innerHTML = hits.map(item => `<button type="button" data-pick="${esc(item.id)}"><strong>${esc(item.nome)}</strong><span>${esc(territoryMeta(item))}</span></button>`).join("") || `<p class="muted">Sen resultados.</p>`;
    results.hidden = false;
    results.querySelectorAll("[data-pick]").forEach(button => button.addEventListener("click", () => {
      const item = data.territoryById.get(button.dataset.pick);
      if (item) setPlace(item.id, item.nome);
    }));
  });
  clear.addEventListener("click", () => setPlace("", ""));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    status.textContent = "Gardando...";
    const body = {
      display_name: nameInput.value,
      handle: handleInput.value,
      bio: bio.value,
      territory_id: place.dataset.territory || "",
      is_public: form.elements.is_public.checked,
      show_favorites: form.elements.show_favorites.checked,
    };
    try {
      await api("/me/profile", { method: "POST", body: JSON.stringify(body) });
      await window.folearAuth?.refresh?.();
      status.textContent = "";
      toast("Perfil gardado.");
      renderProfile();
    } catch (error) {
      status.textContent = error.message;
    }
  });

  view.querySelector("#deleteAccount").addEventListener("click", async () => {
    const ok = window.confirm("Vas borrar a túa conta, o teu perfil e os teus favoritos. Non se pode desfacer. ¿Continuar?");
    if (!ok) return;
    try {
      await api("/me/delete", { method: "POST", body: JSON.stringify({ confirm: true }) });
      window.location.hash = "";
      window.location.reload();
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

// --- Persoas -------------------------------------------------------------

async function renderPeople() {
  const view = document.getElementById("view-people");
  if (!view) return;
  if (S.personHandle) return renderPerson(view, S.personHandle);
  view.innerHTML = `<div class="page people-page"><p class="muted">Cargando...</p></div>`;
  let people = [];
  try {
    people = (await api("/people", { cache: "default" })).people || [];
  } catch {
    view.innerHTML = `<div class="page people-page"><div class="page-head"><div><div class="eyebrow">Comunidade</div><h1>Persoas</h1></div></div><p class="muted">O directorio non está dispoñible agora mesmo.</p></div>`;
    return;
  }
  const paint = query => {
    const q = normalize(query).trim();
    const shown = people.filter(person => !q || normalize(`${person.display_name} ${person.territory_name} ${person.bio}`).includes(q));
    view.querySelector("#peopleCards").innerHTML = shown.map(person => `
      <a class="person-card" href="#/persoa/${esc(person.handle)}" data-person-link="${esc(person.handle)}">
        ${avatarHtml(person.display_name, null)}
        <span class="person-card-body">
          <strong>${esc(person.display_name)}</strong>
          ${person.territory_name ? `<span class="person-place">${esc(person.territory_name)}</span>` : ""}
          ${person.bio ? `<span class="person-bio">${esc(person.bio)}</span>` : ""}
        </span>
      </a>`).join("") || `<p class="muted">${people.length ? "Sen resultados." : "Aínda ninguén fixo público o seu perfil. Podes ser a primeira persoa desde «O meu espazo»."}</p>`;
    view.querySelectorAll("[data-person-link]").forEach(link => link.addEventListener("click", () => { S.personHandle = link.dataset.personLink; }));
  };
  view.innerHTML = `
    <div class="page people-page">
      <div class="page-head"><div><div class="eyebrow">Comunidade</div><h1>Persoas</h1>
      <p>Quen decidiu amosar o seu perfil. Cada persoa elixe que comparte.</p></div></div>
      <div class="toolbar"><div class="searchbox"><span>⌕</span><input id="peopleSearch" type="search" placeholder="Buscar por nome, lugar..."></div></div>
      <div id="peopleCards" class="people-cards"></div>
    </div>`;
  view.querySelector("#peopleSearch").addEventListener("input", event => paint(event.target.value));
  paint("");
}

async function renderPerson(view, handle) {
  view.innerHTML = `<div class="page people-page"><p class="muted">Cargando...</p></div>`;
  let result;
  try {
    result = await api(`/people/${encodeURIComponent(handle)}`, { cache: "default" });
  } catch (error) {
    view.innerHTML = `<div class="page people-page"><p><a class="btn" href="#" data-people-back>← Persoas</a></p><h1>Perfil non atopado</h1><p class="muted">${esc(error.message)}</p></div>`;
    bindBack(view);
    return;
  }
  const { person, favorites } = result;
  let data = null;
  if (favorites) { try { data = await loadData(); } catch { /* sen lista */ } }
  const allPieces = await loadPieces();
  const personPieces = allPieces.filter(piece => piece.owner?.handle === person.handle && piece.status !== "hidden");
  const isSelf = loggedIn() && auth().user.profile?.handle === person.handle;
  if (loggedIn() && !isSelf && !S.followsEnabled && !S.followingList.length) await loadFollows();
  const following = S.following.has(person.handle);

  const piecesSection = personPieces.length
    ? `<section class="panel"><div class="section-title"><h2>Pezas publicadas (${personPieces.length})</h2></div><div class="fav-list">${personPieces.map(piece => `<div class="fav-item"><button type="button" class="fav-open" data-open-piece-id="${esc(piece.id)}"><strong>${esc(piece.title)}</strong><span>${piece.copla_count || (piece.coplas || []).length} coplas</span></button></div>`).join("")}</div></section>`
    : `<section class="panel"><p class="muted">${esc(person.display_name)} aínda non publicou pezas na biblioteca.</p></section>`;
  const sections = favorites ? Object.keys(KIND_LABELS).map(kind => {
    const refs = favorites[kind] || [];
    if (!refs.length) return "";
    const list = favoritesListHtml(kind, refs, data, { stars: false, pieces: allPieces });
    if (!list || /^<p class="muted">/.test(list.trim()) && !list.includes("fav-item")) return "";
    return `<section class="panel"><div class="section-title"><h2>${FAV_HEADINGS[kind]} (${refs.length})</h2></div><div class="fav-list">${list}</div></section>`;
  }).join("") : "";

  view.innerHTML = `
    <div class="page people-page">
      <p><a class="btn" href="#" data-people-back>← Persoas</a></p>
      <div class="page-head">
        <div class="profile-id">
          ${avatarHtml(person.display_name, null)}
          <div>
            <div class="eyebrow">Perfil</div>
            <h1>${esc(person.display_name)}</h1>
            ${person.territory_name ? `<p class="person-place">${esc(person.territory_name)}</p>` : ""}
          </div>
          ${loggedIn() && !isSelf && S.followsEnabled ? `<button type="button" class="btn ${following ? "" : "primary"} follow-btn" id="followBtn">${following ? "Deixar de seguir" : "Seguir"}</button>` : ""}
        </div>
      </div>
      ${person.bio ? `<section class="panel"><p class="person-bio-full">${esc(person.bio)}</p></section>` : ""}
      ${piecesSection}
      ${sections || (person.show_favorites ? "" : `<p class="muted">Esta persoa non amosa favoritos.</p>`)}
    </div>`;
  bindBack(view);
  window.folearApp?.bindResultButtons?.(view);
  bindOpenButtons(view);
  view.querySelector("#followBtn")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/me/follows", { method: "POST", body: JSON.stringify({ handle: person.handle, on: !S.following.has(person.handle) }) });
      await loadFollows();
      renderPerson(view, handle);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  });
}

function bindBack(view) {
  view.querySelectorAll("[data-people-back]").forEach(link => link.addEventListener("click", event => {
    event.preventDefault();
    S.personHandle = "";
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    renderPeople();
  }));
}

function openPersonFromHash() {
  const match = window.location.hash.match(/^#\/persoa\/([a-z0-9-]{3,30})$/);
  if (!match) return false;
  S.personHandle = match[1];
  const active = document.querySelector("#view-people.active");
  if (active) {
    renderPeople();
  } else {
    S.programmatic = true;
    document.querySelector('[data-view="people"]')?.click();
    S.programmatic = false;
  }
  return true;
}

// --- Arranque ------------------------------------------------------------

function bindEvents() {
  // Estrelas: captura para que o clic non abra a copla que hai debaixo.
  document.addEventListener("click", event => {
    const star = event.target.closest(".fav-btn");
    if (!star) return;
    event.preventDefault();
    event.stopPropagation();
    toggleFavorite(star.dataset.favKind, star.dataset.favRef);
  }, true);
  // Entrar en «Persoas» desde o menú amosa sempre o directorio.
  document.addEventListener("click", event => {
    if (S.programmatic) return;
    const nav = event.target.closest('[data-view="people"]');
    if (nav && S.personHandle && !nav.closest("#view-people")) {
      S.personHandle = "";
      if (window.location.hash.startsWith("#/persoa/")) history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }, true);
  document.addEventListener("keydown", event => {
    if ((event.key === "Enter" || event.key === " ") && event.target.closest?.(".fav-btn")) event.stopPropagation();
  }, true);
  window.addEventListener("folear:pezas", () => {
    if (document.querySelector("#view-profile.active")) renderProfile();
    else if (document.querySelector("#view-people.active") && S.personHandle) renderPeople();
  });
  window.addEventListener("hashchange", () => {
    if (!openPersonFromHash() && document.querySelector("#view-people.active") && S.personHandle) {
      S.personHandle = "";
      renderPeople();
    }
  });
}

async function onAuth() {
  await Promise.all([loadFavorites(), loadFollows()]);
  document.querySelectorAll("[data-fav-done]").forEach(node => {
    node.removeAttribute("data-fav-done");
    node.querySelectorAll(".fav-slot, .fav-row, .fav-btn").forEach(item => item.remove());
  });
  document.getElementById("mapFavRow")?.remove();
  decorate();
  if (document.querySelector("#view-profile.active")) renderProfile();
}

// --- Diálogo de gardado de pezas -------------------------------------------

function askPieceSave({ title = "", author = "", visibility = "private", editing = null } = {}) {
  return new Promise(resolve => {
    const profile = auth().user?.profile;
    const publicProfile = Boolean(profile?.is_public && profile?.handle);
    const root = document.createElement("div");
    root.className = "fe-dialog";
    root.innerHTML = `
      <div class="fe-dialog-backdrop" data-dialog-cancel></div>
      <form class="fe-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="feDialogTitle" novalidate>
        <div class="eyebrow">${editing ? "Actualizar peza" : "Gardar peza"}</div>
        <h2 id="feDialogTitle">${editing ? "Gardar os cambios" : "Gardar na túa conta"}</h2>
        <div class="field"><label for="fePieceTitle">Título</label><input id="fePieceTitle" maxlength="160" value="${esc(title)}" placeholder="Título da peza"></div>
        <div class="field"><label for="fePieceAuthor">Autoría (opcional)</label><input id="fePieceAuthor" maxlength="120" value="${esc(author)}" placeholder="Grupo, artista ou persoa que a creou ou arranxou" list="fePieceAuthorList" autocomplete="off"><datalist id="fePieceAuthorList">${(window.folearApp?.authors?.() || []).map(name => `<option value="${esc(name)}"></option>`).join("")}</datalist><small class="muted">Se xa existe a súa ficha, escolle o nome da lista para que quede xunto ao resto.</small></div>
        <fieldset class="field vis-field">
          <legend>Quen pode ver a peza</legend>
          <label class="vis-option"><input type="radio" name="vis" value="private" ${visibility !== "public" ? "checked" : ""}><span><strong>Privada</strong><small>Só ti. Aparece en «As miñas pezas».</small></span></label>
          <label class="vis-option"><input type="radio" name="vis" value="public" ${visibility === "public" ? "checked" : ""}><span><strong>Pública, na biblioteca</strong><small>Calquera persoa pode lela e exportala. Un guía pode agochala se fai falta.</small></span></label>
          <small id="fePublicNote" class="muted" ${visibility === "public" ? "" : "hidden"}>${publicProfile ? `Amosarase co teu nome público (${esc(profile.display_name)}).` : "O teu perfil é privado: a peza sairá sen o teu nome. Podes activar o perfil público en «O meu espazo»."}</small>
        </fieldset>
        ${editing ? `<label class="check-row"><input type="checkbox" id="fePieceCopy"><span><strong>Gardar como copia nova</strong><small>Deixa a versión anterior como está.</small></span></label>` : ""}
        <p id="feDialogError" class="muted is-error" role="alert" hidden></p>
        <div class="form-actions"><button class="btn" type="button" data-dialog-cancel>Cancelar</button><button class="btn primary" type="submit">${editing ? "Gardar cambios" : "Gardar peza"}</button></div>
      </form>`;
    document.body.append(root);
    const previous = document.activeElement;
    const form = root.querySelector("form");
    const note = root.querySelector("#fePublicNote");
    const finish = value => {
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      previous?.focus?.();
      resolve(value);
    };
    const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); finish(null); } };
    document.addEventListener("keydown", onKey, true);
    root.querySelectorAll("[data-dialog-cancel]").forEach(item => item.addEventListener("click", () => finish(null)));
    form.querySelectorAll('input[name="vis"]').forEach(radio => radio.addEventListener("change", () => {
      note.hidden = form.elements.vis.value !== "public";
    }));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const vis = form.elements.vis.value;
      const chosen = root.querySelector("#fePieceTitle").value.trim();
      if (!chosen) {
        const error = root.querySelector("#feDialogError");
        error.textContent = "Pon un título á peza.";
        error.hidden = false;
        return;
      }
      finish({
        title: chosen,
        author: root.querySelector("#fePieceAuthor").value.trim(),
        visibility: vis === "public" ? "public" : "private",
        asCopy: Boolean(root.querySelector("#fePieceCopy")?.checked),
      });
    });
    const copyBox = root.querySelector("#fePieceCopy");
    const titleInput = root.querySelector("#fePieceTitle");
    if (copyBox) {
      const original = title;
      copyBox.addEventListener("change", () => {
        if (copyBox.checked && titleInput.value === original) titleInput.value = `${original} (copia)`;
        else if (!copyBox.checked && titleInput.value === `${original} (copia)`) titleInput.value = original;
      });
    }
    titleInput.focus();
  });
}

window.folearProfile = { renderProfile, renderPeople, askPieceSave };

bindEvents();
startObserver();
if (window.folearAuth?.ready) onAuth();
window.addEventListener("folear:auth", () => {
  onAuth();
  openPersonFromHash();
});
if (!window.folearAuth?.ready) {
  // Directorio por enlace directo mesmo antes de que termine o login.
  window.setTimeout(openPersonFromHash, 400);
}
