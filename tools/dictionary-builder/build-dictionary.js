'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BUILDER_VERSION = '0.2.0';

function parseArgs(argv) {
  const args = { limit: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = value;
    i++;
  }
  args.limit = Math.max(1, Number(args.limit || 20000));
  return args;
}

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function termWords(items) {
  const out = [];
  for (const item of asArray(items)) {
    if (typeof item === 'string') uniquePush(out, item);
    else uniquePush(out, item?.word || item?.term || item?.text || item?.english);
  }
  return out;
}

function isVietnameseTranslation(item) {
  const lang = String(item?.lang || item?.language || item?.lang_name || '').toLowerCase();
  const code = String(item?.lang_code || item?.code || item?.language_code || '').toLowerCase();
  return lang === 'vietnamese' || code === 'vi' || code === 'vie';
}

function extractViTranslations(items) {
  const out = [];
  for (const item of asArray(items)) {
    if (!isVietnameseTranslation(item)) continue;
    uniquePush(out, item.word || item.term || item.text || item.translation || item.alt, 5);
  }
  return out;
}

function sourceArray(entry, bucket, source) {
  entry.source[bucket] = entry.source[bucket] || [];
  if (!entry.source[bucket].includes(source)) entry.source[bucket].push(source);
}

function blankEntry(lemma) {
  return {
    lemma,
    language: 'en',
    frequencyRank: null,
    forms: [],
    pos: [],
    pronunciations: [],
    senses: [],
    source: { translation: [], definition: [], pronunciation: [] },
    quality: { verified: false, confidence: 0.35 },
  };
}

function extractPronunciations(raw) {
  const pronunciations = [];
  for (const sound of asArray(raw.sounds)) {
    const ipa = cleanText(sound?.ipa || sound?.enpr || sound?.rhymes, 80);
    const audio = cleanText(sound?.audio || sound?.ogg_url || sound?.mp3_url, 300) || null;
    if (!ipa && !audio) continue;
    pronunciations.push({ accent: sound?.tags?.includes?.('US') ? 'US' : null, ipa: ipa || null, arpabet: null, audio });
    if (pronunciations.length >= 3) break;
  }
  return pronunciations;
}

function extractForms(raw) {
  const forms = [];
  for (const item of asArray(raw.forms)) uniquePush(forms, item?.form || item?.word || item, 40);
  for (const key of ['heads', 'inflections']) {
    for (const item of asArray(raw[key])) uniquePush(forms, item?.form || item?.word || item, 40);
  }
  return forms.filter(form => normalizeLookupKey(form) !== normalizeLookupKey(raw.word || raw.lemma));
}

function extractSense(raw, rawSense, globalVi) {
  const viMeanings = extractViTranslations(rawSense.translations || rawSense.translation);
  for (const vi of globalVi) uniquePush(viMeanings, vi, 5);

  const examples = [];
  for (const ex of asArray(rawSense.examples)) {
    const en = cleanText(ex?.text || ex?.english || ex, 220);
    if (!en) continue;
    examples.push({ en, vi: cleanText(ex?.translation || ex?.vi, 220) || null });
    if (examples.length >= 4) break;
  }

  const glosses = asArray(rawSense.glosses).concat(asArray(rawSense.raw_glosses));
  return {
    pos: cleanText(rawSense.pos || raw.pos, 40) || null,
    enDefinition: cleanText(glosses[0] || rawSense.gloss || rawSense.definition, 220) || null,
    viMeanings,
    examples,
    synonyms: termWords(rawSense.synonyms || raw.synonyms).slice(0, 20),
    antonyms: termWords(rawSense.antonyms || raw.antonyms).slice(0, 20),
    collocations: termWords(
      []
        .concat(asArray(rawSense.related), asArray(raw.related))
        .concat(asArray(rawSense.derived), asArray(raw.derived))
        .concat(asArray(rawSense.compounds), asArray(raw.compounds))
    ).slice(0, 20),
  };
}

