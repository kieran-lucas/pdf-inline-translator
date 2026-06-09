'use strict';

// ── Guard: ensure PDF.js loaded correctly ──────────────────────────────────

if (typeof pdfjsLib === 'undefined') {
  document.getElementById('error-bar').textContent =
    'PDF.js failed to load (pdf.min.js missing or corrupted). ' +
    'Reload the extension from chrome://extensions.';
  document.getElementById('error-bar').classList.remove('hidden');
  throw new Error('pdfjsLib is not defined');
}

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// Set DEBUG_RENDER = true to outline pageDiv / canvas / textLayer for alignment checking.
const DEBUG_RENDER = false;
const DEBUG_TEXT_GEOMETRY = false;

// PDF.js font resources — must match the version of pdf.min.js.
// CMap files are required for PDFs that use CMap-based font encodings (CJK, Symbol,
// ZapfDingbats, older Type1 fonts).  Without them, PDF.js can't decode character
// codes and assigns wrong advance widths, producing vertical letter stacking.
// Standard font data provides correct metrics for the 14 standard Type1 fonts
// (Times, Helvetica, Courier, Symbol, ZapfDingbats) that PDFs are allowed to omit.
const CMAP_URL            = chrome.runtime.getURL('lib/cmaps/');
const STANDARD_FONT_URL   = chrome.runtime.getURL('lib/standard_fonts/');

// ── DOM refs ───────────────────────────────────────────────────────────────

const fileInput    = document.getElementById('file-input');
const urlInput     = document.getElementById('url-input');
const urlLoadBtn   = document.getElementById('url-load');
const zoomSelect   = document.getElementById('zoom-select');
const errorBar     = document.getElementById('error-bar');
const loadingBar   = document.getElementById('loading-bar');
const pdfContainer = document.getElementById('pdf-container');
const outlinePanel = document.getElementById('outline-panel');
const outlineList  = document.getElementById('outline-list');

// ── Global state ───────────────────────────────────────────────────────────

let currentLoadingTask = null;
let currentPdfDoc      = null;
let currentGeneration  = 0;   // bumped on every new load or zoom change
let currentZoom        = parseFloat(zoomSelect.value); // default 1.5

// Per-page slot array. slots[0] is unused; slots[1..n] mirror PDF pages.
// Each slot:
//   pageDiv           – always in DOM; sized to match page at current zoom
//   canvas            – null until first render; reused across zoom changes
//   textLayerDiv      – inside pageDiv; empty (text layer disabled for canvas fidelity)
//   annotationLayerDiv – inside pageDiv; holds clickable link overlays
//   naturalW/H        – page size (px) at scale 1.0, cached for instant resize
//   state             – 'idle' | 'rendering' | 'rendered' | 'error'
//   activeGeneration  – generation of the in-progress or last-completed render
//   renderedZoom      – zoom used for the completed render (null if never rendered)
//   activeRenderTask  – live PDF.js RenderTask; cancelled on zoom/load change
const slots = [];

// The single IntersectionObserver; replaced whenever a new document loads.
let intersectionObserver = null;

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

// ── Slot creation ──────────────────────────────────────────────────────────

function createSlot(pageNum, naturalW, naturalH) {
  const pageDiv = document.createElement('div');
  pageDiv.className      = 'pdf-page';
  pageDiv.dataset.page   = String(pageNum);
  pageDiv.style.width    = Math.round(naturalW * currentZoom) + 'px';
  pageDiv.style.height   = Math.round(naturalH * currentZoom) + 'px';

  // textLayerDiv is kept but empty — DOM text layer is not rendered because it
  // interferes with canvas fidelity.  Geometry-based word detection drives
  // double-click translation without injecting any visible DOM spans.
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.setAttribute('aria-hidden', 'true');
  pageDiv.appendChild(textLayerDiv);

  // Annotation layer sits above the canvas for clickable link overlays.
  const annotationLayerDiv = document.createElement('div');
  annotationLayerDiv.className = 'annotationLayer';
  pageDiv.appendChild(annotationLayerDiv);

  if (DEBUG_RENDER) {
    pageDiv.style.outline              = '2px solid red';
    textLayerDiv.style.outline         = '2px solid blue';
    annotationLayerDiv.style.outline   = '2px solid orange';
  }

  return {
    pageNum,
    pageDiv,
    canvas:              null,
    textLayerDiv,
    annotationLayerDiv,
    textContentItems:    [],
    wordBoxes:           [],
    textGeometryGeneration: -1,
    textGeometryZoom:    null,
    geometryHighlight:   null,
    geometryDebugLayer:  null,
    naturalW,
    naturalH,
    state:               'idle',
    activeGeneration:    -1,
    renderedZoom:        null,
    activeRenderTask:    null,
  };
}

