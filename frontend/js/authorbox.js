// Escolla de autorías pensada para moitísimas: caixa con suxestións mentres se
// escribe (sen listas gigantes) e directorio completo con busca.
//
//   window.folearAuthorBox.attach(input, { items, onPick, free })
//     items(): [{ name, count }]  (chámase en cada tecla, así está sempre ao día)
//     onPick(name): ao escoller unha suxestión (en «free» tamén se pode escribir un nome novo)
//     free: true -> admite nomes novos (obradoiro, gardado); false -> só existentes (filtro)
//   window.folearAuthorBox.openDirectory({ items, onPick }): directorio con busca, orde e letras.
//
// Non depende da vista: sirve ao obradoiro, ao diálogo de gardar e ao filtro da biblioteca.

const MAX_SUGGESTIONS = 8;
const DIRECTORY_PAGE = 120;

function norm(text = "") {
  return String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Orde: empeza polo texto > empeza unha palabra > contén; despois, máis pezas e nome.
export function rankAuthors(items, query) {
  const q = norm(query);
  const scored = [];
  for (const item of items) {
    const key = norm(item.name);
    let score;
    if (!q) score = 3;
    else if (key.startsWith(q)) score = 0;
    else if (key.split(" ").some(word => word.startsWith(q))) score = 1;
    else if (key.includes(q)) score = 2;
    else continue;
    scored.push({ item, score, key });
  }
  scored.sort((a, b) => a.score - b.score || (b.item.count || 0) - (a.item.count || 0) || a.item.name.localeCompare(b.item.name, "gl"));
  return scored.map(entry => entry.item);
}

let uid = 0;

export function attach(input, { items, onPick, free = true, max = MAX_SUGGESTIONS } = {}) {
  if (!input || input.dataset.authorbox) return;
  input.dataset.authorbox = "1";
  input.removeAttribute("list");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const id = `authorbox-${++uid}`;
  input.setAttribute("aria-controls", id);

  const list = document.createElement("div");
  list.id = id;
  list.className = "authorbox-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  document.body.append(list);

  let active = -1;
  let shown = [];
  let skipOpen = false;

  const place = () => {
    const rect = input.getBoundingClientRect();
    list.style.left = `${Math.max(8, rect.left)}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.minWidth = `${Math.max(rect.width, 240)}px`;
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };

  const choose = name => {
    skipOpen = true;
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
    onPick?.(name);
    skipOpen = false;
  };

  const setActive = index => {
    active = index;
    list.querySelectorAll("[role=option]").forEach((node, i) => {
      node.classList.toggle("is-active", i === index);
      node.setAttribute("aria-selected", String(i === index));
    });
    if (index >= 0) {
      const node = list.querySelectorAll("[role=option]")[index];
      input.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const render = () => {
    if (skipOpen) return;
    const all = items?.() || [];
    const q = input.value.trim();
    const ranked = rankAuthors(all, q);
    shown = ranked.slice(0, max);
    const exact = q && all.some(item => norm(item.name) === norm(q));
    const rows = shown.map((item, i) => `<div role="option" id="${id}-${i}" class="authorbox-option" data-index="${i}" aria-selected="false"><span class="authorbox-name">${esc(item.name)}</span><span class="authorbox-count">${item.count || 0} ${item.count === 1 ? "peza" : "pezas"}</span></div>`);
    let head = "";
    if (!q && ranked.length) head = `<div class="authorbox-head">Máis activas</div>`;
    let foot = "";
    if (ranked.length > shown.length) foot += `<div class="authorbox-note">Hai ${ranked.length - shown.length} máis. Segue escribindo para afinar.</div>`;
    if (free && q && !exact) foot += `<div class="authorbox-note authorbox-new">Nova autoría: <strong>${esc(q)}</strong></div>`;
    if (!rows.length && !foot) {
      if (!free) foot = `<div class="authorbox-note">Ningunha autoría coincide.</div>`;
      else { close(); return; }
    }
    list.innerHTML = head + rows.join("") + foot;
    place();
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" && !list.hidden) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.hidden) render();
      if (!shown.length) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (active + 1) % shown.length : (active <= 0 ? shown.length - 1 : active - 1);
      setActive(next);
      return;
    }
    if (event.key === "Enter" && !list.hidden) {
      const target = active >= 0 ? shown[active] : (!free && shown.length === 1 ? shown[0] : null);
      if (target) {
        event.preventDefault();
        choose(target.name);
      } else if (free) {
        close();
      }
    }
  });
  list.addEventListener("mousedown", event => event.preventDefault());
  list.addEventListener("click", event => {
    const option = event.target.closest("[role=option]");
    if (option) choose(shown[Number(option.dataset.index)].name);
  });
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  window.addEventListener("resize", () => { if (!list.hidden) place(); });
  window.addEventListener("scroll", () => { if (!list.hidden) place(); }, true);

  // Limpeza cando o campo desaparece do DOM (as vistas recréanse con innerHTML).
  const observer = new MutationObserver(() => {
    if (!document.contains(input)) {
      list.remove();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// --- Directorio completo ---------------------------------------------------

export function openDirectory({ items, onPick } = {}) {
  const all = items?.() || [];
  const previous = document.querySelector(".authorbox-dialog");
  previous?.remove();
  let query = "";
  let sort = "count"; // count | az
  let limit = DIRECTORY_PAGE;

  const root = document.createElement("div");
  root.className = "media-modal authorbox-dialog";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Todas as autorías");
  root.innerHTML = `
    <div class="media-modal-backdrop" data-close></div>
    <div class="media-modal-panel authorbox-panel">
      <div class="media-modal-head">
        <div><div class="eyebrow">Autorías</div><h2>${all.length} autoría${all.length === 1 ? "" : "s"}</h2></div>
        <button class="card-close" type="button" data-close aria-label="Pechar">×</button>
      </div>
      <div class="authorbox-tools">
        <input type="search" class="authorbox-search" placeholder="Buscar unha autoría..." aria-label="Buscar unha autoría" autocomplete="off">
        <div class="authorbox-sort" role="group" aria-label="Ordenar">
          <button type="button" class="chip active" data-sort="count">Máis pezas</button>
          <button type="button" class="chip" data-sort="az">A-Z</button>
        </div>
      </div>
      <div class="authorbox-letters" hidden></div>
      <div class="authorbox-body" aria-live="polite"></div>
    </div>`;
  document.body.append(root);

  const body = root.querySelector(".authorbox-body");
  const letters = root.querySelector(".authorbox-letters");
  const search = root.querySelector(".authorbox-search");

  const initial = name => {
    const ch = norm(name).charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : "#";
  };

  // Orde A-Z: o índice de letras sae de TODAS as autorías (con contador) e cada letra amosa só as
  // súas, en páxinas: con milleiros de nomes chégase a «M» nun clic, sen cargar todo o anterior.
  let letter = "";
  const letterIndex = () => {
    const counts = new Map();
    for (const item of all) counts.set(initial(item.name), (counts.get(initial(item.name)) || 0) + 1);
    return [...counts.entries()].sort((a, b) => (a[0] === "#") - (b[0] === "#") || a[0].localeCompare(b[0]));
  };
  const rowHtml = item => `<button type="button" class="authorbox-row" data-name="${esc(item.name)}"><span>${esc(item.name)}</span><small>${item.count || 0} ${item.count === 1 ? "peza" : "pezas"}</small></button>`;

  const paint = () => {
    const byLetter = sort === "az" && !query;
    let ranked = rankAuthors(all, query);
    let letters_ = [];
    if (sort === "az") {
      ranked = [...ranked].sort((a, b) => norm(a.name).localeCompare(norm(b.name), "gl"));
    }
    if (byLetter) {
      letters_ = letterIndex();
      if (!letters_.some(([value]) => value === letter)) letter = letters_[0]?.[0] || "";
      ranked = ranked.filter(item => initial(item.name) === letter);
    }
    const slice = ranked.slice(0, limit);
    let html = slice.map(rowHtml).join("");
    if (!slice.length) html = `<p class="muted">Ningunha autoría coincide.</p>`;
    if (ranked.length > slice.length) html += `<div class="authorbox-more"><span class="muted">Mostrando ${slice.length} de ${ranked.length}${byLetter ? "" : ". Busca para atopar unha en concreto"}.</span> <button type="button" class="link-button" data-more>Ver máis</button></div>`;
    body.innerHTML = html;
    letters.hidden = !byLetter;
    letters.innerHTML = byLetter
      ? letters_.map(([value, n]) => `<button type="button" class="chip ${value === letter ? "active" : ""}" data-letter="${value}" title="${n} autoría${n === 1 ? "" : "s"}">${value}</button>`).join("")
      : "";
  };

  const close = () => root.remove();
  root.addEventListener("click", event => {
    if (event.target.closest("[data-close]")) return close();
    const row = event.target.closest("[data-name]");
    if (row) { const name = row.dataset.name; close(); onPick?.(name); return; }
    const sortButton = event.target.closest("[data-sort]");
    if (sortButton) {
      sort = sortButton.dataset.sort;
      limit = DIRECTORY_PAGE;
      root.querySelectorAll("[data-sort]").forEach(node => node.classList.toggle("active", node === sortButton));
      paint();
      return;
    }
    if (event.target.closest("[data-more]")) { limit += DIRECTORY_PAGE; paint(); return; }
    const letterButton = event.target.closest("[data-letter]");
    if (letterButton) { letter = letterButton.dataset.letter; limit = DIRECTORY_PAGE; paint(); body.scrollTop = 0; }
  });
  search.addEventListener("input", () => { query = search.value; limit = DIRECTORY_PAGE; paint(); });
  root.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
  paint();
  search.focus();
}

window.folearAuthorBox = { attach, openDirectory, rankAuthors };
