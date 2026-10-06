export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function getParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

export function nl2br(text = "") {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

export function sortByNome(items) {
  return [...items].sort((a, b) =>
    (a.nome || "").localeCompare((b.nome || ""), "gl")
  );
}

export function slugify(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function normalizeText(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function territoryTypeLabel(tipo = "") {
  const tipoMap = {
    prov: "Provincia",
    com: "Comarca",
    con: "Concello",
    par: "Parroquia",
  };
  return tipoMap[tipo] || tipo;
}

export function territoryLabel(item) {
  if (!item) return "";
  return `${item.nome} (${territoryTypeLabel(item.tipo)})`;
}

export function formatCount(n, singular, plural = null) {
  const safePlural = plural || `${singular}s`;
  return `${n} ${n === 1 ? singular : safePlural}`;
}

export function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

// Indicador de carga da marca: o anel do isotipo completándose
// e o punto (o ar) aparecendo ao pechalo. Estilos en style.css (MARCA).
export function loaderHtml(label = "") {
  const text = label ? `<span class="fol-loader-label">${escapeHtml(label)}</span>` : "";
  const name = label ? "" : ' aria-label="Cargando"';
  return `<span class="fol-loader" role="status"${name}><svg class="isotipo fol-loader-mark" viewBox="8 9 48 50" aria-hidden="true" focusable="false"><path pathLength="100" d="M50.79 27.16A20 20 0 1 1 38.84 15.21"/><circle cx="51.1" cy="14.9" r="4.2"/></svg>${text}</span>`;
}

export function setLoading(node, label = "") {
  if (node) node.innerHTML = loaderHtml(label);
}
