// Xera unha imaxe vertical (1080 x 1920, o formato das stories de Instagram) cunha copla, ao
// estilo das tarxetas de letra de Spotify: o texto grande e á esquerda, o lugar e a marca abaixo.
// Debúxase nun <canvas> co mesmo isotipo e tipografías do sitio (DM Mono e Inter, autoalojadas).

export const STORY_THEMES = [
  { id: "papel", label: "Papel", bg: "#F7F7F2", ink: "#171717", soft: "#6B6B64", accent: "#C24330", markAlpha: 0.07 },
  { id: "tinta", label: "Tinta", bg: "#171717", ink: "#F7F7F2", soft: "#A8A8A0", accent: "#E0644F", markAlpha: 0.09, dark: true },
  { id: "ar", label: "Ar", bg: "#C24330", ink: "#F7F7F2", soft: "#F6D9D2", accent: "#F7F7F2", markAlpha: 0.14, dark: true, flatDots: true },
];

const WIDTH = 1080;
const HEIGHT = 1920;
const MARGIN = 96;
// Instagram tapa a parte de arriba (perfil) e a de abaixo (resposta): todo o importante queda entre os 270 e os 1650 px.
const HEADER_Y = 330;
const TEXT_TOP = 450;
const TEXT_BOTTOM = 1400;
const FOOTER_Y = 1500;
const MONO = '"DM Mono", "IBM Plex Mono", ui-monospace, Consolas, monospace';
const SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// Cores do nivel do lugar (as mesmas ca no resto da web); en fondos escuros aclárase.
const LEVEL_COLORS = { par: "#C84733", con: "#A66D35", com: "#685F7A", prov: "#526A78" };
const LEVEL_COLORS_DARK = { par: "#EE7B67", con: "#D49A60", com: "#A99FC2", prov: "#86A5B5" };

async function loadFonts() {
  if (!document.fonts?.load) return;
  try {
    await Promise.all([
      document.fonts.load(`500 48px "DM Mono"`),
      document.fonts.load(`400 32px "DM Mono"`),
      document.fonts.load(`600 32px "Inter"`),
      document.fonts.load(`500 32px "Inter"`),
    ]);
  } catch {
    // Sen as tipografías propias cae á monoespaciada do sistema.
  }
}

function greedyWrap(ctx, words, maxWidth) {
  const out = [];
  let current = "";
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(attempt).width <= maxWidth) { current = attempt; continue; }
    out.push(current);
    current = word;
  }
  if (current) out.push(current);
  return out;
}

// Parte unha liña longa en liñas equilibradas (todas do ancho parecido, sen «orfos» dunha palabra solta).
function wrapLine(ctx, line, maxWidth) {
  if (ctx.measureText(line).width <= maxWidth) return [line];
  const words = line.split(/\s+/).filter(Boolean);
  // Unha palabra máis longa ca o ancho parte por caracteres.
  const pieces = [];
  words.forEach(word => {
    if (ctx.measureText(word).width <= maxWidth) { pieces.push(word); return; }
    let chunk = "";
    for (const char of word) {
      if (ctx.measureText(chunk + char).width > maxWidth) { pieces.push(chunk); chunk = char; } else chunk += char;
    }
    if (chunk) pieces.push(chunk);
  });
  const base = greedyWrap(ctx, pieces, maxWidth);
  let low = Math.max(...pieces.map(word => ctx.measureText(word).width));
  let high = maxWidth;
  let best = base;
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) / 2;
    const attempt = greedyWrap(ctx, pieces, mid);
    if (attempt.length <= base.length) { best = attempt; high = mid; } else low = mid;
  }
  return best;
}

// Atopa o tamaño de letra máis grande (ata 62 px) co que o texto cabe na caixa.
export function layoutStoryText(ctx, text, maxWidth, maxHeight) {
  const verses = String(text || "").replace(/\r/g, "").split("\n").map(line => line.trim());
  while (verses.length && !verses[verses.length - 1]) verses.pop();
  for (let size = 62; size >= 24; size -= 2) {
    ctx.font = `500 ${size}px ${MONO}`;
    const lineHeight = Math.round(size * 1.46);
    const lines = [];
    verses.forEach(verse => {
      if (!verse) { lines.push(null); return; }
      wrapLine(ctx, verse, maxWidth).forEach(part => lines.push(part));
    });
    const height = lines.reduce((sum, line) => sum + (line === null ? lineHeight * 0.55 : lineHeight), 0);
    if (height <= maxHeight || size === 24) return { size, lineHeight, lines, height };
  }
  return null;
}

const ISOTIPO_RING = "M50.79 27.16A20 20 0 1 1 38.84 15.21";

