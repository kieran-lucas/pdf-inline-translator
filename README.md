# pdf-inline-translator

A lightweight local Chrome extension for high-quality PDF reading with instant inline translation on text selection and double-click.

No accounts, no servers, no tracking. Everything runs locally except the optional Google Cloud Translation API call.

---

## Features

- Open local PDF files or load PDFs from a URL
- Selectable text layer rendered on top of the PDF canvas
- High-DPI (Retina/HiDPI) rendering — sharp at any zoom
- Lazy page rendering — only visible pages are rendered; large PDFs stay smooth
- Select any text → click **Translate** → inline popup with translation
- Double-click any word → popup opens immediately with translation
- Two-tier translation cache (memory + IndexedDB) — repeated lookups are instant
- Google Cloud Translation API for real translation (requires your own API key)
- "Open in Google Translate" fallback button in every popup

---

## Installation

1. Open **chrome://extensions** in Chrome
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the folder that contains `manifest.json` (the root of this project)
5. The extension icon appears in the toolbar — click it to open the PDF reader

To reload after code changes: click the reload icon (↺) on the extension card at chrome://extensions.

---

## Usage

### Opening a PDF

- **Local file** — click **Open File** in the toolbar and select a `.pdf` file from your computer
- **Remote URL** — paste a PDF URL into the text field and click **Load URL**, or press Enter

### Translating text

**Manual selection:**
1. Click and drag to select text in the PDF
2. A blue **Translate** button appears above the selection
3. Click it — the popup opens with a loading spinner, then shows the translation

**Double-click a word:**
1. Double-click any word in the PDF text layer
2. The translation popup opens immediately (no Translate button step)

### Popup actions

- **Copy** — copies the translated text to the clipboard
- **Open in Google Translate ↗** — opens the selected text in Google Translate in a new tab (fallback, works even without an API key)
- **×** — closes the popup (or press **Escape**)

---

## Configuring the Google Cloud Translation API key

The extension uses the [Google Cloud Translation API v2](https://cloud.google.com/translate/docs/reference/rest) (the Basic tier has a free quota).

### Get an API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. Enable the **Cloud Translation API**
4. Go to **APIs & Services → Credentials → Create credentials → API key**
5. (Optional but recommended) Restrict the key to the Cloud Translation API

### Save the key in the extension

1. Click the **⚙** button in the top-right of the PDF reader toolbar
2. Paste your API key into the **Google Cloud API Key** field
3. Set **Target language** (default: `vi` for Vietnamese — use any [BCP-47 code](https://cloud.google.com/translate/docs/languages))
4. Optionally set **Source language** (leave blank for auto-detect)
5. Click **Save**

A green dot appears on the ⚙ button when a key is stored.

To remove the key: open Settings → **Clear Key**.

---

## Notes

- **API key is stored locally** — stored only in `chrome.storage.local` on your device. It is never logged, never sent anywhere except the Google Cloud Translation API endpoint (`translation.googleapis.com`).
- **No unofficial Google Translate endpoint is used** — the extension makes POST requests only to the official `translation.googleapis.com/language/translate/v2` endpoint. The "Open in Google Translate" button opens the official `translate.google.com` website in a new tab.
- **Scanned/image PDFs** — PDFs that are scanned images rather than text documents will not have a selectable text layer. You need a PDF with embedded text (or one that has been OCR'd) for translation to work.
- **PDFs behind login or paywalls** — URL loading will fail for PDFs that require authentication. Download the file first and open it with **Open File** instead.
- **Translation cache** — successful translations are cached in memory (up to 200 entries) and in IndexedDB (up to 1 000 entries). Cached results appear instantly on repeat lookups. To clear the cache: open Settings → **Clear Cache**.
- **Selection length limit** — inline translation is capped at 2 000 characters. Longer selections show a message and offer the Google Translate fallback instead.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No text layer / can't select text | The PDF contains scanned images only | Use an OCR tool to create a text-layer PDF |
| "Could not fetch the PDF" on URL load | CORS restriction or login wall | Download the PDF and use Open File |
| "Invalid or unauthorized API key" | Wrong key or API not enabled | Check the key in Google Cloud Console; ensure Cloud Translation API is enabled |
| "Rate limit or quota reached" | Free tier exhausted or request burst | Wait and try again; check quota in Google Cloud Console |
| "Request timed out" | Slow network or API outage | Check your connection and retry |
| Translation popup doesn't appear on selection | Text layer missing or PDF is image-only | See scanned PDF note above |
| Extension stops working after Chrome update | Extension needs reload | Go to chrome://extensions and click the reload icon for this extension |
| Popup shows stale translation after changing language | Old cache entries use old language key | Click Clear Cache in Settings, then translate again |

---

## Manual QA Checklist

Run through this after any code change or extension reload.

### PDF loading

- [ ] **Load local PDF** — click Open File, select a multi-page PDF, all pages appear as grey placeholders, visible pages render progressively
- [ ] **Load URL PDF** — paste a public PDF URL, click Load URL, PDF loads correctly
- [ ] **Invalid URL** — enter `not-a-url`, expect a clear error message
- [ ] **Non-PDF file** — select a `.jpg` via Open File, expect "not a valid PDF" error

### Rendering quality

- [ ] **Zoom levels** — change zoom to 50%, 150%, 300%; text and images should remain sharp at each level (no blurry upscaling)
- [ ] **Scroll a multi-page PDF** — scroll through a 10+ page document; pages outside the viewport are placeholders, pages entering the viewport render smoothly without jank

### Text selection and translation

- [ ] **Select text and Translate** — drag-select a sentence; Translate button appears; click it; popup shows spinner then translation
- [ ] **Double-click a word** — popup opens immediately, no Translate button step
- [ ] **Close with Escape** — press Escape while popup is open; popup closes
- [ ] **Close with ×** — click the × button; popup closes
- [ ] **Click outside popup** — click anywhere outside the popup; popup closes

### Translation correctness

- [ ] **Without API key** — clear key in Settings; translate any word; popup shows "No API key" message with ⚙ Open Settings button and Google Translate fallback
- [ ] **Invalid API key** — save a fake key; translate; popup shows auth error with fallback button
- [ ] **Valid API key** — save a real key; translate; popup shows translation in the target language
- [ ] **Copy button** — after a successful translation, click Copy; paste somewhere to verify the text
- [ ] **Google Translate fallback** — click "Open in Google Translate ↗"; new tab opens with the text pre-filled at translate.google.com

### Cache behaviour

- [ ] **Cache hit (memory)** — translate a word, close popup, double-click same word immediately; result appears with no network request (check DevTools → Network)
- [ ] **Cache hit (persistent)** — translate a word, reload the extension viewer tab (Ctrl+R), double-click same word; result appears from IndexedDB, no API call
- [ ] **Clear cache** — open Settings → Clear Cache; translate same word again; network request fires

### Edge cases

- [ ] **Long selection limit** — select more than 2 000 characters; popup shows length warning and fallback button, no API call
- [ ] **Rapid double-click same word** — double-click 3–4 times quickly; only one API call should appear in DevTools → Network
- [ ] **Select new text before old request returns** — select one word, immediately select a different word and click Translate; only the second translation appears in the popup

### Extension lifecycle

- [ ] **Reload extension** — go to chrome://extensions, reload the extension, open viewer again; everything works
- [ ] **Settings persist** — save API key, reload extension, open Settings; key is still saved (shown as masked dots in the field, green dot on ⚙ button)
- [ ] **No console errors** — open DevTools Console; normal use should produce no errors or warnings