// ── Layout builder ─────────────────────────────────────────────────────────
// Fetches all page viewport sizes (fast – no canvas rendering), creates sized
// placeholder divs, then wires up the IntersectionObserver.

async function buildLayout(pdfDoc, generation) {
  pdfContainer.innerHTML = '';
  slots.length = 0;
  slots.push(null); // slots[0] intentionally empty

  const n         = pdfDoc.numPages;
  const BATCH     = 50; // pages fetched in parallel per round

  for (let start = 1; start <= n; start += BATCH) {
    if (generation !== currentGeneration) return;

    const end   = Math.min(start + BATCH - 1, n);
    const tasks = [];

    for (let i = start; i <= end; i++) {
      tasks.push(
        pdfDoc.getPage(i).then(page => {
          const vp = page.getViewport({ scale: 1.0 });
          return { i, naturalW: vp.width, naturalH: vp.height };
        })
      );
    }

    const results = await Promise.all(tasks);
    if (generation !== currentGeneration) return;

    // Append this batch's placeholder divs to the DOM in one pass.
    const fragment = document.createDocumentFragment();
    for (const { i, naturalW, naturalH } of results) {
      const slot = createSlot(i, naturalW, naturalH);
      slots[i] = slot;
      fragment.appendChild(slot.pageDiv);
    }
    pdfContainer.appendChild(fragment);
  }

  if (generation !== currentGeneration) return;

  setLoading(false);
  setupObserver(generation);
  // Immediately trigger renders for the pages already on screen.
  scheduleVisiblePages();
}

// ── IntersectionObserver ───────────────────────────────────────────────────
// rootMargin of 1500 px pre-renders roughly one page-height ahead/behind the
// visible area at typical zoom levels, giving smooth scroll-ahead rendering.

function setupObserver(generation) {
  teardownObserver();

  intersectionObserver = new IntersectionObserver(
    (entries) => {
      if (generation !== currentGeneration) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const pageNum = parseInt(entry.target.dataset.page, 10);
        if (pageNum) scheduleRender(pageNum);
      }
    },
    { rootMargin: '1500px 0px', threshold: 0 }
  );

  for (let i = 1; i < slots.length; i++) {
    if (slots[i]) intersectionObserver.observe(slots[i].pageDiv);
  }
}

function teardownObserver() {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
}

// ── scheduleRender ─────────────────────────────────────────────────────────
// Called by the observer and by scheduleVisiblePages().
// Guards against duplicate or stale renders; cancels any superseded task.

async function scheduleRender(pageNum) {
  if (!currentPdfDoc) return;
  const slot = slots[pageNum];
  if (!slot) return;

  const gen  = currentGeneration;
  const zoom = currentZoom;

  // Already rendered correctly for this generation + zoom → nothing to do.
  if (slot.state === 'rendered' &&
      slot.renderedZoom      === zoom &&
      slot.activeGeneration  === gen) return;

  // Already rendering for this exact generation → don't start a second task.
  if (slot.state === 'rendering' && slot.activeGeneration === gen) return;

  // Cancel any previous in-flight render (different zoom or generation).
  cancelSlotRender(slot);

  slot.state           = 'rendering';
  slot.activeGeneration = gen;

  try {
    const page = await currentPdfDoc.getPage(pageNum);
    // A zoom change may have incremented currentGeneration while we awaited.
    if (gen !== currentGeneration) return;

    await renderPageIntoSlot(page, slot, zoom, gen);

    if (gen === currentGeneration && zoom === currentZoom) {
      slot.state        = 'rendered';
      slot.renderedZoom = zoom;
    }
  } catch (err) {
    if (isCancelError(err)) {
      // Cancelled intentionally – leave state management to the canceller.
      return;
    }
    if (gen === currentGeneration) {
      slot.state = 'error';
      console.error(`Page ${pageNum} render error:`, err);
    }
  }
}

function cancelSlotRender(slot) {
  if (slot.activeRenderTask) {
    try { slot.activeRenderTask.cancel(); } catch { /* ignore */ }
    slot.activeRenderTask = null;
  }
}

