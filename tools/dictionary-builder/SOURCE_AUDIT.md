# Dictionary Source Audit

This file documents every candidate source evaluated for the English→Vietnamese dictionary.

---

## Active Sources

### 1. FVDP / Ho Ngoc Duc — Primary Vietnamese Meaning Source

| Field | Value |
|-------|-------|
| **Name** | Free Vietnamese Dictionary Project (FVDP) by Ho Ngoc Duc |
| **Source repo** | https://github.com/manhminno/English-Vietnamese-Dictionary |
| **Raw file URL** | `https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt` |
| **File format** | FVDP custom plain-text (DICT-derived) |
| **File size** | ~14.8 MB |
| **Entry count** | ~108,854 headwords |
| **License** | GPL (same as original FVDP corpus by Ho Ngoc Duc); repository has no explicit LICENSE file but data provenance is clearly FVDP/GPL |
| **Contains real Vietnamese meanings** | Yes — primary Vietnamese definitions for all headwords |
| **Safe to use** | For build-time use only. Do not commit the raw source file. |
| **Redistribution** | Generated dictionary is a derived work under GPL. Mark as such if distributed. |
| **Local path** | `tools/dictionary-builder/sources/fvdp-en-vi.txt` |

**Sample lookup quality:**

```
@protection /protection/
* danh từ
- sự bảo vệ, sự bảo hộ, sự che chở; sự bảo trợ
- người bảo vệ, người che chở; vật bảo vệ, vật che chở
- giấy thông hành
- chế độ bảo vệ nền công nghiệp trong nước
```

```
@development /di'veləpmənt/
* danh từ
- sự phát triển, sự mở mang; sự triển khai; sự tiến hoá
- khu mới xây dựng
- (nhiếp ảnh) sự tráng phim
```

Quality: Excellent for common English words. Core vocabulary has rich, accurate Vietnamese meanings.

**Download:**
```
node download-sources.js --config sources.json
```
or manually:
```
curl -L "https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt" \
  -o tools/dictionary-builder/sources/fvdp-en-vi.txt
```

---

### 2. Kaikki / Wiktionary — Enrichment Only (IPA, forms, EN definitions)

| Field | Value |
|-------|-------|
| **Name** | Kaikki Wiktionary English JSONL |
| **URL** | https://kaikki.org (official export) |
| **Format** | JSONL (one JSON object per line) |
| **Size** | ~3 GB |
| **License** | CC BY-SA 3.0 (Wiktionary data) |
| **Contains real Vietnamese meanings** | Partial — many common English words lack Vietnamese translations |
| **Role in pipeline** | Enrichment only: IPA, word forms, English definitions, synonyms, antonyms, examples |
| **Local path** | `tools/dictionary-builder/sources/kaikki-en.jsonl` |

**Why not primary for Vietnamese:** Many basic words (e.g., "protection", "responsibility", "government") have no Vietnamese translations in Wiktionary. Using Kaikki as primary Vi source produces an inferior dictionary.

---

### 3. Open English WordNet — English Definitions, Synonyms, Antonyms

| Field | Value |
|-------|-------|
| **Name** | Open English WordNet |
| **Format** | JSON |
| **License** | CC BY 4.0 |
| **Role** | English definitions, synonyms, antonyms (enrichment only) |
| **Local path** | `tools/dictionary-builder/sources/english-wordnet.json` |
| **Creates dictionary hit** | No — WordNet alone does not count as a Vietnamese dictionary hit |

---

### 4. CMUdict — ARPABET Pronunciation

| Field | Value |
|-------|-------|
| **Name** | CMU Pronouncing Dictionary |
| **Format** | Plain text |
| **License** | BSD 2-Clause |
| **Role** | US ARPABET pronunciation fallback |
| **Local path** | `tools/dictionary-builder/sources/cmudict.txt` |
| **Creates dictionary hit** | No — CMUdict alone does not count as a Vietnamese dictionary hit |

---

## Rejected / Unavailable Sources

### Ho Ngoc Duc Original Site (Leipzig University)

| Field | Value |
|-------|-------|
| **URL** | http://www.informatik.uni-leipzig.de/~duc/Dict/ |
| **Status** | Dead (404 as of June 2026) |
| **Action** | Use manhminno mirror instead |

### OVDP StarDict on SourceForge (`AnhViet.zip`)

| Field | Value |
|-------|-------|
| **URL** | https://sourceforge.net/projects/ovdp/files/Stardict/English/AnhViet.zip/download |
| **Format** | StarDict (.dict.dz + .idx + .ifo) |
| **License** | GPL v2 |
| **Status** | Live but requires ZIP extraction + StarDict parser. Not used because manhminno plain text is simpler. |
| **Action** | Use if manhminno mirror becomes unavailable |

### dynamotn/stardict-vi (`star_anhviet`)

| Field | Value |
|-------|-------|
| **URL** | https://github.com/dynamotn/stardict-vi (archived) |
| **Format** | StarDict 2.4.2 |
| **Entry count** | ~387,517 (OVDP-expanded) |
| **License** | Not explicitly stated |
| **Action** | Candidate fallback — needs license verification before use |

### VNEDICT by Paul Denisowski

| Field | Value |
|-------|-------|
| **URL** | http://www.denisowski.org/Vietnamese/vnedict.txt |
| **Format** | Plain text |
| **License** | CC BY 3.0 |
| **Direction** | Vietnamese → English (reversed, cannot be used for EN→VI) |
| **Action** | Not useful for this project's direction |

### freedict.org

| Field | Value |
|-------|-------|
| **Status** | No Vietnamese-English pair exists |

---

## Usage Policy

- Raw source files go in `tools/dictionary-builder/sources/` which is **gitignored**.
- Do not commit raw source dumps (license, size, and provenance reasons).
- Generated `dictionaries/en-vi-core.json` is a derived work from FVDP (GPL).
- If the extension is distributed publicly, the FVDP/GPL attribution must be included.
- For strictly local/personal use, no additional steps are required.

---

## Rebuild Instructions

```bash
cd tools/dictionary-builder

# Download FVDP source (if not present):
node download-sources.js --config sources.json

# Build core from FVDP + Kaikki enrichment:
npm run build:core:fvdp

# Optimize active core:
npm run extract:active

# Copy to active location:
copy ..\..\dictionaries\en-vi-core.16000.optimized.json ..\..\dictionaries\en-vi-core.json

# Audit Vietnamese coverage:
npm run audit:vi
```
