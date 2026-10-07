// A páxina debe quedar sempre estática en móbil: sen o «zoom» que iOS fai ao enfocar un campo,
// sen zoom por pinch sobre a páxina e sen zoom por dobre toque. As capas que si necesitan xestos
// (o mapa de Leaflet, os visores de PDF) xestionan os seus propios eventos e non se ven afectadas.
//
// Capas de defensa (cada navegador respecta unha distinta):
//  1. <meta viewport> con maximum-scale=1 / user-scalable=no (index.html).
//  2. CSS: campos a 16px en táctil e `touch-action: manipulation` (css/profile.css).
//  3. Aquí: Safari iOS ignora user-scalable=no para o pinch, pero lanza `gesturestart`.

function stop(event) {
  event.preventDefault();
}

document.addEventListener("gesturestart", stop, { passive: false });
document.addEventListener("gesturechange", stop, { passive: false });
document.addEventListener("gestureend", stop, { passive: false });

// Pinch de dous dedos fóra de calquera capa que o use de verdade (mapa, visor de PDF).
document.addEventListener("touchmove", event => {
  if (event.touches.length < 2) return;
  if (event.target.closest?.(".leaflet-container, .pdf-canvas-frame, .pdf-viewer, [data-allow-pinch]")) return;
  event.preventDefault();
}, { passive: false });

// Se por calquera motivo o navegador chegase a ampliar (visualViewport.scale > 1) tras enfocar un
// campo, volve ao tamaño normal ao saír del.
document.addEventListener("focusout", () => {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale <= 1.001) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.getAttribute("content");
  meta.setAttribute("content", `${content}, maximum-scale=1`);
  setTimeout(() => meta.setAttribute("content", content), 120);
});
