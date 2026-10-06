// Accesibilidade transversal, sen tocar cada pantalla:
//  - capas modais (role="dialog" aria-modal="true"): o foco entra ao abrir, Tab non sae
//    da capa e, ao pechar, o foco volve a quen a abriu;
//  - Esc pecha a previsualización do PDF.
// Detecta as capas observando o DOM (un só chequeo por fotograma).

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

let current = null;   // capa modal activa
let opener = null;    // elemento que tiña o foco antes de abrila
let scheduled = false;

function isVisible(el) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

function topDialog() {
  const all = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(isVisible);
  return all.length ? all[all.length - 1] : null;
}

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);
}

function enter(dialog) {
  if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
  const preferred = dialog.querySelector("[autofocus]")
    || dialog.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select");
  (preferred && isVisible(preferred) ? preferred : dialog).focus({ preventScroll: true });
}

function check() {
  scheduled = false;
  const top = topDialog();
  if (top === current) return;
  if (top && !current) opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  if (top) {
    enter(top);
  } else if (opener && document.contains(opener) && isVisible(opener)) {
    opener.focus({ preventScroll: true });
    opener = null;
  } else {
    opener = null;
  }
  current = top;
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(check);
}

document.addEventListener("keydown", event => {
  const dialog = topDialog();
  if (!dialog) return;
  if (event.key === "Escape" && dialog.classList.contains("pdf-panel")) {
    dialog.querySelector("[data-close-pdf]")?.click();
    return;
  }
  if (event.key !== "Tab") return;
  const items = focusables(dialog);
  if (!items.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

new MutationObserver(schedule).observe(document.body, {
  childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"],
});
schedule();

// «Saltar ao contido»: leva o foco a <main> sen mudar a URL (o hash úsase para as rutas internas).
document.querySelector(".skip-link")?.addEventListener("click", event => {
  event.preventDefault();
  document.getElementById("main")?.focus();
});
