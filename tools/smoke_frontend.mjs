const listeners = new Map();

class ElementStub {
  constructor(selector = "") {
    this.selector = selector;
    this.id = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.classList = {
      classes: new Set(),
      add: value => this.classList.classes.add(value),
      remove: value => this.classList.classes.delete(value),
      contains: value => this.classList.classes.has(value),
      toggle: (value, force) => {
        if (force) this.classList.classes.add(value);
        else this.classList.classes.delete(value);
      },
    };
  }

  addEventListener(type, fn) {
    listeners.set(`${this.selector}:${type}`, fn);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  closest(selector) {
    return selector === "[data-view]" && this.dataset.view ? this : null;
  }

  insertAdjacentHTML() {}
  setAttribute() {}
  appendChild() {}
}

const elements = new Map();
const viewIds = ["view-map", "view-coplas", "view-pieces", "view-territory", "view-submit", "view-media", "view-about"];

for (const id of viewIds) {
  const el = new ElementStub(`#${id}`);
  el.id = id;
  elements.set(`#${id}`, el);
}

for (const id of [
  "#map",
  "#mapCardTitle",
  "#mapCardText",
  "#mapCoplaCount",
  "#mapPieceCount",
  "#mapTerritoryCount",
  "#clearTerritory",
  "#mapResults",
  "#mapSearch",
  "#mapSearchBtn",
  "#mapLayer",
  "#collapseBtn",
  "#sidebar",
  "#coplaDrawer",
]) {
  elements.set(id, new ElementStub(id));
}

const navs = ["map", "coplas", "pieces", "territory", "submit", "media"].map(view => {
  const el = new ElementStub(`[data-view=${view}]`);
  el.dataset.view = view;
  return el;
});

globalThis.window = {
  FOL_E_AR_FILE_MODE: false,
  location: { href: "http://localhost:8765/frontend/index.html", protocol: "http:", hash: "", pathname: "/frontend/index.html", search: "" },
  setTimeout: fn => fn(),
  addEventListener() {},
  scrollTo() {},
  scrollY: 0,
  topojson: null,
};

elements.set("#global-loading", new ElementStub("#global-loading"));

globalThis.history = { state: null, pushState() {}, replaceState() {} };

globalThis.document = {
  getElementById(id) {
    return elements.get(`#${id}`) || null;
  },
  querySelector(selector) {
    return elements.get(selector) || null;
  },
  querySelectorAll(selector) {
    if (selector === ".view") return [...elements.values()].filter(el => el.id.startsWith("view-"));
    if (selector === "[data-view]") return navs;
    if (selector === "[data-cart-count]") return [];
    return [];
  },
  addEventListener(type, fn) {
    listeners.set(`document:${type}`, fn);
  },
  createElement() {
    return new ElementStub("created");
  },
};

globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
};

globalThis.fetch = async url => ({
  ok: true,
  json: async () => {
    if (String(url).includes("territorios")) return [];
    if (String(url).includes("coplas")) return [];
    if (String(url).includes("pezas")) return [];
    if (String(url).includes("media")) return [];
    return { type: "FeatureCollection", features: [] };
  },
});

globalThis.L = null;

await import(`../frontend/js/archive_app.js?smoke=${Date.now()}`);
await new Promise(resolve => setTimeout(resolve, 0));

const click = listeners.get("document:click");
if (!click) throw new Error("Navigation listener was not registered.");

for (const [index, view] of ["coplas", "pieces", "territory", "submit", "media"].entries()) {
  click({ target: navs[index + 1] });
  const active = elements.get(`#view-${view}`).classList.contains("active");
  if (!active) throw new Error(`View did not activate: ${view}`);
}

console.log("frontend smoke ok");
