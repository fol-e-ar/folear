// Arranque da app. Vive nun ficheiro propio (e non en <script> inline) para
// poder aplicar unha CSP sen 'unsafe-inline' nos scripts.
window.FOL_E_AR_FILE_MODE = location.protocol === "file:";

if (window.FOL_E_AR_FILE_MODE) {
  const localUrl = `http://localhost:8765/frontend/index.html${location.search}${location.hash}`;
  fetch(localUrl, { mode: "no-cors" })
    .then(() => location.replace(localUrl))
    .catch(() => {
      document.body.innerHTML = `
        <main class="file-mode-notice">
          <section>
            <h1>Fol e ar precisa o servidor local</h1>
            <p>Abre a app desde localhost para poder cargar JSON, GeoJSON e módulos JavaScript.</p>
            <code>./serve.sh 8765</code>
            <a href="${localUrl}">Abrir localhost</a>
          </section>
        </main>
      `;
    });
} else {
  import("./archive_app.js");
}
