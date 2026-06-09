'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const SOURCE_DIR = path.resolve(__dirname, 'sources');
const DEFAULT_CONFIG = path.resolve(__dirname, 'sources.json');

function parseArgs(argv) {
  const args = { config: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) args.config = path.resolve(argv[++i]);
  }
  return args;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    console.warn(`Config not found: ${configPath}`);
    console.warn('Copy sources.example.json to sources.json and fill only the URLs you want to download.');
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function targetForKey(key, url) {
  const ext = path.extname(new URL(url).pathname) || '';
  if (key === 'fvdpUrl')               return `fvdp-en-vi${ext || '.txt'}`;
  if (key === 'kaikkiEnglishJsonlUrl') return `kaikki-en${ext || '.jsonl'}`;
  if (key === 'wordnetUrl')            return `english-wordnet${ext || '.json'}`;
  if (key === 'cmudictUrl')            return `cmudict${ext || '.txt'}`;
  return path.basename(new URL(url).pathname);
}

function download(url, outPath) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        download(redirected, outPath).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const tmpPath = outPath + '.tmp';
      const file = fs.createWriteStream(tmpPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tmpPath, outPath);
          resolve();
        });
      });
      file.on('error', err => {
        fs.rmSync(tmpPath, { force: true });
        reject(err);
      });
    });
    request.on('error', reject);
  });
}

function printManualInstructions(missing) {
  if (!missing.length) return;
  console.log('\nManual source setup:');
  if (missing.includes('fvdpUrl')) {
    console.log('- FVDP/Ho Ngoc Duc (PRIMARY Vietnamese source): download from');
    console.log('    https://raw.githubusercontent.com/manhminno/English-Vietnamese-Dictionary/master/data/english-vietnamese.txt');
    console.log('  and place it at sources/fvdp-en-vi.txt');
  }
  if (missing.includes('kaikkiEnglishJsonlUrl')) {
    console.log('- Kaikki/Wiktionary (enrichment): download the English JSONL export from kaikki.org and place it at sources/kaikki-en.jsonl.');
  }
  if (missing.includes('wordnetUrl')) {
    console.log('- Open English WordNet (enrichment): download a verified JSON export and place it at sources/english-wordnet.json.');
  }
  if (missing.includes('cmudictUrl')) {
    console.log('- CMUdict (pronunciation): download the official cmudict plain text file and place it at sources/cmudict.txt.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readConfig(args.config);
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  console.warn('Do not commit raw source dumps.');
  console.warn(`Source directory: ${SOURCE_DIR}`);

  const keys = ['fvdpUrl', 'kaikkiEnglishJsonlUrl', 'wordnetUrl', 'cmudictUrl'];
  const missing = [];
  for (const key of keys) {
    const url = String(config[key] || '').trim();
    if (!url) {
      missing.push(key);
      continue;
    }
    const outPath = path.join(SOURCE_DIR, targetForKey(key, url));
    console.log(`Downloading ${key} -> ${outPath}`);
    await download(url, outPath);
  }

  printManualInstructions(missing);
}

main().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
});