function isCancelError(err) {
  return (
    err?.name === 'RenderingCancelledException' ||
    (typeof err?.message === 'string' &&
     (err.message.includes('cancel') || err.message.includes('Cancel')))
  );
}

// ── renderPageIntoSlot ─────────────────────────────────────────────────────
// Renders the canvas at full device resolution, builds the geometry word index
// for translation hit-testing, and populates the annotation link overlay.
//
// Canvas sizing:
//   Physical canvas pixels = round(viewport CSS px * DPR)
//   Canvas CSS size        = round(viewport CSS px)   ← integer to avoid blur
//   pageDiv CSS size       = same as canvas CSS size
//
// Text layer:
//   Not rendered (DOM text layer disabled).  The geometry word index built from
//   page.getTextContent() provides double-click hit-testing without injecting
//   any visible DOM spans that could corrupt canvas output.

// -- PDF text geometry -------------------------------------------------------
// Derived from PDF.js textContent + viewport transforms, not from textLayer DOM.

let measureCanvas = null;

function getMeasureContext() {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext('2d');
}

function isBaseWordChar(ch) {
  try {
    return /[\p{L}\p{N}_]/u.test(ch);
  } catch (_) {
    return /[A-Za-z0-9_]/.test(ch);
  }
}

function collectWords(str) {
  const words = [];
  let start = -1;

  function isInternalJoiner(idx) {
    const ch = str[idx];
    return (ch === "'" || ch === '\u2019' || ch === '\u2018' ||
            ch === '-' || ch === '\u2010' || ch === '\u2011') &&
           idx > 0 && idx < str.length - 1 &&
           isBaseWordChar(str[idx - 1]) &&
           isBaseWordChar(str[idx + 1]);
  }

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (isBaseWordChar(ch) || (start >= 0 && isInternalJoiner(i))) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      words.push({ text: str.slice(start, i), start, end: i });
      start = -1;
    }
  }

  if (start >= 0) words.push({ text: str.slice(start), start, end: str.length });
  return words;
}

function measurePrefixRatios(str, start, end, fontSize) {
  const ctx = getMeasureContext();
  if (!ctx) {
    const len = Math.max(1, str.length);
    return { startRatio: start / len, endRatio: end / len };
  }

  ctx.font = `${Math.max(1, fontSize)}px sans-serif`;
  const total = ctx.measureText(str).width || str.length || 1;
  const prefix = ctx.measureText(str.slice(0, start)).width;
  const through = ctx.measureText(str.slice(0, end)).width;
  return {
    startRatio: Math.max(0, Math.min(1, prefix / total)),
    endRatio: Math.max(0, Math.min(1, through / total)),
  };
}

function makeItemBox(item, viewport, itemIndex, pageNum) {
  const transform = pdfjsLib.Util?.transform
    ? pdfjsLib.Util.transform(viewport.transform, item.transform)
    : [
        viewport.transform[0] * item.transform[0] + viewport.transform[2] * item.transform[1],
        viewport.transform[1] * item.transform[0] + viewport.transform[3] * item.transform[1],
        viewport.transform[0] * item.transform[2] + viewport.transform[2] * item.transform[3],
        viewport.transform[1] * item.transform[2] + viewport.transform[3] * item.transform[3],
        viewport.transform[0] * item.transform[4] + viewport.transform[2] * item.transform[5] + viewport.transform[4],
        viewport.transform[1] * item.transform[4] + viewport.transform[3] * item.transform[5] + viewport.transform[5],
      ];

  const str = item.str || '';
  const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]) || Math.abs(item.height * viewport.scale) || 1);
  const width = Math.max(1, Math.abs(item.width * viewport.scale) || Math.hypot(transform[0], transform[1]) * Math.max(1, str.length));
  const baseline = transform[5];
  const advanceLen = Math.hypot(transform[0], transform[1]) || 1;
  const advanceX = (transform[0] / advanceLen) * width;
  const advanceY = (transform[1] / advanceLen) * width;
  let heightX = transform[2];
  let heightY = transform[3];
  if (Math.hypot(heightX, heightY) < 0.001) {
    heightX = 0;
    heightY = -fontHeight;
  }
  const corners = [
    { x: transform[4], y: transform[5] },
    { x: transform[4] + advanceX, y: transform[5] + advanceY },
    { x: transform[4] + heightX, y: transform[5] + heightY },
    { x: transform[4] + advanceX + heightX, y: transform[5] + advanceY + heightY },
  ];
  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);

  return {
    pageNum,
    itemIndex,
    str,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    baseline,
  };
}

