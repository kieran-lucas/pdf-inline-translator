'use strict';

// Extracts smaller core dictionaries (5000, 8000 entries) from the full
// generated core (en-vi-core.generated.json) without re-processing the 3GB
// kaikki source. Scoring logic is identical to build-dictionary.js.

const fs = require('fs');
const path = require('path');

const KEY_TERMS = [
  'study', 'education', 'computer', 'language', 'research', 'science',
  'function', 'data', 'system', 'problem', 'method', 'result', 'definition',
  'theorem', 'proof', 'variable', 'equation', 'graph', 'table', 'figure',
  'culture', 'family', 'society', 'history',
];

const LIMITS = [5000, 8000];

function hasVietnamese(entry) {
  return (entry.senses || []).some(s => (s.viMeanings || []).length > 0);
}

function hasUsefulContent(entry) {
  return (entry.senses || []).some(s =>
    (s.viMeanings || []).length || s.enDefinition || (s.synonyms || []).length
  ) || (entry.pronunciations || []).length > 0;
}

function scoreCoreEntry(entry) {
  let score = 0;
  if (hasVietnamese(entry)) score += 1000;
  if (/^[a-z]{2,18}$/i.test(entry.lemma)) score += 100;
  if ((entry.pos || []).length) score += 30;
  if ((entry.senses || []).length) score += 30;
  if ((entry.pronunciations || []).length) score += 15;
  if (/(study|education|research|paper|chapter|section|computer|data|system|method|result|analysis|theory)/i.test(entry.lemma)) score += 20;
  score -= Math.max(0, (entry.lemma || '').length - 20);
  return score;
}

const sourcePath = path.resolve(__dirname, '../../dictionaries/en-vi-core.generated.json');
if (!fs.existsSync(sourcePath)) {
  console.error('Source not found:', sourcePath);
  process.exitCode = 1;
  process.exit();
}

console.log('Reading:', sourcePath);
const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const allEntries = Object.values(data.entries || {});
console.log('Total entries in source:', allEntries.length);

const scored = allEntries
  .filter(e => hasVietnamese(e) && hasUsefulContent(e))
  .map(e => ({ entry: e, score: scoreCoreEntry(e) }))
  .sort((a, b) => b.score - a.score);

console.log('Eligible after filter+score:', scored.length);
console.log('');

for (const limit of LIMITS) {
  const selected = scored
    .slice(0, limit)
    .map(x => x.entry)
    .sort((a, b) => a.lemma.localeCompare(b.lemma));

  const entries = {};
  for (const entry of selected) entries[entry.lemma] = entry;

  const payload = {
    version: data.version || 1,
    languagePair: data.languagePair || 'en-vi',
    generatedAt: new Date().toISOString(),
    entryCount: selected.length,
    sources: data.sources || {},
    limit,
    builderVersion: data.builderVersion || '0.2.0',
    entries,
  };

  const outPath = path.resolve(__dirname, `../../dictionaries/en-vi-core.${limit}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`en-vi-core.${limit}.json: ${selected.length} entries, ${sizeMB} MB`);

  const present = KEY_TERMS.filter(t => entries[t]);
  const missing = KEY_TERMS.filter(t => !entries[t]);
  console.log(`  Key terms present (${present.length}/${KEY_TERMS.length}): ${present.join(', ')}`);
  if (missing.length) console.log(`  Missing: ${missing.join(', ')}`);
  console.log('');
}
