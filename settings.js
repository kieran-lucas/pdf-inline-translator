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
  const saveBtn       = document.getElementById('settings-save');
  const clearBtn      = document.getElementById('settings-clear');
  const clearCacheBtn = document.getElementById('settings-clear-cache');
  const statusEl      = document.getElementById('settings-status');

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

  async function populateForm() {
    const s = await window.Translator.loadSettings();
    // Show masked key placeholder rather than the real key for visual confirmation.
    apiKeyInput.value = s.apiKey ? s.apiKey : '';
    targetInput.value = s.targetLang;
    sourceInput.value = s.sourceLang === 'auto' ? '' : s.sourceLang;
    setKeyIndicator(!!s.apiKey);
  }

  // ── Toggle open / close ────────────────────────────────────────────────────

  toggle.addEventListener('click', () => {
    const isOpen = panel.classList.toggle('settings-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) populateForm();
  });

  // ── Save ───────────────────────────────────────────────────────────────────

  saveBtn.addEventListener('click', async () => {
    const apiKey     = apiKeyInput.value.trim();
    const targetLang = targetInput.value.trim() || 'vi';
    const sourceLang = sourceInput.value.trim() || 'auto';
    await window.Translator.saveSettings({ apiKey, targetLang, sourceLang });
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

  // ── Initialize indicator on load (panel stays closed) ─────────────────────

  window.Translator.loadSettings().then(s => setKeyIndicator(!!s.apiKey));

}());
