'use strict';

// ── Translation interaction layer ──────────────────────────────────────────
// Manages the Translate button and inline popup.
// Calls window.Translator (translator.js) for API access.

(function initSelectionLayer() {

  // ── Create UI elements ─────────────────────────────────────────────────────
  // Both elements live on <body> so they are never affected by pdfContainer
  // clearing (zoom changes, new file loads).

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
    '<div class="tx-body"></div>';
  document.body.appendChild(txPopup);

  const txSourceText = txPopup.querySelector('.tx-source-text');
  const txCloseBtn   = txPopup.querySelector('.tx-close-btn');
  const txBody       = txPopup.querySelector('.tx-body');

  // ── State ──────────────────────────────────────────────────────────────────

  // Captured at mouseup time so the translate button click can use it even if
  // the browser clears the selection when focus moves to the button.
  let pending = null; // { text: string, rect: DOMRect } | null

  // Rect stored when a popup opens; used for re-placement after content loads.
  let openRect = null;

  // Incremented each time openPopup is called. Each call captures myGen and
  // checks it after every await — if it no longer matches, the popup has been
  // superseded by a newer selection and the stale result is silently discarded.
  let popupGeneration = 0;

  // ── Visibility helpers ─────────────────────────────────────────────────────

  function hideTxBtn() { txBtn.classList.add('tx-hidden');   }
  function hidePopup() { txPopup.classList.add('tx-hidden'); }

  function hideAll() {
    hideTxBtn();
    hidePopup();
    pending = null;
    openRect = null;
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  const GAP  = 8;   // px between the reference rect and the placed element
  const EDGE = 10;  // minimum px gap from any viewport edge

  function computePos(w, h, refRect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = refRect.left + refRect.width / 2 - w / 2;
    let top  = refRect.bottom + GAP;

    if (top + h > vh - EDGE) {
      const topAbove = refRect.top - GAP - h;
      top = topAbove >= EDGE ? topAbove : Math.max(EDGE, vh - h - EDGE);
    }

    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    top  = Math.max(EDGE, top);

    return { top: Math.round(top), left: Math.round(left) };
  }

  // Off-screen measurement + single-repaint placement (initial show).
  function place(el, refRect) {
    el.style.top  = '-9999px';
    el.style.left = '-9999px';
    el.classList.remove('tx-hidden');
    const { top, left } = computePos(el.offsetWidth, el.offsetHeight, refRect);
    el.style.top  = top  + 'px';
    el.style.left = left + 'px';
  }

  // Re-position an already-visible element without the off-screen flash.
  function rePlace(el, refRect) {
    const { top, left } = computePos(el.offsetWidth, el.offsetHeight, refRect);
    el.style.top  = top  + 'px';
    el.style.left = left + 'px';
  }

  // ── Popup body helpers ─────────────────────────────────────────────────────

  function googleTranslateUrl(text, settings) {
    const sl = (settings.sourceLang && settings.sourceLang !== 'auto')
      ? settings.sourceLang : 'auto';
    const tl = settings.targetLang || 'vi';
    return (
      'https://translate.google.com/?sl=' + encodeURIComponent(sl) +
      '&tl='   + encodeURIComponent(tl) +
      '&text=' + encodeURIComponent(text.slice(0, 5000)) +
      '&op=translate'
    );
  }

  function makeFallbackBtn(sourceText, settings) {
    const btn = document.createElement('button');
    btn.className   = 'tx-action-btn tx-fallback-btn';
    btn.textContent = 'Open in Google Translate ↗';
    btn.addEventListener('click', () => {
      window.open(googleTranslateUrl(sourceText, settings), '_blank');
    });
    return btn;
  }

  function setBodyLoading() {
    txBody.innerHTML =
      '<div class="tx-loading">' +
        '<div class="tx-spinner"></div>' +
        '<span>Translating…</span>' +
      '</div>';
  }

  function setBodyResult(translated, sourceText, settings) {
    txBody.innerHTML = '';

    const p = document.createElement('p');
    p.className   = 'tx-result-text';
    p.textContent = translated;
    txBody.appendChild(p);

    const actions = document.createElement('div');
    actions.className = 'tx-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className   = 'tx-action-btn tx-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(translated).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Copy'; }, 1500);
      }).catch(() => {});
    });

    actions.appendChild(copyBtn);
    actions.appendChild(makeFallbackBtn(sourceText, settings));
    txBody.appendChild(actions);
  }

  function setBodyError(errorType, errorMsg, sourceText, settings) {
    txBody.innerHTML = '';

    if (errorType === 'no-key') {
      const msg = document.createElement('p');
      msg.className   = 'tx-error-text';
      msg.textContent = 'No Gemini API key configured. Add your Gemini API key in Settings.';
      txBody.appendChild(msg);

      const openSettingsBtn = document.createElement('button');
      openSettingsBtn.className   = 'tx-action-btn tx-open-settings-btn';
      openSettingsBtn.textContent = '⚙ Open Settings';
      openSettingsBtn.addEventListener('click', () => {
        hideAll();
        const settingsPanel  = document.getElementById('settings-panel');
        const settingsToggle = document.getElementById('settings-toggle');
        if (settingsToggle && settingsPanel && !settingsPanel.classList.contains('settings-open')) {
          settingsToggle.click();
        }
      });
      txBody.appendChild(openSettingsBtn);
    } else {
      const msg = document.createElement('p');
      msg.className   = 'tx-error-text';
      msg.textContent = errorMsg;
      txBody.appendChild(msg);
    }

    txBody.appendChild(makeFallbackBtn(sourceText, settings));
  }

  // ── Selection helper ───────────────────────────────────────────────────────

  // Returns { text, rect } when the selection is non-empty and inside a
  // .textLayer element; null otherwise.
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
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    return { text, rect };
  }

  // ── Pointer-down: dismiss stale UI before any new gesture ─────────────────

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#tx-btn') || e.target.closest('#tx-popup')) return;
    hideAll();
  });

  // ── Mouse-up: show translate button after a drag-selection ────────────────
  // Selection is finalised by mouseup time, so no setTimeout is needed.

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#tx-btn') || e.target.closest('#tx-popup')) return;

    const result = getLayerSelection();
    if (!result) return;

    pending = result;
    place(txBtn, result.rect);
  });

  // ── Translate button click → open popup and translate ─────────────────────

  txBtn.addEventListener('click', () => {
    if (!pending) { hideTxBtn(); return; }

    const { text, rect } = pending;
    pending = null;
    hideTxBtn();
    openPopup(text, rect);
  });

  // ── Close button ──────────────────────────────────────────────────────────

  txCloseBtn.addEventListener('click', () => hideAll());

  // ── Escape key ────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideAll();
  });

  // ── Popup display and translation ─────────────────────────────────────────

  const MAX_PREVIEW = 120;

  async function openPopup(text, rect) {
    const myGen = ++popupGeneration; // capture before any await
    openRect = rect;

    const preview = text.length > MAX_PREVIEW
      ? text.slice(0, MAX_PREVIEW).trimEnd() + '…'
      : text;
    txSourceText.textContent = preview;

    // Fast pre-check for length: avoid loading state for a purely local error.
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length > window.Translator.MAX_CHARS) {
      txBody.innerHTML = '';
      const msg = document.createElement('p');
      msg.className   = 'tx-error-text';
      msg.textContent =
        `Selection is too long (${normalized.length} / ` +
        `${window.Translator.MAX_CHARS} chars). Shorten your selection to translate inline.`;
      txBody.appendChild(msg);
      const settings = await window.Translator.loadSettings();
      if (myGen !== popupGeneration) return; // superseded while awaiting settings
      txBody.appendChild(makeFallbackBtn(text, settings));
      hidePopup();
      place(txPopup, rect);
      return;
    }

    // Show loading state immediately, then fire the API call.
    // translate() checks L1 → L2 → API and deduplicates concurrent requests.
    setBodyLoading();
    hidePopup();
    place(txPopup, rect);

    const result = await window.Translator.translate(text);

    // Discard stale result: a newer selection opened while we were waiting.
    if (myGen !== popupGeneration) return;
    // Also discard if user manually dismissed the popup.
    if (txPopup.classList.contains('tx-hidden')) return;

    if (result.ok) {
      setBodyResult(result.translated, text, result.settings);
    } else {
      setBodyError(result.errorType, result.errorMsg, text, result.settings);
    }

    // Re-position now that the popup height has changed with the new content.
    if (openRect && !txPopup.classList.contains('tx-hidden')) {
      rePlace(txPopup, openRect);
    }
  }

  // ── Double-click: select word and show popup directly ─────────────────────
  // The browser commits word-selection AFTER dblclick fires, so setTimeout(0)
  // reads the finalised selection on the next event loop tick.

  document.addEventListener('dblclick', (e) => {
    const span = e.target.closest('.textLayer span');
    if (!span) return;

    // Cancel any translate button the mouseup handler may have shown for the
    // partial selection from the second mouseup before dblclick fired.
    hideTxBtn();
    pending = null;

    setTimeout(() => {
      let text = null;
      let rect = null;

      const result = getLayerSelection();
      if (result) {
        text = result.text;
        rect = result.rect;
      }

      // Fallback: use the clicked span's text when the browser didn't produce
      // a word selection (single-char spans, punctuation, transformed text).
      if (!text) {
        const spanText = span.textContent.trim();
        if (spanText) {
          text = spanText;
          rect = span.getBoundingClientRect();
        }
      }

      if (!text || !rect) return;

      openPopup(text, rect);
    }, 0);
  });

}());
