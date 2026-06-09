# Offline lexical dictionaries

`en-vi-core.json` is the active bundled dictionary. The extension loads it at startup for fast, offline English-to-Vietnamese single-word lookup before any Gemini fallback.

## Active core

**Current active core:** 16,000 entries (11.96 MB), built from FVDP / Ho Ngoc Duc as the primary Vietnamese source.

**Primary Vietnamese source:** FVDP / Free Vietnamese Dictionary Project by Ho Ngoc Duc (~108,000 headwords with real Vietnamese meanings).

**Coverage:** 100% of entries have Vietnamese meanings. All 38 required test words present with Vietnamese definitions.

**Why FVDP:** The previous Kaikki/Wiktionary-based dictionary lacked Vietnamese translations for many common words (e.g., "protection", "responsibility", "science"). FVDP has comprehensive Vietnamese coverage for all common English words.

## Runtime quality gate

A dictionary lookup returns `ok: true` **only if** the entry has at least one non-empty `viMeanings` string. English-only entries (no Vietnamese meaning) return `{ ok: false, reason: 'no-vietnamese-meaning' }` so Gemini fallback translates that exact word instead.

## Runtime lookup order

1. **Memory L1 cache** — last few translations remembered in-session.
2. **16k active core** — in-memory Map, loaded from `en-vi-core.json` at startup.
3. **Full dictionary** — lazy IndexedDB lookup, only if user has imported the JSONL.
4. **Gemini fallback** — API call, only if enabled in settings and dictionary miss.

The extension never downloads dictionary data at runtime and does not require Node.js at runtime.

## Loading performance

The core dictionary loads asynchronously after the first browser idle period (via `requestIdleCallback`), so PDF rendering is never blocked.

Typical load times (V8 on mid-range hardware):
- Fetch: ~5–20 ms (extension file system)
- JSON parse: ~50–120 ms (11.96 MB vs 18 MB previously)
- Map build (16k entries + forms): ~20–50 ms
- Total: ~75–190 ms

Set `DEBUG_LOAD_PERF = true` in `lexical-db.js` to see exact timings in the console.

## Generated core workflow

```bash
cd tools/dictionary-builder

# Download FVDP source (one-time):
node download-sources.js --config sources.json
# Or manually:
# curl -L "https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt" -o sources/fvdp-en-vi.txt

# Build generated core from FVDP (+ optional Kaikki enrichment):
npm run build:core:fvdp-only    # Fast: FVDP + WordNet + CMUdict only

# Extract and optimize the active core (16k best entries):
npm run extract:active

# Copy optimized core to active location:
# Windows:
Copy-Item dictionaries/en-vi-core.16000.optimized.json dictionaries/en-vi-core.json -Force
# Linux/Mac:
# cp ../../dictionaries/en-vi-core.16000.optimized.json ../../dictionaries/en-vi-core.json

# Audit Vietnamese coverage (hard-fail if <16k with VI or "protection" missing):
npm run audit:vi
```

## Full dictionary workflow

`en-vi-full.generated.jsonl` contains ~1M+ entries for IndexedDB import. It is large and stays uncommitted.

Import via the extension's Settings panel:
1. Open Settings (⚙ button in toolbar).
2. Under **Full Offline Dictionary**, choose `en-vi-full.generated.jsonl`.
3. Click **Import Full Dictionary**.

Runtime import helpers (also accessible from DevTools console):
```js
await window.LexicalDB.importJsonlFile(file)
await window.LexicalDB.getFullDictionaryStats()
await window.LexicalDB.clearFullDictionary()
```

## Source policy

Primary Vietnamese source (stored in `tools/dictionary-builder/sources/`, never committed):
- **FVDP / Ho Ngoc Duc** — English-Vietnamese dictionary, ~108k entries, GPL.
  - File: `sources/fvdp-en-vi.txt`
  - URL: `https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt`

Enrichment sources (optional, improve IPA/forms/EN definitions):
- **Kaikki/Wiktionary** English JSONL — word forms, IPA, English definitions, synonyms, antonyms.
- **Open English WordNet** — English definitions, synonyms, antonyms.
- **CMUdict** — US ARPABET pronunciation.

See `tools/dictionary-builder/SOURCE_AUDIT.md` for full license and provenance details.

## Files that are gitignored

| File | Reason |
|------|--------|
| `en-vi-full.generated.jsonl` | Very large, imported into IndexedDB manually |
| `en-vi-core.generated.json` | Large intermediate (~80 MB), not directly shipped |
| `en-vi-core.16000.optimized.json` | Intermediate, copied to `en-vi-core.json` |
| `en-vi-core.5000.json`, `en-vi-core.8000.json` | Legacy size variants |
| `en-vi-core.8000.active.backup.json` | Local backup, not needed in repo |
| `en-vi-core.seed.backup.json` | Local backup, not needed in repo |
| `tools/dictionary-builder/sources/` | Raw source files (GPL data, 3 GB+) |
| `tools/dictionary-builder/tmp/` | Temp build outputs |
