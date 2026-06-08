'use strict';

// ── Settings panel ─────────────────────────────────────────────────────────
// Manages the collapsible settings panel UI.
// Reads and writes via window.Translator (loaded before this script).

(function initSettingsPanel() {

  const panel       = document.getElementById('settings-panel');
  const toggle      = document.getElementById('settings-toggle');
  const apiKeyInput = document.getElementById('settings-api-key');
  const targetInput = document.getElementById('settings-target-lang');
  const sourceInput = document.getElementById('settings-source-lang');
  const modelInput  = document.getElementById('settings-model');
  const offlineDictionaryInput = document.getElementById('settings-offline-dictionary');
  const geminiFallbackInput = document.getElementById('settings-gemini-fallback');
  const prefetchInput  = document.getElementById('settings-prefetch');
  const streamingInput = document.getElementById('settings-streaming');
  const saveBtn       = document.getElementById('settings-save');
  const clearBtn      = document.getElementById('settings-clear');
  const clearCacheBtn = document.getElementById('settings-clear-cache');
  const statusEl      = document.getElementById('settings-status');

  const fullDictFileInput  = document.getElementById('settings-full-dict-file');
  const fullDictImportBtn  = document.getElementById('settings-full-dict-import');
  const fullDictClearBtn   = document.getElementById('settings-full-dict-clear');
  const fullDictStatusEl   = document.getElementById('settings-full-dict-status');

  let statusTimer = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function showStatus(msg, isError) {
    clearTimeout(statusTimer);
    statusEl.textContent = msg;
    statusEl.className   = 'settings-status ' + (isError ? 'settings-status-error' : 'settings-status-ok');
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className   = 'settings-status';
    }, 3000);
  }

  function setKeyIndicator(hasKey) {
    toggle.dataset.hasKey = hasKey ? '1' : '0';
    toggle.title = hasKey
      ? 'Translation settings — API key is set'
      : 'Translation settings — no API key';
  }

  function setFullDictStatus(msg) {
    if (fullDictStatusEl) fullDictStatusEl.textContent = msg;
  }

  async function refreshFullDictStatus() {
    if (!window.LexicalDB || !window.LexicalDB.getFullDictionaryStats) return;
    try {
      const stats = await window.LexicalDB.getFullDictionaryStats();
      if (stats.imported) {
        const count = stats.importedCount.toLocaleString();
        setFullDictStatus(`Full dictionary: ${count} entries imported`);
      } else {
        setFullDictStatus('Full dictionary: not imported');
      }
    } catch {
      setFullDictStatus('Full dictionary: status unknown');
    }
  }

  async function populateForm() {
    const s = await window.Translator.loadSettings();
    apiKeyInput.value = s.apiKey || '';
    targetInput.value = s.targetLang;
    sourceInput.value = s.sourceLang === 'auto' ? '' : s.sourceLang;
    modelInput.value  = s.model || window.Translator.DEFAULT_MODEL || 'gemini-2.5-flash-lite';
    offlineDictionaryInput.checked = s.enableOfflineDictionary !== false;
    geminiFallbackInput.checked = s.enableGeminiFallback !== false;
    prefetchInput.checked = s.enablePrefetch === true;
    streamingInput.checked = s.enableStreaming !== false;
    setKeyIndicator(!!s.apiKey);
  }

  // ── Toggle open / close ────────────────────────────────────────────────────

  toggle.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('settings-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) {
      populateForm();
      refreshFullDictStatus();
    }
  });

  // ── Save ───────────────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    const apiKey     = apiKeyInput.value.trim();
    const targetLang = targetInput.value.trim() || 'vi';
    const sourceLang = sourceInput.value.trim() || 'auto';
    const model      = modelInput.value.trim()  || window.Translator.DEFAULT_MODEL || 'gemini-2.5-flash-lite';
    const enableOfflineDictionary = offlineDictionaryInput.checked;
    const enableGeminiFallback = geminiFallbackInput.checked;
    const enablePrefetch = prefetchInput.checked;
    const enableStreaming = streamingInput.checked;
    await window.Translator.saveSettings({
      apiKey,
      targetLang,
      sourceLang,
      model,
      enableOfflineDictionary,
      enableGeminiFallback,
      enablePrefetch,
      enableStreaming,
    });
    setKeyIndicator(!!apiKey);
    showStatus('Settings saved.', false);
  });

  // Allow Enter in the API key field to save.
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });

  // ── Clear key ──────────────────────────────────────────────────────────────

  clearBtn.addEventListener('click', async () => {
    await window.Translator.clearApiKey();
    apiKeyInput.value = '';
    setKeyIndicator(false);
    showStatus('API key cleared.', false);
  });

  // ── Clear cache ────────────────────────────────────────────────────────────

  clearCacheBtn.addEventListener('click', async () => {
    await window.Translator.clearCache();
    showStatus('Translation cache cleared.', false);
  });

  // ── Full dictionary import ─────────────────────────────────────────────────

  if (fullDictImportBtn) {
    fullDictImportBtn.addEventListener('click', async () => {
      const file = fullDictFileInput?.files?.[0];
      if (!file) {
        setFullDictStatus('Select a .jsonl file first.');
        return;
      }
      if (file.size > 100 * 1024 * 1024) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(0);
        const ok = confirm(
          `This file is ${sizeMB} MB. Import may take several minutes and will not block the reader. Continue?`
        );
        if (!ok) return;
      }

      fullDictImportBtn.disabled = true;
      if (fullDictClearBtn) fullDictClearBtn.disabled = true;
      setFullDictStatus('Starting import…');

      try {
        const stats = await window.LexicalDB.importJsonlFile(file, {
          onProgress(s) {
            const elapsed = (s.elapsedMs / 1000).toFixed(1);
            setFullDictStatus(
              `Importing… ${s.imported.toLocaleString()} entries (${elapsed}s elapsed)`
            );
          },
        });
        const elapsed = (stats.elapsedMs / 1000).toFixed(1);
        setFullDictStatus(
          `Done: ${stats.imported.toLocaleString()} imported, ` +
          `${stats.skipped} skipped, ${stats.errors} errors — ${elapsed}s`
        );
        await refreshFullDictStatus();
      } catch (err) {
        setFullDictStatus(`Import failed: ${err?.message || String(err)}`);
      } finally {
        fullDictImportBtn.disabled = false;
        if (fullDictClearBtn) fullDictClearBtn.disabled = false;
      }
    });
  }

  // ── Full dictionary clear ──────────────────────────────────────────────────

  if (fullDictClearBtn) {
    fullDictClearBtn.addEventListener('click', async () => {
      const ok = confirm('Clear the full IndexedDB dictionary? The core dictionary will remain.');
      if (!ok) return;
      fullDictClearBtn.disabled = true;
      setFullDictStatus('Clearing…');
      try {
        const result = await window.LexicalDB.clearFullDictionary();
        if (result.ok) {
          setFullDictStatus('Full dictionary cleared.');
        } else {
          setFullDictStatus(`Clear failed: ${result.error}`);
        }
      } catch (err) {
        setFullDictStatus(`Clear failed: ${err?.message || String(err)}`);
      } finally {
        fullDictClearBtn.disabled = false;
      }
    });
  }

  // ── Initialize indicator on load (panel stays closed) ─────────────────────

  window.Translator.loadSettings().then(s => setKeyIndicator(!!s.apiKey));

}());
