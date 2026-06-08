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
    window.PdfViewerState?.clearCustomSelection?.();
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

  function setBodyLoading() {
    txBody.innerHTML =
      '<div class="tx-loading">' +
        '<div class="tx-spinner"></div>' +
        '<span>Translating…</span>' +
      '</div>';
  }

  function firstPronunciation(entry) {
    return (entry?.pronunciations || []).find(p => p?.ipa || p?.audio) || null;
  }

  function appendTextList(parent, label, values) {
    const clean = (values || []).filter(Boolean);
    if (!clean.length) return;
    const p = document.createElement('p');
    p.className = 'tx-lex-row';
    p.textContent = `${label}: ${clean.join(', ')}`;
    parent.appendChild(p);
  }

  function makeLexicalExpanded(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'tx-lex-expanded tx-hidden';

    for (const sense of entry?.senses || []) {
      const block = document.createElement('div');
      block.className = 'tx-lex-sense';

      const heading = document.createElement('div');
      heading.className = 'tx-lex-sense-heading';
      heading.textContent = [
        sense.pos,
        ...(sense.viMeanings || []).slice(0, 3),
      ].filter(Boolean).join(' · ');
      block.appendChild(heading);

      if (sense.enDefinition) {
        const def = document.createElement('p');
        def.className = 'tx-lex-definition';
        def.textContent = sense.enDefinition;
        block.appendChild(def);
      }

      for (const ex of (sense.examples || []).slice(0, 2)) {
        const p = document.createElement('p');
        p.className = 'tx-lex-example';
        p.textContent = ex.vi ? `${ex.en} / ${ex.vi}` : ex.en;
        block.appendChild(p);
      }

      appendTextList(block, 'Synonyms', sense.synonyms);
      appendTextList(block, 'Antonyms', sense.antonyms);
      appendTextList(block, 'Collocations', sense.collocations);
      wrap.appendChild(block);
    }

    return wrap;
  }

  function setBodyResult(result, sourceText) {
    txBody.innerHTML = '';
    const translated = result.translated;

    if (result.entry) {
      const entry = result.entry;
      const card = document.createElement('div');
      card.className = 'tx-lex-card';

      const title = document.createElement('div');
      title.className = 'tx-lex-title';
      title.textContent = entry.lemma || sourceText;
      card.appendChild(title);

      const pronunciation = firstPronunciation(entry);
      if (pronunciation?.ipa) {
        const ipa = document.createElement('div');
        ipa.className = 'tx-lex-ipa';
        ipa.textContent = pronunciation.ipa;
        card.appendChild(ipa);
      }

      if (entry.pos?.length) {
        const posWrap = document.createElement('div');
        posWrap.className = 'tx-lex-pos';
        for (const pos of entry.pos.slice(0, 4)) {
          const badge = document.createElement('span');
          badge.className = 'tx-lex-pos-badge';
          badge.textContent = pos;
          posWrap.appendChild(badge);
        }
        card.appendChild(posWrap);
      }

      const meaning = document.createElement('p');
      meaning.className = 'tx-result-text tx-lex-meaning';
      meaning.textContent = translated;
      card.appendChild(meaning);

      const expanded = makeLexicalExpanded(entry);
      if (expanded.childElementCount) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'tx-action-btn tx-lex-more-btn';
        moreBtn.textContent = 'More';
        moreBtn.addEventListener('click', () => {
          const hidden = expanded.classList.toggle('tx-hidden');
          moreBtn.textContent = hidden ? 'More' : 'Less';
          if (openRect && !txPopup.classList.contains('tx-hidden')) rePlace(txPopup, openRect);
        });
        card.appendChild(moreBtn);
        card.appendChild(expanded);
      }

      txBody.appendChild(card);
    } else {
      const p = document.createElement('p');
      p.className   = 'tx-result-text';
      p.textContent = translated;
      txBody.appendChild(p);
    }

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
    txBody.appendChild(actions);
  }

  function setBodyStreaming(translated) {
    let p = txBody.querySelector('.tx-result-text');
    if (!p) {
      txBody.innerHTML = '';
      p = document.createElement('p');
      p.className = 'tx-result-text tx-result-streaming';
      txBody.appendChild(p);
    }
    p.textContent = translated;
  }

  function setBodyError(errorType, errorMsg) {
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
        `Selection is too long (${normalized.length} / ` +
        `${window.Translator.MAX_CHARS} chars). Shorten your selection to translate inline.`;
      txBody.appendChild(msg);
      if (myGen !== popupGeneration) return;
      hidePopup();
      place(txPopup, rect);
      return;
    }

    // Show loading state immediately, then fire the API call.
    // translate() checks L1 → L2 → API and deduplicates concurrent requests.
    setBodyLoading();
    hidePopup();
    place(txPopup, rect);

    const result = await window.Translator.translate(text, {
      mode: 'interactive',
      preferStreaming: !/^[\p{L}\p{N}_]+(?:['\u2019\u2018\-\u2010\u2011][\p{L}\p{N}_]+)*$/u.test(normalized),
      onPartial: (partial) => {
        if (myGen !== popupGeneration) return;
        if (txPopup.classList.contains('tx-hidden')) return;
        setBodyStreaming(partial);
        if (openRect && !txPopup.classList.contains('tx-hidden')) {
          rePlace(txPopup, openRect);
        }
      },
    });

    // Discard stale result: a newer selection opened while we were waiting.
    if (myGen !== popupGeneration) return;
    // Also discard if user manually dismissed the popup.
    if (txPopup.classList.contains('tx-hidden')) return;

    if (result.ok) {
      setBodyResult(result, text);
    } else {
      setBodyError(result.errorType, result.errorMsg);
    }

    // Re-position now that the popup height has changed with the new content.
    if (openRect && !txPopup.classList.contains('tx-hidden')) {
      rePlace(txPopup, openRect);
    }
  }

  // ── Word-detection helpers (used by double-click) ─────────────────────────

  function isBaseWordChar(ch) {
    // Unicode letters, digits, and underscore
    return /[\p{L}\p{N}_]/u.test(ch);
  }

  function isJoinerChar(ch) {
    // Straight apostrophe, right/left single quote, hyphen-minus,
    // non-breaking hyphen, figure dash — joiners inside words
    return ch === "'" || ch === '’' || ch === '‘' ||
           ch === '-' || ch === '‐' || ch === '‑';
  }

  // A joiner at str[idx] is part of a word only when flanked by word chars
  // (e.g. "don't", "well-known") — prevents leading/trailing hyphens.
  function shouldIncludeJoiner(str, idx) {
    return idx > 0 && idx < str.length - 1 &&
           isBaseWordChar(str[idx - 1]) && isBaseWordChar(str[idx + 1]);
  }

  // Expand from str[idx] to word boundaries; returns [start, end) offsets.
  function expandWordInString(str, idx) {
    if (!str || str.length === 0) return { start: 0, end: 0 };
    const safeIdx = Math.max(0, Math.min(idx, str.length - 1));

    let start = safeIdx;
    let end   = safeIdx;

    while (start > 0) {
      const c = str[start - 1];
      if (isBaseWordChar(c) || (isJoinerChar(c) && shouldIncludeJoiner(str, start - 1))) {
        start--;
      } else break;
    }

    while (end < str.length) {
      const c = str[end];
      if (isBaseWordChar(c) || (isJoinerChar(c) && shouldIncludeJoiner(str, end))) {
        end++;
      } else break;
    }

    // Strip any leading/trailing joiners that slipped through
    while (start < end && isJoinerChar(str[start]))   start++;
    while (end > start && isJoinerChar(str[end - 1])) end--;

    return { start, end };
  }

  // Cross-browser caret range at a viewport point
  function getCaretRangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }

  // Apply a Range as the current window selection (for visual highlight)
  function selectRange(range) {
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Strategy A — native browser double-click selection ────────────────────
  // The browser selects a token after dblclick; accept it only when it looks
  // like a clean single word (no embedded whitespace, short enough).

  function getNativeDoubleClickSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const range  = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const node   = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    if (!node || !node.closest('.textLayer')) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { text, rect };
  }

  function isGoodDoubleClickSelection(text, rect) {
    if (!text || text.length > 80) return false;
    if (/\s/.test(text)) return false; // multi-word or contains spaces → skip
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    return true;
  }

  // ── Strategy B — caret position → word expansion within one text node ─────
  // Returns { text, rect, atBoundary } or null.
  // atBoundary=true means the word may continue into a neighbouring span.

  function getWordFromPoint(clientX, clientY) {
    const caretRange = getCaretRangeFromPoint(clientX, clientY);
    if (!caretRange) return null;

    const node = caretRange.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    if (!node.parentElement || !node.parentElement.closest('.textLayer')) return null;

    const str    = node.textContent;
    const offset = caretRange.startOffset;
    const { start, end } = expandWordInString(str, offset);
    if (start >= end) return null;

    const wordText = str.slice(start, end).trim();
    if (!wordText) return null;

    try {
      const wordRange = document.createRange();
      wordRange.setStart(node, start);
      wordRange.setEnd(node, end);
      selectRange(wordRange);
      const rect = wordRange.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      // Word touches a span edge → likely truncated by PDF.js span split
      const atBoundary = (start === 0 || end === str.length);
      return { text: wordText, rect, atBoundary };
    } catch (_) { return null; }
  }

  // ── Strategy C — same-line multi-span reconstruction ─────────────────────
  // PDF.js sometimes splits a single word across adjacent spans (kerning,
  // font changes). This strategy collects all spans on the same visual line,
  // builds a character map with approximate x-centres, finds the character
  // nearest to the click, expands to word boundaries across span borders,
  // then reconstructs a DOM Range spanning however many spans are needed.

  function getWordFromSpanLine(clickedSpan, clientX) {
    const textLayer = clickedSpan.closest('.textLayer');
    if (!textLayer) return null;

    const cr = clickedSpan.getBoundingClientRect();
    if (!cr || cr.height === 0) return null;

    // Gather spans whose vertical midpoint overlaps this line (±35 % of height)
    const tol = cr.height * 0.35;
    const lineSpans = Array.from(textLayer.querySelectorAll('span')).filter(s => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
             r.top  < cr.bottom - tol &&
             r.bottom > cr.top   + tol;
    });

    // Sort left-to-right
    lineSpans.sort((a, b) =>
      a.getBoundingClientRect().left - b.getBoundingClientRect().left
    );

    // Build per-character position map (uniform-width approximation per span)
    const charMap = [];
    for (const s of lineSpans) {
      const txt = s.textContent;
      if (!txt.length) continue;
      const r  = s.getBoundingClientRect();
      const cw = r.width / txt.length;
      for (let i = 0; i < txt.length; i++) {
        charMap.push({ span: s, offset: i, ch: txt[i], xMid: r.left + (i + 0.5) * cw });
      }
    }
    if (!charMap.length) return null;

    // Find the character whose centre is closest to the click x
    let nearestIdx = 0;
    let minDist    = Infinity;
    for (let i = 0; i < charMap.length; i++) {
      const d = Math.abs(charMap[i].xMid - clientX);
      if (d < minDist) { minDist = d; nearestIdx = i; }
    }

    const fullStr = charMap.map(c => c.ch).join('');
    const { start, end } = expandWordInString(fullStr, nearestIdx);
    if (start >= end) return null;

    const wordText = fullStr.slice(start, end).trim();
    if (!wordText) return null;

    const s0 = charMap[start];
    const s1 = charMap[end - 1];
    try {
      const tn0 = s0.span.firstChild;
      const tn1 = s1.span.firstChild;
      if (!tn0 || !tn1 ||
          tn0.nodeType !== Node.TEXT_NODE ||
          tn1.nodeType !== Node.TEXT_NODE) return null;

      const wordRange = document.createRange();
      wordRange.setStart(tn0, s0.offset);
      wordRange.setEnd(tn1, s1.offset + 1);
      selectRange(wordRange);

      const rect = wordRange.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      return { text: wordText, rect };
    } catch (_) { return null; }
  }

  // ── Double-click: select word and show popup directly ─────────────────────
  // Strategy A → B → C waterfall; each strategy falls through if it cannot
  // produce a clean result. The browser commits the word selection AFTER
  // dblclick fires, so setTimeout(0) reads the finalised state.

  document.addEventListener('dblclick', (e) => {
    // Cancel any translate button that mouseup may have shown for the partial
    // selection produced by the second mouseup before dblclick fired.
    hideTxBtn();
    pending = null;

    const clientX = e.clientX;
    const clientY = e.clientY;
    const hasGeometry = window.PdfViewerState?.hasUsableTextGeometryAtPoint?.(clientX, clientY);
    const geometryHit = window.PdfViewerState?.findWordAtPoint?.(clientX, clientY);
    if (geometryHit?.text && geometryHit.rect) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      window.PdfViewerState?.showCustomSelection?.(geometryHit.slot, geometryHit.wordBox);
      openPopup(geometryHit.text, geometryHit.rect);
      return;
    }
    if (hasGeometry) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      window.PdfViewerState?.clearCustomSelection?.();
      return;
    }

    const span = e.target.closest('.textLayer span');
    if (!span) return;

    setTimeout(() => {
      // Strategy A — accept the native browser selection when it is clean
      const nativeSel = getNativeDoubleClickSelection();
      if (nativeSel && isGoodDoubleClickSelection(nativeSel.text, nativeSel.rect)) {
        openPopup(nativeSel.text, nativeSel.rect);
        return;
      }

      // Strategy B — caret-based expansion within a single text node
      const bResult = getWordFromPoint(clientX, clientY);
      if (bResult && !bResult.atBoundary) {
        // Word is fully inside one span; use it directly
        openPopup(bResult.text, bResult.rect);
        return;
      }

      // Strategy C — multi-span line reconstruction for split words
      const cResult = getWordFromSpanLine(span, clientX);
      if (cResult) {
        openPopup(cResult.text, cResult.rect);
        return;
      }

      // B result as fallback when C also failed (at-boundary but best we have)
      if (bResult) {
        openPopup(bResult.text, bResult.rect);
        return;
      }

      // Last resort: full text of the clicked span
      const spanText = span.textContent.trim();
      if (spanText) openPopup(spanText, span.getBoundingClientRect());
    }, 0);
  });

}());