function entryFromKaikki(raw) {
  const lemma = normalizeLookupKey(raw.word || raw.lemma);
  if (!lemma) return null;
  const entry = blankEntry(lemma);
  uniquePush(entry.pos, raw.pos, 12);
  for (const form of extractForms(raw)) uniquePush(entry.forms, form, 60);
  for (const pron of extractPronunciations(raw)) {
    entry.pronunciations.push(pron);
    sourceArray(entry, 'pronunciation', 'kaikki-wiktionary');
  }

  const globalVi = extractViTranslations(raw.translations || raw.translation);
  for (const rawSense of asArray(raw.senses)) {
    const sense = extractSense(raw, rawSense, globalVi);
    if (!sense.enDefinition && !sense.viMeanings.length && !sense.synonyms.length) continue;
    if (sense.viMeanings.length) sourceArray(entry, 'translation', 'kaikki-wiktionary');
    if (sense.enDefinition) sourceArray(entry, 'definition', 'kaikki-wiktionary');
    entry.senses.push(sense);
  }
  if (!entry.senses.length && globalVi.length) {
    entry.senses.push({
      pos: entry.pos[0] || null,
      enDefinition: null,
      viMeanings: globalVi,
      examples: [],
      synonyms: termWords(raw.synonyms).slice(0, 20),
      antonyms: termWords(raw.antonyms).slice(0, 20),
      collocations: termWords([].concat(asArray(raw.related), asArray(raw.derived), asArray(raw.compounds))).slice(0, 20),
    });
    sourceArray(entry, 'translation', 'kaikki-wiktionary');
  }

  entry.quality.confidence = entry.source.translation.length ? 0.7 : 0.45;
  return hasUsefulContent(entry) ? entry : null;
}

function hasUsefulContent(entry) {
  return entry.senses.some(s => s.viMeanings?.length || s.enDefinition || s.synonyms?.length) ||
    entry.pronunciations.length > 0;
}

function hasVietnamese(entry) {
  return entry.senses.some(s => s.viMeanings?.length);
}

function isUsefulLemma(lemma) {
  return /^[a-z][a-z' -]{0,48}$/i.test(lemma) &&
    !/[._]{2,}/.test(lemma) &&
    !/^[\W_]+$/u.test(lemma) &&
    lemma.split(/\s+/).length <= 4;
}

function mergeArray(target, values, max) {
  for (const value of values || []) uniquePush(target, value, max);
}

function mergePronunciations(entry, pronunciations) {
  for (const pron of pronunciations || []) {
    const duplicate = entry.pronunciations.some(p =>
      (pron.ipa && p.ipa === pron.ipa) || (pron.arpabet && p.arpabet === pron.arpabet)
    );
    if (!duplicate && entry.pronunciations.length < 3) entry.pronunciations.push(pron);
  }
}

function mergeEntries(a, b) {
  if (!a) return b;
  mergeArray(a.forms, b.forms, 60);
  mergeArray(a.pos, b.pos, 12);
  mergePronunciations(a, b.pronunciations);
  for (const sense of b.senses) {
    a.senses.push(sense);
    if (a.senses.length >= 12) break;
  }
  for (const bucket of ['translation', 'definition', 'pronunciation']) {
    for (const source of b.source?.[bucket] || []) sourceArray(a, bucket, source);
  }
  a.quality.confidence = Math.max(a.quality.confidence || 0, b.quality?.confidence || 0);
  return a;
}

function parseCmudict(filePath) {
  const map = new Map();
  if (!filePath || !fs.existsSync(filePath)) return map;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.startsWith(';;;')) continue;
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;
    const lemma = normalizeLookupKey(match[1].replace(/\(\d+\)$/u, ''));
    const arpabet = cleanText(match[2], 120);
    if (!lemma || !arpabet) continue;
    if (!map.has(lemma)) map.set(lemma, []);
    const list = map.get(lemma);
    if (!list.includes(arpabet) && list.length < 3) list.push(arpabet);
  }
  return map;
}

