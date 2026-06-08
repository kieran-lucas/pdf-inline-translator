'use strict';

// Translation pipeline: settings, dictionary, L1/L2 cache, request dedupe,
// interactive Gemini streaming, model fallback.
// Prefetch was removed — Gemini is only called on explicit user action.

window.Translator = (() => {
  const DEBUG_TRANSLATION_PERF = false;
  const DEBUG_GEMINI_CALLS     = false;

  const KEY_APIKEY             = 'tx_api_key';
  const KEY_TARGET             = 'tx_target_lang';
  const KEY_SOURCE             = 'tx_source_lang';
  const KEY_MODEL              = 'tx_gemini_model';
  const KEY_OFFLINE_DICTIONARY = 'tx_offline_dictionary_enabled';
  const KEY_GEMINI_FALLBACK    = 'tx_gemini_fallback_enabled';
  const KEY_STREAMING          = 'tx_streaming_enabled';

  const DEFAULT_MODEL   = 'gemini-2.5-flash-lite';
  const FALLBACK_MODEL  = 'gemini-2.5-flash';
  const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const MAX_CHARS       = 2000;
  const TIMEOUT_MS      = 15_000;

  function perf(...args) {
    if (DEBUG_TRANSLATION_PERF) console.debug('[tx-perf]', ...args);
  }

  function geminiLog(...args) {
    if (DEBUG_GEMINI_CALLS) console.debug('[tx-gemini]', ...args);
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isSingleWord(text) {
    return /^[\p{L}\p{N}_]+(?:['’‘\-‐‑][\p{L}\p{N}_]+)*$/u.test(text);
  }

  function makeCacheKey(normalizedText, sourceLang, targetLang, model) {
    return normalizedText + '\x00' + sourceLang + '\x00' + targetLang + '\x00' + model;
  }

  let settingsCache = null;

  function loadSettings() {
    if (settingsCache) return Promise.resolve(settingsCache);
    return new Promise(resolve => {
      chrome.storage.local.get(
        [KEY_APIKEY, KEY_TARGET, KEY_SOURCE, KEY_MODEL, KEY_OFFLINE_DICTIONARY, KEY_GEMINI_FALLBACK, KEY_STREAMING],
        result => {
          settingsCache = {
            apiKey:                 result[KEY_APIKEY]             || '',
            targetLang:             result[KEY_TARGET]             || 'vi',
            sourceLang:             result[KEY_SOURCE]             || 'auto',
            model:                  result[KEY_MODEL]              || DEFAULT_MODEL,
            enableOfflineDictionary: result[KEY_OFFLINE_DICTIONARY] !== false,
            enableGeminiFallback:   result[KEY_GEMINI_FALLBACK]   !== false,
            enableStreaming:         result[KEY_STREAMING]          !== false,
          };
          resolve(settingsCache);
        }
      );
    });
  }

  function saveSettings({ apiKey, targetLang, sourceLang, model, enableOfflineDictionary, enableGeminiFallback, enableStreaming }) {
    return new Promise(resolve => {
      const data = {
        [KEY_APIKEY]:             apiKey                  !== undefined ? apiKey                    : '',
        [KEY_TARGET]:             targetLang              !== undefined ? targetLang                 : 'vi',
        [KEY_SOURCE]:             sourceLang              !== undefined ? sourceLang                 : 'auto',
        [KEY_MODEL]:              model                   !== undefined ? model                      : DEFAULT_MODEL,
        [KEY_OFFLINE_DICTIONARY]: enableOfflineDictionary !== undefined ? !!enableOfflineDictionary  : true,
        [KEY_GEMINI_FALLBACK]:    enableGeminiFallback    !== undefined ? !!enableGeminiFallback     : true,
        [KEY_STREAMING]:          enableStreaming          !== undefined ? !!enableStreaming           : true,
      };
      chrome.storage.local.set(data, () => {
        settingsCache = {
          apiKey:                 data[KEY_APIKEY],
          targetLang:             data[KEY_TARGET],
          sourceLang:             data[KEY_SOURCE],
          model:                  data[KEY_MODEL],
          enableOfflineDictionary: data[KEY_OFFLINE_DICTIONARY],
          enableGeminiFallback:   data[KEY_GEMINI_FALLBACK],
          enableStreaming:         data[KEY_STREAMING],
        };
        resolve();
      });
    });
  }

  function clearApiKey() {
    return new Promise(resolve => {
      chrome.storage.local.remove(KEY_APIKEY, () => {
        if (settingsCache) settingsCache.apiKey = '';
        resolve();
      });
    });
  }

  // ── L1 in-memory cache (LRU, 500 entries) ─────────────────────────────────

  const L1_MAX = 500;
  const l1 = new Map();

  function l1Get(key) {
    if (!l1.has(key)) return null;
    const val = l1.get(key);
    l1.delete(key);
    l1.set(key, val);
    return val;
  }

  function l1Set(key, translated, source = 'memory', entry = null) {
    if (l1.has(key)) l1.delete(key);
    else if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value);
    l1.set(key, { translated, source, entry });
  }

  // ── L2 IndexedDB translation cache ────────────────────────────────────────

  const IDB_NAME    = 'pdf-tx-cache';
  const IDB_VERSION = 1;
  const IDB_STORE   = 'translations';
  const IDB_MAX     = 3000;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'key' });
          store.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror  = (e) => { dbPromise = null; reject(e.target.error); };
    });
    return dbPromise;
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return new Promise(resolve => {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result?.translated ?? null);
        req.onerror   = () => resolve(null);
      });
    } catch { return null; }
  }

  async function idbSet(key, translated) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ key, translated, ts: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror    = (e) => reject(e.target.error);
      });
      idbTrim(db).catch(() => {});
    } catch {}
  }

  async function idbTrim(db) {
    const count = await new Promise(resolve => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(0);
    });
    if (count <= IDB_MAX) return;
    await new Promise(resolve => {
      const tx     = db.transaction(IDB_STORE, 'readwrite');
      const cursor = tx.objectStore(IDB_STORE).index('ts').openCursor();
      let deleted  = 0;
      const toDelete = count - IDB_MAX;
      cursor.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && deleted < toDelete) { cur.delete(); deleted++; cur.continue(); }
      };
      tx.oncomplete = resolve;
      tx.onerror    = resolve;
    });
  }

  async function idbClear() {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror    = (e) => reject(e.target.error);
      });
    } catch {}
  }

  // ── Lexical dictionary lookup ──────────────────────────────────────────────

  async function lexicalLookup(text, settings) {
    if (!settings.enableOfflineDictionary || !isSingleWord(text)) return null;
    const result = await window.LexicalDB?.lookupWord?.(text, {
      sourceLang:      settings.sourceLang,
      targetLang:      settings.targetLang,
      allowFullLookup: true,
    });
    return result?.ok ? result : null;
  }

  // ── Gemini helpers ─────────────────────────────────────────────────────────

  function maxTokensFor(text) {
    if (isSingleWord(text)) return 64;
    if (text.length < 300)  return 128;
    return 256;
  }

  function buildPrompt(text, sourceLang, targetLang) {
    if (sourceLang && sourceLang !== 'auto') {
      return `Translate from ${sourceLang} to ${targetLang}. Return only the translation.\nText: ${text}`;
    }
    return `Translate to ${targetLang}. Return only the translation.\nText: ${text}`;
  }

  function extractText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!parts?.length) return '';
    return parts.map(p => p.text || '').join('').trim();
  }

  async function parseJsonResponse(response) {
    try { return await response.json(); } catch { return null; }
  }

  function isModelUnavailable(result) {
    return result?.errorType === 'model' || result?.status === 404;
  }

  function requestBody(prompt, maxOutputTokens) {
    return JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, topP: 1, maxOutputTokens },
    });
  }

  function linkAbortSignal(controller, signal) {
    if (!signal) return () => {};
    if (signal.aborted) { controller.abort(); return () => {}; }
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  // ── Main translate entry point ─────────────────────────────────────────────

  const inFlight = new Map();

  async function translate(rawText, options = {}) {
    const t0 = performance.now();
    const savedSettings = await loadSettings();
    const settings = {
      ...savedSettings,
      sourceLang:     options.sourceLang || savedSettings.sourceLang,
      targetLang:     options.targetLang || savedSettings.targetLang,
      model:          options.model      || savedSettings.model,
      enableStreaming: options.preferStreaming !== undefined
        ? !!options.preferStreaming
        : savedSettings.enableStreaming,
    };
    const onPartial    = options.onPartial || options.onChunk;
    const forceGemini  = !!options.forceGemini;
    const text         = normalize(rawText);

    if (!text) {
      return { ok: false, errorType: 'empty', errorMsg: 'Nothing to translate.', settings };
    }
    if (text.length > MAX_CHARS) {
      return {
        ok: false, errorType: 'too-long',
        errorMsg: `Selection is too long (${text.length} / ${MAX_CHARS} chars). Shorten your selection.`,
        settings,
      };
    }

    const cacheText = isSingleWord(text) ? text.toLowerCase() : text;
    const model     = settings.model || DEFAULT_MODEL;
    const key       = makeCacheKey(cacheText, settings.sourceLang, settings.targetLang, model);

    // Skip all caches when user explicitly requests Gemini
    if (!forceGemini) {
      const l1Hit = l1Get(key);
      if (l1Hit !== null && (!l1Hit.entry || settings.enableOfflineDictionary)) {
        perf('l1 hit', text, Math.round(performance.now() - t0) + 'ms');
        return {
          ok: true,
          translated: l1Hit.translated,
          settings,
          fromCache: l1Hit.entry ? 'dictionary' : 'memory',
          source:    l1Hit.source,
          entry:     l1Hit.entry || undefined,
        };
      }

      const dictHit = await lexicalLookup(text, settings);
      if (dictHit) {
        const compactMeaning = dictHit.compactMeaning || '';
        l1Set(key, compactMeaning, dictHit.source || 'dictionary', dictHit.entry || null);
        perf('dictionary hit', text);
        return {
          ok: true,
          translated: compactMeaning,
          settings,
          fromCache: 'dictionary',
          source:    dictHit.source,
          entry:     dictHit.entry,
        };
      }

      const l2Hit = await idbGet(key);
      if (l2Hit !== null) {
        l1Set(key, l2Hit, 'idb');
        perf('idb hit', text, Math.round(performance.now() - t0) + 'ms');
        return { ok: true, translated: l2Hit, settings, fromCache: 'idb', source: 'idb' };
      }
    }

    if (!settings.enableGeminiFallback) {
      return {
        ok: false, errorType: 'offline-miss',
        errorMsg: 'Not found in offline dictionary. Enable Gemini fallback to translate this.',
        settings,
      };
    }

    if (!settings.apiKey) {
      return { ok: false, errorType: 'no-key', errorMsg: 'No Gemini API key configured.', settings };
    }

    if (inFlight.has(key)) {
      perf('dedupe attach', text);
      return inFlight.get(key).promise;
    }

    perf('api miss', text);
    const promise = callInteractive(text, key, settings, model, { ...options, onPartial, cacheText })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, { promise });
    return promise;
  }

  async function callInteractive(text, key, settings, model, options) {
    const start = performance.now();
    let result  = null;

    if (!isSingleWord(text) && settings.enableStreaming && options.onPartial) {
      result = await callGeminiStream(text, key, settings, model, options);
      if (result?.ok || !result?.retryNormal) {
        if (result?.ok) perf('stream duration', Math.round(performance.now() - start) + 'ms');
        if (!isModelUnavailable(result)) return result;
      }
    }

    result = await callGeminiOnce(text, key, settings, model, options.signal);
    if (isModelUnavailable(result) && model !== FALLBACK_MODEL) {
      const fallbackKey = makeCacheKey(options.cacheText || text, settings.sourceLang, settings.targetLang, FALLBACK_MODEL);
      result = await callGeminiOnce(text, fallbackKey, settings, FALLBACK_MODEL, options.signal);
      if (result.ok) {
        l1Set(key, result.translated, 'gemini');
        idbSet(key, result.translated);
      }
    }
    perf('request duration', Math.round(performance.now() - start) + 'ms');
    return result;
  }

  async function callGeminiOnce(text, key, settings, model, signal) {
    const endpoint   = GEMINI_BASE_URL + encodeURIComponent(model) + ':generateContent';
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, signal);
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);
    geminiLog('call', model, text.slice(0, 40));

    let response;
    try {
      response = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
        body:    requestBody(buildPrompt(text, settings.sourceLang, settings.targetLang), maxTokensFor(text)),
        signal:  controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      unlinkAbort();
      if (err.name === 'AbortError') {
        return { ok: false, errorType: 'timeout', errorMsg: 'Request timed out. Check your connection.', settings };
      }
      return { ok: false, errorType: 'network', errorMsg: 'Network error. Check your connection.', settings };
    }
    clearTimeout(timeoutId);
    unlinkAbort();

    const data = await parseJsonResponse(response);
    if (!response.ok) return apiError(response.status, data, settings);

    const translated = extractText(data);
    if (!translated) {
      return { ok: false, errorType: 'empty-result', errorMsg: 'Gemini returned an empty result.', settings };
    }
    l1Set(key, translated, 'gemini');
    idbSet(key, translated);
    return { ok: true, translated, settings, fromCache: false, source: 'gemini' };
  }

  async function callGeminiStream(text, key, settings, model, options) {
    const endpoint   = GEMINI_BASE_URL + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
    const started    = performance.now();
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, options.signal);
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);
    geminiLog('stream', model, text.slice(0, 40));

    let response;
    try {
      response = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
        body:    requestBody(buildPrompt(text, settings.sourceLang, settings.targetLang), maxTokensFor(text)),
        signal:  controller.signal,
      });
    } catch {
      clearTimeout(timeoutId);
      unlinkAbort();
      return { ok: false, retryNormal: true, settings };
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      unlinkAbort();
      const data = await parseJsonResponse(response);
      return apiError(response.status, data, settings);
    }
    if (!response.body?.getReader) {
      clearTimeout(timeoutId);
      unlinkAbort();
      return { ok: false, retryNormal: true, settings };
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer     = '';
    let translated = '';
    let firstChunk = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) {
          const lines = event.split(/\r?\n/).filter(line => line.startsWith('data:'));
          for (const line of lines) {
            const payload = line.replace(/^data:\s*/, '').trim();
            if (!payload || payload === '[DONE]') continue;
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            const chunk = extractText(data);
            if (!chunk) continue;
            translated += chunk;
            if (!firstChunk) {
              firstChunk = true;
              perf('stream first chunk', Math.round(performance.now() - started) + 'ms');
            }
            options.onPartial?.(translated);
          }
        }
      }
    } catch {
      clearTimeout(timeoutId);
      unlinkAbort();
      return { ok: false, retryNormal: true, settings };
    }
    clearTimeout(timeoutId);
    unlinkAbort();

    translated = translated.trim();
    if (!translated) return { ok: false, retryNormal: true, settings };
    l1Set(key, translated, 'gemini');
    idbSet(key, translated);
    return { ok: true, translated, settings, fromCache: false, source: 'gemini', streamed: true };
  }

  function apiError(status, data, settings) {
    const apiMsg = data?.error?.message || '';
    if (status === 401 || status === 403) {
      return { ok: false, status, errorType: 'auth', errorMsg: 'Invalid Gemini API key or unauthorized project.', settings };
    }
    if (status === 404) {
      return { ok: false, status, errorType: 'model', errorMsg: 'Gemini model unavailable. Check model name in Settings.', settings };
    }
    if (status === 429) {
      return { ok: false, status, errorType: 'quota', errorMsg: 'Gemini free-tier rate limit reached. Try again later.', settings };
    }
    return {
      ok: false, status, errorType: 'api',
      errorMsg: `Translation failed (HTTP ${status})${apiMsg ? ': ' + apiMsg : ''}.`,
      settings,
    };
  }

  async function clearCache() {
    l1.clear();
    await idbClear();
  }

  return {
    loadSettings,
    saveSettings,
    clearApiKey,
    translate,
    clearCache,
    MAX_CHARS,
    DEFAULT_MODEL,
  };
})();
