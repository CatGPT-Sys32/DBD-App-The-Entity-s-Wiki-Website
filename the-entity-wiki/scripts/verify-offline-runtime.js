#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { validateNormalizedDatabase } = require('./normalize-images');

const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const INDEX_PATH = path.join(WEB_ROOT, 'index.html');
const DATA_PATH = path.join(WEB_ROOT, 'data.js');
const COSMETICS_DATA_PATH = path.join(WEB_ROOT, 'cosmetics.js');
const COMMUNITY_CONTENT_DATA_PATH = path.join(WEB_ROOT, 'community-content.js');
const WORLDLE_DATA_PATH = path.join(WEB_ROOT, 'worldle-data.js');
const CAPACITOR_CONFIG_PATH = path.join(ROOT, 'capacitor.config.json');
const ANDROID_MANIFEST_PATH = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

const issues = [];
const warnings = [];

function fail(message) {
  issues.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fileExists(relPathFromRoot) {
  return fs.existsSync(path.join(ROOT, relPathFromRoot));
}

function parseDatabase() {
  const code = fs.readFileSync(DATA_PATH, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.DATABASE = DATABASE;`, sandbox);
  return sandbox.DATABASE;
}

function parseWorldleData() {
  const code = fs.readFileSync(WORLDLE_DATA_PATH, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.WORLDLE_DATA = WORLDLE_DATA;`, sandbox);
  return sandbox.WORLDLE_DATA;
}

function parseCosmeticsData() {
  const code = fs.readFileSync(COSMETICS_DATA_PATH, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.COSMETICS_CATALOG = COSMETICS_CATALOG;`, sandbox);
  return sandbox.COSMETICS_CATALOG;
}

function parseCommunityContentData() {
  const code = fs.readFileSync(COMMUNITY_CONTENT_DATA_PATH, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.COMMUNITY_CONTENT = COMMUNITY_CONTENT;`, sandbox);
  return sandbox.COMMUNITY_CONTENT;
}

function normalizeEmojiClueSets(rawSets) {
  if (Array.isArray(rawSets) && rawSets.every((entry) => typeof entry === 'string')) {
    return rawSets.length >= 3 ? [{ id: 'legacy-1', emojis: rawSets.slice(0, 3) }] : [];
  }
  if (!Array.isArray(rawSets)) return [];
  return rawSets
    .map((entry, index) => {
      if (Array.isArray(entry) && entry.every((item) => typeof item === 'string')) {
        return entry.length >= 3 ? { id: `set-${index + 1}`, emojis: entry.slice(0, 3) } : null;
      }
      if (!entry || typeof entry !== 'object') return null;
      const emojis = Array.isArray(entry.emojis) ? entry.emojis.filter((item) => typeof item === 'string').slice(0, 3) : [];
      if (emojis.length < 3) return null;
      return {
        id: entry.id || `set-${index + 1}`,
        emojis
      };
    })
    .filter(Boolean);
}

function auditHtml(indexHtml) {
  const externalTagPatterns = [
    { pattern: /<script\b[^>]*\bsrc=["']https?:\/\//i, message: 'External <script> src found in web/index.html.' },
    { pattern: /<link\b(?![^>]*\brel=["']canonical["'])[^>]*\bhref=["']https?:\/\//i, message: 'External <link> href found in web/index.html.' },
    { pattern: /<img\b[^>]*\bsrc=["']https?:\/\//i, message: 'External <img> src found in web/index.html.' },
    { pattern: /url\(["']?https?:\/\//i, message: 'External CSS url(...) found in web/index.html.' },
  ];
  externalTagPatterns.forEach(({ pattern, message }) => {
    if (pattern.test(indexHtml)) fail(message);
  });

  const forbiddenRuntimePatterns = [
    { pattern: /fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com|cdn\.tailwindcss\.com/i, message: 'Remote CDN or font host reference still present in web/index.html.' },
    { pattern: /const\s+CDN_BASE\s*=/, message: 'CDN_BASE fallback is still defined in web/index.html.' },
    { pattern: /\bcdnUrl\s*=/, message: 'A CDN image fallback is still defined in web/index.html.' },
    { pattern: /const\s+IMAGE_ALIASES\s*=/, message: 'Legacy IMAGE_ALIASES resolver logic is still present in web/index.html.' },
    { pattern: /const\s+buildPerkCandidates\s*=/, message: 'Legacy buildPerkCandidates resolver logic is still present in web/index.html.' },
    { pattern: /const\s+buildMapCandidates\s*=/, message: 'Legacy buildMapCandidates resolver logic is still present in web/index.html.' },
    { pattern: /url\.startsWith\((['"])http\1\)/, message: 'AssetFrame still accepts raw http image URLs at runtime.' },
    { pattern: /\bfetch\s*\(/, message: 'fetch() is present in web/index.html.' },
    { pattern: /\bXMLHttpRequest\b/, message: 'XMLHttpRequest is present in web/index.html.' },
    { pattern: /\baxios\b/, message: 'axios is present in web/index.html.' },
    { pattern: /\bCapacitorHttp\b/, message: 'CapacitorHttp is present in web/index.html.' },
    { pattern: /serviceWorker\.register\s*\(/, message: 'service worker registration is present in web/index.html.' },
  ];
  forbiddenRuntimePatterns.forEach(({ pattern, message }) => {
    if (pattern.test(indexHtml)) fail(message);
  });
}

function auditCapacitorConfig() {
  const config = JSON.parse(fs.readFileSync(CAPACITOR_CONFIG_PATH, 'utf8'));
  if (config.webDir !== 'web') {
    fail(`capacitor.config.json should point to "web", found "${config.webDir}".`);
  }
  if (config.server && config.server.url) {
    fail('capacitor.config.json has server.url configured, which breaks the offline bundle contract.');
  }
}

function auditAndroidManifest() {
  const manifest = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
  if (/android\.permission\.INTERNET/.test(manifest)) {
    fail('AndroidManifest.xml declares android.permission.INTERNET, which breaks the strict offline contract.');
  }
}

function auditRoutes(indexHtml) {
  const setViewTargets = new Set([...indexHtml.matchAll(/setView\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]));
  const renderedRoutes = new Set([...indexHtml.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map(match => match[1]));
  renderedRoutes.add('home');
  setViewTargets.forEach((route) => {
    if (!renderedRoutes.has(route)) {
      fail(`setView() target "${route}" does not match any rendered route in App.renderContent().`);
    }
  });
}

function auditRequiredFiles(indexHtml) {
  const requiredFiles = [
    'web/vendor/react.production.min.js',
    'web/vendor/react-dom.production.min.js',
    'web/vendor/babel.min.js',
    'web/vendor/tailwindcss.min.js',
    'web/cosmetics.js',
    'web/community-content.js',
    'web/worldle-data.js',
    'web/assets/default-killer.png',
    'web/assets/default-survivor.png',
    'web/assets/default-perk.svg',
    'web/assets/default-map.svg',
  ];

  requiredFiles.forEach((relPath) => {
    if (!fileExists(relPath)) fail(`Missing required offline runtime file: ${relPath}`);
  });

  const gameIconMatches = [...indexHtml.matchAll(/icon:\s*["'](\.\/dbd_images\/game_icons\/[^"']+)["']/g)];
  const gameIcons = new Set(gameIconMatches.map((match) => match[1].replace(/^\.\//, 'web/')));
  gameIcons.forEach((relPath) => {
    if (!fileExists(relPath)) fail(`Missing game icon asset referenced in web/index.html: ${relPath}`);
  });

  const layoutMatches = [...indexHtml.matchAll(/path:\s*["']([^"']+)["']/g)];
  const mapLayouts = new Set(layoutMatches.map((match) => path.posix.join('web/dbd_images', match[1])));
  mapLayouts.forEach((relPath) => {
    if (!fileExists(relPath)) warn(`Missing map layout asset referenced in web/index.html: ${relPath}`);
  });

  if (!/<script\s+src=["']cosmetics\.js["'][^>]*><\/script>/.test(indexHtml)) {
    fail('web/index.html does not load web/cosmetics.js.');
  }

  if (!/<script\s+src=["']community-content\.js["'][^>]*><\/script>/.test(indexHtml)) {
    fail('web/index.html does not load web/community-content.js.');
  }
}

function auditDatabaseImages(db) {
  const issuesFromDatabase = validateNormalizedDatabase(db, { webRoot: WEB_ROOT });
  issuesFromDatabase.forEach((message) => fail(`Generated DATABASE image issue: ${message}`));
}

function auditWorldle(indexHtml, db, worldleData) {
  const killers = Array.isArray(db.killers) ? db.killers : [];
  const perks = Array.isArray(db.perks) ? db.perks : [];
  const aliases = worldleData?.aliases || {};
  const genders = worldleData?.genders || {};
  const emojiClues = worldleData?.emojiClues || {};

  const killerStatsMatches = [...indexHtml.matchAll(/"([^"]+)":\s*\{\s*terrorRadius:\s*"[^"]+",\s*speed:\s*"[^"]+",\s*height:\s*"[^"]+"/g)];
  const killerStatsNames = new Set(killerStatsMatches.map((match) => match[1]));

  killers.forEach((killer) => {
    if (!killerStatsNames.has(killer.name)) {
      fail(`Worldle classic metadata is missing KILLER_STATS for "${killer.name}".`);
    }
    if (!Array.isArray(aliases[killer.name]) || aliases[killer.name].length === 0) {
      fail(`Worldle alias metadata is missing entries for "${killer.name}".`);
    }
    if (typeof genders[killer.name] !== 'string' || !genders[killer.name]) {
      fail(`Worldle gender metadata is missing for "${killer.name}".`);
    }
    const emojiSets = normalizeEmojiClueSets(emojiClues[killer.name]);
    if (emojiSets.length < 3) {
      fail(`Worldle emoji clue coverage is incomplete for "${killer.name}" (expected at least 3 clue sets).`);
      return;
    }
    const seenSetIds = new Set();
    emojiSets.forEach((emojiSet, index) => {
      if (seenSetIds.has(emojiSet.id)) {
        fail(`Worldle emoji clue set id "${emojiSet.id}" is duplicated for "${killer.name}".`);
      }
      seenSetIds.add(emojiSet.id);
      if (!Array.isArray(emojiSet.emojis) || emojiSet.emojis.length !== 3) {
        fail(`Worldle emoji clue set #${index + 1} for "${killer.name}" must contain exactly 3 emojis.`);
      }
    });
  });

  const survivorPerks = perks.filter((perk) => perk.type === 'Survivor');
  const killerPerks = perks.filter((perk) => perk.type === 'Killer');
  const teachableKillers = killers.filter((killer) => perks.filter((perk) => perk.owner === killer.name).length === 3);

  if (killers.length === 0) fail('Worldle classic/emoji killer pool is empty.');
  if (survivorPerks.length === 0) fail('Worldle survivor perk pool is empty.');
  if (killerPerks.length === 0) fail('Worldle killer perk pool is empty.');
  if (teachableKillers.length === 0) fail('Worldle teachables pool is empty.');

  const emojiVariantPoolSize = killers.reduce((count, killer) => {
    const emojiSets = normalizeEmojiClueSets(emojiClues[killer.name]);
    return count + (emojiSets.length * 6);
  }, 0);
  if (emojiVariantPoolSize === 0) {
    fail('Worldle emoji practice variant pool is empty.');
  }
}

function auditCosmetics(db, catalog) {
  const charactersById = new Map([
    ...(Array.isArray(db.killers) ? db.killers : []).map((killer) => [killer.id, { ...killer, type: 'Killer' }]),
    ...(Array.isArray(db.survivors) ? db.survivors : []).map((survivor) => [survivor.id, { ...survivor, type: 'Survivor' }])
  ]);
  const seenIds = new Set();
  const groups = [
    { key: 'characterSwaps', label: 'Character swap cosmetic' },
    { key: 'fullSets', label: 'Cosmetic' }
  ];

  groups.forEach(({ key, label: groupLabel }) => {
    const entries = Array.isArray(catalog?.[key]) ? catalog[key] : [];
    entries.forEach((entry, index) => {
      const label = `${groupLabel} entry #${index + 1}`;
      if (!entry || typeof entry !== 'object') {
        fail(`${label} is not a valid object.`);
        return;
      }
      if (typeof entry.id !== 'string' || !entry.id) {
        fail(`${label} is missing a valid id.`);
        return;
      }
      if (seenIds.has(entry.id)) {
        fail(`Cosmetic id "${entry.id}" is duplicated.`);
      }
      seenIds.add(entry.id);
      if (typeof entry.baseCharacterId !== 'string' || !charactersById.has(entry.baseCharacterId)) {
        fail(`Cosmetic "${entry.id}" references an unknown base character id.`);
      } else {
        const baseCharacter = charactersById.get(entry.baseCharacterId);
        if (typeof entry.baseCharacterName !== 'string' || entry.baseCharacterName !== baseCharacter.name) {
          fail(`Cosmetic "${entry.id}" has a mismatched baseCharacterName.`);
        }
        if (!['Killer', 'Survivor'].includes(entry.baseCharacterType) || entry.baseCharacterType !== baseCharacter.type) {
          fail(`Cosmetic "${entry.id}" has an invalid baseCharacterType.`);
        }
      }
      if (typeof entry.image !== 'string' || !entry.image.startsWith('./') || /^https?:\/\//i.test(entry.image)) {
        fail(`Cosmetic "${entry.id}" must reference a bundled local image.`);
        return;
      }
      if (entry.status === 'ready') {
        const imagePath = path.join(WEB_ROOT, entry.image.replace(/^\.\//, ''));
        if (!fs.existsSync(imagePath)) {
          fail(`Cosmetic "${entry.id}" is missing its bundled asset: ${path.relative(ROOT, imagePath)}`);
        }
      }
    });
  });
}

function auditOfferingFixes(db) {
  const requiredOfferings = {
    'MISTLE TOES': 'dbd_images/offerings/iconfavors_mistletoes.png',
    'Shroud of Vanishing': 'dbd_images/offerings/iconfavors_shroudofvanishing.png',
    'Coconut Scream Pie': 'dbd_images/offerings/iconfavors_9thanniversary.png'
  };

  Object.entries(requiredOfferings).forEach(([name, expectedImage]) => {
    const offering = (Array.isArray(db.offerings) ? db.offerings : []).find((entry) => entry.name === name);
    if (!offering) {
      fail(`Offering "${name}" is missing from DATABASE.`);
      return;
    }
    if (offering.image !== expectedImage) {
      fail(`Offering "${name}" must use ${expectedImage}, found ${offering.image}.`);
    }
    const imagePath = path.join(WEB_ROOT, expectedImage);
    if (!fs.existsSync(imagePath)) {
      fail(`Offering "${name}" is missing its bundled fixed icon: ${path.relative(ROOT, imagePath)}`);
    }
  });
}

function main() {
  const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  const database = parseDatabase();
  const cosmeticsCatalog = parseCosmeticsData();
  const communityContent = parseCommunityContentData();
  const worldleData = parseWorldleData();
  auditHtml(indexHtml);
  auditCapacitorConfig();
  auditAndroidManifest();
  auditRoutes(indexHtml);
  auditRequiredFiles(indexHtml);
  auditDatabaseImages(database);
  auditCosmetics(database, cosmeticsCatalog);
  if (!communityContent || typeof communityContent !== 'object') {
    fail('Community content runtime module did not expose a valid COMMUNITY_CONTENT object.');
  }
  auditOfferingFixes(database);
  auditWorldle(indexHtml, database, worldleData);

  if (warnings.length) {
    console.log('Warnings:');
    warnings.forEach((message) => console.log(`- ${message}`));
  }

  if (issues.length) {
    console.error('Offline runtime verification failed:');
    issues.forEach((message) => console.error(`- ${message}`));
    process.exit(1);
  }

  console.log('Offline runtime verification passed.');
}

main();