function parseWordnet(filePath) {
  const map = new Map();
  if (!filePath || !fs.existsSync(filePath)) return map;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const entries = Array.isArray(raw) ? raw : asArray(raw.entries || raw.synsets || raw.words);
  for (const item of entries) {
    const lemmas = item.lemmas || item.words || [item.lemma || item.word].filter(Boolean);
    for (const rawLemma of asArray(lemmas)) {
      const lemma = normalizeLookupKey(typeof rawLemma === 'string' ? rawLemma : rawLemma?.word || rawLemma?.lemma);
      if (!lemma) continue;
      if (!map.has(lemma)) map.set(lemma, []);
      map.get(lemma).push({
        pos: cleanText(item.pos || item.partOfSpeech, 40) || null,
        enDefinition: cleanText(item.definition || item.gloss || asArray(item.glosses)[0], 240) || null,
        synonyms: termWords(item.synonyms || item.lemmas || item.words).filter(w => normalizeLookupKey(w) !== lemma).slice(0, 20),
        antonyms: termWords(item.antonyms).slice(0, 20),
      });
    }
  }
  return map;
}

function applyCmudict(entry, cmuMap) {
  const list = cmuMap.get(entry.lemma);
  if (!list?.length) return;
  for (const arpabet of list) {
    mergePronunciations(entry, [{ accent: 'US', ipa: null, arpabet, audio: null }]);
  }
  if (list.length) sourceArray(entry, 'pronunciation', 'cmudict');
}

function applyWordnet(entry, wordnetMap) {
  const items = wordnetMap.get(entry.lemma);
  if (!items?.length) return;
  for (const item of items.slice(0, 5)) {
    const matching = entry.senses.find(s => item.pos && s.pos === item.pos && !s.enDefinition);
    const sense = matching || {
      pos: item.pos,
      enDefinition: null,
      viMeanings: [],
      examples: [],
      synonyms: [],
      antonyms: [],
      collocations: [],
    };
    if (!sense.enDefinition && item.enDefinition) sense.enDefinition = item.enDefinition;
    mergeArray(sense.synonyms, item.synonyms, 20);
    mergeArray(sense.antonyms, item.antonyms, 20);
    if (!matching && (sense.enDefinition || sense.synonyms.length || sense.antonyms.length)) entry.senses.push(sense);
  }
  sourceArray(entry, 'definition', 'wordnet');
}

function capEntry(entry, rich) {
  const maxSenses = rich ? 12 : 5;
  const maxExamples = rich ? 4 : 2;
  const maxTerms = rich ? 20 : 10;
  const capped = {
    ...entry,
    forms: entry.forms.slice(0, rich ? 60 : 20),
    pos: entry.pos.slice(0, 8),
    pronunciations: entry.pronunciations.slice(0, 3),
    senses: entry.senses.slice(0, maxSenses).map(s => ({
      pos: s.pos || null,
      enDefinition: s.enDefinition || null,
      viMeanings: asArray(s.viMeanings).slice(0, rich ? 10 : 5),
      examples: asArray(s.examples).slice(0, maxExamples),
      synonyms: asArray(s.synonyms).slice(0, maxTerms),
      antonyms: asArray(s.antonyms).slice(0, maxTerms),
      collocations: asArray(s.collocations).slice(0, maxTerms),
    })),
  };
  return capped;
}

function scoreCoreEntry(entry) {
  let score = 0;
  if (hasVietnamese(entry)) score += 1000;
  if (/^[a-z]{2,18}$/i.test(entry.lemma)) score += 100;
  if (entry.pos.length) score += 30;
  if (entry.senses.length) score += 30;
  if (entry.pronunciations.length) score += 15;
  if (/(study|education|research|paper|chapter|section|computer|data|system|method|result|analysis|theory)/i.test(entry.lemma)) score += 20;
  score -= Math.max(0, entry.lemma.length - 20);
  return score;
}

function pruneCoreCandidates(map, limit) {
  const max = Math.max(limit * 4, limit + 100);
  if (map.size <= max) return;
  const keep = Array.from(map.values())
    .sort((a, b) => scoreCoreEntry(b) - scoreCoreEntry(a))
    .slice(0, Math.max(limit * 2, limit));
  map.clear();
  for (const entry of keep) map.set(entry.lemma, entry);
}

