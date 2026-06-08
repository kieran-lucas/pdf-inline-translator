'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

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

function hasDefinition(entry) {
  return (entry.senses || []).some(s => s.enDefinition);
}

function hasSynonyms(entry) {
  return (entry.senses || []).some(s => (s.synonyms || []).length > 0);
}

function hasAntonyms(entry) {
  return (entry.senses || []).some(s => (s.antonyms || []).length > 0);
}

function hasIpa(entry) {
  return (entry.pronunciations || []).some(p => p.ipa);
}

function hasArpabet(entry) {
  return (entry.pronunciations || []).some(p => p.arpabet);
}

const KEY_TERMS = [
  'study', 'education', 'computer', 'language', 'research', 'science',
  'function', 'data', 'system', 'problem', 'method', 'result', 'definition',
  'theorem', 'proof', 'variable', 'equation', 'graph', 'table', 'figure',
  'culture', 'family', 'society', 'history',
  'analysis', 'algorithm', 'memory', 'cache', 'performance',
  'translation', 'paragraph', 'sentence', 'word',
];

function summarizeEntries(entries, label) {
  const map = new Map(entries.map(e => [e.lemma, e]));
  const summary = {
    label,
    total: entries.length,
    withVietnameseMeanings:  0,
    withEnglishDefinitions:  0,
    withIpa:                 0,
    withArpabet:             0,
    withPronunciations:      0,
    withSynonyms:            0,
    withAntonyms:            0,
    withForms:               0,
    averageSensesPerEntry:   0,
    keyTerms:     { present: [], missing: [] },
    sampleEntries: entries.slice(0, 10).map(e => e.lemma),
    suspiciousEmptyMeanings: [],
  };

  let senseCount = 0;
  for (const entry of entries) {
    if (hasVi(entry))         summary.withVietnameseMeanings++;
    if (hasDefinition(entry)) summary.withEnglishDefinitions++;
    if (hasIpa(entry))        summary.withIpa++;
    if (hasArpabet(entry))    summary.withArpabet++;
    if ((entry.pronunciations || []).length) summary.withPronunciations++;
    if (hasSynonyms(entry))   summary.withSynonyms++;
    if (hasAntonyms(entry))   summary.withAntonyms++;
    if ((entry.forms || []).length) summary.withForms++;
    senseCount += (entry.senses || []).length;
    if (!hasVi(entry) && summary.suspiciousEmptyMeanings.length < 20) {
      summary.suspiciousEmptyMeanings.push(entry.lemma);
    }
  }

  summary.averageSensesPerEntry = entries.length
    ? Number((senseCount / entries.length).toFixed(2))
    : 0;

  for (const term of KEY_TERMS) {
    const entry = map.get(term);
    if (entry) {
      const vi = (entry.senses || [])[0]?.viMeanings?.[0] || '';
      summary.keyTerms.present.push({ term, vi: vi.slice(0, 60) });
    } else {
      summary.keyTerms.missing.push(term);
    }
  }

  return summary;
}

function readCore(corePath) {
  if (!corePath || !fs.existsSync(corePath)) return { entries: [], fileMeta: {} };
  const data    = JSON.parse(fs.readFileSync(corePath, 'utf8'));
  const entries = Object.values(data.entries || {});
  const fileMeta = {
    version:            data.version,
    languagePair:       data.languagePair,
    entryCount:         data.entryCount,
    limit:              data.limit,
    activeCore:         data.activeCore,
    builderVersion:     data.builderVersion,
    generatedAt:        data.generatedAt,
    optimizationPolicy: data.optimizationPolicy || null,
  };
  return { entries, fileMeta };
}

// Stream JSONL file line-by-line — never loads the full 770 MB into memory.
function readFullStream(fullPath, sampleLimit = 10000) {
  if (!fullPath || !fs.existsSync(fullPath)) {
    return Promise.resolve({ entries: [], totalLines: 0, malformed: 0, sampled: 0 });
  }

  return new Promise((resolve, reject) => {
    const state = { entries: [], totalLines: 0, malformed: 0 };
    const rl = readline.createInterface({
      input: fs.createReadStream(fullPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      state.totalLines++;
      if (state.entries.length < sampleLimit) {
        try {
          state.entries.push(JSON.parse(line));
        } catch {
          state.malformed++;
        }
      }
    });

    rl.on('close', () => resolve({ ...state, sampled: state.entries.length }));
    rl.on('error', reject);
  });
}

async function main() {
  const args     = parseArgs(process.argv.slice(2));
  const corePath = args.core ? path.resolve(args.core) : null;
  const fullPath = args.full ? path.resolve(args.full) : null;

  const { entries: coreEntries, fileMeta: coreMeta } = readCore(corePath);
  const fullData = await readFullStream(fullPath);

  const report = {
    files: {
      core: {
        path: corePath,
        size: formatBytes(fileSize(corePath)),
        meta: corePath ? coreMeta : null,
      },
      full: {
        path:              fullPath,
        size:              formatBytes(fileSize(fullPath)),
        totalLinesScanned: fullData.totalLines,
        sampledEntries:    fullData.sampled,
        malformedLines:    fullData.malformed,
      },
    },
    core:       coreEntries.length ? summarizeEntries(coreEntries, 'core')                              : null,
    fullSample: fullData.entries.length ? summarizeEntries(fullData.entries, `full-sample-${fullData.sampled}`) : null,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
