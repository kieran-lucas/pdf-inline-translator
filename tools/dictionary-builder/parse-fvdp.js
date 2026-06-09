'use strict';

// parse-fvdp.js
//
// Parses the FVDP / Ho Ngoc Duc English-Vietnamese dictionary in its plain-text
// export format (as redistributed by manhminno/English-Vietnamese-Dictionary).
//
// Format per entry block:
//   @headword /pronunciation/
//   * Vietnamese-POS-label (may appear multiple times for different POS)
//   - Vietnamese meaning line
//   = example line (English+  Vietnamese split by " + ")
//   ! phrase heading (skipped)

const fs      = require('fs');
const readline = require('readline');

// Must match normalizeLookupKey in build-dictionary.js exactly.
function normalizeLookupKey(text) {
  return String(text || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
}

function cleanText(value, max = 160) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max).trimEnd() : text;
}

function uniquePush(list, value, max = 20) {
  const text = cleanText(value);
  if (!text || list.includes(text) || list.length >= max) return;
  list.push(text);
}

// Map Vietnamese POS labels to normalized English POS strings.
const VI_POS_NORMALIZE = [
  [/trợ\s*động\s*từ/,   'auxiliary'],
  [/động\s*từ/,          'verb'],
  [/danh\s*từ/,          'noun'],
  [/tính\s*từ/,          'adjective'],
  [/phó\s*từ/,           'adverb'],
  [/đại\s*từ/,           'pronoun'],
  [/giới\s*từ/,          'preposition'],
  [/liên\s*từ/,          'conjunction'],
  [/thán\s*từ/,          'interjection'],
  [/mạo\s*từ/,           'article'],
  [/số\s*từ/,            'numeral'],
  [/\btừ\b/,             'particle'],
];

function normalizePosLabel(viPos) {
  const lower = viPos.toLowerCase();
  for (const [re, en] of VI_POS_NORMALIZE) {
    if (re.test(lower)) return en;
  }
  return null;
}

// Parse pronunciation from @headword /pron/ line.
// Some entries have mock pronunciations like /protection/ — still store them.
function extractIpa(headLine) {
  const m = headLine.match(/\/([^/]+)\//);
  if (!m) return null;
  const ipa = cleanText(m[1], 80);
  // Skip trivially wrong IPA that is just the word itself (no phonetic chars).
  if (!ipa) return null;
  const hasPhoneticChars = /[ˈˌːɪʊæɑɒɔəɛɜʌðθʃʒŋ,'`´]/.test(ipa);
  const isJustTheWord = ipa.toLowerCase() === headLine.slice(1).replace(/\s*\/[^/]+\/.*/, '').trim().toLowerCase();
  if (isJustTheWord && !hasPhoneticChars) return null;
  return ipa;
}

// Parse headword lemma from @headword line.
function parseHeadword(headLine) {
  // Strip leading @ and BOM, remove /.../ pronunciation, trim
  const stripped = headLine.replace(/^[\s﻿@]+/, '').replace(/\s*\/[^/]+\/.*/, '').trim();
  return normalizeLookupKey(stripped);
}

// Parse a single - meaning line. Returns cleaned Vietnamese text.
function parseMeaningLine(line) {
  return cleanText(line.slice(1).trim(), 220);
}

// Parse a single = example line. Returns { en, vi } or null.
function parseExampleLine(line) {
  const raw = cleanText(line.slice(1).trim(), 320);
  if (!raw) return null;
  // FVDP example format: "english text+ vietnamese text"
  const plusIdx = raw.indexOf('+');
  if (plusIdx > 0) {
    const en = cleanText(raw.slice(0, plusIdx), 200);
    const vi = cleanText(raw.slice(plusIdx + 1), 200);
    return en ? { en, vi: vi || null } : null;
  }
  return { en: raw, vi: null };
}

function blankSense(pos) {
  return {
    pos:          pos || null,
    enDefinition: null,
    viMeanings:   [],
    examples:     [],
    synonyms:     [],
    antonyms:     [],
    collocations: [],
  };
}

// ── Main parser ────────────────────────────────────────────────────────────────

async function parseFvdpFile(filePath) {
  const map   = new Map();
  const stats = { total: 0, withVi: 0, skipped: 0, multiHeadword: 0 };

  if (!filePath || !fs.existsSync(filePath)) return { map, stats };

  const rl = readline.createInterface({
    input:      fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay:  Infinity,
  });

  let curLemma  = null;
  let curIpa    = null;
  let curSenses = [];     // finalized senses for current entry
  let curSense  = null;   // sense being built

  function finalizeSense() {
    if (!curSense) return;
    if (curSense.viMeanings.length || curSense.enDefinition) {
      curSenses.push(curSense);
    }
    curSense = null;
  }

  function finalizeEntry() {
    finalizeSense();
    if (!curLemma) return;

    if (!curSenses.length) {
      stats.skipped++;
      curLemma = null; curIpa = null; curSenses = []; curSense = null;
      return;
    }

    // Collect normalized POS tags from all senses.
    const pos = [];
    for (const sense of curSenses) {
      const norm = sense.pos ? normalizePosLabel(sense.pos) : null;
      if (norm && !pos.includes(norm)) pos.push(norm);
    }

    const pronunciations = curIpa
      ? [{ accent: null, ipa: curIpa, arpabet: null }]
      : [];

    const entry = {
      lemma:         curLemma,
      language:      'en',
      frequencyRank: null,
      forms:         [],
      pos,
      pronunciations,
      senses:        curSenses,
      source:        {
        translation:   ['fvdp-ho-ngoc-duc'],
        definition:    [],
        pronunciation: pronunciations.length ? ['fvdp-ho-ngoc-duc'] : [],
      },
      quality: { verified: false, confidence: 0.9 },
    };

    if (map.has(curLemma)) {
      // Merge duplicate headwords (same lemma, different POS blocks).
      const existing = map.get(curLemma);
      for (const sense of curSenses) {
        if (existing.senses.length < 12) existing.senses.push(sense);
      }
      for (const p of pos) {
        if (!existing.pos.includes(p)) existing.pos.push(p);
      }
      if (pronunciations.length && !existing.pronunciations.length) {
        existing.pronunciations.push(...pronunciations);
      }
      stats.multiHeadword++;
    } else {
      map.set(curLemma, entry);
      stats.total++;
      if (curSenses.some(s => s.viMeanings.length > 0)) stats.withVi++;
    }

    curLemma = null; curIpa = null; curSenses = []; curSense = null;
  }

  for await (const rawLine of rl) {
    // Strip BOM and normalize
    const line = rawLine.replace(/^﻿/, '');
    if (!line.trim()) continue;

    if (line.startsWith('@')) {
      finalizeEntry();
      const lemma = parseHeadword(line);
      if (lemma) {
        curLemma = lemma;
        curIpa   = extractIpa(line);
      }

    } else if (line.startsWith('*') && curLemma) {
      finalizeSense();
      const posRaw = cleanText(line.slice(1).trim(), 120);
      curSense = blankSense(posRaw || null);

    } else if (line.startsWith('-') && curLemma) {
      if (!curSense) curSense = blankSense(null);
      const meaning = parseMeaningLine(line);
      if (meaning) uniquePush(curSense.viMeanings, meaning, 8);

    } else if (line.startsWith('=') && curLemma && curSense) {
      const ex = parseExampleLine(line);
      if (ex && curSense.examples.length < 3) curSense.examples.push(ex);

    }
    // Lines starting with '!' (phrase headings) are ignored.
  }

  finalizeEntry();
  return { map, stats };
}

module.exports = { parseFvdpFile };
