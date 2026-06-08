# Future lexical database build tools

These tools are offline helpers only. The Chrome extension must not depend on Node tooling at runtime.

Planned workflow:
1. Read Kaikki/Wiktionary JSONL.
2. Filter English lemmas that have Vietnamese translations or useful lexical metadata.
3. Merge Open English WordNet definitions, synonyms, antonyms, and semantic relations.
4. Merge CMUdict pronunciations as ARPABET fallback.
5. Normalize entries to the extension lexical-entry schema.
6. Emit a compact JSON package or an IndexedDB import package.

Large generated dictionaries should be imported into IndexedDB rather than bundled as a huge startup JSON file.