function buildTextGeometryIndex(textContent, viewport, pageNum) {
  const wordBoxes = [];
  const items = textContent.items || [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const str = item.str || '';
    if (!str.trim()) continue;

    const itemBox = makeItemBox(item, viewport, i, pageNum);
    if (!Number.isFinite(itemBox.left) || !Number.isFinite(itemBox.top) ||
        itemBox.width <= 0 || itemBox.height <= 0) continue;

    for (const word of collectWords(str)) {
      const ratios = measurePrefixRatios(str, word.start, word.end, itemBox.height);
      const left = itemBox.left + itemBox.width * ratios.startRatio;
      const right = itemBox.left + itemBox.width * ratios.endRatio;
      const width = right - left;
      if (width <= 0.5) continue;

      wordBoxes.push({
        text: word.text,
        pageNum,
        itemIndex: i,
        itemText: str,
        start: word.start,
        end: word.end,
        left,
        top: itemBox.top,
        right,
        bottom: itemBox.bottom,
        width,
        height: itemBox.height,
        baseline: itemBox.baseline,
        centerX: left + width / 2,
        centerY: itemBox.top + itemBox.height / 2,
      });
    }
  }

  return wordBoxes;
}

function getPageSlotFromPoint(clientX, clientY) {
  const pageDiv = document.elementsFromPoint(clientX, clientY)
    .find(el => el.classList?.contains('pdf-page'));
  if (!pageDiv) return null;
  const pageNum = parseInt(pageDiv.dataset.page, 10);
  return Number.isFinite(pageNum) ? slots[pageNum] || null : null;
}

function getPageLocalPoint(slot, clientX, clientY) {
  const rect = slot?.pageDiv.getBoundingClientRect();
  if (!rect) return null;
  return { x: clientX - rect.left, y: clientY - rect.top, pageRect: rect };
}

function rectFromWordBox(pageRect, wordBox) {
  const left = pageRect.left + wordBox.left;
  const top = pageRect.top + wordBox.top;
  const right = pageRect.left + wordBox.right;
  const bottom = pageRect.top + wordBox.bottom;
  return {
    left,
    top,
    right,
    bottom,
    width: wordBox.width,
    height: wordBox.height,
  };
}

function findWordAtPoint(clientX, clientY) {
  const slot = getPageSlotFromPoint(clientX, clientY);
  if (!hasUsableTextGeometry(slot)) return null;

  const local = getPageLocalPoint(slot, clientX, clientY);
  if (!local) return null;

  const { x, y, pageRect } = local;
  const yCandidates = [];
  for (const box of slot.wordBoxes) {
    const yTol = Math.max(2, Math.min(6, box.height * 0.35));
    if (y >= box.top - yTol && y <= box.bottom + yTol) yCandidates.push(box);
  }

  if (!yCandidates.length) return null;

  let best = null;
  let bestScore = Infinity;
  for (const box of yCandidates) {
    if (x < box.left || x > box.right) continue;
    const linePenalty = Math.abs(y - box.centerY);
    const score = linePenalty + Math.abs(x - box.centerX) * 0.01;
    if (score < bestScore) {
      best = box;
      bestScore = score;
    }
  }

  if (!best) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const box of yCandidates) {
      const lineDist = Math.abs(y - box.centerY);
      const lineTol = Math.max(3, box.height * 0.5);
      if (lineDist > lineTol) continue;
      const dist = x < box.left ? box.left - x : x - box.right;
      if (dist < nearestDist) {
        nearest = box;
        nearestDist = dist;
      }
    }

    const maxSnap = nearest ? Math.max(3, Math.min(8, nearest.height * 0.45)) : 0;
    if (nearest && nearestDist <= maxSnap) best = nearest;
  }

  if (!best) return null;

  const rect = rectFromWordBox(pageRect, best);
  if (DEBUG_TEXT_GEOMETRY) {
    console.debug('[text-geometry] hit', {
      pageNum: best.pageNum,
      localX: Math.round(x),
      localY: Math.round(y),
      text: best.text,
    });
  }

  return {
    text: best.text,
    rect,
    pageNum: best.pageNum,
    source: 'pdf-geometry',
    slot,
    wordBox: best,
  };
}

