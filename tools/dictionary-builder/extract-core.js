'use strict';

// extract-core.js
//
// Extracts and optimizes core dictionary variants from en-vi-core.generated.json.
//
// Single-output mode (optimized active core):
//   node extract-core.js \
//     --input  ../../dictionaries/en-vi-core.generated.json \
//     --out    ../../dictionaries/en-vi-core.16000.optimized.json \
//     --limit  16000 \
//     --optimize-active-core
//
// Legacy multi-output mode (generates 5000 and 8000 variants):
//   node extract-core.js

const fs   = require('fs');
const path = require('path');

const EXTENDED_KEY_TERMS = [
  'study', 'education', 'computer', 'language', 'research', 'science',
  'function', 'data', 'system', 'problem', 'method', 'result', 'definition',
  'theorem', 'proof', 'variable', 'equation', 'graph', 'table', 'figure',
  'culture', 'family', 'society', 'history',
  'analysis', 'algorithm', 'memory', 'cache', 'performance',
  'translation', 'paragraph', 'sentence', 'word',
];

const LEGACY_KEY_TERMS = EXTENDED_KEY_TERMS.slice(0, 24);

// ── Arg parser ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i++;
    }
  }
  return args;
}

// ── Entry predicates & scoring ─────────────────────────────────────────────────

function hasVietnamese(entry) {
  return (entry.senses || []).some(s => (s.viMeanings || []).length > 0);
}

function hasUsefulContent(entry) {
  return (entry.senses || []).some(s =>
    (s.viMeanings || []).length || s.enDefinition || (s.synonyms || []).length
  ) || (entry.pronunciations || []).length > 0;
}

const MUST_INCLUDE_LEMMAS = new Set([
  'protection','development','environment','responsibility','education',
  'research','science','method','result','function','variable','theorem',
  'table','society','culture','history','language','computer','data',
  'system','problem','student','teacher','school','university','important',
  'different','possible','necessary','information','knowledge','government',
  'economic','health','family','children','people','world',
  'analysis','definition','algorithm','equation','figure','paragraph',
  'sentence','performance','memory','graph','proof','theory','business',
  'company','country','national','international','management','market',
  'number','order','product','quality','service','structure','value',
  'work','year','time','place','case','area','point','group','example',
  'power','type','state','part','fact','program','process','section',
  'level','field','model','network','design','paper','chapter',
  'translation','measure','dimension','set','class','object','layer',
]);

function scoreCoreEntry(entry) {
  let score = 0;
  if (hasVietnamese(entry)) score += 1000;
  if ((entry.source?.translation || []).includes('fvdp-ho-ngoc-duc')) score += 500;

  const lemma = (entry.lemma || '');
  const len   = lemma.length;

  if (MUST_INCLUDE_LEMMAS.has(lemma)) score += 2000;

  if (/^[a-z]+$/i.test(lemma)) {
    score += Math.max(0, Math.round(200 - (len - 2) * 11.1));
  }
  const wordCount = lemma.split(/\s+/).length;
  if (wordCount > 1) score -= wordCount * 100;
  if (lemma.includes('-')) score -= 50;

  const viCount = (entry.senses || []).reduce((n, s) => n + (s.viMeanings?.length || 0), 0);
  score += Math.min(viCount, 6) * 5;
  if ((entry.pos || []).length)            score += 15;
  if ((entry.senses || []).length)         score += 15;
  if ((entry.pronunciations || []).length) score += 10;

  return score;
}

// ── Optimization ───────────────────────────────────────────────────────────────

function optimizeEntry(entry, opts) {
  const {
    maxSenses, maxExamples, maxTerms, maxForms,
    maxPronunciations, maxViMeanings,
    stripAudio, stripMeta,
  } = opts;

  // Strip runtime-unused meta fields when optimizing for active core
  const out = {
    lemma: entry.lemma,
    forms: (entry.forms || []).slice(0, maxForms),
    pos:   (entry.pos   || []).slice(0, 8),
    pronunciations: (entry.pronunciations || [])
      .slice(0, maxPronunciations)
      .map(p => {
        const pron = {
          accent:   p.accent   || null,
          ipa:      p.ipa      || null,
          arpabet:  p.arpabet  || null,
        };
        if (!stripAudio) pron.audio = p.audio || null;
        return pron;
      }),
    senses: (entry.senses || [])
      // Prioritise Vietnamese-bearing senses before capping so they are never silently dropped.
      .sort((a, b) => {
        const av = (a.viMeanings || []).length > 0;
        const bv = (b.viMeanings || []).length > 0;
        return (bv ? 1 : 0) - (av ? 1 : 0); // Vietnamese senses first, stable within each group
      })
      .slice(0, maxSenses)
      .map(s => ({
        pos:          s.pos          || null,
        enDefinition: s.enDefinition || null,
        viMeanings:   (s.viMeanings  || []).slice(0, maxViMeanings),
        examples:     (s.examples    || []).slice(0, maxExamples),
        synonyms:     (s.synonyms    || []).slice(0, maxTerms),
        antonyms:     (s.antonyms    || []).slice(0, maxTerms),
        collocations: (s.collocations || []).slice(0, maxTerms),
      }))
      .filter(s =>
        s.enDefinition ||
        (s.viMeanings  || []).length ||
        (s.synonyms    || []).length ||
        (s.antonyms    || []).length
      ),
  };

  if (!stripMeta) {
    out.source        = entry.source        || {};
    out.quality       = entry.quality       || {};
    out.language      = entry.language      || 'en';
    out.frequencyRank = entry.frequencyRank ?? null;
  }

  return out;
}

// ── Key-term report ────────────────────────────────────────────────────────────

