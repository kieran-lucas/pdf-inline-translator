'use strict';

// ── Translation interaction layer ──────────────────────────────────────────
// Manages the Translate button and inline popup.
// Calls window.Translator (translator.js) for API access.

(function initSelectionLayer() {

  // ── Create UI elements ─────────────────────────────────────────────────────

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
      '<button class="tx-close-btn" aria-label="Close">&#x2715;</button>' +
    '</div>' +
    '<div class="tx-body"></div>';
  document.body.appendChild(txPopup);

  const txSourceText = txPopup.querySelector('.tx-source-text');
  const txCloseBtn   = txPopup.querySelector('.tx-close-btn');
  const txBody       = txPopup.querySelector('.tx-body');

  // ── State ──────────────────────────────────────────────────────────────────

  let pending        = null; // { text, rect } | null
  let openRect       = null;
  let popupGeneration = 0;

  // ── Visibility helpers ─────────────────────────────────────────────────────

  function hideTxBtn() { txBtn.classList.add('tx-hidden'); }
  function hidePopup() { txPopup.classList.add('tx-hidden'); }

  function hideAll() {
    hideTxBtn();
    hidePopup();
    window.PdfViewerState?.clearCustomSelection?.();
    pending  = null;
    openRect = null;
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  const GAP  = 10;
  const EDGE = 10;

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

  function place(el, refRect) {
    el.style.top  = '-9999px';
    el.style.left = '-9999px';
    el.classList.remove('tx-hidden');
    const { top, left } = computePos(el.offsetWidth, el.offsetHeight, refRect);
    el.style.top  = top  + 'px';
    el.style.left = left + 'px';
  }

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

  function sourceBadgeLabel(source) {
    if (!source) return null;
    if (source === 'core-dictionary') return 'core';
    if (source === 'full-dictionary') return 'full dict';
    if (source === 'gemini')          return 'Gemini';
    if (source === 'idb')             return 'cached';
    if (source === 'memory')          return null;
    return null;
  }

  // Build the expandable senses section (hidden by default).
  function makeLexicalExpanded(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'tx-expanded tx-hidden';

    for (const sense of entry?.senses || []) {
      const block = document.createElement('div');
      block.className = 'tx-sense';

      const heading = document.createElement('div');
      heading.className = 'tx-sense-heading';
      const parts = [sense.pos, ...(sense.viMeanings || []).slice(0, 3)].filter(Boolean);
      heading.textContent = parts.join(' · ');
      block.appendChild(heading);

      if (sense.enDefinition) {
        const def = document.createElement('p');
        def.className   = 'tx-sense-def';
        def.textContent = sense.enDefinition;
        block.appendChild(def);
      }

      for (const ex of (sense.examples || []).slice(0, 1)) {
        const p = document.createElement('p');
        p.className   = 'tx-sense-example';
        p.textContent = ex.vi ? `“${ex.en}” → ${ex.vi}` : `“${ex.en}”`;
        block.appendChild(p);
      }

      const lists = [
        ['Synonyms', sense.synonyms],
        ['Antonyms', sense.antonyms],
        ['Collocations', sense.collocations],
      ];
      for (const [label, values] of lists) {
        const clean = (values || []).filter(Boolean);
        if (!clean.length) continue;
        const p = document.createElement('p');
        p.className   = 'tx-sense-row';
        p.textContent = `${label}: ${clean.join(', ')}`;
        block.appendChild(p);
      }

      if (block.childElementCount > 0) wrap.appendChild(block);
    }

    return wrap;
  }

  // ── Action builder ─────────────────────────────────────────────────────────

  function appendActions(container, translated, sourceText, result, wordForSave, expanded) {
    const actions = document.createElement('div');
    actions.className = 'tx-actions';

    // Copy translation
    const copyBtn = document.createElement('button');
    copyBtn.className   = 'tx-action-btn tx-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy translation';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(translated).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('tx-copy-btn--done');
        setTimeout(() => {
          if (copyBtn.isConnected) {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('tx-copy-btn--done');
          }
        }, 1500);
      }).catch(() => {});
    });
    actions.appendChild(copyBtn);

    // Copy source
    const copySourceBtn = document.createElement('button');
    copySourceBtn.className   = 'tx-action-btn tx-copy-source-btn';
    copySourceBtn.textContent = 'Copy source';
    copySourceBtn.title = 'Copy original text';
    copySourceBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(sourceText).then(() => {
        copySourceBtn.textContent = 'Copied!';
        setTimeout(() => {
          if (copySourceBtn.isConnected) copySourceBtn.textContent = 'Copy source';
        }, 1500);
      }).catch(() => {});
    });
    actions.appendChild(copySourceBtn);

    // Speak (Web Speech API)
    if ('speechSynthesis' in window) {
      const speakBtn = document.createElement('button');
      speakBtn.className   = 'tx-action-btn tx-speak-btn';
      speakBtn.textContent = '🔊 Speak';
      speakBtn.title = 'Pronounce in English';
      speakBtn.addEventListener('click', () => {
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(sourceText);
        utt.lang = 'en-US';
        utt.rate = 0.85;
        window.speechSynthesis.speak(utt);
      });
      actions.appendChild(speakBtn);
    }

    // Save word
    const saveBtn = document.createElement('button');
    saveBtn.className   = 'tx-action-btn tx-save-btn';
    saveBtn.textContent = '☆ Save';
    saveBtn.title = 'Save to word list';
    const SAVED_KEY = 'saved_words';

    function refreshSaveState() {
      chrome.storage.local.get(SAVED_KEY, (data) => {
        const words = data[SAVED_KEY] || [];
        const saved = words.some(w => w.word === wordForSave);
        saveBtn.textContent = saved ? '★ Saved' : '☆ Save';
        saveBtn.classList.toggle('tx-save-btn--saved', saved);
      });
    }
    refreshSaveState();

    saveBtn.addEventListener('click', () => {
      chrome.storage.local.get(SAVED_KEY, (data) => {
        const words = data[SAVED_KEY] || [];
        const idx   = words.findIndex(w => w.word === wordForSave);
        if (idx >= 0) {
          words.splice(idx, 1);
        } else {
          words.push({
            word:        wordForSave,
            translation: translated,
            source:      result.source || 'unknown',
            savedAt:     Date.now(),
          });
        }
        chrome.storage.local.set({ [SAVED_KEY]: words }, refreshSaveState);
      });
    });
    actions.appendChild(saveBtn);

    // More / Less (only when expanded section has content)
    if (expanded && expanded.childElementCount) {
      const moreBtn = document.createElement('button');
      moreBtn.className   = 'tx-action-btn tx-more-btn';
      moreBtn.textContent = 'More ▸';
      moreBtn.addEventListener('click', () => {
        const hidden = expanded.classList.toggle('tx-hidden');
        moreBtn.textContent = hidden ? 'More ▸' : 'Less ▾';
        if (openRect && !txPopup.classList.contains('tx-hidden')) rePlace(txPopup, openRect);
      });
      actions.appendChild(moreBtn);
    }

    // Ask Gemini — shown when result came from offline dictionary
    const isDictSource = result.fromCache === 'dictionary' ||
      (result.source && result.source !== 'gemini' && result.source !== 'idb' && result.source !== 'memory');
    if (isDictSource) {
      const geminiBtn = document.createElement('button');
      geminiBtn.className   = 'tx-action-btn tx-retry-btn';
      geminiBtn.textContent = 'Ask Gemini';
      geminiBtn.title = 'Get AI translation from Gemini';
      geminiBtn.addEventListener('click', () => {
        if (!openRect) return;
        geminiBtn.disabled = true;
        openPopup(sourceText, openRect, { forceGemini: true });
      });
      actions.appendChild(geminiBtn);
    }

    // Open Settings
    const settingsBtn = document.createElement('button');
    settingsBtn.className   = 'tx-action-btn tx-open-settings-btn';
    settingsBtn.textContent = '⚙ Settings';
    settingsBtn.addEventListener('click', openSettings);
    actions.appendChild(settingsBtn);

    container.appendChild(actions);
  }

  function openSettings() {
    hideAll();
    const settingsPanel  = document.getElementById('settings-panel');
    const settingsToggle = document.getElementById('settings-toggle');
    if (settingsToggle && settingsPanel && !settingsPanel.classList.contains('settings-open')) {
      settingsToggle.click();
    }
  }

  // ── Result body ────────────────────────────────────────────────────────────

  function setBodyResult(result, sourceText) {
    txBody.innerHTML = '';
    const translated = result.translated;

    if (result.entry) {
      const entry = result.entry;

      // Lemma + IPA
      const lemmaRow = document.createElement('div');
      lemmaRow.className = 'tx-lemma-row';

      const lemmaEl = document.createElement('span');
      lemmaEl.className   = 'tx-lemma';
      lemmaEl.textContent = entry.lemma || sourceText;
      lemmaRow.appendChild(lemmaEl);

      const pron = firstPronunciation(entry);
      if (pron?.ipa) {
        const ipaEl = document.createElement('span');
        ipaEl.className   = 'tx-ipa';
        ipaEl.textContent = pron.ipa;
        lemmaRow.appendChild(ipaEl);
      }
      txBody.appendChild(lemmaRow);

      // POS badges + source badge
      const hasPOS    = (entry.pos || []).length > 0;
      const srcLabel  = sourceBadgeLabel(result.source);
      if (hasPOS || srcLabel) {
        const badgeRow = document.createElement('div');
        badgeRow.className = 'tx-badge-row';
        for (const pos of (entry.pos || []).slice(0, 4)) {
          const badge = document.createElement('span');
          badge.className   = 'tx-pos-badge';
          badge.textContent = pos;
          badgeRow.appendChild(badge);
        }
        if (srcLabel) {
          const srcBadge = document.createElement('span');
          srcBadge.className   = 'tx-source-badge';
          srcBadge.textContent = srcLabel;
          badgeRow.appendChild(srcBadge);
        }
        txBody.appendChild(badgeRow);
      }

      // Vietnamese meaning (prominent)
      if (translated) {
        const viEl = document.createElement('p');
        viEl.className   = 'tx-vi-meaning';
        viEl.textContent = translated;
        txBody.appendChild(viEl);
      }

      // English definition from first sense that has one
      const firstDef = (entry.senses || []).find(s => s.enDefinition)?.enDefinition;
      if (firstDef) {
        const defEl = document.createElement('p');
        defEl.className   = 'tx-en-def';
        defEl.textContent = firstDef;
        txBody.appendChild(defEl);
      }

      // Expandable senses
      const expanded = makeLexicalExpanded(entry);
      if (expanded.childElementCount) {
        txBody.appendChild(expanded);
      }

      appendActions(txBody, translated, sourceText, result, entry.lemma || sourceText,
        expanded.childElementCount ? expanded : null);

    } else {
      // Simple Gemini result
      const p = document.createElement('p');
      p.className   = 'tx-result-text';
      p.textContent = translated;
      txBody.appendChild(p);

      appendActions(txBody, translated, sourceText, result, sourceText, null);
    }
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

  function setBodyError(errorType, errorMsg, sourceText, retryFn) {
    txBody.innerHTML = '';

    const msg = document.createElement('p');
    msg.className   = 'tx-error-text';

    if (errorType === 'no-key') {
      msg.textContent = 'No Gemini API key configured. Add your key in Settings.';
    } else {
      msg.textContent = errorMsg || 'Translation failed.';
    }
    txBody.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'tx-actions';

    if (errorType !== 'no-key' && errorType !== 'offline-miss' && retryFn) {
      const retryBtn = document.createElement('button');
      retryBtn.className   = 'tx-action-btn tx-retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', retryFn);
      actions.appendChild(retryBtn);
    }

    if (errorType === 'offline-miss') {
      const geminiBtn = document.createElement('button');
      geminiBtn.className   = 'tx-action-btn tx-retry-btn';
      geminiBtn.textContent = 'Ask Gemini';
      geminiBtn.title = 'Try Gemini API translation';
      geminiBtn.addEventListener('click', () => {
        if (openRect) openPopup(sourceText, openRect, { forceGemini: true });
      });
      actions.appendChild(geminiBtn);
    }

    const settingsBtn = document.createElement('button');
    settingsBtn.className   = 'tx-action-btn tx-open-settings-btn';
    settingsBtn.textContent = '⚙ Settings';
    settingsBtn.addEventListener('click', openSettings);
    actions.appendChild(settingsBtn);

    txBody.appendChild(actions);
  }

  // ── Selection helper ───────────────────────────────────────────────────────

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

  // ── Pointer-down: dismiss stale UI ────────────────────────────────────────

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#tx-btn') || e.target.closest('#tx-popup')) return;
    hideAll();
  });

  // ── Mouse-up: show translate button ──────────────────────────────────────

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('#tx-btn') || e.target.closest('#tx-popup')) return;

    const result = getLayerSelection();
    if (!result) return;

    pending = result;
    place(txBtn, result.rect);
  });

  // ── Translate button click ────────────────────────────────────────────────

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

  async function openPopup(text, rect, opts) {
    const myGen = ++popupGeneration;
    openRect    = rect;

    const preview = text.length > MAX_PREVIEW
      ? text.slice(0, MAX_PREVIEW).trimEnd() + '…'
      : text;
    txSourceText.textContent = preview;

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

    setBodyLoading();
    hidePopup();
    place(txPopup, rect);

    const isSingle = /^[\p{L}\p{N}_]+(?:['''\-‐‑][\p{L}\p{N}_]+)*$/u.test(normalized);
    const result   = await window.Translator.translate(text, {
      mode:            'interactive',
      preferStreaming: !isSingle,
      forceGemini:     !!(opts && opts.forceGemini),
      onPartial: (partial) => {
        if (myGen !== popupGeneration) return;
        if (txPopup.classList.contains('tx-hidden')) return;
        setBodyStreaming(partial);
        if (openRect && !txPopup.classList.contains('tx-hidden')) rePlace(txPopup, openRect);
      },
    });

    if (myGen !== popupGeneration) return;
    if (txPopup.classList.contains('tx-hidden')) return;

    if (result.ok) {
      setBodyResult(result, text);
    } else {
      const retryFn = ['timeout', 'network', 'api', 'quota'].includes(result.errorType)
        ? () => openPopup(text, rect, opts)
        : null;
      setBodyError(result.errorType, result.errorMsg, text, retryFn);
    }

    if (openRect && !txPopup.classList.contains('tx-hidden')) rePlace(txPopup, openRect);
  }

  // ── Word-detection helpers (used by double-click) ─────────────────────────

  function isBaseWordChar(ch) {
    return /[\p{L}\p{N}_]/u.test(ch);
  }

  function isJoinerChar(ch) {
    return ch === "'" || ch === '’' || ch === '‘' ||
           ch === '-' || ch === '‐' || ch === '‑';
  }

  function shouldIncludeJoiner(str, idx) {
    return idx > 0 && idx < str.length - 1 &&
           isBaseWordChar(str[idx - 1]) && isBaseWordChar(str[idx + 1]);
  }

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

    while (start < end && isJoinerChar(str[start]))   start++;
    while (end > start && isJoinerChar(str[end - 1])) end--;

    return { start, end };
  }

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

  function selectRange(range) {
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── Strategy A — native browser double-click selection ────────────────────

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
    if (/\s/.test(text)) return false;
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    return true;
  }

  // ── Strategy B — caret position → word expansion within one text node ─────

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
      const atBoundary = (start === 0 || end === str.length);
      return { text: wordText, rect, atBoundary };
    } catch (_) { return null; }
  }

  // ── Strategy C — same-line multi-span reconstruction ─────────────────────

  function getWordFromSpanLine(clickedSpan, clientX) {
    const textLayer = clickedSpan.closest('.textLayer');
    if (!textLayer) return null;

    const cr = clickedSpan.getBoundingClientRect();
    if (!cr || cr.height === 0) return null;

    const tol = cr.height * 0.35;
    const lineSpans = Array.from(textLayer.querySelectorAll('span')).filter(s => {
      const r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0 &&
             r.top    < cr.bottom - tol &&
             r.bottom > cr.top   + tol;
    });

    lineSpans.sort((a, b) =>
      a.getBoundingClientRect().left - b.getBoundingClientRect().left
    );

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

  document.addEventListener('dblclick', (e) => {
    hideTxBtn();
    pending = null;

    const clientX = e.clientX;
    const clientY = e.clientY;
    const hasGeometry  = window.PdfViewerState?.hasUsableTextGeometryAtPoint?.(clientX, clientY);
    const geometryHit  = window.PdfViewerState?.findWordAtPoint?.(clientX, clientY);
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
      const nativeSel = getNativeDoubleClickSelection();
      if (nativeSel && isGoodDoubleClickSelection(nativeSel.text, nativeSel.rect)) {
        openPopup(nativeSel.text, nativeSel.rect);
        return;
      }

      const bResult = getWordFromPoint(clientX, clientY);
      if (bResult && !bResult.atBoundary) {
        openPopup(bResult.text, bResult.rect);
        return;
      }

      const cResult = getWordFromSpanLine(span, clientX);
      if (cResult) {
        openPopup(cResult.text, cResult.rect);
        return;
      }

      if (bResult) {
        openPopup(bResult.text, bResult.rect);
        return;
      }

      const spanText = span.textContent.trim();
      if (spanText) openPopup(spanText, span.getBoundingClientRect());
    }, 0);
  });

}());