function hasUsableTextGeometry(slot) {
  return !!slot &&
    slot.state === 'rendered' &&
    !!slot.wordBoxes?.length &&
    slot.textGeometryGeneration === currentGeneration &&
    slot.textGeometryZoom === currentZoom;
}

function hasUsableTextGeometryAtPoint(clientX, clientY) {
  return hasUsableTextGeometry(getPageSlotFromPoint(clientX, clientY));
}

function ensureHighlight(slot) {
  if (slot.geometryHighlight?.isConnected) return slot.geometryHighlight;
  const div = document.createElement('div');
  div.className = 'geometry-word-highlight';
  slot.geometryHighlight = div;
  slot.pageDiv.appendChild(div);
  return div;
}

function clearCustomSelection() {
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    if (slot?.geometryHighlight) {
      slot.geometryHighlight.remove();
      slot.geometryHighlight = null;
    }
  }
}

function showCustomSelection(slot, wordBox) {
  clearCustomSelection();
  if (!slot || !wordBox) return;
  const div = ensureHighlight(slot);
  div.style.left = wordBox.left + 'px';
  div.style.top = wordBox.top + 'px';
  div.style.width = wordBox.width + 'px';
  div.style.height = wordBox.height + 'px';
}

function drawGeometryDebug(slot) {
  if (!DEBUG_TEXT_GEOMETRY) return;
  if (slot.geometryDebugLayer) slot.geometryDebugLayer.remove();
  const layer = document.createElement('div');
  layer.className = 'geometry-debug-layer';
  for (const box of slot.wordBoxes || []) {
    const div = document.createElement('div');
    div.className = 'geometry-debug-box';
    div.style.left = box.left + 'px';
    div.style.top = box.top + 'px';
    div.style.width = box.width + 'px';
    div.style.height = box.height + 'px';
    layer.appendChild(div);
  }
  slot.geometryDebugLayer = layer;
  slot.pageDiv.appendChild(layer);
}

function getVisibleWordTexts(extraPages = 1) {
  const pageNums = new Set();
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot?.pageDiv) continue;
    const rect = slot.pageDiv.getBoundingClientRect();
    if (rect.bottom >= 0 && rect.top <= window.innerHeight) {
      for (let p = i - extraPages; p <= i + extraPages; p++) {
        if (p > 0 && p < slots.length) pageNums.add(p);
      }
    }
  }

  const words = [];
  const seen = new Set();
  for (const pageNum of pageNums) {
    const slot = slots[pageNum];
    if (!slot?.wordBoxes?.length ||
        slot.textGeometryGeneration !== currentGeneration ||
        slot.textGeometryZoom !== currentZoom) continue;
    for (const box of slot.wordBoxes) {
      const word = (box.text || '').toLowerCase();
      if (seen.has(word)) continue;
      seen.add(word);
      words.push(word);
      if (words.length >= 120) return words;
    }
  }
  return words;
}

window.PdfViewerState = {
  getPageSlotFromPoint,
  getPageLocalPoint,
  findWordAtPoint,
  hasUsableTextGeometryAtPoint,
  getVisibleWordTexts,
  clearCustomSelection,
  showCustomSelection,
};

// ── Navigation ─────────────────────────────────────────────────────────────

