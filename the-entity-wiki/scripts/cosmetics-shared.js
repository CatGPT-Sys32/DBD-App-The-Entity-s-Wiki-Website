const fs = require('fs');
const https = require('https');
const path = require('path');
const { writeFileAtomic, writeJsonAtomic } = require('./atomic-write');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_PATH = path.join(ROOT, 'content', 'cosmetics.json');
const DATABASE_PATH = path.join(ROOT, 'content', 'database.json');
const DISCOVERY_PATH = path.join(ROOT, 'review', 'cosmetics-discovery.json');
const AUDIT_PATH = path.join(ROOT, 'review', 'cosmetics-audit.txt');
const WEB_ROOT = path.join(ROOT, 'web');
const CHARACTER_SWAP_DIR = path.join(WEB_ROOT, 'dbd_images', 'cosmetics', 'character_swaps');
const FULL_SET_DIR = path.join(WEB_ROOT, 'dbd_images', 'cosmetics', 'full_sets');
const API_BASE = 'https://deadbydaylight.wiki.gg/api.php';
const USER_AGENT = 'TheEntityWikiCosmeticsSync/1.0 (local-dev)';
const REQUEST_DELAY_MS = 260;
const REQUEST_TIMEOUT_MS = 25000;
const RETRYABLE_ERROR_CODES = new Set(['ratelimited']);
const HTTP_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

const CHARACTER_SWAP_CATEGORIES = [
  { key: 'legendary', title: 'Category:Legendary_Characters', label: 'Legendary' },
  { key: 'costume', title: 'Category:Costume_Characters', label: 'Costume' },
  { key: 'ultraRare', title: 'Category:Ultra_Rare_Characters', label: 'Ultra Rare' }
];

const OFFICIAL_FILE_OVERRIDES = {
  'Kate Denson/Yennefer of Vengerberg': ['File:GS Head037.png'],
  'Vittorio Toscano/Geralt of Rivia': ['File:S34 Head023.png']
};