function reportKeyTerms(entries, keyTerms) {
  const present = keyTerms.filter(t => entries[t]);
  const missing = keyTerms.filter(t => !entries[t]);
  console.log(`  Key terms present: ${present.length}/${keyTerms.length}`);
  if (missing.length) {
    console.log(`  Missing: ${missing.join(', ')}`);
  } else {
    console.log('  All key terms present.');
  }
  return missing;
}

// ── Single-output mode ─────────────────────────────────────────────────────────

function runSingleOutput(args, allEntries, data) {
  const limit            = args.limit ? parseInt(args.limit, 10) : Infinity;
  const optimizeCore     = !!args['optimize-active-core'];

  const opts = {
    maxSenses:         5,   // keep 5 to avoid silently dropping Vietnamese-only 5th senses
    maxExamples:       optimizeCore ? 1  : 2,
    maxTerms:          optimizeCore ? 8  : 10,
    maxForms:          optimizeCore ? 15 : 20,
    maxPronunciations: optimizeCore ? 2  : 3,
    maxViMeanings:     optimizeCore ? 4  : 5,
    stripAudio:        optimizeCore,
    stripMeta:         optimizeCore,
  };

  // Allow explicit overrides
  for (const [flag, field] of [
    ['maxSenses',         'maxSenses'],
    ['maxExamples',       'maxExamples'],
    ['maxTerms',          'maxTerms'],
    ['maxForms',          'maxForms'],
    ['maxPronunciations', 'maxPronunciations'],
    ['maxViMeanings',     'maxViMeanings'],
  ]) {
    if (args[flag] !== undefined) opts[field] = parseInt(args[flag], 10);
  }

  const scored = allEntries
    .filter(e => hasUsefulContent(e))
    .map(e => ({ entry: e, score: scoreCoreEntry(e) }))
    .sort((a, b) => b.score - a.score);

  const taken = isFinite(limit) ? scored.slice(0, limit) : scored;
  const selected = taken
    .map(x => x.entry)
    .sort((a, b) => a.lemma.localeCompare(b.lemma));

  const entries = {};
  for (const entry of selected) {
    entries[entry.lemma] = optimizeEntry(entry, opts);
  }

  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(__dirname, '../../dictionaries/en-vi-core.optimized.json');

  const payload = {
    version:         data.version         || 1,
    languagePair:    data.languagePair    || 'en-vi',
    generatedAt:     new Date().toISOString(),
    entryCount:      selected.length,
    activeCore:      true,
    primaryViSource: data.primaryViSource || 'unknown',
    sourceFile:      path.basename(args.input || 'en-vi-core.generated.json'),
    builderVersion:  data.builderVersion  || '0.2.0',
    optimizationPolicy: {
      maxSenses:         opts.maxSenses,
      maxExamples:       opts.maxExamples,
      maxTerms:          opts.maxTerms,
      maxForms:          opts.maxForms,
      maxPronunciations: opts.maxPronunciations,
      maxViMeanings:     opts.maxViMeanings,
      stripAudio:        opts.stripAudio,
      stripMeta:         opts.stripMeta,
    },
    sources: data.sources || {},
    entries,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
  const fileSizeBytes = fs.statSync(outPath).size;
  const sizeMB = (fileSizeBytes / 1024 / 1024).toFixed(2);

  console.log(`Output: ${outPath}`);
  console.log(`Entries: ${selected.length}`);
  console.log(`Size: ${sizeMB} MB`);
  reportKeyTerms(entries, EXTENDED_KEY_TERMS);

  return { entryCount: selected.length, sizeMB: parseFloat(sizeMB), fileSizeBytes };
}

// ── Legacy multi-output mode (5000 + 8000 variants) ───────────────────────────

function runLegacyMultiOutput(allEntries, data) {
  const LIMITS = [5000, 8000];

  const scored = allEntries
    .filter(e => hasVietnamese(e) && hasUsefulContent(e))
    .map(e => ({ entry: e, score: scoreCoreEntry(e) }))
    .sort((a, b) => b.score - a.score);

  console.log(`Eligible after filter+score: ${scored.length}`);
  console.log('');

  for (const limit of LIMITS) {
    const selected = scored
      .slice(0, limit)
      .map(x => x.entry)
      .sort((a, b) => a.lemma.localeCompare(b.lemma));

    const entries = {};
    for (const entry of selected) entries[entry.lemma] = entry;

    const payload = {
      version:      data.version      || 1,
      languagePair: data.languagePair || 'en-vi',
      generatedAt:  new Date().toISOString(),
      entryCount:   selected.length,
      sources:      data.sources      || {},
      limit,
      builderVersion: data.builderVersion || '0.2.0',
      entries,
    };

    const outPath = path.resolve(__dirname, `../../dictionaries/en-vi-core.${limit}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
    const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
    console.log(`en-vi-core.${limit}.json: ${selected.length} entries, ${sizeMB} MB`);
    reportKeyTerms(entries, LEGACY_KEY_TERMS);
    console.log('');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

const args       = parseArgs(process.argv.slice(2));
const singleMode = !!(args.out || args.input || args['optimize-active-core'] || args.limit);

const inputPath = args.input
  ? path.resolve(args.input)
  : path.resolve(__dirname, '../../dictionaries/en-vi-core.generated.json');

if (!fs.existsSync(inputPath)) {
  console.error('Source not found:', inputPath);
  process.exitCode = 1;
  process.exit();
}

console.log('Reading:', inputPath);
const data       = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const allEntries = Object.values(data.entries || {});
console.log(`Total entries in source: ${allEntries.length}`);
console.log('');

if (singleMode) {
  runSingleOutput(args, allEntries, data);
} else {
  runLegacyMultiOutput(allEntries, data);
}
