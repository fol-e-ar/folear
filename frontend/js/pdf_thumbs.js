import { loaderHtml } from "./utils.js";
// Miniaturas da primeira páxina dos PDFs.
//
// As tarxetas de media con PDF levan `data-pdf-thumb="<url>"`. Cando unha
// delas entra na pantalla, renderízase a primeira páxina con pdf.js (só no
// navegador, cargado baixo demanda) e substitúese a icona por unha imaxe.
// O PDF descárgase a través de /api/pdf-proxy (a maioría dos servidores non
// permiten lelos directamente por CORS). A miniatura gárdase en localStorage
// para non repetir o traballo; se algo falla, queda a icona de sempre.

const PDFJS_BASE = new URL("../assets/vendor/pdfjs/", import.meta.url).href;
const CACHE_PREFIX = "fol-e-ar-pdfthumb-v1:";
const THUMB_WIDTH = 480;
const THUMB_HEIGHT = 360;
const MAX_PARALLEL = 2;

let pdfjsPromise = null;
let active = 0;
const queue = [];

function cacheGet(url) {
  try {
    return window.localStorage?.getItem(CACHE_PREFIX + url) || null;
  } catch {
    return null;
  }
}

function cacheSet(url, dataUrl) {
  try {
    window.localStorage?.setItem(CACHE_PREFIX + url, dataUrl);
  } catch {
    // Cota chea: bórrase a caché de miniaturas e tentámolo unha vez máis.
    try {
      Object.keys(window.localStorage)
        .filter(key => key.startsWith(CACHE_PREFIX))
        .forEach(key => window.localStorage.removeItem(key));
      window.localStorage.setItem(CACHE_PREFIX + url, dataUrl);
    } catch {
      // Sen almacenamento: a miniatura xerarase de novo a próxima vez.
    }
  }
}

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${PDFJS_BASE}pdf.min.js`;
      script.onload = () => {
        try {
          const lib = window.pdfjsLib;
          lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}pdf.worker.min.js`;
          resolve(lib);
        } catch (error) {
          reject(error);
        }
      };
      script.onerror = () => reject(new Error("Non se puido cargar pdf.js"));
      document.head.appendChild(script);
    });
  }
  return pdfjsPromise;
}

async function renderFirstPage(url) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({ isEvalSupported: false, url: `../api/pdf-proxy?url=${encodeURIComponent(url)}` });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    // Queda a parte de arriba da páxina, que é a que amosa a tarxeta.
    const crop = document.createElement("canvas");
    crop.width = canvas.width;
    crop.height = Math.min(canvas.height, THUMB_HEIGHT);
    crop.getContext("2d").drawImage(canvas, 0, 0);
    return crop.toDataURL("image/jpeg", 0.72);
  } finally {
    pdf.destroy();
  }
}

function applyThumb(node, dataUrl) {
  if (!node.isConnected) return;
  node.classList.add("has-thumb");
  node.innerHTML = `<img src="${dataUrl}" alt="">`;
  node.dataset.pdfState = "done";
}

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const node = queue.shift();
    const url = node.dataset.pdfThumb;
    active += 1;
    node.dataset.pdfState = "loading";
    node.insertAdjacentHTML("beforeend", loaderHtml());
    renderFirstPage(url)
      .then(dataUrl => {
        cacheSet(url, dataUrl);
        applyThumb(node, dataUrl);
      })
      .catch(error => {
        console.warn("Sen miniatura de PDF:", url, error?.message || error);
        node.querySelector(".fol-loader")?.remove();
        node.dataset.pdfState = "error";
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

export function initPdfThumbs() {
  if (typeof MutationObserver === "undefined" || typeof IntersectionObserver === "undefined") return;

  const visible = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const node = entry.target;
      visible.unobserve(node);
      queue.push(node);
    });
    pump();
  }, { rootMargin: "200px" });

  const scan = () => {
    document.querySelectorAll("[data-pdf-thumb]:not([data-pdf-state])").forEach(node => {
      const cached = cacheGet(node.dataset.pdfThumb);
      if (cached) {
        applyThumb(node, cached);
        return;
      }
      node.dataset.pdfState = "waiting";
      visible.observe(node);
    });
  };

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
}

// ---------------------------------------------------------------------------
// Visor de PDF con pdf.js (para navegadores que non amosan un PDF dentro dun
// <object>/<iframe>: Safari, sobre todo en iPhone/iPad). Debuxa cada páxina nun
// <canvas> dentro de `container`. `isCancelled()` permite deixalo se se pecha o visor.
// ---------------------------------------------------------------------------

export function browserNeedsPdfCanvas() {
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android/.test(ua);
  return ios || safari || navigator.pdfViewerEnabled === false;
}

export async function renderPdfPages(container, blob, { isCancelled = () => false, maxPages = 60 } = {}) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const pdf = await lib.getDocument({ data, isEvalSupported: false }).promise;
  try {
    const total = Math.min(pdf.numPages, maxPages);
    const width = Math.max(240, Math.min(container.clientWidth - 24, 1000));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    for (let number = 1; number <= total; number += 1) {
      if (isCancelled()) return;
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale: scale * ratio });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.floor(base.width * scale)}px`;
      canvas.style.height = `${Math.floor(base.height * scale)}px`;
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Páxina ${number} de ${pdf.numPages}`);
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      container.appendChild(canvas);
      await page.render({ canvasContext: context, viewport }).promise;
      if (number === 1) container.querySelector(".pdf-loading")?.remove();
    }
  } finally {
    pdf.destroy();
  }
}
