'use strict';

// ── Translator ─────────────────────────────────────────────────────────────
// Manages settings storage, two-tier translation cache, in-flight request
// deduplication, and Gemini API (generativelanguage.googleapis.com) calls.
// Exposed as window.Translator for settings.js and selection.js.

window.Translator = (() => {

  const KEY_APIKEY      = 'tx_api_key';
  const KEY_TARGET      = 'tx_target_lang';
  const KEY_SOURCE      = 'tx_source_lang';
  const KEY_MODEL       = 'tx_gemini_model';
  const DEFAULT_MODEL   = 'gemini-2.5-flash';
  const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const MAX_CHARS       = 2000;
  const TIMEOUT_MS      = 15_000;

  // ── Text normalisation ─────────────────────────────────────────────────────

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Cache key includes model so a model change correctly invalidates old entries.
  function makeCacheKey(normalizedText, sourceLang, targetLang, model) {
    return normalizedText + '\x00' + sourceLang + '\x00' + targetLang + '\x00' + model;
  }

  // ── Settings — with in-memory cache so L1 lookups cost no storage round-trip

  let settingsCache = null; // { apiKey, targetLang, sourceLang, model } | null

  function loadSettings() {
    if (settingsCache) return Promise.resolve(settingsCache);
    return new Promise(resolve => {
      chrome.storage.local.get([KEY_APIKEY, KEY_TARGET, KEY_SOURCE, KEY_MODEL], result => {
        settingsCache = {
          apiKey:     result[KEY_APIKEY] || '',
          targetLang: result[KEY_TARGET] || 'vi',
          sourceLang: result[KEY_SOURCE] || 'auto',
          model:      result[KEY_MODEL]  || DEFAULT_MODEL,
        };
        resolve(settingsCache);
      });
    });
  }

  function saveSettings({ apiKey, targetLang, sourceLang, model }) {
    return new Promise(resolve => {
      const data = {
        [KEY_APIKEY]: apiKey     !== undefined ? apiKey     : '',
        [KEY_TARGET]: targetLang !== undefined ? targetLang : 'vi',
        [KEY_SOURCE]: sourceLang !== undefined ? sourceLang : 'auto',
        [KEY_MODEL]:  model      !== undefined ? model      : DEFAULT_MODEL,
      };
      chrome.storage.local.set(data, () => {
        settingsCache = {
          apiKey:     data[KEY_APIKEY],
          targetLang: data[KEY_TARGET],
          sourceLang: data[KEY_SOURCE],
          model:      data[KEY_MODEL],
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

  // ── L1: in-memory LRU cache (200 entries) ─────────────────────────────────
  // Map preserves insertion order; delete-on-read + re-insert gives true LRU.

  const L1_MAX = 200;
  const l1     = new Map();

  function l1Get(key) {
    if (!l1.has(key)) return null;
    const val = l1.get(key);
    l1.delete(key);
    l1.set(key, val); // re-insert at end = most-recently-used
    return val;
  }

  function l1Set(key, translated) {
    if (l1.has(key)) l1.delete(key);
    else if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value); // evict LRU
    l1.set(key, translated);
  }

  function l1Clear() { l1.clear(); }

  // ── L2: IndexedDB persistent cache (1 000 entries, trimmed by timestamp) ──

  const IDB_NAME    = 'pdf-tx-cache';
  const IDB_VERSION = 1;
  const IDB_STORE   = 'translations';
  const IDB_MAX     = 1000;

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
      req.onerror   = (e) => { dbPromise = null; reject(e.target.error); };
    });
    return dbPromise;
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return new Promise(resolve => {
        const req = db.transaction(IDB_STORE, 'readonly')
                      .objectStore(IDB_STORE).get(key);
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
      idbTrim(db).catch(() => {}); // best-effort size trim; non-blocking
    } catch { /* cache write failure is non-fatal */ }
  }

  async function idbTrim(db) {
    const count = await new Promise(resolve => {
      const req = db.transaction(IDB_STORE, 'readonly')
                    .objectStore(IDB_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(0);
    });
    if (count <= IDB_MAX) return;

    const toDelete = count - IDB_MAX;
    await new Promise(resolve => {
      const tx     = db.transaction(IDB_STORE, 'readwrite');
      const cursor = tx.objectStore(IDB_STORE).index('ts').openCursor();
      let   deleted = 0;
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
    } catch { /* best-effort */ }
  }

  // ── In-flight deduplication ────────────────────────────────────────────────
  // Concurrent requests for the same cache key share one promise — one API call.

  const inFlight = new Map();

  // ── Prompt builder ─────────────────────────────────────────────────────────

  function buildPrompt(text, sourceLang, targetLang) {
    const fromClause = (sourceLang && sourceLang !== 'auto')
      ? `from ${sourceLang} `
      : '';
    return (
      `Translate the following text ${fromClause}into ${targetLang}.\n` +
      `Return only the translated text.\n` +
      `Do not explain.\n` +
      `Do not add quotation marks.\n` +
      `Do not add markdown.\n` +
      `Preserve the meaning, tone, punctuation, and line breaks.\n` +
      `If the input is already in ${targetLang}, return it unchanged.\n` +
      `\nText: ${text}`
    );
  }

  // ── Core translate() ───────────────────────────────────────────────────────
  // Returns:
  //   { ok: true,  translated, settings, fromCache: 'l1'|'l2'|false }
  //   { ok: false, errorType, errorMsg, settings }

  async function translate(rawText) {
    const settings = await loadSettings(); // fast: memory-cached after first call

    if (!settings.apiKey) {
      return { ok: false, errorType: 'no-key', errorMsg: 'No Gemini API key configured.', settings };
    }

    const text = normalize(rawText);

    if (!text) {
      return { ok: false, errorType: 'empty', errorMsg: 'Nothing to translate.', settings };
    }

    if (text.length > MAX_CHARS) {
      return {
        ok: false,
        errorType: 'too-long',
        errorMsg: `Selection is too long (${text.length} / ${MAX_CHARS} chars). Shorten your selection.`,
        settings,
      };
    }

    const model = settings.model || DEFAULT_MODEL;
    const key   = makeCacheKey(text, settings.sourceLang, settings.targetLang, model);

    // ── L1 hit ─────────────────────────────────────────────────────────────
    const l1Hit = l1Get(key);
    if (l1Hit !== null) {
      return { ok: true, translated: l1Hit, settings, fromCache: 'l1' };
    }

    // ── L2 hit (IndexedDB, ~5–20 ms) ──────────────────────────────────────
    const l2Hit = await idbGet(key);
    if (l2Hit !== null) {
      l1Set(key, l2Hit);
      return { ok: true, translated: l2Hit, settings, fromCache: 'l2' };
    }

    // ── In-flight dedup ────────────────────────────────────────────────────
    if (inFlight.has(key)) {
      return inFlight.get(key); // reuse pending promise — no second API call
    }

    const promise = callGemini(text, key, settings, model);
    inFlight.set(key, promise);
    promise.finally(() => inFlight.delete(key));
    return promise;
  }

  // ── callGemini ─────────────────────────────────────────────────────────────
  // Fires the Gemini generateContent request.
  // API key is sent in the x-goog-api-key header and is never logged.

  async function callGemini(text, key, settings, model) {
    const endpoint = GEMINI_BASE_URL + encodeURIComponent(model) + ':generateContent';
    const prompt   = buildPrompt(text, settings.sourceLang, settings.targetLang);

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(endpoint, {
        method:  'POST',
        headers: {
          'Content-Type':   'application/json',
          'x-goog-api-key': settings.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature:     0,
            topP:            1,
            maxOutputTokens: 2048,
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        return { ok: false, errorType: 'timeout', errorMsg: 'Request timed out. Check your connection.', settings };
      }
      return { ok: false, errorType: 'network', errorMsg: 'Network error. Check your connection.', settings };
    }
    clearTimeout(timeoutId);

    let data;
    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        errorType: 'parse',
        errorMsg: `Unexpected response (HTTP ${response.status}).`,
        settings,
      };
    }

    if (!response.ok) {
      const status = response.status;
      const apiMsg = data?.error?.message || '';

      if (status === 401 || status === 403) {
        return { ok: false, errorType: 'auth', errorMsg: 'Invalid Gemini API key or unauthorized project.', settings };
      }
      if (status === 404) {
        return { ok: false, errorType: 'model', errorMsg: 'Gemini model unavailable. Check model name in Settings.', settings };
      }
      if (status === 429) {
        return { ok: false, errorType: 'quota', errorMsg: 'Gemini free-tier rate limit reached. Try again later.', settings };
      }
      return {
        ok: false,
        errorType: 'api',
        errorMsg: `Translation failed (HTTP ${status})${apiMsg ? ': ' + apiMsg : ''}.`,
        settings,
      };
    }

    // Robust extraction: join all parts, trim
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      return { ok: false, errorType: 'empty-result', errorMsg: 'Gemini returned an empty result.', settings };
    }

    const translated = parts.map(p => p.text || '').join('').trim();
    if (!translated) {
      return { ok: false, errorType: 'empty-result', errorMsg: 'Gemini returned an empty result.', settings };
    }

    // Write to both caches on success (idbSet is non-blocking)
    l1Set(key, translated);
    idbSet(key, translated);

    return { ok: true, translated, settings, fromCache: false };
  }

  // ── Cache clear ────────────────────────────────────────────────────────────

  async function clearCache() {
    l1Clear();
    await idbClear();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

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