function drawIsotipo(ctx, x, y, size, color, dot) {
  const scale = size / 48; // o isotipo vive nunha retícula de 48 de alto (viewBox 8 9 48 50)
  ctx.save();
  ctx.translate(x - 8 * scale, y - 9 * scale);
  ctx.scale(scale, scale);
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.stroke(new Path2D(ISOTIPO_RING));
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(51.1, 14.9, 4.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Anel enorme, case transparente, que se corta polo bordo: textura de marca sen competir co texto.
function drawWatermark(ctx, theme) {
  ctx.save();
  ctx.globalAlpha = theme.markAlpha;
  ctx.translate(WIDTH - 40, HEIGHT - 520);
  const scale = 30; // radio 20 * 30 = 600 px
  ctx.scale(scale, scale);
  ctx.translate(-32, -34);
  ctx.lineWidth = 3.6;
  ctx.lineCap = "round";
  ctx.strokeStyle = theme.ink;
  ctx.stroke(new Path2D(ISOTIPO_RING));
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(51.1, 14.9, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Lugares co seu punto de cor de nivel. Devolve a coordenada y do final.
function drawPlaces(ctx, theme, places, lugar, x, y) {
  const maxWidth = WIDTH - MARGIN * 2;
  const palette = theme.dark ? LEVEL_COLORS_DARK : LEVEL_COLORS;
  const items = [];
  if (lugar) items.push({ label: lugar, color: theme.ink });
  (places || []).forEach(place => items.push({ label: place.label, color: theme.flatDots ? theme.ink : palette[place.tipo] || theme.soft }));
  if (!items.length) items.push({ label: "Galiza", color: theme.ink });
  ctx.font = `600 40px ${SANS}`;
  ctx.textBaseline = "alphabetic";
  const dotGap = 30;
  const lineHeight = 56;
  const gap = 36;
  let line = 0;
  let cursor = 0;
  let hidden = 0;
  items.forEach(item => {
    // Un nome moi longo recórtase co seu punto suspensivo en vez de saír da imaxe.
    let label = item.label;
    if (ctx.measureText(label).width > maxWidth - dotGap) {
      while (label.length > 1 && ctx.measureText(`${label}…`).width > maxWidth - dotGap) label = label.slice(0, -1);
      label = `${label.trimEnd()}…`;
    }
    const width = dotGap + ctx.measureText(label).width;
    let nextLine = line;
    let nextCursor = cursor;
    if (nextCursor && nextCursor + width > maxWidth) { nextLine += 1; nextCursor = 0; }
    if (nextLine >= 3) { hidden += 1; return; }
    line = nextLine;
    cursor = nextCursor;
    const baseX = x + cursor;
    const baseY = y + line * lineHeight;
    ctx.fillStyle = item.color;
    ctx.beginPath();
    ctx.arc(baseX + 8, baseY - 14, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.ink;
    ctx.fillText(label, baseX + dotGap, baseY);
    cursor += width + gap;
  });
  if (hidden) {
    // Avísase de que hai máis territorios dos que caben, na liña de «folear.gal» (sempre libre)
    const tag = `+${hidden} ${hidden === 1 ? "territorio" : "territorios"}`;
    ctx.font = `400 34px ${MONO}`;
    ctx.fillStyle = theme.soft;
    ctx.textAlign = "right";
    ctx.fillText(tag, WIDTH - MARGIN, y + line * lineHeight + 70);
    ctx.textAlign = "left";
  }
  return y + line * lineHeight;
}

// Cápsula: `roundRect` non existe en Safari < 16 nin Firefox < 112, así que se traza con arcos.
function pillPath(ctx, x, y, w, h) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

export async function renderCoplaStory({ text, places = [], lugar = "", volta = false, themeId = "papel" } = {}) {
  await loadFonts();
  const theme = STORY_THEMES.find(item => item.id === themeId) || STORY_THEMES[0];
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawWatermark(ctx, theme);

  // Cabeceira: isotipo + «fol e ar» (e «Volta» se a copla é unha volta)
  drawIsotipo(ctx, MARGIN, HEADER_Y - 40, 76, theme.ink, theme.accent);
  ctx.fillStyle = theme.ink;
  ctx.textBaseline = "middle";
  ctx.font = `400 48px ${MONO}`;
  ctx.fillText("fol e ar", MARGIN + 104, HEADER_Y);
  if (volta) {
    ctx.font = `500 30px ${SANS}`;
    const label = "VOLTA";
    const w = ctx.measureText(label).width + 40;
    ctx.fillStyle = theme.accent;
    pillPath(ctx, WIDTH - MARGIN - w, HEADER_Y - 26, w, 52);
    ctx.fill();
    ctx.fillStyle = theme.bg;
    ctx.fillText(label, WIDTH - MARGIN - w + 20, HEADER_Y + 1);
  }

  // Copla: bloque centrado en vertical dentro da caixa, aliñado á esquerda
  const box = layoutStoryText(ctx, text, WIDTH - MARGIN * 2, TEXT_BOTTOM - TEXT_TOP);
  ctx.textBaseline = "alphabetic";
  if (box) {
    ctx.font = `500 ${box.size}px ${MONO}`;
    ctx.fillStyle = theme.ink;
    let y = TEXT_TOP + Math.max(0, (TEXT_BOTTOM - TEXT_TOP - box.height) / 2) + box.size;
    box.lines.forEach(line => {
      if (line === null) { y += box.lineHeight * 0.55; return; }
      ctx.fillText(line, MARGIN, y);
      y += box.lineHeight;
    });
  }

  // Pé: barra de acento, lugares con punto de nivel e enderezo
  ctx.fillStyle = theme.accent;
  ctx.fillRect(MARGIN, FOOTER_Y, 72, 6);
  const endY = drawPlaces(ctx, theme, places, lugar, MARGIN, FOOTER_Y + 78);
  ctx.fillStyle = theme.soft;
  ctx.font = `400 34px ${MONO}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText("folear.gal", MARGIN, endY + 70);

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("Non se puido xerar a imaxe."))), "image/png");
  });
}

export function canShareFile(blob) {
  try {
    const file = new File([blob], "fol-e-ar.png", { type: "image/png" });
    return Boolean(navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share);
  } catch {
    return false;
  }
}

export async function shareStory(blob, name) {
  const file = new File([blob], name, { type: "image/png" });
  await navigator.share({ files: [file], title: "Fol e ar" });
}
