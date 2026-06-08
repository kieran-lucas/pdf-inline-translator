# Offline lexical dictionaries

`en-vi-core.json` is the active bundled seed dictionary. The extension loads it at startup for fast, offline English-to-Vietnamese single-word lookup before any Gemini fallback.

## Generated Core Workflow

Phase 2 builder output goes to `en-vi-core.generated.json`. The runtime does not automatically prefer this file. Review its size and quality first, then replace or copy it to `en-vi-core.json` when you want to bundle it with the extension.

Example:

```bash
cd tools/dictionary-builder
npm run build:sample
npm run build:all
```

`en-vi-core.generated.json` may be committed only when it is reasonably sized and reviewed.

## Full Dictionary Workflow

`en-vi-full.generated.jsonl` is intended for IndexedDB import, one lexical entry per line. It can include richer English-only entries with definitions, pronunciation, synonyms, antonyms, examples, and collocations. Large full files should usually stay uncommitted and are ignored by default.

Developer import helpers are exposed in the viewer runtime:

```js
await window.LexicalDB.importEntries(entries)
await window.LexicalDB.importJsonlText(jsonlText)
await window.LexicalDB.importJsonlFile(file)
```

Imported entries are stored in the `lexical-db` IndexedDB database with a form index, then found through `lookupFull()`.

## Runtime Lookup Order

1. In-memory core dictionary from `en-vi-core.json`.
2. Full dictionary entries previously imported into IndexedDB.
3. Gemini fallback, only when enabled in settings.

The extension never downloads dictionary source data at runtime and does not require Node.js at runtime.

## Source Policy

Recommended builder sources:

- Kaikki/Wiktionary extracted English JSONL for entries, Vietnamese translations, IPA, examples, forms, related terms, derived terms, and compounds.
- Open English WordNet for English definitions, synonyms, antonyms, and semantic relations.
- CMUdict for US ARPABET pronunciation fallback.

Future fields supported by the entry shape include IPA, audio, definitions, examples, collocations, synonyms, antonyms, forms, source metadata, and quality metadata.

Do not commit raw source dumps. Do not use random StarDict dictionaries unless the license is verified.
