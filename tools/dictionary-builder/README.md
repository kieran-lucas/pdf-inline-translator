# Dictionary Builder

This tool builds offline English-to-Vietnamese lexical dictionary files for `pdf-inline-translator`. It is a developer tool only. The Chrome extension runtime does not run Node.js and does not download dictionary data.

## Primary Source: FVDP / Ho Ngoc Duc

Vietnamese meanings come primarily from the **Free Vietnamese Dictionary Project (FVDP)** by Ho Ngoc Duc — the most complete publicly available English-Vietnamese dictionary (~108,000 entries, all with real Vietnamese meanings).

FVDP is GPL-licensed. Raw source files stay in `sources/` (gitignored). See `SOURCE_AUDIT.md` for full provenance details.

## Enrichment Sources

| Source | Role |
|--------|------|
| Kaikki / Wiktionary English JSONL | IPA pronunciation, word forms, English definitions, synonyms, antonyms, examples |
| Open English WordNet | English definitions, synonyms, antonyms |
| CMUdict | US ARPABET pronunciation fallback |

**Important:** Kaikki, WordNet, and CMUdict do NOT create Vietnamese dictionary hits on their own. An entry must have a Vietnamese meaning from FVDP (or Kaikki, as secondary) to be counted.

## Install

```bash
cd tools/dictionary-builder
npm install
```

No runtime dependencies. `npm install` only creates local project metadata.

## Quick Sample Build (no internet required)

```bash
npm run build:sample
```

Outputs `tmp/sample-core.json` and `tmp/sample-full.jsonl` using checked-in fixtures.

## Real Builds with FVDP (recommended)

### Step 1 — Get sources

Place source files in `sources/` (gitignored):

| File | How to get |
|------|------------|
| `sources/fvdp-en-vi.txt` | Download from GitHub (see below) |
| `sources/kaikki-en.jsonl` | Download from kaikki.org (~3 GB, optional — for enrichment) |
| `sources/english-wordnet.json` | Open English WordNet JSON export (optional) |
| `sources/cmudict.txt` | CMU Pronouncing Dictionary (optional) |

**Download FVDP (primary Vietnamese source):**
```bash
node download-sources.js --config sources.json
```
Or manually (Windows PowerShell):
```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt" -OutFile "sources/fvdp-en-vi.txt"
```
Or curl:
```bash
curl -L "https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt" -o sources/fvdp-en-vi.txt
```

### Step 2 — Build generated core (all FVDP entries)

FVDP only (fast, ~30 seconds):
```bash
npm run build:core:fvdp-only
```

FVDP + Kaikki enrichment (slower, needs kaikki-en.jsonl):
```bash
npm run build:core:fvdp
```

Both commands write to `dictionaries/en-vi-core.generated.json` (~80 MB, gitignored).

### Step 3 — Extract optimized active core (16,000 entries)

```bash
npm run extract:active
```

Selects the 16,000 most useful entries by score (short common words, must-include vocabulary, richness signals). Outputs `dictionaries/en-vi-core.16000.optimized.json` (~12 MB, gitignored).

### Step 4 — Install active core

Windows:
```powershell
Copy-Item ../../dictionaries/en-vi-core.16000.optimized.json ../../dictionaries/en-vi-core.json -Force
```
Linux/Mac:
```bash
cp ../../dictionaries/en-vi-core.16000.optimized.json ../../dictionaries/en-vi-core.json
```

### Step 5 — Audit Vietnamese coverage

```bash
npm run audit:vi
```

Hard fails if:
- Fewer than 16,000 entries have Vietnamese meanings
- "protection" is missing or has no Vietnamese meanings
- Any required test word has empty viMeanings

## Build Scripts Reference

| Script | Description |
|--------|-------------|
| `build:core:fvdp` | FVDP + Kaikki enrichment → generated core (limit=110k) |
| `build:core:fvdp-only` | FVDP only → generated core (limit=110k, fast) |
| `build:full:fvdp` | FVDP + Kaikki → full JSONL for IndexedDB import |
| `build:core` | Kaikki-only mode (legacy, weaker Vietnamese coverage) |
| `extract:active` | Extract top 16k from generated core → optimized active |
| `audit:vi` | Vietnamese coverage audit (hard-fail if <16k with VI) |
| `audit:core` | General stats audit of active core |
| `audit:vi:generated` | Vietnamese coverage audit of generated core |
| `build:sample` | Sample build with test fixtures |
| `download:sources` | Download sources from sources.json config |

## Source Priority

```
FVDP / Ho Ngoc Duc
  → Vietnamese meaning source of truth
  → Provides: Vietnamese definitions, POS (Vietnamese labels), IPA pronunciation

Kaikki / Wiktionary
  → Enrichment only
  → Provides: word forms (inflections), additional IPA, English definitions,
               synonyms, antonyms, collocations, examples

Open English WordNet
  → Enrichment only
  → Provides: English definitions, synonyms, antonyms

CMUdict
  → Pronunciation only
  → Provides: ARPABET (US) pronunciation
```

A core entry is counted only if it has **at least one Vietnamese meaning** (viMeanings non-empty).

## Output Format

`en-vi-core.json` is compact JSON for fast in-memory lookup:

```json
{
  "version": 1,
  "languagePair": "en-vi",
  "primaryViSource": "fvdp-ho-ngoc-duc",
  "entryCount": 16000,
  "entries": {
    "protection": {
      "lemma": "protection",
      "forms": [],
      "pos": ["noun"],
      "pronunciations": [{ "accent": null, "ipa": "prə'tekʃn", "arpabet": null }],
      "senses": [{
        "pos": "danh từ",
        "enDefinition": null,
        "viMeanings": ["sự bảo vệ, sự bảo hộ, sự che chở; sự bảo trợ", "..."],
        "examples": [],
        "synonyms": [],
        "antonyms": [],
        "collocations": []
      }]
    }
  }
}
```

## Raw Source Policy

- Source files go in `tools/dictionary-builder/sources/` (gitignored, ~3 GB+).
- Never commit raw source dumps.
- FVDP data is GPL. Mark derived dictionaries accordingly if distributed.
- See `SOURCE_AUDIT.md` for full license and provenance details.

## Importing Full JSONL Later

The runtime exposes developer-facing helpers for importing the full dictionary:

```js
await window.LexicalDB.importJsonlText(jsonlText)
await window.LexicalDB.importJsonlFile(file)
```

These import entries into the `lexical-db` IndexedDB database, build a form index, and return `{ imported, skipped, errors }`.