function scrollToPage(pageNum) {
  const slot = slots[pageNum];
  if (slot?.pageDiv) {
    slot.pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function navigateToDest(dest) {
  if (!currentPdfDoc || !dest) return;
  try {
    const explicitDest = typeof dest === 'string'
      ? await currentPdfDoc.getDestination(dest)
      : dest;
    if (!Array.isArray(explicitDest) || explicitDest.length === 0) return;

    const ref = explicitDest[0];
    let pageNum;
    if (ref && typeof ref === 'object' && 'num' in ref) {
      // PDF reference object — resolve to page index
      const pageIndex = await currentPdfDoc.getPageIndex(ref);
      pageNum = pageIndex + 1;
    } else if (typeof ref === 'number') {
      pageNum = ref + 1;
    } else {
      return;
    }
    scrollToPage(pageNum);
  } catch (err) {
    console.warn('[pdf-viewer] navigateToDest failed:', err);
  }
}

// ── Annotation link overlay ─────────────────────────────────────────────────
// Renders transparent clickable divs over the canvas for link annotations.
// Handles GoTo (internal page), Named (named dest), and URI (external link).

async function renderAnnotationLayer(page, slot, viewport, generation) {
  const annotDiv = slot.annotationLayerDiv;
  annotDiv.innerHTML = '';

  // Disable pointer events while loading to avoid stale overlays being clicked.
  annotDiv.style.pointerEvents = 'none';

  const annotations = await page.getAnnotations({ intent: 'display' });
  if (generation !== currentGeneration) return;

  for (const ann of annotations) {
    if (ann.subtype !== 'Link') continue;

    // Transform the annotation rect (PDF user space, bottom-left origin) to
    // CSS pixel coordinates (top-left origin) within the pageDiv.
    const [pdfX1, pdfY1, pdfX2, pdfY2] = ann.rect;
    const [vx1, vy1] = applyTransform([pdfX1, pdfY1], viewport.transform);
    const [vx2, vy2] = applyTransform([pdfX2, pdfY2], viewport.transform);

    const left   = Math.min(vx1, vx2);
    const top    = Math.min(vy1, vy2);
    const width  = Math.abs(vx2 - vx1);
    const height = Math.abs(vy2 - vy1);

    if (width < 1 || height < 1) continue;

    const linkDiv = document.createElement('div');
    linkDiv.className = 'annotationLink';
    linkDiv.style.left   = left   + 'px';
    linkDiv.style.top    = top    + 'px';
    linkDiv.style.width  = width  + 'px';
    linkDiv.style.height = height + 'px';

    if (ann.url) {
      linkDiv.title = ann.url;
      linkDiv.addEventListener('click', () => {
        window.open(ann.url, ann.newWindow ? '_blank' : '_self');
      });
    } else if (ann.dest != null) {
      linkDiv.addEventListener('click', () => navigateToDest(ann.dest));
    } else if (ann.action) {
      const action = ann.action;
      if (action.type === 'Named') {
        // Named actions like NextPage, PrevPage, etc.
        linkDiv.addEventListener('click', () => handleNamedAction(action.action));
      } else if (action.type === 'GoTo' && action.dest) {
        linkDiv.addEventListener('click', () => navigateToDest(action.dest));
      } else if (action.type === 'GoToR' && action.url) {
        linkDiv.title = action.url;
        linkDiv.addEventListener('click', () => window.open(action.url, '_blank'));
      } else if (action.type === 'URI' && action.url) {
        linkDiv.title = action.url;
        linkDiv.addEventListener('click', () => window.open(action.url, '_blank'));
      }
    }

    annotDiv.appendChild(linkDiv);
  }

  annotDiv.style.pointerEvents = '';
}

function handleNamedAction(name) {
  if (!currentPdfDoc) return;
  const n = currentPdfDoc.numPages;
  // Find the currently visible page (topmost in viewport).
  let visiblePage = 1;
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const rect = slot.pageDiv.getBoundingClientRect();
    if (rect.top <= window.innerHeight / 2 && rect.bottom >= 0) {
      visiblePage = i;
      break;
    }
  }
  switch (name) {
    case 'NextPage':   scrollToPage(Math.min(visiblePage + 1, n)); break;
    case 'PrevPage':   scrollToPage(Math.max(visiblePage - 1, 1)); break;
    case 'FirstPage':  scrollToPage(1); break;
    case 'LastPage':   scrollToPage(n); break;
  }
}

// Applies a 6-element transform matrix [a,b,c,d,e,f] to a point [x,y].
function applyTransform([x, y], [a, b, c, d, e, f]) {
  return [a * x + c * y + e, b * x + d * y + f];
}

// ── Outline / TOC sidebar ──────────────────────────────────────────────────

async function buildOutline(pdfDoc) {
  if (!outlinePanel || !outlineList) return;

  outlinePanel.classList.add('hidden');
  outlineList.innerHTML = '';

  let outline;
  try {
    outline = await pdfDoc.getOutline();
  } catch (_) {
    return;
  }

  if (!outline || outline.length === 0) return;

  function buildItems(items, ul) {
    for (const item of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'outline-item';
      btn.textContent = item.title || '(untitled)';
      btn.addEventListener('click', () => {
        if (item.dest != null) navigateToDest(item.dest);
        else if (item.url)     window.open(item.url, '_blank');
      });
      li.appendChild(btn);

      if (item.items && item.items.length > 0) {
        const subUl = document.createElement('ul');
        buildItems(item.items, subUl);
        li.appendChild(subUl);
      }

      ul.appendChild(li);
    }
  }

  buildItems(outline, outlineList);
  outlinePanel.classList.remove('hidden');
}

async function renderPageIntoSlot(page, slot, zoom, generation) {
  const outputScale = window.devicePixelRatio || 1;
  const viewport    = page.getViewport({ scale: zoom });

  // Integer CSS pixel dimensions — prevents sub-pixel mismatch between the
  // pageDiv, canvas, and the text layer (which applies CSS round() internally).
  const cssW   = Math.round(viewport.width);
  const cssH   = Math.round(viewport.height);
  const pixelW = Math.round(viewport.width  * outputScale);
  const pixelH = Math.round(viewport.height * outputScale);

  // Keep page div correctly sized (may differ from placeholder if page sizes vary).
  slot.pageDiv.style.width  = cssW + 'px';
  slot.pageDiv.style.height = cssH + 'px';

  // Reuse the existing canvas element across zoom changes to avoid DOM churn.
  let { canvas } = slot;
  if (!canvas) {
    canvas = document.createElement('canvas');
    slot.canvas = canvas;
    if (DEBUG_RENDER) canvas.style.outline = '1px solid green';
    // Insert before the text layer so the layer sits on top.
    slot.pageDiv.insertBefore(canvas, slot.textLayerDiv);
  }

  // Resizing canvas clears its bitmap (spec behaviour) – no explicit clear needed.
  canvas.width        = pixelW;
  canvas.height       = pixelH;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');

  // Fill white so the placeholder background doesn't bleed through on resize.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pixelW, pixelH);

  // The transform scales the 2D context by outputScale so PDF.js paints at
  // full device resolution while the viewport stays in CSS-pixel coordinates.
  const renderParams = { canvasContext: ctx, viewport };
  if (outputScale !== 1) {
    renderParams.transform = [outputScale, 0, 0, outputScale, 0, 0];
  }

  const renderTask      = page.render(renderParams);
  slot.activeRenderTask = renderTask;
  try {
    await renderTask.promise;
  } finally {
    // Clear the reference whether or not the task succeeded.
    if (slot.activeRenderTask === renderTask) slot.activeRenderTask = null;
  }

  if (generation !== currentGeneration) return;

  // ── Geometry word index ────────────────────────────────────────────────────
  // Reset stale state from a previous render.
  slot.textContentItems = [];
  slot.wordBoxes = [];
  slot.textGeometryGeneration = -1;
  slot.textGeometryZoom = null;
  if (slot.geometryHighlight) {
    slot.geometryHighlight.remove();
    slot.geometryHighlight = null;
  }
  if (slot.geometryDebugLayer) {
    slot.geometryDebugLayer.remove();
    slot.geometryDebugLayer = null;
  }

  try {
    const textContent = await page.getTextContent();
    if (generation !== currentGeneration) return;

    slot.textContentItems = textContent.items || [];
    slot.wordBoxes = buildTextGeometryIndex(textContent, viewport, slot.pageNum);
    slot.textGeometryGeneration = generation;
    slot.textGeometryZoom = zoom;
    drawGeometryDebug(slot);
  } catch (err) {
    if (!isCancelError(err)) {
      console.warn(`getTextContent error on page ${slot.pageNum}:`, err);
    }
  }

  // ── Annotation link overlay ────────────────────────────────────────────────
  try {
    await renderAnnotationLayer(page, slot, viewport, generation);
  } catch (err) {
    if (!isCancelError(err)) {
      console.warn(`Annotation layer error on page ${slot.pageNum}:`, err);
    }
  }

  page.cleanup();
}

// ── scheduleVisiblePages ───────────────────────────────────────────────────
// Manually checks which page divs are near the viewport and schedules renders.
// Needed after zoom changes because IntersectionObserver does not always re-fire
// for entries that were *already* intersecting before the layout changed.

function scheduleVisiblePages() {
  const margin = Math.max(window.innerHeight, 600);

  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const rect = slot.pageDiv.getBoundingClientRect();
    if (rect.bottom >= -margin && rect.top <= window.innerHeight + margin) {
      scheduleRender(i);
    }
  }
}

