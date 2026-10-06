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
const KIND_LABELS = { copla: "Coplas", territory: "Lugares" };
const FAV_HEADINGS = { copla: "Coplas favoritas", territory: "Lugares favoritos" };
const TERRITORY_TYPES = { prov: "provincia", com: "comarca", con: "concello", par: "parroquia" };

const S = {
  favorites: { copla: new Set(), territory: new Set(), tag: new Set(), media: new Set(), melody: new Set() },
  favEnabled: false,
  favTab: "copla",
  personHandle: "",
  data: null,
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
  const [coplas, territorios] = await Promise.all([
    fetch(`${DATA}/coplas/coplas.json`).then(response => response.json()),
    fetch(`${DATA}/territorios/territorios.json`).then(response => response.json()),
  ]);
  const territoryById = new Map(territorios.map(item => [item.id, item]));
  const coplaById = new Map(coplas.map(item => [String(item.id), item]));
  S.data = { coplas, territorios, territoryById, coplaById };
  return S.data;
}

function coplaTitleOf(copla) {
  const first = String(copla.incipit || copla.text || "").split("\n").find(line => line.trim()) || "";
  return first.trim() || `Copla ${copla.id}`;
}

function territoryMeta(territory) {
  return TERRITORY_TYPES[territory.tipo] || territory.tipo || "";
}

// --- Favoritos -----------------------------------------------------------

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

function favButtonMarkup(kind, ref, { label = false } = {}) {
  const on = isFav(kind, ref);
  const title = on ? "Quitar dos favoritos" : "Gardar nos favoritos";
  return `<button type="button" class="fav-btn${label ? " has-label" : ""}${on ? " is-on" : ""}" data-fav-kind="${esc(kind)}" data-fav-ref="${esc(ref)}" aria-pressed="${on}" title="${title}" aria-label="${title}"><span aria-hidden="true">${favGlyph(on)}</span>${label ? `<span class="fav-label">${on ? "Gardado" : "Gardar"}</span>` : ""}</button>`;
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
        <p>Con unha conta de Google podes gardar coplas e lugares favoritos e, se queres, ter un perfil público. Consultar o arquivo non require conta.</p></div></div>
        <p><a class="btn primary" href="${esc(window.folearAuth?.loginUrl?.() || "#")}">Entrar con Google</a></p>
        <p class="muted small-print"><a href="./privacidade.html" target="_blank" rel="noopener">Como tratamos os teus datos</a></p>
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

      <section class="panel profile-favs">
        <div class="section-title"><h2>Os meus favoritos</h2></div>
        <div class="territory-tabs" id="favTabs">
          ${Object.entries(KIND_LABELS).map(([kind, label]) => `<button type="button" class="${S.favTab === kind ? "active" : ""}" data-fav-tab="${kind}">${label} (${S.favorites[kind].size})</button>`).join("")}
        </div>
        <div id="favList" class="fav-list">${favoritesListHtml(S.favTab, [...S.favorites[S.favTab]], data)}</div>
        <p class="muted small-print">Gárdanse co botón ☆ de cada copla e de cada lugar.</p>
      </section>

      <section class="panel profile-danger">
        <div class="section-title"><h2>A miña conta</h2></div>
        <p class="muted">Podes borrar a túa conta cando queiras: elimínanse o teu perfil, os teus favoritos e a túa sesión. Non se borra nada do arquivo. <a href="./privacidade.html" target="_blank" rel="noopener">Política de privacidade</a>.</p>
        <button class="btn danger" type="button" id="deleteAccount">Borrar a miña conta</button>
      </section>
    </div>`;

  bindProfileForm(view, profile, data);
  bindFavList(view, data);
}

function favoritesListHtml(kind, refs, data, { stars = true } = {}) {
  if (!refs.length) return `<p class="muted">Aínda non tes ${kind === "copla" ? "coplas" : "lugares"} gardados.</p>`;
  if (!data) return `<p class="muted">Non se puido cargar o arquivo para amosar os favoritos.</p>`;
  const rows = refs.map(ref => {
    if (kind === "copla") {
      const copla = data.coplaById.get(String(ref));
      if (!copla) return "";
      return `<div class="fav-item"><button type="button" class="fav-open" data-copla-id="${esc(copla.id)}"><strong>${esc(coplaTitleOf(copla))}</strong></button>${stars ? favButtonMarkup("copla", copla.id) : ""}</div>`;
    }
    const territory = data.territoryById.get(String(ref));
    if (!territory) return "";
    return `<div class="fav-item"><button type="button" class="fav-open" data-territory-id="${esc(territory.id)}"><strong>${esc(territory.nome)}</strong><span>${esc(territoryMeta(territory))}</span></button>${stars ? favButtonMarkup("territory", territory.id) : ""}</div>`;
  }).join("");
  return rows || `<p class="muted">Eses favoritos xa non existen no arquivo.</p>`;
}

function bindFavList(view, data) {
  view.querySelectorAll("[data-fav-tab]").forEach(button => button.addEventListener("click", () => {
    S.favTab = button.dataset.favTab;
    renderProfile();
  }));
  window.folearApp?.bindResultButtons?.(view);
  view.querySelectorAll("[data-person-link]").forEach(link => link.addEventListener("click", () => {
    S.personHandle = link.dataset.personLink;
  }));
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

  const sections = favorites ? Object.keys(KIND_LABELS).map(kind => {
    const refs = favorites[kind] || [];
    if (!refs.length) return "";
    return `<section class="panel"><div class="section-title"><h2>${FAV_HEADINGS[kind]} (${refs.length})</h2></div><div class="fav-list">${favoritesListHtml(kind, refs, data, { stars: false })}</div></section>`;
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
        </div>
      </div>
      ${person.bio ? `<section class="panel"><p class="person-bio-full">${esc(person.bio)}</p></section>` : ""}
      ${sections || (person.show_favorites ? "" : `<p class="muted">Esta persoa non amosa favoritos.</p>`)}
    </div>`;
  bindBack(view);
  window.folearApp?.bindResultButtons?.(view);
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
  window.addEventListener("hashchange", () => {
    if (!openPersonFromHash() && document.querySelector("#view-people.active") && S.personHandle) {
      S.personHandle = "";
      renderPeople();
    }
  });
}

async function onAuth() {
  await loadFavorites();
  document.querySelectorAll("[data-fav-done]").forEach(node => {
    node.removeAttribute("data-fav-done");
    node.querySelectorAll(".fav-slot, .fav-row, .fav-btn").forEach(item => item.remove());
  });
  document.getElementById("mapFavRow")?.remove();
  decorate();
  if (document.querySelector("#view-profile.active")) renderProfile();
}

window.folearProfile = { renderProfile, renderPeople };

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
