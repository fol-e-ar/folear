// Avatares «mapa»: cada persoa leva unha cor da paleta da marca e a súa inicial debuxada como o
// contorno dun territorio (unha «parroquia con forma de A»): o polígono da letra con bordos
// irregulares, distinto para cada persoa pero sempre o mesmo para ela (sae do seu identificador).
import { AVATAR_GLYPHS } from "./avatar_glyphs.js";

// Cores da identidade: aire, concello, comarca, provincia e tinta.
export const AVATAR_COLORS = ["#C24330", "#A66D35", "#685F7A", "#526A78", "#171717"];
const PAPER = "#F7F7F2";

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function avatarLetter(name = "") {
  const text = String(name).trim();
  for (const ch of text) {
    const upper = ch.toUpperCase();
    if (upper === "Ñ") return "Ñ";
    const base = upper.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/^[A-Z0-9]$/.test(base)) return base;
  }
  return "?";
}

const parsed = new Map();
function contours(letter) {
  if (!parsed.has(letter)) {
    const raw = AVATAR_GLYPHS[letter] || AVATAR_GLYPHS["?"];
    parsed.set(letter, raw.split("|").map(c => c.split(" ").map(p => p.split(",").map(Number))));
  }
  return parsed.get(letter);
}

// Fai o contorno máis «de mapa»: vértices algo movidos e puntos extra nos lados longos.
function roughen(points, random) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    out.push([ax + (random() - 0.5) * 2.6, ay + (random() - 0.5) * 2.6]);
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    const extra = Math.min(3, Math.floor(length / 7));
    for (let k = 1; k <= extra; k++) {
      const t = (k + (random() - 0.5) * 0.4) / (extra + 1);
      const push = (random() - 0.5) * Math.min(5.4, length * 0.38);
      out.push([ax + dx * t - (dy / length) * push, ay + dy * t + (dx / length) * push]);
    }
  }
  return out;
}

const cache = new Map();

// Devolve só o SVG (para metelo onde faga falta). `seed` fixa cor e forma (handle, e-mail...).
export function avatarSvg(name, seed = "") {
  const key = `${avatarLetter(name)}|${seed || name}`;
  if (cache.has(key)) return cache.get(key);
  const letter = avatarLetter(name);
  const h = hash(`${seed || name}`);
  const random = rng(h);
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  const d = contours(letter).map(contour => {
    const pts = roughen(contour, random);
    return `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}Z`;
  }).join("");
  const svg = `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><rect width="100" height="100" fill="${color}"/><path fill="${PAPER}" fill-rule="nonzero" d="${d}"/></svg>`;
  cache.set(key, svg);
  return svg;
}

// Avatar completo (círculo coa letra-mapa). `large` para o tamaño da cabeceira de perfil.
export function avatarMarkup(name, seed = "", { large = false } = {}) {
  return `<span class="account-avatar is-map${large ? " is-large" : ""}">${avatarSvg(name, seed)}</span>`;
}