// ── PDF load orchestrator ──────────────────────────────────────────────────

async function loadPDF(source) {
  clearError();
  clearViewer();
  setLoading(true);

  const generation = ++currentGeneration;

  const loadingTask = pdfjsLib.getDocument({
    ...source,
    // CMap files resolve character encoding for Type1/CIDFont PDFs.
    // Without them, PDF.js assigns wrong advance widths and characters
    // render at incorrect positions — the primary cause of vertical-letter
    // stacking on bullet lists and other encoded text.
    cMapUrl:             CMAP_URL,
    cMapPacked:          true,
    // Standard font data provides correct metrics for the 14 standard Type1
    // fonts (Helvetica, Times, Courier, Symbol, ZapfDingbats) that conforming
    // PDFs are allowed to omit.  useSystemFonts must be false when this is set.
    standardFontDataUrl: STANDARD_FONT_URL,
    useSystemFonts:      false,
    disableFontFace:     false,
    enableXfa:           true,
    stopAtErrors:        false,
  });
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
  currentPdfDoc = pdfDoc;

  // buildLayout shows the loading bar until placeholder divs are ready,
  // then hides it and fires the observer.
  await buildLayout(pdfDoc, generation);
  if (generation === currentGeneration) {
    buildOutline(pdfDoc);
  }
}