function ensureParent(filePath) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

async function build(args) {
  if (!args.kaikki) throw new Error('Missing --kaikki path');
  const kaikkiPath = path.resolve(args.kaikki);
  if (!fs.existsSync(kaikkiPath)) throw new Error(`Kaikki JSONL not found: ${kaikkiPath}`);

  const cmuMap = parseCmudict(args.cmudict && path.resolve(args.cmudict));
  const wordnetMap = parseWordnet(args.wordnet && path.resolve(args.wordnet));
  const coreCandidates = new Map();
  const stats = { lines: 0, malformed: 0, acceptedFull: 0, acceptedCore: 0 };

  let fullStream = null;
  let pendingFullEntry = null;
  if (args.fullOut) {
    ensureParent(args.fullOut);
    fullStream = fs.createWriteStream(path.resolve(args.fullOut), 'utf8');
  }

  function writePendingFull() {
    if (!fullStream || !pendingFullEntry) return;
    fullStream.write(JSON.stringify(capEntry(pendingFullEntry, true)) + '\n');
    stats.acceptedFull++;
    pendingFullEntry = null;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(kaikkiPath, 'utf8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    stats.lines++;
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      stats.malformed++;
      continue;
    }
    const entry = entryFromKaikki(raw);
    if (!entry || !isUsefulLemma(entry.lemma)) continue;
    applyCmudict(entry, cmuMap);
    applyWordnet(entry, wordnetMap);
    if (!hasUsefulContent(entry)) continue;

    if (fullStream && (hasVietnamese(entry) || entry.senses.some(s => s.enDefinition || s.synonyms.length) || entry.pronunciations.length)) {
      if (pendingFullEntry && pendingFullEntry.lemma !== entry.lemma) writePendingFull();
      pendingFullEntry = mergeEntries(pendingFullEntry, entry);
    }

    if (hasVietnamese(entry)) {
      const merged = mergeEntries(coreCandidates.get(entry.lemma), entry);
      coreCandidates.set(entry.lemma, merged);
      stats.acceptedCore++;
      if (stats.acceptedCore % 5000 === 0) pruneCoreCandidates(coreCandidates, args.limit);
    }
  }

  if (fullStream) {
    writePendingFull();
    await new Promise((resolve, reject) => {
      fullStream.end(resolve);
      fullStream.on('error', reject);
    });
  }

  if (args.coreOut) {
    ensureParent(args.coreOut);
    pruneCoreCandidates(coreCandidates, args.limit);
    const selected = Array.from(coreCandidates.values())
      .filter(entry => hasVietnamese(entry) && hasUsefulContent(entry))
      .sort((a, b) => scoreCoreEntry(b) - scoreCoreEntry(a))
      .slice(0, args.limit)
      .sort((a, b) => a.lemma.localeCompare(b.lemma));
    const entries = {};
    for (const entry of selected) entries[entry.lemma] = capEntry(entry, false);
    const payload = {
      version: 1,
      languagePair: 'en-vi',
      generatedAt: new Date().toISOString(),
      entryCount: selected.length,
      sources: {
        translation: ['kaikki-wiktionary'],
        definition: ['kaikki-wiktionary', ...(wordnetMap.size ? ['wordnet'] : [])],
        pronunciation: [...(cmuMap.size ? ['cmudict'] : []), 'kaikki-wiktionary'],
      },
      limit: args.limit,
      builderVersion: BUILDER_VERSION,
      entries,
    };
    fs.writeFileSync(path.resolve(args.coreOut), JSON.stringify(payload), 'utf8');
  }

  console.log(JSON.stringify({
    ...stats,
    malformedWarning: stats.malformed ? `${stats.malformed} malformed JSONL line(s) skipped` : null,
    cmudictEntries: cmuMap.size,
    wordnetEntries: wordnetMap.size,
    coreCandidates: coreCandidates.size,
  }, null, 2));
}

build(parseArgs(process.argv.slice(2))).catch(err => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
