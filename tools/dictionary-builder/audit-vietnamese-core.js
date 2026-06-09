'use strict';

// audit-vietnamese-core.js
//
// Audits the active core dictionary for Vietnamese coverage.
// Hard fails if:
//   - entries with Vietnamese meanings < 16000
//   - "protection" is missing
//   - any core entry in the test word list has empty viMeanings

const fs   = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function fileSize(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.statSync(filePath).size;
}

function formatBytes(bytes) {
  if (bytes === null) return 'missing';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function hasVi(entry) {
  return (entry.senses || []).some(s => (s.viMeanings || []).length > 0);
}

function getFirstVi(entry) {
  for (const s of entry.senses || []) {
    if ((s.viMeanings || []).length) return s.viMeanings[0];
  }
  return '';
}

function countViMeanings(entry) {
  let n = 0;
  for (const s of entry.senses || []) n += (s.viMeanings || []).length;
  return n;
}

function hasDuplicateVi(entry) {
  const seen = new Set();
  for (const s of entry.senses || []) {
    for (const vi of s.viMeanings || []) {
      if (seen.has(vi)) return true;
      seen.add(vi);
    }
  }
  return false;
}

const TEST_WORDS = [
  'protection', 'development', 'environment', 'responsibility', 'education',
  'research', 'science', 'method', 'result', 'function', 'variable', 'theorem',
  'table', 'society', 'culture', 'history', 'language', 'computer', 'data',
  'system', 'problem', 'student', 'teacher', 'school', 'university', 'important',
  'different', 'possible', 'necessary', 'information', 'knowledge', 'government',
  'economic', 'health', 'family', 'children', 'people', 'world',
];

function audit(corePath) {
  if (!corePath || !fs.existsSync(corePath)) {
    console.error(`ERROR: Core file not found: ${corePath}`);
    process.exitCode = 2;
    return;
  }

  const data    = JSON.parse(fs.readFileSync(corePath, 'utf8'));
  const entries = Object.values(data.entries || {});
  const size    = fileSize(corePath);

  // ── Aggregate stats ──────────────────────────────────────────────────────────
  let withVi          = 0;
  let withoutVi       = 0;
  let withEnDef       = 0;
  let withIpa         = 0;
  let withArpabet     = 0;
  let withForms       = 0;
  let withSynonyms    = 0;
  let withAntonyms    = 0;
  let withDupVi       = 0;
  let totalViMeanings = 0;
  const missingVi     = [];
  const sourceCount   = {};
  const suspiciousEnOnly = [];

  for (const entry of entries) {
    if (hasVi(entry)) {
      withVi++;
      totalViMeanings += countViMeanings(entry);
      if (hasDuplicateVi(entry)) withDupVi++;
    } else {
      withoutVi++;
      if (missingVi.length < 50) missingVi.push(entry.lemma);
    }

    if ((entry.senses || []).some(s => s.enDefinition)) withEnDef++;
    if ((entry.pronunciations || []).some(p => p.ipa))     withIpa++;
    if ((entry.pronunciations || []).some(p => p.arpabet)) withArpabet++;
    if ((entry.forms || []).length)                        withForms++;
    if ((entry.senses || []).some(s => (s.synonyms || []).length)) withSynonyms++;
    if ((entry.senses || []).some(s => (s.antonyms || []).length)) withAntonyms++;

    // Source breakdown
    for (const src of (entry.source?.translation || [])) {
      sourceCount[src] = (sourceCount[src] || 0) + 1;
    }

    // Flag English-only vi meanings (ASCII-only strings — likely not Vietnamese)
    if (hasVi(entry)) {
      const firstVi = getFirstVi(entry);
      if (firstVi && !/[àáạảãăắặẳẵâấậẩẫèéẹẻẽêếệểễìíịỉĩòóọỏõôốộổỗơớợởỡùúụủũưứựửữỳýỵỷỹđÀÁẠẢÃĂẮẶẲẴÂẤẬẨẪÈÉẸẺẼÊẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỐỘỔỖƠỚỢỞỠÙÚỤỦŨƯỨỰỬỮỲÝỴỶỸĐ]/.test(firstVi)) {
        if (suspiciousEnOnly.length < 20) {
          suspiciousEnOnly.push({ lemma: entry.lemma, vi: firstVi.slice(0, 60) });
        }
      }
    }
  }

  const avgViMeanings = withVi > 0 ? (totalViMeanings / withVi).toFixed(2) : 0;

  // ── Test word coverage ────────────────────────────────────────────────────────
  const entryMap = new Map(entries.map(e => [e.lemma, e]));
  const testResults = TEST_WORDS.map(word => {
    const e = entryMap.get(word);
    if (!e) return { word, status: 'MISSING', vi: '' };
    if (!hasVi(e)) return { word, status: 'NO_VI', vi: '' };
    return { word, status: 'OK', vi: getFirstVi(e).slice(0, 60) };
  });

  const testMissing   = testResults.filter(r => r.status === 'MISSING').map(r => r.word);
  const testNoVi      = testResults.filter(r => r.status === 'NO_VI').map(r => r.word);
  const testOk        = testResults.filter(r => r.status === 'OK').length;

  // ── Hard fail conditions ──────────────────────────────────────────────────────
  const hardFails = [];
  if (withVi < 16000) {
    hardFails.push(`FAIL: only ${withVi} entries with Vietnamese meanings — need ≥ 16000`);
  }
  if (!entryMap.has('protection') || !hasVi(entryMap.get('protection'))) {
    hardFails.push('FAIL: "protection" is missing or has no Vietnamese meanings');
  }
  for (const word of testNoVi) {
    hardFails.push(`FAIL: "${word}" is in core but has no Vietnamese meanings`);
  }

  // ── Report ────────────────────────────────────────────────────────────────────
  const report = {
    file: {
      path:         corePath,
      size:         formatBytes(size),
      generatedAt:  data.generatedAt  || null,
      primaryVi:    data.primaryViSource || '(unknown)',
      builderVersion: data.builderVersion || '(unknown)',
    },
    totals: {
      entries:             entries.length,
      withVietnameseMeanings: withVi,
      withoutViMeanings:   withoutVi,
      percentWithVi:       entries.length ? ((withVi / entries.length) * 100).toFixed(1) + '%' : '0%',
      withEnglishDefs:     withEnDef,
      withIpa:             withIpa,
      withArpabet:         withArpabet,
      withForms:           withForms,
      withSynonyms:        withSynonyms,
      withAntonyms:        withAntonyms,
      avgViMeaningsPerEntry: parseFloat(avgViMeanings),
      totalViMeanings,
      duplicateViEntries:  withDupVi,
    },
    sourceBreakdown: sourceCount,
    testWordCoverage: {
      total:   TEST_WORDS.length,
      ok:      testOk,
      missing: testMissing,
      noVi:    testNoVi,
      results: testResults,
    },
    topMissingBasicWords: missingVi.slice(0, 30),
    suspiciousEnglishOnlyMeanings: suspiciousEnOnly,
    hardFails,
    passed: hardFails.length === 0,
  };

  console.log(JSON.stringify(report, null, 2));

  if (hardFails.length > 0) {
    console.error('\n=== AUDIT FAILED ===');
    for (const f of hardFails) console.error(f);
    process.exitCode = 1;
  } else {
    console.error('\n=== AUDIT PASSED ===');
    console.error(`${withVi} entries with Vietnamese meanings, ${testOk}/${TEST_WORDS.length} test words OK`);
  }
}

const args = parseArgs(process.argv.slice(2));
const corePath = args.core
  ? path.resolve(args.core)
  : path.resolve(__dirname, '../../dictionaries/en-vi-core.json');

audit(corePath);
