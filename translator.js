'use strict';

// Translation pipeline: settings, dictionary, L1/L2 cache, request dedupe,
// interactive Gemini streaming, model fallback, and idle visible-word prefetch.

window.Translator = (() => {
  const DEBUG_TRANSLATION_PERF = false;

  const KEY_APIKEY    = 'tx_api_key';
  const KEY_TARGET    = 'tx_target_lang';
  const KEY_SOURCE    = 'tx_source_lang';
  const KEY_MODEL     = 'tx_gemini_model';
  const KEY_PREFETCH  = 'tx_prefetch_enabled';
  const KEY_STREAMING = 'tx_streaming_enabled';

  const DEFAULT_MODEL       = 'gemini-2.5-flash-lite';
  const FALLBACK_MODEL      = 'gemini-2.5-flash';
  const GEMINI_BASE_URL     = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const MAX_CHARS           = 2000;
  const TIMEOUT_MS          = 15_000;
  const PREFETCH_BATCH_MAX  = 40;
  const PREFETCH_INTERVAL   = 2500;
  const PREFETCH_429_PAUSE  = 60_000;

  function perf(...args) {
    if (DEBUG_TRANSLATION_PERF) console.debug('[tx-perf]', ...args);
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isSingleWord(text) {
    return /^[\p{L}\p{N}_]+(?:['\u2019\u2018\-\u2010\u2011][\p{L}\p{N}_]+)*$/u.test(text);
  }

  function isPrefetchWord(text) {
    return /^[\p{L}\p{N}_-]{3,24}$/u.test(text) && !/^\d+$/.test(text);
  }

  function makeCacheKey(normalizedText, sourceLang, targetLang, model) {
    return normalizedText + '\x00' + sourceLang + '\x00' + targetLang + '\x00' + model;
  }

  let settingsCache = null;

  function loadSettings() {
    if (settingsCache) return Promise.resolve(settingsCache);
    return new Promise(resolve => {
      chrome.storage.local.get(
        [KEY_APIKEY, KEY_TARGET, KEY_SOURCE, KEY_MODEL, KEY_PREFETCH, KEY_STREAMING],
        result => {
          settingsCache = {
            apiKey: result[KEY_APIKEY] || '',
            targetLang: result[KEY_TARGET] || 'vi',
            sourceLang: result[KEY_SOURCE] || 'auto',
            model: result[KEY_MODEL] || DEFAULT_MODEL,
            enablePrefetch: result[KEY_PREFETCH] !== false,
            enableStreaming: result[KEY_STREAMING] !== false,
          };
          resolve(settingsCache);
        }
      );
    });
  }

  function saveSettings({ apiKey, targetLang, sourceLang, model, enablePrefetch, enableStreaming }) {
    return new Promise(resolve => {
      const data = {
        [KEY_APIKEY]: apiKey !== undefined ? apiKey : '',
        [KEY_TARGET]: targetLang !== undefined ? targetLang : 'vi',
        [KEY_SOURCE]: sourceLang !== undefined ? sourceLang : 'auto',
        [KEY_MODEL]: model !== undefined ? model : DEFAULT_MODEL,
        [KEY_PREFETCH]: enablePrefetch !== undefined ? !!enablePrefetch : true,
        [KEY_STREAMING]: enableStreaming !== undefined ? !!enableStreaming : true,
      };
      chrome.storage.local.set(data, () => {
        settingsCache = {
          apiKey: data[KEY_APIKEY],
          targetLang: data[KEY_TARGET],
          sourceLang: data[KEY_SOURCE],
          model: data[KEY_MODEL],
          enablePrefetch: data[KEY_PREFETCH],
          enableStreaming: data[KEY_STREAMING],
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

  const L1_MAX = 500;
  const l1 = new Map();

  function l1Get(key) {
    if (!l1.has(key)) return null;
    const val = l1.get(key);
    l1.delete(key);
    l1.set(key, val);
    return val;
  }

  function l1Set(key, translated, source = 'memory') {
    if (l1.has(key)) l1.delete(key);
    else if (l1.size >= L1_MAX) l1.delete(l1.keys().next().value);
    l1.set(key, { translated, source });
  }

  const IDB_NAME = 'pdf-tx-cache';
  const IDB_VERSION = 1;
  const IDB_STORE = 'translations';
  const IDB_MAX = 3000;
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
      req.onerror = (e) => { dbPromise = null; reject(e.target.error); };
    });
    return dbPromise;
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return new Promise(resolve => {
        const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result?.translated ?? null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function idbSet(key, translated) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ key, translated, ts: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
      idbTrim(db).catch(() => {});
    } catch {}
  }

  async function idbTrim(db) {
    const count = await new Promise(resolve => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
    if (count <= IDB_MAX) return;
    await new Promise(resolve => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const cursor = tx.objectStore(IDB_STORE).index('ts').openCursor();
      let deleted = 0;
      const toDelete = count - IDB_MAX;
      cursor.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && deleted < toDelete) {
          cur.delete();
          deleted++;
          cur.continue();
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  async function idbClear() {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch {}
  }

  function dictionaryLookup(text, settings) {
    return window.LocalDictionary?.lookup?.(text, settings.sourceLang, settings.targetLang) || null;
  }

  function maxTokensFor(text) {
    if (isSingleWord(text)) return 64;
    if (text.length < 300) return 128;
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
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function isModelUnavailable(result) {
    return result?.errorType === 'model' || result?.status === 404;
  }

  const inFlight = new Map();

  async function translate(rawText, options = {}) {
    const t0 = performance.now();
    const savedSettings = await loadSettings();
    const settings = {
      ...savedSettings,
      sourceLang: options.sourceLang || savedSettings.sourceLang,
      targetLang: options.targetLang || savedSettings.targetLang,
      model: options.model || savedSettings.model,
      enableStreaming: options.preferStreaming !== undefined
        ? !!options.preferStreaming
        : savedSettings.enableStreaming,
    };
    const onPartial = options.onPartial || options.onChunk;
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

    const cacheText = isSingleWord(text) ? text.toLowerCase() : text;
    const model = settings.model || DEFAULT_MODEL;
    const key = makeCacheKey(cacheText, settings.sourceLang, settings.targetLang, model);

    const l1Hit = l1Get(key);
    if (l1Hit !== null) {
      perf('l1 hit', text, Math.round(performance.now() - t0) + 'ms');
      return {
        ok: true,
        translated: l1Hit.translated,
        settings,
        fromCache: l1Hit.source === 'prefetch' ? 'prefetch' : 'memory',
        source: l1Hit.source,
      };
    }

    const dictHit = dictionaryLookup(text, settings);
    if (dictHit) {
      l1Set(key, dictHit, 'dictionary');
      idbSet(key, dictHit);
      perf('dictionary hit', text);
      return { ok: true, translated: dictHit, settings, fromCache: 'dictionary', source: 'dictionary' };
    }

    const l2Hit = await idbGet(key);
    if (l2Hit !== null) {
      l1Set(key, l2Hit, 'idb');
      perf('idb hit', text, Math.round(performance.now() - t0) + 'ms');
      return { ok: true, translated: l2Hit, settings, fromCache: 'idb', source: 'idb' };
    }

    const prefetchPromise = prefetchPromises.get(cacheText);
    if (prefetchPromise) {
      await prefetchPromise.catch(() => null);
      const warmed = l1Get(key);
      if (warmed !== null) {
        perf('prefetch attach hit', text);
        return { ok: true, translated: warmed.translated, settings, fromCache: 'prefetch', source: warmed.source };
      }
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
    let result = null;

    if (settings.enableStreaming && options.onPartial) {
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
        l1Set(key, result.translated, 'memory');
        idbSet(key, result.translated);
      }
    }
    perf('request duration', Math.round(performance.now() - start) + 'ms');
    return result;
  }

  function requestBody(prompt, maxOutputTokens) {
    return JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        topP: 1,
        maxOutputTokens,
      },
    });
  }

  function linkAbortSignal(controller, signal) {
    if (!signal) return () => {};
    if (signal.aborted) {
      controller.abort();
      return () => {};
    }
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  async function callGeminiOnce(text, key, settings, model, signal) {
    const endpoint = GEMINI_BASE_URL + encodeURIComponent(model) + ':generateContent';
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, signal);
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': settings.apiKey,
        },
        body: requestBody(buildPrompt(text, settings.sourceLang, settings.targetLang), maxTokensFor(text)),
        signal: controller.signal,
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
    l1Set(key, translated, 'memory');
    idbSet(key, translated);
    return { ok: true, translated, settings, fromCache: false };
  }

  async function callGeminiStream(text, key, settings, model, options) {
    const endpoint = GEMINI_BASE_URL + encodeURIComponent(model) + ':streamGenerateContent?alt=sse';
    let response;
    const started = performance.now();
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, options.signal);
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': settings.apiKey,
        },
        body: requestBody(buildPrompt(text, settings.sourceLang, settings.targetLang), maxTokensFor(text)),
        signal: controller.signal,
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
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
    l1Set(key, translated, 'memory');
    idbSet(key, translated);
    return { ok: true, translated, settings, fromCache: false, streamed: true };
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
      prefetchPausedUntil = Date.now() + PREFETCH_429_PAUSE;
      perf('429 pause prefetch', PREFETCH_429_PAUSE + 'ms');
      return { ok: false, status, errorType: 'quota', errorMsg: 'Gemini free-tier rate limit reached. Try again later.', settings };
    }
    return {
      ok: false,
      status,
      errorType: 'api',
      errorMsg: `Translation failed (HTTP ${status})${apiMsg ? ': ' + apiMsg : ''}.`,
      settings,
    };
  }

  const pendingPrefetch = new Set();
  const prefetchPromises = new Map();
  let prefetchQueue = [];
  let prefetchTimer = null;
  let lastPrefetchAt = 0;
  let prefetchPausedUntil = 0;
  let lastScrollAt = 0;

  window.addEventListener('scroll', () => {
    lastScrollAt = Date.now();
  }, { passive: true });

  function scheduleIdle(fn, timeout = 1500) {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(fn, { timeout });
    } else {
      setTimeout(() => fn({ timeRemaining: () => 20 }), timeout);
    }
  }

  async function hasCachedWord(word, settings) {
    const text = normalize(word);
    const key = makeCacheKey(text, settings.sourceLang, settings.targetLang, settings.model || DEFAULT_MODEL);
    if (l1Get(key) !== null) return true;
    if (dictionaryLookup(text, settings)) return true;
    const hit = await idbGet(key);
    if (hit !== null) {
      l1Set(key, hit, 'idb');
      return true;
    }
    return false;
  }

  function queuePrefetchWords(words) {
    if (!Array.isArray(words) || !words.length) return;
    loadSettings().then(async settings => {
      if (!settings.enablePrefetch || !settings.apiKey || settings.targetLang !== 'vi') return;
      const candidates = [];
      const seen = new Set();
      for (const raw of words) {
        const word = normalize(raw).toLowerCase();
        if (!isPrefetchWord(word) || seen.has(word) || pendingPrefetch.has(word)) continue;
        seen.add(word);
        if (await hasCachedWord(word, settings)) continue;
        pendingPrefetch.add(word);
        candidates.push(word);
        if (candidates.length >= PREFETCH_BATCH_MAX) break;
      }
      if (!candidates.length) return;
      prefetchQueue.push(...candidates);
      prefetchQueue = Array.from(new Set(prefetchQueue)).slice(0, 160);
      perf('prefetch queued word count', candidates.length);
      schedulePrefetch();
    }).catch(() => {});
  }

  function schedulePrefetch() {
    if (prefetchTimer) return;
    scheduleIdle(() => {
      prefetchTimer = null;
      runPrefetchBatch().catch(() => {});
    }, 1200);
    prefetchTimer = true;
  }

  async function runPrefetchBatch() {
    const now = Date.now();
    if (!prefetchQueue.length) return;
    if (inFlight.size > 0 ||
        now < prefetchPausedUntil ||
        now - lastScrollAt < 450 ||
        now - lastPrefetchAt < PREFETCH_INTERVAL) {
      setTimeout(schedulePrefetch, 700);
      return;
    }

    const settings = await loadSettings();
    if (!settings.enablePrefetch || !settings.apiKey) return;
    const rawBatch = prefetchQueue.splice(0, PREFETCH_BATCH_MAX);
    const batch = [];
    for (const word of rawBatch) {
      if (await hasCachedWord(word, settings)) {
        pendingPrefetch.delete(word);
        continue;
      }
      batch.push(word);
    }
    if (!batch.length) return;

    lastPrefetchAt = Date.now();
    perf('prefetch batch size', batch.length);
    const batchPromise = callPrefetchBatch(batch, settings);
    for (const word of batch) prefetchPromises.set(word, batchPromise);
    const result = await batchPromise;
    for (const word of batch) {
      pendingPrefetch.delete(word);
      prefetchPromises.delete(word);
    }
    if (result?.ok && prefetchQueue.length) schedulePrefetch();
  }

  async function callPrefetchBatch(words, settings) {
    const started = performance.now();
    const prompt =
      'Translate the following English words into Vietnamese.\n' +
      'Return valid minified JSON only.\n' +
      'Use the original input word as key.\n' +
      'Do not explain.\n' +
      'Do not add markdown.\n\n' +
      'Words:\n' + JSON.stringify(words);

    let model = settings.model || DEFAULT_MODEL;
    let response;
    try {
      response = await fetchPrefetchModel(model, prompt, settings);
      if (response.status === 404 && model !== FALLBACK_MODEL) {
        model = FALLBACK_MODEL;
        response = await fetchPrefetchModel(model, prompt, settings);
      }
    } catch {
      return { ok: false };
    }

    const data = await parseJsonResponse(response);
    if (!response.ok) {
      if (response.status === 429) prefetchPausedUntil = Date.now() + PREFETCH_429_PAUSE;
      if (response.status === 429) perf('429 pause prefetch', PREFETCH_429_PAUSE + 'ms');
      return { ok: false };
    }

    let raw = extractText(data).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false };
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false };

    for (const word of words) {
      const translated = normalize(parsed[word]);
      if (!translated) continue;
      const key = makeCacheKey(word, settings.sourceLang, settings.targetLang, settings.model || DEFAULT_MODEL);
      l1Set(key, translated, 'prefetch');
      idbSet(key, translated);
      if (model !== (settings.model || DEFAULT_MODEL)) {
        const fallbackKey = makeCacheKey(word, settings.sourceLang, settings.targetLang, model);
        l1Set(fallbackKey, translated, 'prefetch');
        idbSet(fallbackKey, translated);
      }
    }
    perf('prefetch duration', Math.round(performance.now() - started) + 'ms');
    return { ok: true };
  }

  function fetchPrefetchModel(model, prompt, settings) {
    const endpoint = GEMINI_BASE_URL + encodeURIComponent(model) + ':generateContent';
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey,
      },
      body: requestBody(prompt, 512),
    });
  }

  async function clearCache() {
    l1.clear();
    prefetchQueue = [];
    pendingPrefetch.clear();
    prefetchPromises.clear();
    await idbClear();
  }

  document.addEventListener('pdf-visible-words', (event) => {
    queuePrefetchWords(event.detail?.words || []);
  });

  return {
    loadSettings,
    saveSettings,
    clearApiKey,
    translate,
    queuePrefetchWords,
    clearCache,
    MAX_CHARS,
    DEFAULT_MODEL,
  };
})();
