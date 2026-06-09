'use strict';

const assert = require('assert');
const {
  normalizePartOfSpeech,
  canonicalizeEntry,
  validateDictionaryEntry,
} = require('../dictionary-model');
const core = require('../dictionaries/en-vi-core.json');

function pos(raw) {
  return normalizePartOfSpeech(raw).canonicalPos;
}

assert.strictEqual(pos('tinh tu'), 'adjective');
assert.strictEqual(pos('adjactive'), 'adjective');
assert.strictEqual(pos('adj.'), 'adjective');
assert.strictEqual(pos('pho tu'), 'adverb');
assert.strictEqual(pos('danh tu'), 'noun');
assert.strictEqual(pos('dong tu'), 'verb');
assert.strictEqual(pos('danh từ+ (adherer)'), 'noun');
assert.strictEqual(pos('tính từ+ (cozy)'), 'adjective');
assert.strictEqual(pos('ngoại động từstymied'), 'verb');
assert.strictEqual(pos('tính từghép'), 'adjective');
assert.strictEqual(pos('prep.'), 'preposition');
assert.strictEqual(pos('conj'), 'conjunction');
assert.strictEqual(pos('pron.'), 'pronoun');
assert.strictEqual(pos('interj.'), 'interjection');
assert.strictEqual(pos('cum tu'), 'phrase');
assert.strictEqual(pos('thanh ngu'), 'idiom');
assert.strictEqual(pos('mao tu'), 'article');
assert.strictEqual(pos('tu han dinh'), 'determiner');

const unknown = normalizePartOfSpeech('made-up-source-label');
assert.strictEqual(unknown.canonicalPos, 'unknown');
assert.strictEqual(unknown.displayLabel, 'unknown');
assert.strictEqual(unknown.rawValue, 'made-up-source-label');

const mixed = canonicalizeEntry({
  lemma: 'mixed',
  senses: [
    { pos: 'tinh tu', viMeanings: ['mot'], examples: [] },
    { pos: 'adjective', viMeanings: ['hai'], examples: [] },
    { pos: 'adjactive', viMeanings: ['mot'], examples: [] },
  ],
  source: { translation: ['fixture'] },
}, 'mixed');
assert.deepStrictEqual(mixed.partsOfSpeech.map(p => p.canonicalPos), ['adjective']);
assert.deepStrictEqual(mixed.partsOfSpeech[0].rawPosValues, ['tinh tu', 'adjective', 'adjactive']);
assert.deepStrictEqual(mixed.partsOfSpeech[0].senses.map(s => s.meaningVi), ['mot', 'hai']);

const singleMeaning = canonicalizeEntry({
  lemma: 'exampled',
  senses: [{
    pos: 'verb',
    viMeanings: ['lam mau'],
    examples: [{ en: 'example this', vi: 'vi du dieu nay' }],
  }],
}, 'exampled');
assert.strictEqual(singleMeaning.partsOfSpeech[0].senses[0].examples[0].textEn, 'example this');

const multiMeaning = canonicalizeEntry({
  lemma: 'globalish',
  senses: [{
    pos: 'verb',
    viMeanings: ['mot', 'hai'],
    examples: [{ en: 'not attached safely', vi: 'khong gan' }],
  }],
}, 'globalish');
assert.strictEqual(multiMeaning.partsOfSpeech[0].senses.length, 2);
assert.strictEqual(multiMeaning.partsOfSpeech[0].senses[0].examples.length, 0);
assert.strictEqual(multiMeaning.partsOfSpeech[0].senses[1].examples.length, 0);

const flat = canonicalizeEntry({
  lemma: 'flat',
  senses: [{ pos: 'noun', viMeanings: ['one flat meaning; with semicolon preserved'] }],
}, 'flat');
assert.strictEqual(flat.partsOfSpeech[0].senses[0].meaningVi, 'one flat meaning; with semicolon preserved');

const singleEntryPosFallback = canonicalizeEntry({
  lemma: 'fallbackpos',
  pos: ['verb'],
  senses: [{ pos: null, viMeanings: ['nghia khong co pos rieng'] }],
}, 'fallbackpos');
assert.strictEqual(singleEntryPosFallback.partsOfSpeech[0].canonicalPos, 'verb');

const multiEntryPosFallback = canonicalizeEntry({
  lemma: 'ambiguouspos',
  pos: ['noun', 'verb'],
  senses: [{ pos: null, viMeanings: ['nghia mo ho pos'] }],
}, 'ambiguouspos');
assert.strictEqual(multiEntryPosFallback.partsOfSpeech[0].canonicalPos, 'unknown');

const alreadyCanonical = canonicalizeEntry({
  id: 'canonical',
  headword: 'canonical',
  sourceMetadata: {
    sourceId: 'generated-fixture',
    sourceName: 'Generated fixture',
    sourceType: 'ai_generated',
    modelName: 'test-model',
    generatedAt: '2026-06-09T00:00:00.000Z',
    reviewStatus: 'unreviewed',
    confidence: 0.4,
  },
  partsOfSpeech: [{
    canonicalPos: 'adjactive',
    rawPosValues: ['adjactive'],
    senses: [{
      id: 'canonical:adjective:1',
      meaningVi: 'co tinh chat mau',
      examples: [{ textEn: 'canonical example', translationVi: 'vi du canonical', sourceType: 'ai_generated' }],
    }],
  }],
}, 'canonical');
assert.strictEqual(alreadyCanonical.sourceMetadata.sourceType, 'ai_generated');
assert.strictEqual(alreadyCanonical.partsOfSpeech[0].canonicalPos, 'adjective');
assert.strictEqual(alreadyCanonical.partsOfSpeech[0].senses[0].examples[0].sourceType, 'ai_generated');

for (const word of ['wild', 'reduce', 'light', 'record']) {
  const entry = canonicalizeEntry(core.entries[word], word);
  assert.strictEqual(validateDictionaryEntry(entry).ok, true, word);
  assert.ok(entry.partsOfSpeech.length >= 1, word);
  assert.ok(entry.partsOfSpeech.every(p => /^[a-z]+$/.test(p.displayLabel)), word);
}

const wild = canonicalizeEntry(core.entries.wild, 'wild');
assert.strictEqual(wild.headword, 'wild');
assert.deepStrictEqual(wild.partsOfSpeech.map(p => p.canonicalPos), ['noun', 'adjective', 'adverb']);
assert.strictEqual(wild.partsOfSpeech.filter(p => p.canonicalPos === 'adjective').length, 1);

console.log('dictionary-model tests passed');
