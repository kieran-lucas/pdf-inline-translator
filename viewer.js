'use strict';

// ── Guard: ensure PDF.js loaded correctly ──────────────────────────────────

if (typeof pdfjsLib === 'undefined') {
  document.getElementById('error-bar').textContent =
    'PDF.js failed to load (pdf.min.js missing or corrupted). ' +
    'Reload the extension from chrome://extensions.';
  document.getElementById('error-bar').classList.remove('hidden');
  throw new Error('pdfjsLib is not defined');
}

// ── Wire up the PDF.js worker ──────────────────────────────────────────────

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// ── DOM refs ───────────────────────────────────────────────────────────────

const fileInput    = document.getElementById('file-input');
const urlInput     = document.getElementById('url-input');
const urlLoadBtn   = document.getElementById('url-load');
const errorBar     = document.getElementById('error-bar');
const loadingBar   = document.getElementById('loading-bar');
const pdfContainer = document.getElementById('pdf-container');

// ── State ──────────────────────────────────────────────────────────────────

let currentLoadingTask = null;
let currentGeneration  = 0; // incremented on every new load to abort stale renders

// ── UI helpers ─────────────────────────────────────────────────────────────

function showError(msg) {
  errorBar.textContent = msg;
  errorBar.classList.remove('hidden');
  loadingBar.classList.add('hidden');
}

function clearError() {
  errorBar.textContent = '';
  errorBar.classList.add('hidden');
}

function setLoading(active) {
  loadingBar.classList.toggle('hidden', !active);
}

function clearViewer() {
  if (currentLoadingTask) {
    currentLoadingTask.destroy().catch(() => {});
    currentLoadingTask = null;
  }
  pdfContainer.innerHTML = '';
}

// ── Page rendering ─────────────────────────────────────────────────────────

const BASE_SCALE = 1.5;

async function renderPage(page, container, generation) {
  if (generation !== currentGeneration) return;

  // Cap DPR at 2 to avoid excessive canvas memory on 3× displays.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // CSS-space viewport (used for layout and text layer positioning).
  const viewport   = page.getViewport({ scale: BASE_SCALE });
  // Hi-DPI viewport for the actual canvas pixels.
  const hiDpiVP    = page.getViewport({ scale: BASE_SCALE * dpr });

  // Page wrapper
  const pageDiv = document.createElement('div');
  pageDiv.className = 'pdf-page';
  pageDiv.style.width  = viewport.width  + 'px';
  pageDiv.style.height = viewport.height + 'px';
  container.appendChild(pageDiv);

  // Canvas (rendered at full pixel density, displayed at CSS size)
  const canvas = document.createElement('canvas');
  canvas.width  = hiDpiVP.width;
  canvas.height = hiDpiVP.height;
  canvas.style.width  = viewport.width  + 'px';
  canvas.style.height = viewport.height + 'px';
  pageDiv.appendChild(canvas);

  // Transparent text layer (positioned on top of canvas, matches CSS size)
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  pageDiv.appendChild(textLayerDiv);

  // Render the canvas
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: hiDpiVP }).promise;

  if (generation !== currentGeneration) return;

  // Render the selectable text layer
  if (typeof pdfjsLib.renderTextLayer === 'function') {
    try {
      const textContent = await page.getTextContent();
      if (generation !== currentGeneration) return;

      const task = pdfjsLib.renderTextLayer({
        textContent,
        container: textLayerDiv,
        viewport,          // CSS-space viewport keeps span positions correct
        textDivs: [],
      });
      await task.promise;
    } catch (err) {
      // Text layer is non-critical; log but do not break the page display.
      console.warn('Text layer render failed on a page:', err);
    }
  }

  page.cleanup();
}

// ── PDF load orchestrator ──────────────────────────────────────────────────

async function loadPDF(source) {
  clearError();
  clearViewer();
  setLoading(true);

  const generation = ++currentGeneration;

  const loadingTask = pdfjsLib.getDocument(source);
  currentLoadingTask = loadingTask;

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    if (generation !== currentGeneration) return; // a newer load already took over
    setLoading(false);
    handleLoadError(err);
    return;
  }

  if (generation !== currentGeneration) return;
  setLoading(false);

  const numPages = pdfDoc.numPages;

  for (let i = 1; i <= numPages; i++) {
    if (generation !== currentGeneration) return;

    try {
      const page = await pdfDoc.getPage(i);
      await renderPage(page, pdfContainer, generation);
    } catch (err) {
      if (generation !== currentGeneration) return;
      console.error(`Page ${i} render error:`, err);

      const errDiv = document.createElement('div');
      errDiv.className = 'page-error';
      errDiv.textContent = `Page ${i} failed to render: ${err.message || String(err)}`;
      pdfContainer.appendChild(errDiv);
    }
  }
}

// ── Error classification ───────────────────────────────────────────────────

function handleLoadError(err) {
  const name = err.name  || '';
  const msg  = (err.message || String(err)).toLowerCase();

  if (name === 'PasswordException') {
    showError('This PDF is password-protected and cannot be opened.');
    return;
  }

  if (name === 'InvalidPDFException') {
    showError('The selected file is not a valid PDF.');
    return;
  }

  if (name === 'MissingPDFException') {
    showError('PDF not found (404). Check the URL and try again.');
    return;
  }

  if (name === 'UnexpectedResponseException') {
    const status = err.status ? ` (HTTP ${err.status})` : '';
    showError(
      `The server returned an error${status}. ` +
      'If this PDF requires a login or is behind a paywall, download the file first and ' +
      'open it with the "Open File" button.'
    );
    return;
  }

  // CORS / network errors surface as TypeError or generic network messages
  if (err instanceof TypeError ||
      msg.includes('cors') ||
      msg.includes('failed to fetch') ||
      msg.includes('network') ||
      msg.includes('xmlhttprequest')) {
    showError(
      'Could not fetch the PDF — likely a CORS restriction or network error. ' +
      'Download the file and open it with the "Open File" button instead.'
    );
    return;
  }

  if (msg.includes('worker')) {
    showError(
      'The PDF.js worker failed to start. ' +
      'Try reloading the extension from chrome://extensions, then open the viewer again.'
    );
    return;
  }

  showError(`Failed to load PDF: ${err.message || String(err)}`);
}

// ── File input handler ─────────────────────────────────────────────────────

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file
  if (!file) return;

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showError('Please select a PDF file (.pdf).');
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => showError('Could not read the file. It may be inaccessible or corrupted.');
  reader.onload  = (ev) => loadPDF({ data: new Uint8Array(ev.target.result) });
  reader.readAsArrayBuffer(file);
});

// ── URL input handler ──────────────────────────────────────────────────────

function loadFromURL() {
  const raw = urlInput.value.trim();

  if (!raw) {
    showError('Please enter a PDF URL.');
    return;
  }

  if (raw.startsWith('file://')) {
    showError(
      'file:// URLs cannot be accessed here. ' +
      'Use the "Open File" button to load a PDF from your computer.'
    );
    return;
  }

  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    showError('URL must start with http:// or https://');
    return;
  }

  loadPDF({ url: raw });
}

urlLoadBtn.addEventListener('click', loadFromURL);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFromURL();
});
