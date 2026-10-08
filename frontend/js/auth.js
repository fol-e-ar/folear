// Identidade: sesión, botón de entrar/saír e permisos de edición.
//
// A consulta é libre. Só as escrituras (dar de alta, editar e borrar
// coplas, recursos e melodías) piden rol de guía ou admin, e iso
// comprébao SEMPRE o servidor; aquí só se decide que botóns se amosan.
//
// O servidor responde en /api/auth/me:
//   mode "google"       login con Google (produción)
//   mode "local"        servidor local: sen login, todo permitido
//   mode "open"         produción con escrituras abertas (só desenvolvemento)
//   mode "unconfigured" produción sen Google configurado: escrituras pechadas
//   mode "offline"      sen API (p. ex. páxina estática): só consulta
//
// Este módulo é autónomo (ver index.html): pon atributos no <body> que usa
// css/auth.css para esconder os controis de edición, e expón
// window.folearAuth para o resto da aplicación.

import { avatarMarkup as mapAvatar } from "./avatar.js";
const EDIT_ROLES = ["guia", "admin"];
const ROLE_LABELS = { foleante: "Foleante", guia: "Guía", admin: "Admin" };
const ERROR_MESSAGES = {
  denied: "Cancelaches o acceso con Google.",
  state: "A sesión de acceso caducou. Téntao de novo.",
  google: "Google non aceptou o acceso. Téntao de novo.",
  config: "O acceso con Google aínda non está configurado no servidor.",
  migration: "Falta preparar a base de datos do servidor (migración 0003).",
  db: "Non se puido iniciar a sesión. Téntao de novo.",
};

