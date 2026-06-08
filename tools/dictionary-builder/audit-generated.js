'use strict';

const fs = require('fs');
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
  return (entry.senses || []).some(sense => (sense.viMeanings || []).length);
}

function hasDefinition(entry) {
  return (entry.senses || []).some(sense => sense.enDefinition);
}

function hasSynonyms(entry) {
  return (entry.senses || []).some(sense => (sense.synonyms || []).length);
}

function hasAntonyms(entry) {
  return (entry.senses || []).some(sense => (sense.antonyms || []).length);
}

function hasIpa(entry) {
  return (entry.pronunciations || []).some(pron => pron.ipa);
}

function hasArpabet(entry) {
  return (entry.pronunciations || []).some(pron => pron.arpabet);
}

function summarizeEntries(entries) {
  const summary = {
    total: entries.length,
    withVietnameseMeanings: 0,
    withEnglishDefinitions: 0,
    withIpa: 0,
    withArpabet: 0,
    withPronunciations: 0,
    withSynonyms: 0,
    withAntonyms: 0,
    withForms: 0,
    averageSensesPerEntry: 0,
    suspiciousEmptyMeanings: [],
    top20SampleEntries: [],
  };

  let senseCount = 0;
  for (const entry of entries) {
    if (hasVi(entry)) summary.withVietnameseMeanings++;
    if (hasDefinition(entry)) summary.withEnglishDefinitions++;
    if (hasIpa(entry)) summary.withIpa++;
    if (hasArpabet(entry)) summary.withArpabet++;
    if ((entry.pronunciations || []).length) summary.withPronunciations++;
    if (hasSynonyms(entry)) summary.withSynonyms++;
    if (hasAntonyms(entry)) summary.withAntonyms++;
    if ((entry.forms || []).length) summary.withForms++;
    senseCount += (entry.senses || []).length;
    if (!hasVi(entry) && summary.suspiciousEmptyMeanings.length < 20) {
      summary.suspiciousEmptyMeanings.push(entry.lemma);
    }
  }

  summary.averageSensesPerEntry = entries.length ? Number((senseCount / entries.length).toFixed(2)) : 0;
  summary.top20SampleEntries = entries.slice(0, 20).map(entry => entry.lemma);
  return summary;
}

function readCore(corePath) {
  if (!corePath || !fs.existsSync(corePath)) return [];
  const data = JSON.parse(fs.readFileSync(corePath, 'utf8'));
  return Object.values(data.entries || {});
}

function readFullSample(fullPath, limit = 10000) {
  if (!fullPath || !fs.existsSync(fullPath)) return [];
  const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line));
    if (entries.length >= limit) break;
  }
  return entries;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corePath = args.core ? path.resolve(args.core) : null;
  const fullPath = args.full ? path.resolve(args.full) : null;
  const coreEntries = readCore(corePath);
  const fullEntries = readFullSample(fullPath);

  const report = {
    files: {
      core: { path: corePath, size: formatBytes(fileSize(corePath)) },
      full: { path: fullPath, size: formatBytes(fileSize(fullPath)), sampledEntries: fullEntries.length },
    },
    core: summarizeEntries(coreEntries),
    fullSample: summarizeEntries(fullEntries),
  };

  console.log(JSON.stringify(report, null, 2));
}

main();
