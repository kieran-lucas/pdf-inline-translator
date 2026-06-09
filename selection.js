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
      '<span class="tx-headword"></span>' +
      '<button class="tx-head-speak-btn tx-hidden" aria-label="Speak word aloud">🔊</button>' +
      '<button class="tx-close-btn" aria-label="Close">&#x2715;</button>' +
    '</div>' +
    '<div class="tx-body"></div>';
  document.body.appendChild(txPopup);

  const txHeadword  = txPopup.querySelector('.tx-headword');
  const txSpeakBtn  = txPopup.querySelector('.tx-head-speak-btn');
  const txCloseBtn  = txPopup.querySelector('.tx-close-btn');
  const txBody      = txPopup.querySelector('.tx-body');

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

  // ── POS normalization ──────────────────────────────────────────────────────
  //
  // sense.pos from FVDP entries is raw Vietnamese ("danh từ", "tính từ", …).
  // sense.pos from Kaikki entries is English, sometimes abbreviated ("adj", "adv").
  // This layer maps both to canonical English keys before displaying.

  const POS_ORDER = [
    'noun', 'verb', 'adjective', 'adverb', 'auxiliary',
    'preposition', 'conjunction', 'pronoun', 'interjection',
    'phrase', 'idiom', 'article', 'determiner', 'numeral', 'particle',
    'suffix', 'prefix',
  ];

  // Legacy fallback kept only for old cached entry shapes. The active pipeline
  // normalizes POS in dictionary-model.js before rendering.
  function legacyNormalizePartOfSpeech(rawPos) {
    if (!rawPos) return null;
    const s = rawPos.toLowerCase().trim();
    if (!s) return null;

    // Vietnamese labels from FVDP — longer compound matches before their substrings
    if (/trợ\s*động\s*từ/.test(s)) return 'auxiliary';
    if (/động\s*từ/.test(s))       return 'verb';
    if (/danh\s*từ/.test(s))       return 'noun';
    if (/tính\s*từ/.test(s))       return 'adjective';
    if (/phó\s*từ/.test(s))        return 'adverb';
    if (/đại\s*từ/.test(s))        return 'pronoun';
    if (/giới\s*từ/.test(s))       return 'preposition';
    if (/liên\s*từ/.test(s))       return 'conjunction';
    if (/thán\s*từ/.test(s))       return 'interjection';
    if (/mạo\s*từ/.test(s))        return 'article';
    if (/số\s*từ/.test(s))         return 'numeral';
    if (/\btừ\b/.test(s))          return 'particle';

    // English full words (Kaikki / already-normalized data)
    const EN_FULL = {
      noun: 'noun', verb: 'verb', adjective: 'adjective', adverb: 'adverb',
      pronoun: 'pronoun', preposition: 'preposition', conjunction: 'conjunction',
      interjection: 'interjection', article: 'article', auxiliary: 'auxiliary',
      numeral: 'numeral', particle: 'particle', phrase: 'phrase', idiom: 'idiom',
      determiner: 'determiner', suffix: 'suffix', prefix: 'prefix',
    };
    if (EN_FULL[s]) return EN_FULL[s];

    // English abbreviations as used in Kaikki/Wiktionary dump data
    if (s === 'n'    || s === 'n.')    return 'noun';
    if (s === 'v'    || s === 'v.')    return 'verb';
    if (s === 'adj'  || s === 'adj.')  return 'adjective';
    if (s === 'adv'  || s === 'adv.')  return 'adverb';
    if (s === 'prep' || s === 'prep.') return 'preposition';
    if (s === 'pron' || s === 'pron.') return 'pronoun';
    if (s === 'conj' || s === 'conj.') return 'conjunction';
    if (s === 'int'  || s === 'int.'  ||
        s === 'interj' || s === 'interj.' ||
        s === 'intj'   || s === 'intj.')   return 'interjection';
    if (s === 'art'  || s === 'art.')  return 'article';
    if (s === 'aux'  || s === 'aux.')  return 'auxiliary';
    if (s === 'num'  || s === 'num.')  return 'numeral';
    if (s === 'det'  || s === 'det.')  return 'determiner';

    // Unknown — return null so caller can display the raw value as a fallback
    return null;
  }

  // ── Action builder ──────────────────────────────────────────────────────────

  function legacyGroupSensesByPos(senses) {
    const groups = [];
    const indexMap = new Map();
    for (const sense of senses || []) {
      const canonical = legacyNormalizePartOfSpeech(sense.pos);
      // Group key: canonical key when known, raw string otherwise (preserves distinct unknowns)
      const key = canonical !== null ? canonical : (sense.pos || '');
      if (indexMap.has(key)) {
        groups[indexMap.get(key)].senses.push(sense);
      } else {
        indexMap.set(key, groups.length);
        groups.push({
          canonical,
          // displayPos: English label for known POS; raw value for unknown; null if empty
          displayPos: canonical !== null ? canonical : (sense.pos || null),
          senses: [sense],
        });
      }
    }
    // Sort by canonical POS order; unknown/unnamed groups go last
    groups.sort((a, b) => {
      const ai = a.canonical !== null ? POS_ORDER.indexOf(a.canonical) : -1;
      const bi = b.canonical !== null ? POS_ORDER.indexOf(b.canonical) : -1;
      const av = ai === -1 ? Infinity : ai;
      const bv = bi === -1 ? Infinity : bi;
      return av - bv;
    });
    return groups;
  }

  function getCanonicalParts(entry) {
    if (Array.isArray(entry?.partsOfSpeech) && entry.partsOfSpeech.length) return entry.partsOfSpeech;
    return window.DictionaryModel?.canonicalizeEntry?.(entry, entry?.lemma)?.partsOfSpeech || [];
  }

  function renderFooterActions(container, translated, sourceText, result, wordForSave) {
    const footer = document.createElement('div');
    footer.className = 'tx-vc-footer';

    const saveBtn = document.createElement('button');
    saveBtn.className   = 'tx-vc-btn tx-vc-save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Save to word list';
    const SAVED_KEY = 'saved_words';

    function refreshSaveState() {
      chrome.storage.local.get(SAVED_KEY, (data) => {
        const words = data[SAVED_KEY] || [];
        const saved = words.some(w => w.word === wordForSave);
        saveBtn.textContent = saved ? 'Saved' : 'Save';
        saveBtn.classList.toggle('tx-vc-save-btn--saved', saved);
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
    footer.appendChild(saveBtn);

    const moreBtn = document.createElement('button');
    moreBtn.className   = 'tx-vc-btn tx-vc-more-btn';
    moreBtn.textContent = 'More ▸';

    const morePanel = document.createElement('div');
    morePanel.className = 'tx-vc-more-panel tx-hidden';

    const copyItem = document.createElement('button');
    copyItem.className   = 'tx-vc-more-item';
    copyItem.textContent = 'Copy translation';
    copyItem.addEventListener('click', () => {
      navigator.clipboard.writeText(translated).then(() => {
        copyItem.textContent = 'Copied!';
        copyItem.classList.add('tx-vc-more-item--done');
        setTimeout(() => {
          if (copyItem.isConnected) {
            copyItem.textContent = 'Copy translation';
            copyItem.classList.remove('tx-vc-more-item--done');
          }
        }, 1500);
      }).catch(() => {});
    });
    morePanel.appendChild(copyItem);

    const isDictSource = result.fromCache === 'dictionary' ||
      (result.source && result.source !== 'gemini' && result.source !== 'idb' && result.source !== 'memory');
    if (isDictSource) {
      const geminiItem = document.createElement('button');
      geminiItem.className   = 'tx-vc-more-item';
      geminiItem.textContent = 'Ask Gemini';
      geminiItem.title = 'Get AI translation from Gemini';
      geminiItem.addEventListener('click', () => {
        if (!openRect) return;
        geminiItem.disabled = true;
        openPopup(sourceText, openRect, { forceGemini: true });
      });
      morePanel.appendChild(geminiItem);
    }

    moreBtn.addEventListener('click', () => {
      const hidden = morePanel.classList.toggle('tx-hidden');
      moreBtn.textContent = hidden ? 'More ▸' : 'More ▾';
      if (openRect && !txPopup.classList.contains('tx-hidden')) rePlace(txPopup, openRect);
    });

    footer.appendChild(moreBtn);
    footer.appendChild(morePanel);
    container.appendChild(footer);
  }

  // ── Result body ────────────────────────────────────────────────────────────

  function wireHeaderSpeaker(text) {
    if (!('speechSynthesis' in window)) return;
    txSpeakBtn.classList.remove('tx-hidden');
    txSpeakBtn.onclick = () => {
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = 'en-US';
      utt.rate = 0.85;
      window.speechSynthesis.speak(utt);
    };
  }

  function setBodyResult(result, sourceText) {
    txBody.innerHTML = '';
    const translated = result.translated;

    if (result.entry) {
      const entry = result.entry;
      txHeadword.textContent = entry.lemma || sourceText;
      wireHeaderSpeaker(sourceText);

      const pron = firstPronunciation(entry);
      if (pron?.ipa) {
        const pronEl = document.createElement('div');
        pronEl.className   = 'tx-vc-pronun';
        pronEl.textContent = pron.ipa;
        txBody.appendChild(pronEl);
      }

      const groups = getCanonicalParts(entry);

      // Build sections first so tab handlers can close over their section elements
      const sectionsEl = document.createElement('div');
      sectionsEl.className = 'tx-vc-sections';
      const namedSections = [];

      for (const g of groups) {
        const section = document.createElement('div');
        section.className = 'tx-vc-section';

        if (g.displayLabel) {
          const posLabel = document.createElement('div');
          posLabel.className   = 'tx-vc-pos-label';
          posLabel.textContent = g.displayLabel;
          section.appendChild(posLabel);
          namedSections.push({ pos: g.displayLabel, section });
        }

        if (g.senses?.length) {
          const ol = document.createElement('ol');
          ol.className = 'tx-vc-ol';
          for (const sense of g.senses.slice(0, 8)) {
            const li = document.createElement('li');
            const meaning = document.createElement('div');
            meaning.className = 'tx-vc-meaning';
            meaning.textContent = sense.meaningVi;
            li.appendChild(meaning);

            const usageItems = [];
            for (const collocation of sense.collocations || []) {
              if (collocation) usageItems.push(collocation);
              if (usageItems.length >= 2) break;
            }
            if (!usageItems.length) {
              for (const example of sense.examples || []) {
                if (example?.textEn) usageItems.push(example.textEn);
                if (usageItems.length >= 2) break;
              }
            }
            for (const usage of usageItems) {
              const usageEl = document.createElement('div');
              usageEl.className = 'tx-vc-usage';
              usageEl.textContent = usage;
              li.appendChild(usageEl);
            }

            ol.appendChild(li);
          }
          section.appendChild(ol);
        }

        if (section.childElementCount > 0) sectionsEl.appendChild(section);
      }

      if (namedSections.length >= 1) {
        const tabsEl = document.createElement('div');
        tabsEl.className = 'tx-vc-tabs';
        for (const { pos, section } of namedSections) {
          const tab = document.createElement('button');
          tab.className   = 'tx-vc-tab';
          tab.type = 'button';
          tab.textContent = pos;
          tab.addEventListener('click', () => {
            section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          });
          tabsEl.appendChild(tab);
        }
        txBody.appendChild(tabsEl);
      }

      if (sectionsEl.childElementCount > 0) {
        txBody.appendChild(sectionsEl);
      } else if (translated) {
        const p = document.createElement('p');
        p.className = 'tx-result-text';
        p.textContent = translated;
        txBody.appendChild(p);
      }

      renderFooterActions(txBody, translated, sourceText, result, entry.lemma || sourceText);

    } else {
      // Simple Gemini result
      wireHeaderSpeaker(sourceText);
      const p = document.createElement('p');
      p.className = 'tx-result-text';
      p.textContent = translated;
      txBody.appendChild(p);

      renderFooterActions(txBody, translated, sourceText, result, sourceText);
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
    msg.className = 'tx-error-text';

    if (errorType === 'no-key') {
      msg.textContent = 'No Gemini API key. Open Settings (⚙) to add your key.';
    } else {
      msg.textContent = errorMsg || 'Translation failed.';
    }
    txBody.appendChild(msg);

    const hasRetry   = errorType !== 'no-key' && errorType !== 'offline-miss' && retryFn;
    const hasGemini  = errorType === 'offline-miss';
    if (hasRetry || hasGemini) {
      const actions = document.createElement('div');
      actions.className = 'tx-vc-footer';

      if (hasRetry) {
        const retryBtn = document.createElement('button');
        retryBtn.className   = 'tx-vc-btn';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', retryFn);
        actions.appendChild(retryBtn);
      }

      if (hasGemini) {
        const geminiBtn = document.createElement('button');
        geminiBtn.className   = 'tx-vc-btn';
        geminiBtn.textContent = 'Ask Gemini';
        geminiBtn.title = 'Try Gemini API translation';
        geminiBtn.addEventListener('click', () => {
          if (openRect) openPopup(sourceText, openRect, { forceGemini: true });
        });
        actions.appendChild(geminiBtn);
      }

      txBody.appendChild(actions);
    }
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
    txHeadword.textContent = preview;
    txSpeakBtn.classList.add('tx-hidden');
    txSpeakBtn.onclick = null;

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