const session = { mode: "offline", user: null, ready: false };
const listeners = new Set();

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function fetchMe() {
  try {
    const response = await fetch("../api/auth/me", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (!data || data.ok !== true) throw new Error("resposta inesperada");
    return { mode: data.mode || "offline", user: data.user || null };
  } catch {
    return { mode: "offline", user: null };
  }
}

function canEdit() {
  return Boolean(session.user && EDIT_ROLES.includes(session.user.role));
}

function isAdmin() {
  return Boolean(session.user && session.user.role === "admin");
}

// Volve á mesma páxina: `fe_back=1` avisa a app de que ven do login e debe restaurar a vista
// (que se garda en `saveReturnState` ao premer calquera ligazón/botón de entrar).
function loginUrl() {
  const search = new URLSearchParams(window.location.search);
  search.set("fe_back", "1");
  const next = `${window.location.pathname}?${search.toString()}`;
  return `../api/auth/google?next=${encodeURIComponent(next)}`;
}

function rememberWhereWeAre() {
  try { window.folearApp?.saveReturnState?.(); } catch {}
}

// Calquera ligazón de entrada garda o sitio onde estamos antes de saír.
document.addEventListener("click", event => {
  const link = event.target.closest?.("a[href*='api/auth/google']");
  if (link) rememberWhereWeAre();
}, true);

async function logout() {
  try {
    await fetch("../api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    // Se falla a rede, a recarga amosará o estado real igualmente.
  }
  window.location.reload();
}

function avatarMarkup(user) {
  if (user.picture) {
    return `<span class="account-avatar"><img src="${escapeText(user.picture)}" alt="" referrerpolicy="no-referrer"></span>`;
  }
  return mapAvatar(user.name || user.email || "?", user.profile?.handle || user.email || user.name || "");
}

// --- Interface --------------------------------------------------------

function sidebarMarkup() {
  const { mode, user } = session;
  if (user && !user.open && mode === "google") {
    return `
      <button type="button" class="account-line is-link" data-view="profile" title="O meu espazo">
        ${avatarMarkup(user)}
        <span class="account-text"><strong>${escapeText(user.name || user.email)}</strong><small>${ROLE_LABELS[user.role] || user.role}</small></span>
      </button>
      ${isAdmin() ? `<button type="button" data-account="people"><span class="nav-icon">☷</span><span>Xestionar roles</span></button>` : ""}
      <button type="button" data-account="logout"><span class="nav-icon">↗</span><span>Saír</span></button>
    `;
  }
  if (mode === "google") {
    return `<button type="button" data-account="login"><span class="nav-icon">→</span><span>Entrar con Google</span></button>`;
  }
  if (mode === "local" || mode === "open") {
    return `<div class="account-line is-note"><span class="account-text"><small>${mode === "local" ? "Modo local" : "Acceso aberto"}</small></span></div>`;
  }
  return "";
}

function mobileMarkup() {
  const { mode, user } = session;
  if (user && !user.open && mode === "google") {
    return `
      <div class="mobile-menu-sep" role="separator"></div>
      <button type="button" role="menuitem" class="mobile-menu-account" data-view="profile" title="O meu espazo">
        ${avatarMarkup(user)}
        <span class="account-text"><strong>${escapeText(user.name || user.email)}</strong><small>${ROLE_LABELS[user.role] || user.role}</small></span>
      </button>
      ${isAdmin() ? `<button type="button" role="menuitem" data-account="people"><i>☷</i>Xestionar roles</button>` : ""}
      <button type="button" role="menuitem" data-account="logout"><i>↗</i>Saír</button>
    `;
  }
  if (mode === "google") {
    return `<div class="mobile-menu-sep" role="separator"></div><button type="button" role="menuitem" data-account="login"><i>→</i>Entrar con Google</button>`;
  }
  return "";
}

function render() {
  const body = document.body;
  body.dataset.authMode = session.mode;
  body.dataset.role = session.user ? session.user.role : "visitante";
  body.dataset.canEdit = String(canEdit());
  body.dataset.isAdmin = String(isAdmin());

  const foot = document.querySelector(".sidebar-foot");
  if (foot) {
    let box = foot.querySelector("#accountBox");
    if (!box) {
      box = document.createElement("div");
      box.id = "accountBox";
      box.className = "account-box";
      foot.prepend(box);
    }
    box.innerHTML = sidebarMarkup();
  }

  const menu = document.getElementById("mobileExploreMenu");
  if (menu) {
    let tail = menu.querySelector("#mobileAccount");
    if (!tail) {
      tail = document.createElement("div");
      tail.id = "mobileAccount";
      tail.className = "mobile-account";
      menu.append(tail);
    }
    tail.innerHTML = mobileMarkup();
  }
}

function toast(message) {
  const node = document.createElement("div");
  node.className = "auth-toast";
  node.setAttribute("role", "status");
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.classList.add("is-in"), 20);
  window.setTimeout(() => {
    node.classList.remove("is-in");
    window.setTimeout(() => node.remove(), 300);
  }, 6000);
}

function promptLogin() {
  if (session.mode === "google" && !session.user) {
    toast("Para dar de alta ou editar contidos tes que entrar con Google e ser guía.");
  } else if (session.mode === "google") {
    toast("Para dar de alta ou editar contidos fai falla ser guía. Pídello a unha persoa admin.");
  } else {
    toast("Agora mesmo non se poden editar contidos desde aquí.");
  }
}

// --- Panel de persoas (admin) ----------------------------------------

const ROLE_ORDER = { admin: 0, guia: 1, foleante: 2 };
const ROLE_HINTS = { foleante: "Consulta", guia: "Edita o arquivo", admin: "Xestiona roles" };
const NEW_DAYS = 14;
const PEOPLE_FILTERS = [
  ["all", "Todas"],
  ["new", "Recén chegados"],
  ["foleante", "Foleantes"],
  ["guia", "Guías"],
  ["admin", "Admins"],
];

function parseDbDate(value) {
  if (!value) return null;
  const date = new Date(String(value).includes("T") ? value : `${String(value).replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysSince(date) {
  return date ? Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000)) : null;
}

function agoLabel(days) {
  if (days === null) return "";
  if (days === 0) return "hoxe";
  if (days === 1) return "onte";
  if (days < 45) return `hai ${days} días`;
  if (days < 365) return `hai ${Math.round(days / 30)} meses`;
  return `hai ${Math.round(days / 365)} ${Math.round(days / 365) === 1 ? "ano" : "anos"}`;
}

function isNewcomer(person) {
  const days = daysSince(parseDbDate(person.created_at));
  return days !== null && days < NEW_DAYS;
}

async function openPeople() {
  let host = document.getElementById("peopleModal");
  if (!host) {
    host = document.createElement("div");
    host.id = "peopleModal";
    document.body.append(host);
  }
  host.innerHTML = `
    <div class="auth-modal" role="dialog" aria-modal="true" aria-label="Xestión de roles">
      <div class="auth-modal-backdrop" data-people-close></div>
      <div class="auth-modal-panel roles-panel">
        <div class="auth-modal-head">
          <div><div class="eyebrow">Administración</div><h2>Xestión de roles</h2></div>
          <button class="card-close" type="button" data-people-close aria-label="Pechar">×</button>
        </div>
        <p class="muted roles-intro">Quen entra con Google é <strong>foleante</strong> (consulta). Unha persoa <strong>guía</strong> pode dar de alta, editar e borrar. As contas <strong>admin</strong> poden ademais cambiar roles.</p>
        <div class="roles-tools">
          <input id="rolesSearch" type="search" placeholder="Buscar por nome ou correo..." autocomplete="off" aria-label="Buscar persoas">
          <div class="roles-filters" id="rolesFilters" role="group" aria-label="Filtrar por grupo"></div>
        </div>
        <div id="peopleList" class="people-list"><p class="muted">Cargando...</p></div>
        <p id="peopleFeedback" class="muted roles-feedback" role="status" aria-live="polite"></p>
      </div>
    </div>
  `;
  host.hidden = false;
  const close = () => { host.hidden = true; host.innerHTML = ""; };
  host.querySelectorAll("[data-people-close]").forEach(item => item.addEventListener("click", close));

  const list = host.querySelector("#peopleList");
  const feedback = host.querySelector("#peopleFeedback");
  const filtersBox = host.querySelector("#rolesFilters");
  const search = host.querySelector("#rolesSearch");
  let users = [];
  let filter = "all";

  const matches = (person, key) => key === "all" || (key === "new" ? isNewcomer(person) : person.role === key);
  const count = key => users.filter(person => matches(person, key)).length;

  const paintFilters = () => {
    filtersBox.innerHTML = PEOPLE_FILTERS.map(([key, label]) =>
      `<button type="button" class="roles-filter${filter === key ? " active" : ""}" data-filter="${key}" aria-pressed="${filter === key}">${label}<span>${count(key)}</span></button>`
    ).join("");
  };

  const rowMarkup = person => {
    const name = person.name || person.email;
    const created = parseDbDate(person.created_at);
    const seen = parseDbDate(person.last_login_at);
    const meta = [
      created ? `Entrou ${agoLabel(daysSince(created))}` : "",
      seen ? `última visita ${agoLabel(daysSince(seen))}` : "",
    ].filter(Boolean).join(" \\ ");
    const self = String(person.email).toLowerCase() === String(session.user?.email || "").toLowerCase();
    const locked = person.fixed_admin;
    return `
      <div class="people-row" data-row="${person.id}">
        ${avatarMarkup(person)}
        <div class="people-who">
          <strong>${escapeText(name)}${isNewcomer(person) ? ` <em class="roles-new">Novo</em>` : ""}</strong>
          <small>${escapeText(person.email)}</small>
          ${meta ? `<small class="people-meta">${escapeText(meta)}</small>` : ""}
        </div>
        <div class="role-seg" role="group" aria-label="Rol de ${escapeText(name)}" data-person="${person.id}">
          ${["foleante", "guia", "admin"].map(role => {
            const disabled = locked || (self && role !== "admin");
            return `<button type="button" class="role-opt is-${role}${person.role === role ? " active" : ""}" data-role="${role}" aria-pressed="${person.role === role}" title="${ROLE_HINTS[role]}${locked ? " \\ admin fixo polo servidor" : ""}" ${disabled ? "disabled" : ""}>${ROLE_LABELS[role]}</button>`;
          }).join("")}
        </div>
      </div>`;
  };

  const paintList = () => {
    const q = (search.value || "").trim().toLowerCase();
    const shown = users
      .filter(person => matches(person, filter))
      .filter(person => !q || `${person.name || ""} ${person.email}`.toLowerCase().includes(q))
      .sort((a, b) => {
        if (filter === "new") return String(b.created_at).localeCompare(String(a.created_at));
        return (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || String(a.name || a.email).localeCompare(String(b.name || b.email), "gl");
      });
    list.innerHTML = shown.map(rowMarkup).join("")
      || `<p class="muted roles-empty">${users.length ? "Ninguén coincide con ese filtro." : "Aínda non hai ninguén rexistrado."}</p>`;
  };

  filtersBox.addEventListener("click", event => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    filter = button.dataset.filter;
    paintFilters();
    paintList();
  });
  search.addEventListener("input", paintList);

  list.addEventListener("click", async event => {
    const option = event.target.closest(".role-opt");
    if (!option || option.disabled || option.classList.contains("active")) return;
    const seg = option.closest("[data-person]");
    const person = users.find(item => item.id === Number(seg.dataset.person));
    if (!person) return;
    const previous = person.role;
    const next = option.dataset.role;
    if (next === "admin" && !window.confirm(`¿Dar o rol de admin a ${person.name || person.email}? Poderá cambiar roles e editar todo o arquivo.`)) return;
    person.role = next;
    seg.querySelectorAll(".role-opt").forEach(item => { item.classList.toggle("active", item === option); item.setAttribute("aria-pressed", String(item === option)); });
    seg.classList.add("is-saving");
    feedback.textContent = "Gardando...";
    try {
      const result = await fetch("../api/users/role", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: person.id, role: next }),
      });
      const payload = await result.json();
      if (!result.ok) throw new Error(payload.error || "Non se puido cambiar o rol.");
      feedback.textContent = `${person.name || person.email}: agora é ${ROLE_LABELS[next].toLowerCase()}.`;
      paintFilters(); // os contadores cambian; a fila queda onde estaba ata que se cambie de filtro
    } catch (error) {
      person.role = previous;
      feedback.textContent = error.message;
      paintFilters();
      paintList();
    } finally {
      seg.classList.remove("is-saving");
    }
  });

  try {
    const response = await fetch("../api/users", { cache: "no-store", credentials: "same-origin" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Non se puido cargar a lista.");
    users = data.users;
    paintFilters();
    paintList();
  } catch (error) {
    list.innerHTML = `<p class="muted">${escapeText(error.message)}</p>`;
  }
}

// --- Arranque --------------------------------------------------------

function bindEvents() {
  document.addEventListener("click", event => {
    const account = event.target.closest("[data-account]");
    if (account) {
      event.preventDefault();
      const action = account.dataset.account;
      const menu = document.getElementById("mobileExploreMenu");
      if (menu) menu.hidden = true;
      document.getElementById("mobileExploreBtn")?.setAttribute("aria-expanded", "false");
      if (action === "login") { rememberWhereWeAre(); window.location.href = loginUrl(); }
      if (action === "logout") logout();
      if (action === "people") openPeople();
      return;
    }
    // Rede de seguridade: aínda que un botón de alta se colase, sen permiso
    // non se abre o formulario (o servidor igualmente o rexeitaría).
    if (!canEdit() && session.ready && event.target.closest('[data-view="submit"]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      promptLogin();
    }
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      const host = document.getElementById("peopleModal");
      if (host && !host.hidden) { host.hidden = true; host.innerHTML = ""; }
    }
  });
}

function showLoginError() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("auth_error");
  if (!code) return;
  toast(ERROR_MESSAGES[code] || "Non se puido iniciar a sesión.");
  params.delete("auth_error");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
}

async function init() {
  bindEvents();
  render();
  const me = await fetchMe();
  session.mode = me.mode;
  session.user = me.user;
  session.ready = true;
  render();
  showLoginError();
  listeners.forEach(callback => callback({ mode: session.mode, user: session.user }));
  window.dispatchEvent(new CustomEvent("folear:auth", { detail: { mode: session.mode, user: session.user } }));
}

async function refresh() {
  const me = await fetchMe();
  session.mode = me.mode;
  session.user = me.user;
  render();
}

window.folearAuth = {
  get mode() { return session.mode; },
  get user() { return session.user; },
  get ready() { return session.ready; },
  toast,
  refresh,
  canEdit,
  isAdmin,
  loginUrl,
  logout,
  onChange(callback) { listeners.add(callback); },
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
