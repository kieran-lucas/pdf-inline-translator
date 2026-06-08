# Dictionary Builder

This tool builds offline English-to-Vietnamese lexical dictionary files for `pdf-inline-translator`. It is a developer tool only. The Chrome extension runtime does not run Node.js and does not download dictionary data.

## Supported Sources

- Kaikki/Wiktionary English JSONL: English lemmas, parts of speech, forms, senses, Vietnamese translations when present, IPA/audio fields, examples, synonyms, antonyms, related terms, derived terms, and compounds.
- Open English WordNet JSON: English definitions, synonyms, and antonyms.
- CMUdict text: US ARPABET pronunciation fallback.

Do not use random StarDict dictionaries unless the license is verified.

## Install

```bash
cd tools/dictionary-builder
npm install
```

There are no runtime dependencies. `npm install` only creates the local Node project metadata if your npm version wants it.

## Sample Build

The sample build uses tiny checked-in fixtures and does not require internet access.

```bash
npm run build:sample
```

Expected outputs:

- `tmp/sample-core.json`
- `tmp/sample-full.jsonl`

The sample includes `study`, `education`, `computer`, an English-only `obscure` entry, CMUdict pronunciation fallback, WordNet merge data, and one malformed JSONL line to verify warning handling.

## Real Source Files

Put source files here:

- `sources/kaikki-en.jsonl`
- `sources/english-wordnet.json`
- `sources/cmudict.txt`

Raw dumps are ignored because they can be huge and have independent licenses. Do not commit raw source dumps.

To configure explicit downloads, copy `sources.example.json` to `sources.json` and fill only URLs you have verified:

```bash
node download-sources.js --config sources.json
```

If a URL is blank, the script prints manual placement instructions instead of guessing.

## Real Builds

```bash
npm run build:core
npm run build:full
npm run build:all
```

Equivalent direct command:

```bash
node build-dictionary.js \
  --kaikki ./sources/kaikki-en.jsonl \
  --cmudict ./sources/cmudict.txt \
  --wordnet ./sources/english-wordnet.json \
  --coreOut ../../dictionaries/en-vi-core.generated.json \
  --fullOut ../../dictionaries/en-vi-full.generated.jsonl \
  --limit 20000
```

The Kaikki parser reads JSONL line by line and skips malformed lines with a warning count. It does not load the entire Kaikki dump into memory.

## Outputs

`en-vi-core.generated.json` is compact JSON for fast in-memory lookup. It includes metadata, entries keyed by lemma, capped senses/examples/terms, and prioritizes entries with Vietnamese translations.

`en-vi-full.generated.jsonl` is one lexical entry per line for IndexedDB import. It is richer and may include entries without Vietnamese translations if they still have useful definitions, pronunciation, or synonym data.

## Using Generated Core

The extension currently loads `dictionaries/en-vi-core.json`. Generated core output is not used automatically. After reviewing size and quality, replace or copy `dictionaries/en-vi-core.generated.json` to `dictionaries/en-vi-core.json`.

## Importing Full JSONL Later

The runtime exposes developer-facing helpers:

```js
await window.LexicalDB.importJsonlText(jsonlText)
await window.LexicalDB.importJsonlFile(file)
```

These import entries into the `lexical-db` IndexedDB database, build a form index, and return `{ imported, skipped, errors }`. A full import UI can be added later.

## License And Provenance

Review each source license before generating or distributing dictionary files. Keep source metadata in generated entries. Kaikki/Wiktionary, WordNet, and CMUdict have their own licensing and attribution requirements.
