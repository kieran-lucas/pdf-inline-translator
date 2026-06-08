# pdf-inline-translator

A lightweight local Chrome extension for high-quality PDF reading with instant inline translation on text selection and double-click.

No accounts, no servers, no tracking. Everything runs locally except the Gemini API call you configure with your own key.

---

## Features

- Open local PDF files or load PDFs from a URL
- Selectable text layer rendered on top of the PDF canvas
- High-DPI (Retina/HiDPI) rendering — sharp at any zoom level
- Lazy page rendering — only visible pages are rendered; large PDFs stay smooth
- Select any text → click **Translate** → inline popup with translation
- Double-click any word → popup opens immediately with translation
- Two-tier translation cache (memory + IndexedDB) — repeated lookups are instant
- Offline English-to-Vietnamese lexical dictionary lookup before Gemini
- Gemini API fallback for sentence translation and dictionary misses when enabled

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
- **More** — expands rich offline dictionary entries when extra senses or examples are available
- **×** — closes the popup (or press **Escape**)

---

## Setting up the Gemini API key

The extension uses the [Gemini API](https://ai.google.dev/) via Google AI Studio. A free API key is available with a generous daily quota.

### Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with your Google account
3. Click **Get API key** → **Create API key**
4. Copy the generated key

> **Security:** Treat this key like a password. Do not commit it, share it, or paste it into any untrusted tool. If your key is exposed, delete it in AI Studio and create a new one.

### Configure the extension

1. Click the **⚙** button in the top-right of the PDF reader toolbar
2. Paste your Gemini API key into the **Gemini API Key** field
3. Set **Gemini model** — default is `gemini-2.5-flash` (fast and capable; change only if needed)
4. Set **Target language** — default is `vi` (Vietnamese); use any [BCP-47 language code](https://cloud.google.com/translate/docs/languages)
5. Optionally set **Source language** — leave blank for automatic detection
6. Click **Save**

A green dot appears on the ⚙ button when a key is stored.

To remove the key: open Settings → **Clear Key**.

---

## Notes

- **API key is stored locally** — stored only in `chrome.storage.local` on your device. It is sent only to `generativelanguage.googleapis.com` in the `x-goog-api-key` request header. It is never logged, never stored in the translation cache, never put in a URL query string.
- **No external translation fallback UI** — dictionary lookup is offline-first, and optional translation fallback uses only the configured Gemini API (`generativelanguage.googleapis.com`).
- **Dictionary builder** — `tools/dictionary-builder` can generate reviewed offline dictionary files from Kaikki/Wiktionary, Open English WordNet, and CMUdict. Source downloads are explicit developer commands and raw dumps are ignored.
- **Scanned / image PDFs** — PDFs that are scanned images rather than embedded text will not have a selectable text layer. You need a PDF with embedded text (or one that has been OCR'd) for translation to work.
- **PDFs behind login or paywalls** — URL loading will fail for PDFs that require authentication. Download the file first and open it with **Open File** instead.
- **Translation cache** — successful translations are cached in memory (up to 200 entries) and in IndexedDB (up to 1 000 entries). Cached results appear instantly on repeat lookups. Cache key includes: normalized text, source language, target language, and Gemini model. To clear: open Settings → **Clear Cache**.
- **Selection length limit** — inline translation is capped at 2 000 characters. Longer selections show a message and do not call Gemini.
- **Model names** — if a model becomes unavailable (HTTP 404), try another model name in Settings (e.g. `gemini-1.5-flash`, `gemini-2.0-flash`).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No text layer / can't select text | PDF contains scanned images only | Use an OCR tool to add a text layer |
| "Could not fetch the PDF" on URL load | CORS restriction or login wall | Download the PDF and use Open File |
| "No Gemini API key configured" | Key not saved yet | Open ⚙ Settings, paste key, click Save |
| "Invalid Gemini API key or unauthorized project" | Wrong key or billing issue | Verify the key at aistudio.google.com; check API is enabled |
| "Gemini model unavailable" | Model name is wrong or deprecated | Open Settings, correct the model name (e.g. `gemini-2.5-flash`) |
| "Gemini free-tier rate limit reached" | Too many requests in a short period | Wait a moment and try again |
| "Request timed out" | Slow network or Gemini outage | Check your connection and retry |
| Translation popup doesn't appear | Text layer missing or PDF is image-only | See scanned PDF note above |
| Extension stops working after Chrome update | Extension needs reload | Go to chrome://extensions and click ↺ |
| Popup shows stale translation after changing language or model | Old cache entries use old key | Click Clear Cache in Settings, then translate again |

---

## Manual QA Checklist

Run through this after any code change or extension reload.

### PDF loading

- [ ] Load a local multi-page PDF — pages appear as grey placeholders, visible pages render progressively
- [ ] Load a PDF from a public URL — PDF loads and renders correctly
- [ ] Enter an invalid URL — clear error message appears
- [ ] Open a non-PDF file — "not a valid PDF" error appears

### Rendering quality

- [ ] Change zoom to 50%, 150%, 300% — text and images are sharp at each level
- [ ] Scroll through a 10+ page PDF — off-screen pages stay as placeholders; pages entering the viewport render smoothly

### Translation

- [ ] Drag-select text → click Translate → spinner → translation appears in popup
- [ ] Double-click a word → popup opens directly → translation appears
- [ ] Press Escape — popup closes
- [ ] Click × — popup closes
- [ ] Click outside popup — popup closes

### API key scenarios

- [ ] No key saved → popup shows "No Gemini API key configured" with ⚙ Open Settings
- [ ] Invalid key saved → popup shows "Invalid Gemini API key or unauthorized project"
- [ ] Valid key saved → popup shows correct translation in the target language
- [ ] Copy button → paste elsewhere to verify the translated text

### Cache behaviour

- [ ] Translate a word; immediately double-click same word → no network request (DevTools → Network)
- [ ] Translate a word; reload the viewer tab (Ctrl+R); double-click same word → result from IndexedDB, no API call
- [ ] Open Settings → Clear Cache; translate same word → network request fires

### Edge cases

- [ ] Select more than 2 000 characters → length warning shown, no API call made
- [ ] Rapid double-click same word 4–5 times → only one POST in DevTools → Network
- [ ] Select word A, quickly select word B and click Translate → only word B's translation appears

### Settings

- [ ] Open Settings — label reads "Gemini API Key" (not "Google Cloud API Key")
- [ ] Model field shows and persists correct value after Save + reopen
- [ ] Change model to an invalid name → translate → "Gemini model unavailable" message appears

### Extension lifecycle

- [ ] Reload extension at chrome://extensions, reopen viewer — all features work
- [ ] Save API key, reload extension, open Settings — key persists (green dot on ⚙)
- [ ] Normal use with DevTools Console open — no errors or warnings