function clearViewer() {
  teardownObserver();
  clearCustomSelection();

  // Cancel every in-flight render before destroying the document.
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]) cancelSlotRender(slots[i]);
  }
  slots.length = 0;

  if (currentLoadingTask) {
    currentLoadingTask.destroy().catch(() => {});
    currentLoadingTask = null;
  }
  currentPdfDoc = null;
  pdfContainer.innerHTML = '';

  // Hide outline panel when document is unloaded.
  if (outlinePanel) {
    outlinePanel.classList.add('hidden');
    if (outlineList) outlineList.innerHTML = '';
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
  e.target.value = '';
  if (!file) return;

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showError('Please select a PDF file (.pdf).');
    return;
  }

  const reader   = new FileReader();
  reader.onerror = () => showError('Could not read the file. It may be inaccessible or corrupted.');
  reader.onload  = (ev) => loadPDF({ data: new Uint8Array(ev.target.result) });
  reader.readAsArrayBuffer(file);
});

// ── URL input ──────────────────────────────────────────────────────────────

function loadFromURL() {
  const raw = urlInput.value.trim();

  if (!raw) { showError('Please enter a PDF URL.'); return; }

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
// On zoom change:
//   1. Bump the generation so in-flight renders know they are stale.
//   2. Cancel every active render task.
//   3. Reset all slot states and resize their divs using cached natural sizes
//      (no page re-fetch needed).
//   4. Re-create the observer with the new generation so stale observer
//      callbacks are ignored.
//   5. Manually schedule visible pages, because the observer will not re-fire
//      for elements that were already intersecting before the resize.

zoomSelect.addEventListener('change', () => {
  currentZoom = parseFloat(zoomSelect.value);
  if (!currentPdfDoc) return;

  const generation = ++currentGeneration;

  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;

    cancelSlotRender(slot);

    slot.state           = 'idle';
    slot.activeGeneration = -1;
    slot.renderedZoom    = null;
    slot.textContentItems = [];
    slot.wordBoxes = [];
    slot.textGeometryGeneration = -1;
    slot.textGeometryZoom = null;
    if (slot.geometryHighlight) {
      slot.geometryHighlight.remove();
      slot.geometryHighlight = null;
    }
    if (slot.geometryDebugLayer) {
      slot.geometryDebugLayer.remove();
      slot.geometryDebugLayer = null;
    }

    // Instant resize from cached natural dimensions — no async work needed.
    // Round to integer CSS pixels to stay consistent with renderPageIntoSlot.
    slot.pageDiv.style.width  = Math.round(slot.naturalW * currentZoom) + 'px';
    slot.pageDiv.style.height = Math.round(slot.naturalH * currentZoom) + 'px';

    // Remove the stale canvas so the grey placeholder background shows while
    // the page is re-rendering. canvas.remove() is O(1) and non-blocking.
    if (slot.canvas) {
      slot.canvas.remove();
      slot.canvas = null;
    }

    // Clear stale annotation overlays — they will be rebuilt at the new zoom.
    slot.annotationLayerDiv.innerHTML = '';
  }

  // Reconnect with the new generation so old observer callbacks are no-ops.
  setupObserver(generation);

  // Kick off renders for everything currently on or near the screen.
  scheduleVisiblePages();
});
