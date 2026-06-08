# Offline lexical dictionaries

`en-vi-core.json` is the active bundled dictionary. The extension loads it at startup for fast, offline English-to-Vietnamese single-word lookup before any Gemini fallback.

## Active core

**Current active core:** ~16,000 entries (18 MB optimized), covering essentially all English words that have Vietnamese translations in Wiktionary.

Why 16k was chosen:
- 8k covered 19/24 key terms — important academic/CS terms like "science", "theorem", "variable", "table", "society" were missing.
- 16k covers 32/33 key terms (only "performance" is absent because Wiktionary has no Vietnamese translation for it).
- 16k gives significantly better coverage for normal PDF reading without approaching the 22 MB size threshold.
- The full JSONL dictionary (769 MB) covers all remaining words but must be imported manually into IndexedDB.

## Runtime lookup order

1. **Memory L1 cache** — last few translations remembered in-session.
2. **16k active core** — in-memory Map, loaded from `en-vi-core.json` at startup.
3. **Full dictionary** — lazy IndexedDB lookup, only if user has imported the JSONL.
4. **Gemini fallback** — API call, only if enabled in settings.

The extension never downloads dictionary data at runtime and does not require Node.js at runtime.

## Loading performance

The core dictionary loads asynchronously after the first browser idle period (via `requestIdleCallback`), so PDF rendering is never blocked. The first dictionary lookup transparently awaits the init if it hasn't completed yet.

Typical load times (V8 on mid-range hardware):
- Fetch: ~5–20 ms (extension file system)
- JSON parse: ~80–200 ms
- Map build (16k entries + forms): ~20–50 ms
- Total: ~100–270 ms

Set `DEBUG_LOAD_PERF = true` in `lexical-db.js` to see exact timings in the console.

## Generated core workflow

Builder outputs go to `en-vi-core.generated.json` (27 MB, all ~16k candidates).  
`extract-core.js` produces the optimized active core (`en-vi-core.16000.optimized.json`, 18 MB) by stripping audio URLs and runtime-unused metadata while keeping all lexical fields.

```bash
cd tools/dictionary-builder

# Regenerate from Kaikki/WordNet/CMUdict sources:
npm run build:core

# Re-extract and optimize the active core (fast, reads 27 MB not 3 GB):
npm run extract:active

# Copy optimized core to active location:
cp ../../dictionaries/en-vi-core.16000.optimized.json ../../dictionaries/en-vi-core.json

# Audit quality:
npm run audit:core
```

## Full dictionary workflow

`en-vi-full.generated.jsonl` contains ~1,340,022 entries for IndexedDB import. It is large (769 MB) and stays uncommitted.

Import via the extension's Settings panel:
1. Open Settings (⚙ button in toolbar).
2. Under **Full Offline Dictionary**, choose `en-vi-full.generated.jsonl`.
3. Click **Import Full Dictionary**.
4. Progress updates in real time. Import may take several minutes.

Runtime import helpers (also accessible from DevTools console):
```js
await window.LexicalDB.importJsonlFile(file)
await window.LexicalDB.getFullDictionaryStats()
await window.LexicalDB.clearFullDictionary()
```

## Source policy

Recommended builder sources (stored in `tools/dictionary-builder/sources/`, never committed):
- **Kaikki/Wiktionary** English JSONL — entries, Vietnamese translations, IPA, examples, forms, related terms.
- **Open English WordNet** — English definitions, synonyms, antonyms, semantic relations.
- **CMUdict** — US ARPABET pronunciation fallback.

Do not commit raw source dumps. Do not use StarDict dictionaries unless the license is verified.

## Files that are gitignored

| File | Reason |
|---|---|
| `en-vi-full.generated.jsonl` | 769 MB, imported into IndexedDB manually |
| `en-vi-core.generated.json` | 27 MB intermediate, not directly shipped |
| `en-vi-core.16000.optimized.json` | 18 MB intermediate, copied to `en-vi-core.json` |
| `en-vi-core.5000.json`, `en-vi-core.8000.json` | Legacy size variants |
| `en-vi-core.8000.active.backup.json` | Local backup, not needed in repo |
| `en-vi-core.seed.backup.json` | Local backup, not needed in repo |
| `tools/dictionary-builder/sources/` | 3 GB+ raw sources |
| `tools/dictionary-builder/tmp/` | Temp build outputs |
