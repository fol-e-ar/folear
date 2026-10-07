// Botón «x» para borrar toda a busca en calquera <input type="search">, como o do buscador de
// Instagram. Chrome/Safari levan un propio, pero Firefox e os móbiles non (e cada un o debuxa
// distinto): engádese un igual en todos (o nativo agóchase por CSS) sen tocar cada pantalla.
//
// O botón créase ao entrar no campo, como irmán do input, e posiciónase por riba do seu extremo
// dereito. Móstrase só mentres o campo ten foco e texto. Ao premelo vacíase o campo e avísanse os
// oíntes (`input` e `search`). A zona táctil é de 44px (mínimo recomendado en móbil) aínda que o
// círculo visible sexa máis pequeno.

const BUTTON_CLASS = "search-clear";
const HIT = 44; // lado da zona táctil, en px
const EDGE = 2; // separación ao bordo dereito do campo
const LONG_PRESS_GUARD_MS = 700;

let active = null; // { input, button }
let resizeObserver = null;
let frame = 0;

function buttonFor(input) {
  let button = input.nextElementSibling;
  if (button && button.classList.contains(BUTTON_CLASS)) return button;
  button = document.createElement("button");
  button.type = "button";
  button.className = BUTTON_CLASS;
  button.tabIndex = -1;
  button.hidden = true;
  button.setAttribute("aria-label", "Borrar a busca");
  button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 5l6 6M11 5l-6 6"/></svg>';
  // O foco non debe saír do campo: así o teclado móbil non se pecha ao borrar. `pointerdown` e
  // `mousedown` con preventDefault evitan o blur (en `touchstart` non se pode: cancelaría o click);
  // a marca `pressing` evita que o `focusout` agoche o botón antes de que chegue o `click`.
  const press = event => {
    button.dataset.pressing = "1";
    clearTimeout(button._pressTimer);
    button._pressTimer = setTimeout(() => { delete button.dataset.pressing; }, LONG_PRESS_GUARD_MS);
    if (event.type !== "touchstart" && event.cancelable) event.preventDefault();
  };
  button.addEventListener("pointerdown", press);
  button.addEventListener("mousedown", press);
  button.addEventListener("touchstart", press, { passive: true });
  button.addEventListener("pointercancel", () => { delete button.dataset.pressing; });
  button.addEventListener("click", event => {
    event.preventDefault();
    delete button.dataset.pressing;
    const target = button.previousElementSibling;
    if (!(target instanceof HTMLInputElement)) return;
    target.value = "";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("search", { bubbles: true }));
    target.focus({ preventScroll: true });
    update(target);
  });
  input.insertAdjacentElement("afterend", button);
  return button;
}

function place(input, button) {
  const height = Math.min(HIT, input.offsetHeight); // nunca máis alto ca o campo
  const left = input.offsetLeft + input.offsetWidth - HIT - EDGE;
  const top = input.offsetTop + (input.offsetHeight - height) / 2;
  button.style.height = `${height}px`;
  button.style.left = `${Math.round(left)}px`;
  button.style.top = `${Math.round(top)}px`;
}

function schedulePlace() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (active && active.input.isConnected) {
      if (document.activeElement !== active.input) return;
      place(active.input, active.button);
    }
  });
}

function watch(input) {
  if (!("ResizeObserver" in window)) return;
  if (!resizeObserver) resizeObserver = new ResizeObserver(schedulePlace);
  resizeObserver.disconnect();
  resizeObserver.observe(input);
  if (input.parentElement) resizeObserver.observe(input.parentElement);
}

function update(input) {
  const button = buttonFor(input);
  const show = Boolean(input.value) && document.activeElement === input && !input.disabled && !input.readOnly;
  button.hidden = !show;
  input.classList.toggle("has-clear", show);
  if (show) {
    place(input, button);
    watch(input);
    active = { input, button };
    // O padding extra cambia o ancho útil, non o do campo; recolócase igualmente tras o repintado.
    schedulePlace();
  }
}

function isSearch(node) {
  return node instanceof HTMLInputElement && node.type === "search";
}

document.addEventListener("focusin", event => { if (isSearch(event.target)) update(event.target); });
document.addEventListener("input", event => { if (isSearch(event.target)) update(event.target); });
document.addEventListener("focusout", event => {
  const input = event.target;
  if (!isSearch(input)) return;
  const button = input.nextElementSibling;
  if (button && button.classList.contains(BUTTON_CLASS)) {
    if (button.dataset.pressing || event.relatedTarget === button) return; // vai chegar o click
    button.hidden = true;
  }
  input.classList.remove("has-clear");
  if (resizeObserver) resizeObserver.disconnect();
  if (active && active.input === input) active = null;
});

window.addEventListener("resize", schedulePlace);
window.addEventListener("orientationchange", schedulePlace);
if (window.visualViewport) window.visualViewport.addEventListener("resize", schedulePlace);
