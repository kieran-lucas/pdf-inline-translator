'use strict';

window.LexicalDB = (() => {
  const CORE_URL = 'dictionaries/en-vi-core.json';
  const DB_NAME = 'lexical-db';
  const DB_VERSION = 1;
  const STORE_ENTRIES = 'entries';
  const STORE_FORMS = 'formIndex';
  const STORE_META = 'metadata';
  const META_FULL_DICT = 'fullDictMeta';

  let initPromise = null;
  let ready = false;
  let coreMap = new Map();
  let coreFormMap = new Map();
  let dbPromise = null;

  function normalizeLookupKey(text) {
    return String(text || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
  }

  function isSingleWord(text) {
    return /^[\p{L}\p{N}_]+(?:[‘’‘\-‐‑][\p{L}\p{N}_]+)*$/u.test(text);
  }

  function supportsLanguages(sourceLang, targetLang) {
    const src = String(sourceLang || 'auto').toLowerCase();
    const tgt = String(targetLang || 'vi').toLowerCase();
    return tgt === 'vi' && (src === '' || src === 'auto' || src === 'en' || src === 'eng' || src === 'english');
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        const url = chrome.runtime.getURL(CORE_URL);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Core dictionary HTTP ${response.status}`);
        const data = await response.json();
        const entries = data?.entries || {};
        coreMap = new Map();
        coreFormMap = new Map();
        for (const [key, entry] of Object.entries(entries)) {
          const normalized = normalizeLookupKey(key || entry.lemma);
          if (!normalized) continue;
          const normalizedEntry = normalizeEntry(entry, normalized);
          coreMap.set(normalized, normalizedEntry);
          for (const form of normalizedEntry.forms || []) {
            const formKey = normalizeLookupKey(form);
            if (formKey && !coreFormMap.has(formKey)) coreFormMap.set(formKey, normalized);
          }
        }
        ready = true;
      } catch (err) {
        ready = false;
        coreMap = new Map();
        coreFormMap = new Map();
      }
      return ready;
    })();
    return initPromise;
  }

  function normalizeEntry(entry, fallbackLemma) {
    return {
      lemma: entry.lemma || fallbackLemma,
      language: entry.language || 'en',
      frequencyRank: entry.frequencyRank ?? null,
      forms: Array.isArray(entry.forms) ? entry.forms : [],
      pos: Array.isArray(entry.pos) ? entry.pos : [],
      pronunciations: Array.isArray(entry.pronunciations) ? entry.pronunciations : [],
      senses: Array.isArray(entry.senses) ? entry.senses : [],
      source: entry.source || {},
      quality: entry.quality || {},
    };
  }

  function safeLemmaFallback(key) {
    const candidates = [];
    if (key.endsWith('ies') && key.length > 4) candidates.push(key.slice(0, -3) + 'y');
    if (key.endsWith('ied') && key.length > 4) candidates.push(key.slice(0, -3) + 'y');
    if (key.endsWith('ying') && key.length > 5) candidates.push(key.slice(0, -4) + 'ie');
    if (key.endsWith('ing') && key.length > 5) candidates.push(key.slice(0, -3));
    if (key.endsWith('ed') && key.length > 4) candidates.push(key.slice(0, -2));
    if (key.endsWith('es') && key.length > 4) candidates.push(key.slice(0, -2));
    if (key.endsWith('s') && key.length > 3) candidates.push(key.slice(0, -1));
    return candidates;
  }

  function getCompactMeaning(entry) {
    const meanings = [];
    for (const sense of entry?.senses || []) {
      for (const meaning of sense.viMeanings || []) {
        const text = String(meaning || '').trim();
        if (text && !meanings.includes(text)) meanings.push(text);
        if (meanings.length >= 5) break;
      }
      if (meanings.length >= 5) break;
    }
    const compact = meanings.join('; ');
    return compact.length > 120 ? compact.slice(0, 117).trimEnd() + '...' : compact;
  }

  function makeResult(entry, source, displayText) {
    return {
      ok: true,
      source,
      lemma: entry.lemma,
      displayText,
      compactMeaning: getCompactMeaning(entry),
      entry,
    };
  }

  async function lookupCore(text, options = {}) {
    if (!supportsLanguages(options.sourceLang, options.targetLang)) {
      return { ok: false, reason: 'unsupported-language' };
    }
    const displayText = String(text || '').trim();
    const key = normalizeLookupKey(displayText);
    if (!key || !isSingleWord(key)) return { ok: false, reason: 'not-single-word' };
    await init();
    if (!ready) return { ok: false, reason: 'disabled' };

    let entry = coreMap.get(key);
    if (entry) return makeResult(entry, 'core-dictionary', displayText);
    const formLemma = coreFormMap.get(key);
    if (formLemma && coreMap.has(formLemma)) return makeResult(coreMap.get(formLemma), 'core-dictionary', displayText);
    for (const candidate of safeLemmaFallback(key)) {
      entry = coreMap.get(candidate);
      if (entry) return makeResult(entry, 'core-dictionary', displayText);
    }
    return { ok: false, reason: 'not-found' };
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
          db.createObjectStore(STORE_ENTRIES, { keyPath: 'lemma' });
        }
        if (!db.objectStoreNames.contains(STORE_FORMS)) {
          db.createObjectStore(STORE_FORMS, { keyPath: 'form' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };
      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => { dbPromise = null; reject(event.target.error); };
    });
    return dbPromise;
  }

  async function idbGet(storeName, key) {
    try {
      const db = await openDb();
      return await new Promise(resolve => {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  async function lookupFull(text, options = {}) {
    if (options.allowFullLookup === false) return { ok: false, reason: 'disabled' };
    if (!supportsLanguages(options.sourceLang, options.targetLang)) {
      return { ok: false, reason: 'unsupported-language' };
    }
    const displayText = String(text || '').trim();
    const key = normalizeLookupKey(displayText);
    if (!key || !isSingleWord(key)) return { ok: false, reason: 'not-single-word' };

    let entry = await idbGet(STORE_ENTRIES, key);
    if (entry) return makeResult(normalizeEntry(entry, key), 'full-dictionary', displayText);
    const formRecord = await idbGet(STORE_FORMS, key);
    if (formRecord?.lemma) {
      entry = await idbGet(STORE_ENTRIES, formRecord.lemma);
      if (entry) return makeResult(normalizeEntry(entry, formRecord.lemma), 'full-dictionary', displayText);
    }
    for (const candidate of safeLemmaFallback(key)) {
      entry = await idbGet(STORE_ENTRIES, candidate);
      if (entry) return makeResult(normalizeEntry(entry, candidate), 'full-dictionary', displayText);
    }
    return { ok: false, reason: 'not-found' };
  }

  async function lookupWord(text, options = {}) {
    const core = await lookupCore(text, options);
    if (core.ok) return core;
    if (core.reason === 'not-single-word' || core.reason === 'unsupported-language') return core;
    return lookupFull(text, options);
  }

  async function importEntries(entries) {
    const db = await openDb();
    const list = Array.isArray(entries) ? entries : Object.values(entries || {});
    const stats = { imported: 0, skipped: 0, errors: 0 };
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_ENTRIES, STORE_FORMS, STORE_META], 'readwrite');
      const entryStore = tx.objectStore(STORE_ENTRIES);
      const formStore = tx.objectStore(STORE_FORMS);
      for (const entry of list) {
        const normalized = normalizeLookupKey(entry?.lemma);
        if (!normalized) {
          stats.skipped++;
          continue;
        }
        const record = normalizeEntry(entry, normalized);
        record.lemma = normalized;
        entryStore.put(record);
        for (const form of record.forms || []) {
          const formKey = normalizeLookupKey(form);
          if (formKey) formStore.put({ form: formKey, lemma: normalized });
        }
        stats.imported++;
      }
      tx.objectStore(STORE_META).put({ key: 'updatedAt', value: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = (event) => {
        stats.errors++;
        reject(event.target.error);
      };
    });
    return stats;
  }

  function idleTick() {
    return new Promise(resolve => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => resolve(), { timeout: 250 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  async function saveImportMeta(meta) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readwrite');
        tx.objectStore(STORE_META).put({ key: META_FULL_DICT, ...meta });
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
    } catch { /* non-fatal */ }
  }

  async function getFullDictionaryStats() {
    try {
      const meta = await idbGet(STORE_META, META_FULL_DICT);
      if (!meta) {
        return { imported: false, importedCount: 0, importedAt: null, sourceFileName: null, sourceFileSize: null };
      }
      return {
        imported: true,
        importedCount: meta.importedCount || 0,
        importedAt: meta.importedAt || null,
        sourceFileName: meta.sourceFileName || null,
        sourceFileSize: meta.sourceFileSize || null,
      };
    } catch {
      return { imported: false, importedCount: 0, importedAt: null, sourceFileName: null, sourceFileSize: null };
    }
  }

  async function clearFullDictionary() {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_ENTRIES, STORE_FORMS, STORE_META], 'readwrite');
        tx.objectStore(STORE_ENTRIES).clear();
        tx.objectStore(STORE_FORMS).clear();
        const metaStore = tx.objectStore(STORE_META);
        metaStore.delete(META_FULL_DICT);
        metaStore.delete('updatedAt');
        tx.oncomplete = resolve;
        tx.onerror = (e) => reject(e.target.error);
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function importJsonlText(text, options = {}) {
    const t0 = Date.now();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const batchSize = Math.max(1, options.batchSize || 500);
    const stats = { imported: 0, skipped: 0, errors: 0, elapsedMs: 0 };
    let batch = [];

    async function flush() {
      if (!batch.length) return;
      const result = await importEntries(batch);
      stats.imported += result.imported;
      stats.skipped += result.skipped;
      stats.errors += result.errors;
      stats.elapsedMs = Date.now() - t0;
      batch = [];
      if (onProgress) onProgress({ ...stats });
      await idleTick();
    }

    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        batch.push(JSON.parse(line));
      } catch {
        stats.errors++;
        continue;
      }
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    stats.elapsedMs = Date.now() - t0;
    return stats;
  }

  async function importJsonlFile(file, options = {}) {
    if (!file) return { imported: 0, skipped: 0, errors: 1, elapsedMs: 0 };
    const t0 = Date.now();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const batchSize = Math.max(1, options.batchSize || 500);
    const stats = { imported: 0, skipped: 0, errors: 0, elapsedMs: 0 };
    let batch = [];

    async function flush() {
      if (!batch.length) return;
      const result = await importEntries(batch);
      stats.imported += result.imported;
      stats.skipped += result.skipped;
      stats.errors += result.errors;
      stats.elapsedMs = Date.now() - t0;
      batch = [];
      if (onProgress) onProgress({ ...stats });
      await idleTick();
    }

    if (!file.stream || !window.TextDecoderStream) {
      // Fallback: load into memory when streaming is unavailable
      const text = await file.text();
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try { batch.push(JSON.parse(line)); } catch { stats.errors++; }
        if (batch.length >= batchSize) await flush();
      }
    } else {
      // Stream line-by-line — avoids loading the full file into memory
      const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { batch.push(JSON.parse(line)); } catch { stats.errors++; }
          if (batch.length >= batchSize) await flush();
        }
      }
      if (buffer.trim()) {
        try { batch.push(JSON.parse(buffer)); } catch { stats.errors++; }
      }
    }

    await flush();
    stats.elapsedMs = Date.now() - t0;

    await saveImportMeta({
      importedAt: Date.now(),
      importedCount: stats.imported,
      sourceFileName: file.name || '',
      sourceFileSize: file.size || 0,
    });

    return stats;
  }

  function isReady() {
    return ready;
  }

  function clearRuntimeCache() {
    initPromise = null;
    ready = false;
    coreMap = new Map();
    coreFormMap = new Map();
  }

  init().catch(() => {});

  return {
    init,
    lookupWord,
    lookupCore,
    lookupFull,
    normalizeLookupKey,
    getCompactMeaning,
    isReady,
    clearRuntimeCache,
    importEntries,
    importJsonlText,
    importJsonlFile,
    getFullDictionaryStats,
    clearFullDictionary,
  };
})();
