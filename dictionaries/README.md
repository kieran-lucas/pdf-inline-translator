# Offline lexical dictionaries

`en-vi-core.json` is a small seed dictionary bundled with the extension. It is meant to make common single-word lookup instant and offline, without spending Gemini quota.

The JSON shape is intentionally richer than a string map. Entries can hold lemmas, forms, parts of speech, IPA/ARPABET pronunciation, Vietnamese meanings, English definitions, examples, collocations, synonyms, antonyms, source metadata, and quality metadata. Most seed entries are compact today, but the runtime tolerates missing fields.

Future full dictionaries should be generated offline from public/open sources and imported into IndexedDB instead of being loaded fully into memory at startup.

Recommended future sources:
- Kaikki/Wiktionary extracted data for translations, IPA, pronunciations, examples, related terms, and forms.
- Open English WordNet for definitions, synonyms, antonyms, and semantic relations.
- CMUdict for US pronunciation/ARPABET fallback.

Do not include unknown-license StarDict files blindly. Keep source/provenance metadata with generated entries.

Large dictionary packages should be imported into the `lexical-db` IndexedDB database using `window.LexicalDB.importEntries()` or a future import UI/tool. The extension should continue to load only the small core dictionary into memory.
