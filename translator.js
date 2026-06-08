'use strict';

// ── Translator ─────────────────────────────────────────────────────────────
// Manages chrome.storage settings and Google Cloud Translation API v2 calls.
// Exposed as window.Translator so settings.js and selection.js can use it
// without a module bundler.

window.Translator = (() => {

  const KEY_APIKEY = 'tx_api_key';
  const KEY_TARGET = 'tx_target_lang';
  const KEY_SOURCE = 'tx_source_lang';
  const ENDPOINT   = 'https://translation.googleapis.com/language/translate/v2';
  const MAX_CHARS  = 2000;

  // ── HTML entity decoder ────────────────────────────────────────────────────
  // Google Cloud Translation API v2 returns HTML-encoded text (e.g. &amp; &#39;).
  // Decode via a throwaway textarea so we never set innerHTML with user data.

  function decodeEntities(str) {
    const tmp = document.createElement('textarea');
    tmp.innerHTML = str;
    return tmp.value;
  }

  // ── Settings storage ───────────────────────────────────────────────────────

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get([KEY_APIKEY, KEY_TARGET, KEY_SOURCE], result => {
        resolve({
          apiKey:     result[KEY_APIKEY] || '',
          targetLang: result[KEY_TARGET] || 'vi',
          sourceLang: result[KEY_SOURCE] || 'auto',
        });
      });
    });
  }

  function saveSettings({ apiKey, targetLang, sourceLang }) {
    return new Promise(resolve => {
      chrome.storage.local.set({
        [KEY_APIKEY]: apiKey     !== undefined ? apiKey     : '',
        [KEY_TARGET]: targetLang !== undefined ? targetLang : 'vi',
        [KEY_SOURCE]: sourceLang !== undefined ? sourceLang : 'auto',
      }, resolve);
    });
  }

  function clearApiKey() {
    return new Promise(resolve => chrome.storage.local.remove(KEY_APIKEY, resolve));
  }

  // ── Translation ────────────────────────────────────────────────────────────
  // Returns:
  //   { ok: true,  translated: string, settings }
  //   { ok: false, errorType: string, errorMsg: string, settings }
  //
  // errorType values: 'no-key' | 'empty' | 'too-long' | 'network' |
  //                   'auth' | 'quota' | 'api' | 'parse' | 'empty-result'

  async function translate(rawText) {
    const settings = await loadSettings();

    if (!settings.apiKey) {
      return { ok: false, errorType: 'no-key', errorMsg: 'No API key configured.', settings };
    }

    const text = rawText.replace(/\s+/g, ' ').trim();

    if (!text) {
      return { ok: false, errorType: 'empty', errorMsg: 'Nothing to translate.', settings };
    }

    if (text.length > MAX_CHARS) {
      return {
        ok: false,
        errorType: 'too-long',
        errorMsg: `Selection is too long (${text.length} / ${MAX_CHARS} chars). Shorten your selection.`,
        settings,
      };
    }

    const body = { q: text, target: settings.targetLang };
    if (settings.sourceLang && settings.sourceLang !== 'auto') {
      body.source = settings.sourceLang;
    }

    let response;
    try {
      // API key travels in the query string per Google Cloud Translation v2 spec.
      // Never log this URL.
      response = await fetch(
        ENDPOINT + '?key=' + encodeURIComponent(settings.apiKey),
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        }
      );
    } catch {
      return {
        ok: false,
        errorType: 'network',
        errorMsg:  'Network error. Check your internet connection.',
        settings,
      };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        errorType: 'parse',
        errorMsg:  `Unexpected response from translation API (HTTP ${response.status}).`,
        settings,
      };
    }

    if (!response.ok) {
      const status = response.status;
      const apiMsg = data?.error?.message || '';

      if (status === 401 || status === 403) {
        return {
          ok: false,
          errorType: 'auth',
          errorMsg:  'Invalid or unauthorized API key. Check your key in Settings.',
          settings,
        };
      }
      if (status === 429) {
        return {
          ok: false,
          errorType: 'quota',
          errorMsg:  'Rate limit or quota reached. Try again later.',
          settings,
        };
      }
      return {
        ok: false,
        errorType: 'api',
        errorMsg:  `Translation failed (HTTP ${status})${apiMsg ? ': ' + apiMsg : ''}.`,
        settings,
      };
    }

    const raw = data?.data?.translations?.[0]?.translatedText;
    if (!raw) {
      return {
        ok: false,
        errorType: 'empty-result',
        errorMsg:  'API returned an empty result.',
        settings,
      };
    }

    return { ok: true, translated: decodeEntities(raw), settings };
  }

  return { loadSettings, saveSettings, clearApiKey, translate, MAX_CHARS };

})();
