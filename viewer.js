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
const zoomSelect   = document.getElementById('zoom-select');
const errorBar     = document.getElementById('error-bar');
const loadingBar   = document.getElementById('loading-bar');
const pdfContainer = document.getElementById('pdf-container');

// ── State ──────────────────────────────────────────────────────────────────

let currentLoadingTask = null;
let currentPdfDoc      = null;   // kept alive so zoom can re-render without reloading
let currentGeneration  = 0;      // incremented on every new render pass to abort stale work
let currentZoom        = parseFloat(zoomSelect.value); // mirrors the select, default 1.5

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
  // Null the doc so a stale zoom handler cannot re-render the old document.
  currentPdfDoc = null;
  pdfContainer.innerHTML = '';
}

// ── High-DPI page rendering ────────────────────────────────────────────────
//
// Strategy (standard PDF.js high-DPI approach):
//   1. Get a viewport at the desired CSS scale (currentZoom).
//   2. Size the canvas in *physical* pixels:  Math.round(viewport.width  * DPR)
//   3. Display the canvas at *CSS* pixels:     viewport.width  + 'px'
//   4. Pass a transform = [DPR,0,0,DPR,0,0] to page.render() so PDF.js
//      draws into the larger canvas without needing a separate hi-DPI viewport.
//   5. Give the text layer the same CSS-scale viewport so span positions match.
//
// This avoids the previous approach of creating two different viewports, which
// could diverge by fractional pixels and mis-align the text layer.

async function renderPage(page, container, generation) {
  if (generation !== currentGeneration) return;

  // Use the true device pixel ratio — no artificial cap so quality is never
  // reduced on high-DPI displays (125 %, 150 %, 175 %, 200 % Windows scaling).
  const outputScale = window.devicePixelRatio || 1;

  // Single viewport at the chosen zoom level. Used for layout, canvas CSS size,
  // text-layer positioning, and (via transform) for canvas pixel rendering.
  const viewport = page.getViewport({ scale: currentZoom });

  // Physical canvas dimensions. Math.round avoids sub-pixel sizing artifacts.
  const pixelW = Math.round(viewport.width  * outputScale);
  const pixelH = Math.round(viewport.height * outputScale);

  // ── Page wrapper ──────────────────────────────────────────────────────────
  const pageDiv = document.createElement('div');
  pageDiv.className    = 'pdf-page';
  pageDiv.style.width  = viewport.width  + 'px';
  pageDiv.style.height = viewport.height + 'px';
  container.appendChild(pageDiv);

  // ── Canvas ────────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width        = pixelW;   // physical pixels
  canvas.height       = pixelH;
  canvas.style.width  = viewport.width  + 'px'; // CSS display size
  canvas.style.height = viewport.height + 'px';
  pageDiv.appendChild(canvas);

  // ── Text layer ────────────────────────────────────────────────────────────
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  pageDiv.appendChild(textLayerDiv);

  // ── Render canvas ─────────────────────────────────────────────────────────
  const ctx = canvas.getContext('2d');

  // The transform scales the 2D context so that every PDF coordinate is
  // rendered into outputScale × more canvas pixels, giving crisp output on
  // high-DPI screens without changing the viewport scale or the text layer.
  const renderParams = { canvasContext: ctx, viewport };
  if (outputScale !== 1) {
    renderParams.transform = [outputScale, 0, 0, outputScale, 0, 0];
  }

  await page.render(renderParams).promise;

  if (generation !== currentGeneration) return;

  // ── Render text layer ─────────────────────────────────────────────────────
  // The text layer uses the same CSS-scale viewport as the canvas display size,
  // so span positions align exactly with the canvas pixels the user sees.
  if (typeof pdfjsLib.renderTextLayer === 'function') {
    try {
      const textContent = await page.getTextContent();
      if (generation !== currentGeneration) return;

      const task = pdfjsLib.renderTextLayer({
        textContent,
        container: textLayerDiv,
        viewport,     // CSS-scale — matches canvas.style.width/height exactly
        textDivs: [],
      });
      await task.promise;
    } catch (err) {
      // Text layer is non-critical; canvas rendering is already done.
      console.warn('Text layer render failed on a page:', err);
    }
  }

  page.cleanup();
}

// ── Document render loop ───────────────────────────────────────────────────
// Shared by initial load and zoom changes. Clears the container first so
// the new scale's pages replace the old ones cleanly.

async function renderDocument(pdfDoc, generation) {
  pdfContainer.innerHTML = '';
  setLoading(true);

  const n = pdfDoc.numPages;
  for (let i = 1; i <= n; i++) {
    if (generation !== currentGeneration) {
      setLoading(false);
      return;
    }
    try {
      const page = await pdfDoc.getPage(i);
      await renderPage(page, pdfContainer, generation);
    } catch (err) {
      if (generation !== currentGeneration) { setLoading(false); return; }
      console.error(`Page ${i} render error:`, err);
      const errDiv = document.createElement('div');
      errDiv.className = 'page-error';
      errDiv.textContent = `Page ${i} failed to render: ${err.message || String(err)}`;
      pdfContainer.appendChild(errDiv);
    }
  }

  if (generation === currentGeneration) setLoading(false);
}

// ── PDF load orchestrator ──────────────────────────────────────────────────

async function loadPDF(source) {
  clearError();
  clearViewer();

  const generation = ++currentGeneration;

  const loadingTask = pdfjsLib.getDocument(source);
  currentLoadingTask = loadingTask;

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    if (generation !== currentGeneration) return;
    setLoading(false);
    handleLoadError(err);
    return;
  }

  if (generation !== currentGeneration) return;

  // Keep the document alive so zoom changes can re-render without re-fetching.
  currentPdfDoc = pdfDoc;
  await renderDocument(pdfDoc, generation);
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

// ── File input ─────────────────────────────────────────────────────────────

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

// ── URL input ──────────────────────────────────────────────────────────────

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
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFromURL(); });

// ── Zoom ───────────────────────────────────────────────────────────────────
// Re-render the current document at the new scale. The canvas is destroyed and
// rebuilt at the correct pixel dimensions — no CSS-scaling tricks.

zoomSelect.addEventListener('change', async () => {
  currentZoom = parseFloat(zoomSelect.value);
  if (!currentPdfDoc) return;
  const generation = ++currentGeneration;
  await renderDocument(currentPdfDoc, generation);
});