const BASE_TITLE_ALIASES = {
  'hak ji woon': 'The Trickster',
  'lee yun jin': 'Yun-Jin Lee',
  'leon scott kennedy': 'Leon S. Kennedy',
  'tarhos kovacs': 'The Knight',
  'frank julie susie joey': 'The Legion'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value, { backup: true });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeKey(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeGuessToken(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function slugify(value = '') {
  return normalizeKey(value).replace(/\s+/g, '-');
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&#8211;/g, '-')
    .replace(/&#8212;/g, '-')
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8230;/g, '...');
}

function stripHtml(value = '') {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function stripWikiMarkup(value = '') {
  return String(value || '')
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/''+/g, '')
    .replace(/\{\{#Invoke:Utils\|clr\|[^|]+\|([^}]+)\}\}/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function request(url, responseType = 'text', redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json,text/plain,*/*'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        if (redirects >= 5) {
          reject(new Error(`Too many redirects while requesting ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        request(nextUrl, responseType, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        const error = new Error(`Request failed for ${url} with status ${status}`);
        error.statusCode = status;
        reject(error);
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(responseType === 'buffer' ? buffer : buffer.toString('utf8'));
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeoutError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`);
      timeoutError.code = 'ETIMEDOUT';
      req.destroy(timeoutError);
    });
  });
}

async function requestJson(params, attempt = 0) {
  await sleep(REQUEST_DELAY_MS);
  const query = new URLSearchParams({ format: 'json', ...params });
  let raw;
  try {
    raw = await request(`${API_BASE}?${query.toString()}`);
  } catch (error) {
    const retryableStatus = HTTP_RETRY_STATUSES.has(error.statusCode);
    const retryableNetwork = RETRYABLE_NETWORK_CODES.has(String(error.code || ''));
    if ((retryableStatus || retryableNetwork) && attempt < 6) {
      await sleep((attempt + 1) * 1500);
      return requestJson(params, attempt + 1);
    }
    throw error;
  }
  if (/^\s*</.test(raw)) {
    throw new Error(`Received HTML instead of JSON for ${params.action || 'query'} request.`);
  }
  const json = JSON.parse(raw);
  if (json.error) {
    if (RETRYABLE_ERROR_CODES.has(json.error.code) && attempt < 4) {
      await sleep((attempt + 1) * 1000);
      return requestJson(params, attempt + 1);
    }
    throw new Error(`API error ${json.error.code}: ${json.error.info}`);
  }
  return json;
}

async function fetchWikitext(pageTitle) {
  const data = await requestJson({
    action: 'parse',
    page: pageTitle,
    prop: 'wikitext'
  });
  return String(data.parse?.wikitext?.['*'] || '');
}

async function fetchRenderedHtml(pageTitle) {
  const data = await requestJson({
    action: 'parse',
    page: pageTitle,
    prop: 'text'
  });
  return String(data.parse?.text?.['*'] || '');
}

function extractRenderedImageTitles(html = '') {
  return uniq(
    [...String(html || '').matchAll(/<img[^>]+alt="([^"]+\.(?:png|jpg|jpeg))"/gi)]
      .map((match) => `File:${match[1]}`.replace(/_/g, ' '))
  );
}

async function fetchCategoryMembers(categoryTitle) {
  const titles = [];
  let nextContinue = null;
  do {
    const params = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: categoryTitle,
      cmlimit: '200'
    };
    if (nextContinue) params.cmcontinue = nextContinue;
    const data = await requestJson(params);
    const members = Array.isArray(data.query?.categorymembers) ? data.query.categorymembers : [];
    members.forEach((member) => member?.title && titles.push(member.title));
    nextContinue = data.continue?.cmcontinue || null;
  } while (nextContinue);
  return titles;
}

async function fetchPageImages(pageTitle) {
  const data = await requestJson({
    action: 'query',
    titles: pageTitle,
    prop: 'images',
    imlimit: '100'
  });
  const page = Object.values(data.query?.pages || {})[0] || {};
  return Array.isArray(page.images) ? page.images.map((image) => image.title).filter(Boolean) : [];
}

function scorePortraitImageTitle(title) {
  let score = 0;
  if (!/^File:/i.test(title)) score -= 500;
  if (/charSelect\s+portrait/i.test(title)) score += 120;
  if (/Head|Mask|Hair/i.test(title)) score += 240;
  if (/CategoryIcon|IconHelp/i.test(title)) score -= 500;
  if (/portraitHUD|portrait\s+HUD/i.test(title)) score -= 160;
  if (/render|preview|banner|collection|promo|video|gallery|corpse|logo/i.test(title)) score -= 240;
  return score;
}

function scoreFullSetImageTitle(title) {
  let score = 0;
  if (!/^File:/i.test(title)) score -= 500;
  if (/outfit/i.test(title)) score += 300;
  if (/Head|Body|Torso|Legs|Mask|Weapon/i.test(title)) score -= 240;
  if (/CategoryIcon|IconHelp|banner|promo|logo/i.test(title)) score -= 260;
  return score;
}

async function getImageInfo(fileTitle) {
  const data = await requestJson({
    action: 'query',
    titles: fileTitle,
    prop: 'imageinfo',
    iiprop: 'url|mime'
  });
  const page = Object.values(data.query?.pages || {})[0] || {};
  const imageInfo = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  if (!imageInfo?.url) return null;
  return {
    fileTitle: page.title || fileTitle,
    url: imageInfo.url,
    mime: imageInfo.mime || ''
  };
}

async function downloadToFile(url, filePath) {
  ensureDir(path.dirname(filePath));
  const buffer = await request(url, 'buffer');
  writeFileAtomic(filePath, buffer);
}

function buildCharacterLookup(database) {
  const lookup = new Map();
  const addCharacter = (character, type) => {
    [character.name, character.realName].filter(Boolean).forEach((key) => {
      const normalized = normalizeKey(key);
      if (normalized) lookup.set(normalized, { ...character, type });
    });
  };
  (database.killers || []).forEach((killer) => addCharacter(killer, 'Killer'));
  (database.survivors || []).forEach((survivor) => addCharacter(survivor, 'Survivor'));
  Object.entries(BASE_TITLE_ALIASES).forEach(([wikiTitle, localName]) => {
    const mapped = lookup.get(normalizeKey(localName));
    if (mapped) lookup.set(normalizeKey(wikiTitle), mapped);
  });
  return lookup;
}

function buildAliases(name = '', extra = []) {
  const aliases = [String(name || '').toLowerCase()];
  const ascii = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (ascii && ascii !== aliases[0]) aliases.push(ascii);
  extra.forEach((value) => value && aliases.push(String(value).toLowerCase()));
  return uniq(aliases);
}

module.exports = {
  ROOT,
  CONTENT_PATH,
  DATABASE_PATH,
  DISCOVERY_PATH,
  AUDIT_PATH,
  WEB_ROOT,
  CHARACTER_SWAP_DIR,
  FULL_SET_DIR,
  CHARACTER_SWAP_CATEGORIES,
  OFFICIAL_FILE_OVERRIDES,
  BASE_TITLE_ALIASES,
  readJson,
  writeJson,
  ensureDir,
  uniq,
  normalizeKey,
  normalizeGuessToken,
  slugify,
  decodeHtml,
  stripHtml,
  stripWikiMarkup,
  requestJson,
  fetchWikitext,
  fetchRenderedHtml,
  extractRenderedImageTitles,
  fetchCategoryMembers,
  fetchPageImages,
  scorePortraitImageTitle,
  scoreFullSetImageTitle,
  getImageInfo,
  downloadToFile,
  buildCharacterLookup,
  buildAliases
};
