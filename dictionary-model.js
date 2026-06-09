'use strict';

(function initDictionaryModel(root) {
  const POS_ORDER = [
    'noun',
    'verb',
    'adjective',
    'adverb',
    'preposition',
    'conjunction',
    'pronoun',
    'interjection',
    'phrase',
    'idiom',
    'article',
    'determiner',
    'unknown',
  ];

  const POS_LABELS = {
    noun: 'noun',
    verb: 'verb',
    adjective: 'adjective',
    adverb: 'adverb',
    preposition: 'preposition',
    conjunction: 'conjunction',
    pronoun: 'pronoun',
    interjection: 'interjection',
    phrase: 'phrase',
    idiom: 'idiom',
    article: 'article',
    determiner: 'determiner',
    unknown: 'unknown',
  };

  const POS_VARIANTS = new Map([
    ['noun', 'noun'], ['n', 'noun'], ['n.', 'noun'], ['danh tu', 'noun'],
    ['verb', 'verb'], ['v', 'verb'], ['v.', 'verb'], ['dong tu', 'verb'], ['ngoai dong tu', 'verb'], ['noi dong tu', 'verb'],
    ['adjective', 'adjective'], ['adj', 'adjective'], ['adj.', 'adjective'], ['adjactive', 'adjective'], ['tinh tu', 'adjective'],
    ['adverb', 'adverb'], ['adv', 'adverb'], ['adv.', 'adverb'], ['pho tu', 'adverb'],
    ['preposition', 'preposition'], ['prep', 'preposition'], ['prep.', 'preposition'], ['gioi tu', 'preposition'],
    ['conjunction', 'conjunction'], ['conj', 'conjunction'], ['conj.', 'conjunction'], ['lien tu', 'conjunction'],
    ['pronoun', 'pronoun'], ['pron', 'pronoun'], ['pron.', 'pronoun'], ['dai tu', 'pronoun'],
    ['interjection', 'interjection'], ['interj', 'interjection'], ['interj.', 'interjection'], ['int', 'interjection'], ['int.', 'interjection'], ['intj', 'interjection'], ['intj.', 'interjection'], ['than tu', 'interjection'],
    ['phrase', 'phrase'], ['phr', 'phrase'], ['cum tu', 'phrase'],
    ['idiom', 'idiom'], ['thanh ngu', 'idiom'],
    ['article', 'article'], ['art', 'article'], ['art.', 'article'], ['mao tu', 'article'],
    ['determiner', 'determiner'], ['det', 'determiner'], ['det.', 'determiner'], ['tu han dinh', 'determiner'],
  ]);

  function stripVietnameseMarks(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\u0111/g, 'd')
      .replace(/\u0110/g, 'D');
  }

  function cleanText(value, max) {
    const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return max && text.length > max ? text.slice(0, max).trimEnd() : text;
  }

  function normalizePartOfSpeech(rawPos) {
    const rawValue = cleanText(rawPos, 120);
    if (!rawValue) {
      return { canonicalPos: 'unknown', displayLabel: POS_LABELS.unknown, rawValue: null, isKnown: false };
    }

    const normalized = stripVietnameseMarks(rawValue)
      .toLowerCase()
      .replace(/[()]/g, ' ')
      .replace(/[,;:/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    for (const [variant, canonicalPos] of POS_VARIANTS.entries()) {
      if (normalized === variant || normalized.startsWith(variant + ' ') || normalized.includes(' ' + variant + ' ')) {
        return { canonicalPos, displayLabel: POS_LABELS[canonicalPos], rawValue, isKnown: true };
      }
    }

    return { canonicalPos: 'unknown', displayLabel: POS_LABELS.unknown, rawValue, isKnown: false };
  }

  function uniquePush(list, value) {
    if (value && !list.includes(value)) list.push(value);
  }

  function makeSourceMetadata(rawEntry, sourceId) {
    if (rawEntry?.sourceMetadata) {
      return {
        sourceId: rawEntry.sourceMetadata.sourceId || sourceId || 'fallback',
        sourceName: rawEntry.sourceMetadata.sourceName || rawEntry.sourceMetadata.sourceId || sourceId || 'fallback',
        sourceType: rawEntry.sourceMetadata.sourceType || 'fallback',
        modelName: rawEntry.sourceMetadata.modelName || null,
        generatedAt: rawEntry.sourceMetadata.generatedAt || null,
        reviewStatus: rawEntry.sourceMetadata.reviewStatus || 'unreviewed',
        confidence: typeof rawEntry.sourceMetadata.confidence === 'number' ? rawEntry.sourceMetadata.confidence : null,
        rawSourceReference: rawEntry.sourceMetadata.rawSourceReference || rawEntry.source || null,
      };
    }

    const rawSource = rawEntry?.source || {};
    const translationSources = Array.isArray(rawSource.translation) ? rawSource.translation : [];
    const firstSource = sourceId || translationSources[0] || 'fallback';
    return {
      sourceId: firstSource,
      sourceName: firstSource === 'fvdp-ho-ngoc-duc' ? 'FVDP / Ho Ngoc Duc' : firstSource,
      sourceType: firstSource === 'fallback' ? 'fallback' : 'dataset',
      modelName: null,
      generatedAt: null,
      reviewStatus: rawEntry?.quality?.verified ? 'reviewed' : 'unreviewed',
      confidence: typeof rawEntry?.quality?.confidence === 'number' ? rawEntry.quality.confidence : null,
      rawSourceReference: rawSource,
    };
  }

  function normalizeExamples(rawExamples, senseId, attachToSense) {
    if (!attachToSense) return [];
    const examples = [];
    for (const example of rawExamples || []) {
      const textEn = cleanText(example?.textEn || example?.en, 220);
      if (!textEn) continue;
      examples.push({
        textEn,
        translationVi: cleanText(example?.translationVi || example?.vi, 220) || null,
        sourceType: example?.sourceType || 'dataset',
        senseId,
      });
      if (examples.length >= 2) break;
    }
    return examples;
  }

  function canonicalizeEntry(rawEntry, fallbackLemma, sourceId) {
    const headword = cleanText(rawEntry?.headword || rawEntry?.lemma || fallbackLemma, 120);
    const partsByPos = new Map();
    const duplicateSenseKeys = new Set();

    for (const rawSense of rawEntry?.senses || []) {
      const posInfo = normalizePartOfSpeech(rawSense?.canonicalPos || rawSense?.pos);
      const key = posInfo.canonicalPos;
      if (!partsByPos.has(key)) {
        partsByPos.set(key, {
          canonicalPos: key,
          displayLabel: POS_LABELS[key],
          rawPosValues: [],
          senses: [],
        });
      }

      const part = partsByPos.get(key);
      uniquePush(part.rawPosValues, posInfo.rawValue);

      const meanings = Array.isArray(rawSense?.viMeanings)
        ? rawSense.viMeanings
        : [rawSense?.meaningVi || rawSense?.definitionVi || rawSense?.meaning];
      const usableMeanings = meanings.map(m => cleanText(m, 260)).filter(Boolean);
      const attachExamples = usableMeanings.length === 1;

      for (const meaningVi of usableMeanings) {
        const dedupeKey = key + '\x00' + meaningVi.toLowerCase();
        if (duplicateSenseKeys.has(dedupeKey)) continue;
        duplicateSenseKeys.add(dedupeKey);

        const senseId = headword + ':' + key + ':' + (part.senses.length + 1);
        const rawCollocations = Array.isArray(rawSense?.collocations) ? rawSense.collocations : [];
        part.senses.push({
          id: senseId,
          order: part.senses.length + 1,
          meaningVi,
          definitionEn: cleanText(rawSense?.definitionEn || rawSense?.enDefinition, 260) || null,
          examples: normalizeExamples(rawSense?.examples, senseId, attachExamples),
          collocations: rawCollocations.map(c => cleanText(c, 140)).filter(Boolean).slice(0, 3),
          domain: rawSense?.domain || null,
          register: rawSense?.register || null,
          rawSourceReference: {
            pos: rawSense?.pos ?? null,
            examplesAttached: attachExamples,
          },
        });
      }
    }

    const partsOfSpeech = Array.from(partsByPos.values())
      .filter(part => part.senses.length > 0)
      .sort((a, b) => POS_ORDER.indexOf(a.canonicalPos) - POS_ORDER.indexOf(b.canonicalPos));

    if (typeof console !== 'undefined') {
      for (const part of partsOfSpeech) {
        if (part.canonicalPos === 'unknown' && part.rawPosValues.length && root?.location?.protocol !== 'chrome-extension:') {
          console.debug('[DictionaryModel] Unknown POS:', part.rawPosValues);
        }
      }
    }

    return {
      id: headword,
      headword,
      language: rawEntry?.language || 'en',
      ipa: (rawEntry?.pronunciations || []).find(p => p?.ipa)?.ipa || null,
      pronunciations: Array.isArray(rawEntry?.pronunciations) ? rawEntry.pronunciations : [],
      audio: (rawEntry?.pronunciations || []).filter(p => p?.audio),
      sourceMetadata: makeSourceMetadata(rawEntry, sourceId),
      partsOfSpeech,
      rawEntry,
    };
  }

  function validateDictionaryEntry(entry) {
    const errors = [];
    if (!entry?.headword) errors.push('missing-headword');
    if (!entry?.partsOfSpeech?.length) errors.push('missing-usable-senses');
    for (const part of entry?.partsOfSpeech || []) {
      if (!part.senses.length) errors.push('empty-pos:' + part.canonicalPos);
      for (const sense of part.senses) {
        if (!sense.meaningVi) errors.push('empty-meaning:' + part.canonicalPos);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  const api = {
    POS_ORDER,
    POS_LABELS,
    normalizePartOfSpeech,
    canonicalizeEntry,
    validateDictionaryEntry,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.DictionaryModel = api;
}(typeof window !== 'undefined' ? window : globalThis));
