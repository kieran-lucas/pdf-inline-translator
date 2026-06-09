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

  const DEBUG_UNKNOWN_POS = false;
  const LOOSE_POS_PREFIXES = new Set([
    'danh tu',
    'dong tu',
    'ngoai dong tu',
    'noi dong tu',
    'tinh tu',
    'pho tu',
    'gioi tu',
    'lien tu',
    'dai tu',
    'than tu',
    'mao tu',
    'cum tu',
    'thanh ngu',
    'tu han dinh',
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
      .replace(/[+,;:/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    for (const [variant, canonicalPos] of POS_VARIANTS.entries()) {
      const loosePrefix = LOOSE_POS_PREFIXES.has(variant) && normalized.startsWith(variant);
      if (normalized === variant || normalized.startsWith(variant + ' ') || normalized.includes(' ' + variant + ' ') || loosePrefix) {
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
    if (Array.isArray(rawEntry?.partsOfSpeech) && rawEntry.partsOfSpeech.length) {
      const partsOfSpeech = [];
      const byPos = new Map();
      for (const rawPart of rawEntry.partsOfSpeech) {
        const posInfo = normalizePartOfSpeech(rawPart?.canonicalPos || rawPart?.displayLabel);
        if (!byPos.has(posInfo.canonicalPos)) {
          byPos.set(posInfo.canonicalPos, {
            canonicalPos: posInfo.canonicalPos,
            displayLabel: POS_LABELS[posInfo.canonicalPos],
            rawPosValues: [],
            senses: [],
          });
        }
        const part = byPos.get(posInfo.canonicalPos);
        for (const rawValue of rawPart.rawPosValues || []) uniquePush(part.rawPosValues, cleanText(rawValue, 120));
        uniquePush(part.rawPosValues, posInfo.rawValue);
        for (const rawSense of rawPart.senses || []) {
          const meaningVi = cleanText(rawSense?.meaningVi, 260);
          if (!meaningVi) continue;
          const senseId = rawSense.id || headword + ':' + posInfo.canonicalPos + ':' + (part.senses.length + 1);
          part.senses.push({
            id: senseId,
            order: part.senses.length + 1,
            meaningVi,
            definitionEn: cleanText(rawSense.definitionEn, 260) || null,
            examples: normalizeExamples(rawSense.examples, senseId, true),
            collocations: (rawSense.collocations || []).map(c => cleanText(c, 140)).filter(Boolean).slice(0, 3),
            domain: rawSense.domain || null,
            register: rawSense.register || null,
            rawSourceReference: rawSense.rawSourceReference || null,
          });
        }
      }
      partsOfSpeech.push(...Array.from(byPos.values())
        .filter(part => part.senses.length > 0)
        .sort((a, b) => POS_ORDER.indexOf(a.canonicalPos) - POS_ORDER.indexOf(b.canonicalPos)));

      return {
        id: rawEntry.id || headword,
        headword,
        language: rawEntry.language || 'en',
        ipa: rawEntry.ipa || (rawEntry.pronunciations || []).find(p => p?.ipa)?.ipa || null,
        pronunciations: Array.isArray(rawEntry.pronunciations) ? rawEntry.pronunciations : [],
        audio: Array.isArray(rawEntry.audio) ? rawEntry.audio : (rawEntry.pronunciations || []).filter(p => p?.audio),
        sourceMetadata: makeSourceMetadata(rawEntry, sourceId),
        partsOfSpeech,
        rawEntry,
      };
    }

    const partsByPos = new Map();
    const duplicateSenseKeys = new Set();
    const entryLevelPos = [];
    for (const rawPos of rawEntry?.pos || []) {
      const posInfo = normalizePartOfSpeech(rawPos);
      if (posInfo.isKnown && !entryLevelPos.includes(posInfo.canonicalPos)) entryLevelPos.push(posInfo.canonicalPos);
    }
    const singleEntryLevelPos = entryLevelPos.length === 1 ? entryLevelPos[0] : null;

    for (const rawSense of rawEntry?.senses || []) {
      const posInfo = normalizePartOfSpeech(rawSense?.canonicalPos || rawSense?.pos || singleEntryLevelPos);
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

    if (DEBUG_UNKNOWN_POS && typeof console !== 'undefined') {
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
