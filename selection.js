'use strict';

// ── Translation interaction layer ──────────────────────────────────────────
// Manages the Translate button and inline popup.
// Self-contained: reads only from the DOM and window.getSelection().
// Does not call any external translation API in this phase.

(function initSelectionLayer() {

  // ── Create UI elements ─────────────────────────────────────────────────────
  // Both elements live directly on <body> so they are never affected by
  // pdfContainer clearing (zoom changes, new file loads, etc.).

  const txBtn = document.createElement('button');
  txBtn.id        = 'tx-btn';
  txBtn.className = 'tx-hidden';
  txBtn.setAttribute('aria-label', 'Translate selected text');
  txBtn.textContent = 'Translate';
  document.body.appendChild(txBtn);

  const txPopup = document.createElement('div');
  txPopup.id        = 'tx-popup';
  txPopup.className = 'tx-hidden';
  txPopup.setAttribute('role', 'dialog');
  txPopup.setAttribute('aria-modal', 'false');
  txPopup.setAttribute('aria-label', 'Translation');
  txPopup.innerHTML =
    '<div class="tx-head">' +
      '<span class="tx-source-text"></span>' +
      '<button class="tx-close-btn" aria-label="Close">×</button>' +
    '</div>' +
    '<div class="tx-body">' +
      '<p class="tx-result-text">Translation will appear here.</p>' +
    '</div>';
  document.body.appendChild(txPopup);

  const txSourceText = txPopup.querySelector('.tx-source-text');
  const txCloseBtn   = txPopup.querySelector('.tx-close-btn');

  // ── State ──────────────────────────────────────────────────────────────────

  // Captured at mouseup time so the translate button click can use it even if
  // the browser clears the selection when focus moves to the button.
  let pending = null; // { text: string, rect: DOMRect } | null

  // ── Visibility helpers ─────────────────────────────────────────────────────

  function hideTxBtn()  { txBtn.classList.add('tx-hidden');   }
  function hidePopup()  { txPopup.classList.add('tx-hidden'); }

  function hideAll() {
    hideTxBtn();
    hidePopup();
    pending = null;
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  const GAP  = 8;   // px between the reference rect and the placed element
  const EDGE = 10;  // minimum px gap from any viewport edge

  // Place el (position:fixed) centred horizontally just below refRect,
  // flipping above if it would overflow the bottom, and clamping to all edges.
  // We measure el off-screen first; because both the remove-hidden and the
  // final top/left writes happen in the same synchronous call the browser
  // batches them into one repaint — the user never sees the element at -9999px.
  function place(el, refRect) {
    el.style.top  = '-9999px';
    el.style.left = '-9999px';
    el.classList.remove('tx-hidden'); // make it layout-visible for measurement

    const w  = el.offsetWidth;
    const h  = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: centred under the selection, clamped to viewport
    let left = refRect.left + refRect.width / 2 - w / 2;

    // Vertical: prefer below
    let top = refRect.bottom + GAP;

    // Flip above if overflowing bottom
    if (top + h > vh - EDGE) {
      const topAbove = refRect.top - GAP - h;
      top = topAbove >= EDGE ? topAbove : Math.max(EDGE, vh - h - EDGE);
    }

    // Clamp all edges
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    top  = Math.max(EDGE, top);

    el.style.top  = Math.round(top)  + 'px';
    el.style.left = Math.round(left) + 'px';
  }

  // ── Selection helper ───────────────────────────────────────────────────────

  // Returns { text, rect } when the browser selection is non-empty and
  // originates inside a .textLayer element; null otherwise.
  function getLayerSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    const range  = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const node   = anchor.nodeType === Node.TEXT_NODE
      ? anchor.parentElement
      : /** @type {Element} */ (anchor);

    if (!node || !node.closest('.textLayer')) return null;

    const rect = range.getBoundingClientRect();
    // Degenerate rects happen with out-of-view or collapsed ranges.
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    return { text, rect };
  }

  // ── Pointer-down: dismiss stale UI before any new gesture ─────────────────

  document.addEventListener('pointerdown', (e) => {
    // Preserve our own UI so the translate button can be clicked.
    if (e.target.closest('#tx-btn') || e.target.closest('#tx-popup')) return;
    hideAll();
  });

  // ── Mouse-up: show translate button after a drag-selection ────────────────
  // Selection is finalised by mouseup time (unlike dblclick where the word
  // selection is committed after the event), so no setTimeout is needed here.

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#tx-btn') || e.target.closest('#tx-popup')) return;

    const result = getLayerSelection();
    if (!result) return;

    pending = result;
    place(txBtn, result.rect);
  });

  // ── Translate button click → open popup ───────────────────────────────────

  txBtn.addEventListener('click', () => {
    if (!pending) { hideTxBtn(); return; }

    const { text, rect } = pending;
    pending = null;
    hideTxBtn();
    openPopup(text, rect);
  });

  // ── Close button ───────────────────────────────────────────────────────────

  txCloseBtn.addEventListener('click', () => hideAll());

  // ── Escape key ────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideAll();
  });

  // ── Popup display ──────────────────────────────────────────────────────────

  const MAX_PREVIEW = 120; // characters shown in the popup header

  function openPopup(text, rect) {
    const preview = text.length > MAX_PREVIEW
      ? text.slice(0, MAX_PREVIEW).trimEnd() + '…'
      : text;

    txSourceText.textContent = preview;

    // Ensure popup is hidden before placement so the old position doesn't
    // flash while we're measuring.
    hidePopup();
    place(txPopup, rect);
  }

  // ── Double-click: select word and show popup directly ─────────────────────
  // The browser commits the word-selection AFTER dblclick fires, so we use
  // setTimeout(0) to read the finalised selection on the next event loop tick.

  document.addEventListener('dblclick', (e) => {
    const span = e.target.closest('.textLayer span');
    if (!span) return;

    // Prevent the mouseup handler (fires before dblclick) from showing the
    // translate button for whatever partial selection exists at that moment —
    // the dblclick handler will take over on the next tick.
    // We clear pending here; if mouseup showed a button it will be gone.
    hideTxBtn();
    pending = null;

    setTimeout(() => {
      let text = null;
      let rect = null;

      // Primary: use the browser's word selection
      const result = getLayerSelection();
      if (result) {
        text = result.text;
        rect = result.rect;
      }

      // Fallback: use the clicked span's full text content.
      // This covers cases where the browser didn't select a word (e.g.
      // single-character spans, punctuation spans, or transformed text
      // where dblclick word-selection doesn't fire correctly).
      if (!text) {
        const spanText = span.textContent.trim();
        if (spanText) {
          text = spanText;
          rect = span.getBoundingClientRect();
        }
      }

      if (!text || !rect) return;

      // No translate button for double-click — open the popup directly.
      openPopup(text, rect);
    }, 0);
  });

}());
