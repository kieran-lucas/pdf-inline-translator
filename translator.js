'use strict';

// ── Translator ─────────────────────────────────────────────────────────────
// Manages settings storage, two-tier translation cache, in-flight request
// deduplication, and Google Cloud Translation API v2 calls.
// Exposed as window.Translator for settings.js and selection.js.

window.Translator = (() => {

  const KEY_APIKEY = 'tx_api_key';
  const KEY_TARGET = 'tx_target_lang';
  const KEY_SOURCE = 'tx_source_lang';
  const ENDPOINT   = 'https://translation.googleapis.com/language/translate/v2';
  const MAX_CHARS  = 2000;
  const TIMEOUT_MS = 10_000;

  // ── HTML entity decoder ────────────────────────────────────────────────────
  // Google Cloud Translation API v2 returns HTML-encoded text (e.g. &amp;).
  // Decode via a throwaway textarea — never set innerHTML with user content.

  function decodeEntities(str) {
    const tmp = document.createElement('textarea');
    tmp.innerHTML = str;
    return tmp.value;
  }

  // ── Text normalisation ─────────────────────────────────────────────────────

  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Cache key includes all three dimensions that make a translation unique.
  function makeCacheKey(normalizedText, sourceLang, targetLang) {
    return normalizedText + '\x00' + sourceLang + '\x00' + targetLang;
  }

  // ── Settings — with in-memory cache so L1 lookups are truly synchronous ───

  let settingsCache = null; // { apiKey, targetLang, sourceLang } | null

  function loadSettings() {
    if (settingsCache) return Promise.resolve(settingsCache);
    return new Promise(resolve => {
      chrome.storage.local.get([KEY_APIKEY, KEY_TARGET, KEY_SOURCE], result => {
        settingsCache = {
          apiKey:     result[KEY_APIKEY] || '',
          targetLang: result[KEY_TARGET] || 'vi',
          sourceLang: result[KEY_SOURCE] || 'auto',
        };
        resolve(settingsCache);
      });
    });
  }

  function saveSettings({ apiKey, targetLang, sourceLang }) {
    return new Promise(resolve => {
      const data = {
        [KEY_APIKEY]: apiKey     !== undefined ? apiKey     : '',
        [KEY_TARGET]: targetLang !== undefined ? targetLang : 'vi',
        [KEY_SOURCE]: sourceLang !== undefined ? sourceLang : 'auto',
      };
      chrome.storage.local.set(data, () => {
        settingsCache = {
          apiKey:     data[KEY_APIKEY],
          targetLang: data[KEY_TARGET],
          sourceLang: data[KEY_SOURCE],
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
  const l1     = new Map(); // key → translated string

  function l1Get(key) {
    if (!l1.has(key)) return null;
    const val = l1.get(key);
    l1.delete(key);   // remove from position
    l1.set(key, val); // re-insert at end (most-recently-used)
    return val;
  }

  function l1Set(key, translated) {
    if (l1.has(key)) l1.delete(key); // refresh position
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
          store.createIndex('ts', 'ts', { unique: false }); // for oldest-first trim
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
  // Concurrent requests for the same key share one promise — one API call.

  const inFlight = new Map(); // cacheKey → Promise<result>

  // ── Core translate() ───────────────────────────────────────────────────────
  // Returns:
  //   { ok: true,  translated, settings, fromCache: 'l1'|'l2'|false }
  //   { ok: false, errorType, errorMsg, settings }

  async function translate(rawText) {
    const settings = await loadSettings(); // fast: memory-cached after first call

    if (!settings.apiKey) {
      return { ok: false, errorType: 'no-key', errorMsg: 'No API key configured.', settings };
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

    const key = makeCacheKey(text, settings.sourceLang, settings.targetLang);

    // ── L1 hit (synchronous after the settings await) ──────────────────────
    const l1Hit = l1Get(key);
    if (l1Hit !== null) {
      return { ok: true, translated: l1Hit, settings, fromCache: 'l1' };
    }

    // ── L2 hit (IndexedDB, ~5–20 ms) ──────────────────────────────────────
    const l2Hit = await idbGet(key);
    if (l2Hit !== null) {
      l1Set(key, l2Hit); // promote to L1 for subsequent requests
      return { ok: true, translated: l2Hit, settings, fromCache: 'l2' };
    }

    // ── In-flight dedup ────────────────────────────────────────────────────
    if (inFlight.has(key)) {
      return inFlight.get(key); // reuse the pending promise — no second API call
    }

    const promise = callApi(text, key, settings);
    inFlight.set(key, promise);
    promise.finally(() => inFlight.delete(key));
    return promise;
  }

  // ── callApi ────────────────────────────────────────────────────────────────
  // Fires the Google Cloud Translation API request and writes to both caches
  // on success. API key is never logged.

  async function callApi(text, key, settings) {
    const body = { q: text, target: settings.targetLang };
    if (settings.sourceLang && settings.sourceLang !== 'auto') {
      body.source = settings.sourceLang;
    }

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(
        ENDPOINT + '?key=' + encodeURIComponent(settings.apiKey),
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
          signal:  controller.signal,
        }
      );
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
        return { ok: false, errorType: 'auth', errorMsg: 'Invalid or unauthorized API key. Check Settings.', settings };
      }
      if (status === 429) {
        return { ok: false, errorType: 'quota', errorMsg: 'Rate limit or quota reached. Try again later.', settings };
      }
      return {
        ok: false,
        errorType: 'api',
        errorMsg: `Translation failed (HTTP ${status})${apiMsg ? ': ' + apiMsg : ''}.`,
        settings,
      };
    }

    const raw = data?.data?.translations?.[0]?.translatedText;
    if (!raw) {
      return { ok: false, errorType: 'empty-result', errorMsg: 'API returned an empty result.', settings };
    }

    const translated = decodeEntities(raw);

    // Write to both caches. idbSet is non-blocking (fire-and-forget).
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
  };

})();
