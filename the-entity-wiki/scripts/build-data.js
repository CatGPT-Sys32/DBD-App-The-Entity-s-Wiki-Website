#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_ROOT = path.join(ROOT, 'content');
const WEB_ROOT = path.join(ROOT, 'web');

const DATABASE_PATH = path.join(CONTENT_ROOT, 'database.json');
const TIMELINE_PATH = path.join(CONTENT_ROOT, 'timeline.json');
const COSMETICS_PATH = path.join(CONTENT_ROOT, 'cosmetics.json');
const COMMUNITY_CONTENT_PATH = path.join(CONTENT_ROOT, 'community-content.json');
const WEB_DATABASE_PATH = path.join(WEB_ROOT, 'data.js');
const WEB_TIMELINE_PATH = path.join(WEB_ROOT, 'lore.js');
const WEB_COSMETICS_PATH = path.join(WEB_ROOT, 'cosmetics.js');
const WEB_COMMUNITY_CONTENT_PATH = path.join(WEB_ROOT, 'community-content.js');

const DATABASE_KEYS = [
  'killers',
  'survivors',
  'perks',
  'maps',
  'realms',
  'items',
  'offerings',
  'addons'
];

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  console.error(`build-data: ${message}`);
  process.exit(1);
}

function ensureObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    fail(`${label} must be a JSON object.`);
  }
}

function validateDatabase(database) {
  ensureObject(database, 'content/database.json');

  const keys = Object.keys(database);
  const missing = DATABASE_KEYS.filter((key) => !(key in database));
  const extra = keys.filter((key) => !DATABASE_KEYS.includes(key));

  if (missing.length) {
    fail(`content/database.json is missing required keys: ${missing.join(', ')}`);
  }

  if (extra.length) {
    fail(`content/database.json has unexpected keys: ${extra.join(', ')}`);
  }

  for (const key of DATABASE_KEYS) {
    if (!Array.isArray(database[key])) {
      fail(`content/database.json key "${key}" must be an array.`);
    }
  }
}

function validateTimeline(timeline) {
  ensureObject(timeline, 'content/timeline.json');

  const keys = Object.keys(timeline);
  if (!keys.includes('releases')) {
    fail('content/timeline.json is missing required key: releases');
  }

  const extra = keys.filter((key) => key !== 'releases');
  if (extra.length) {
    fail(`content/timeline.json has unexpected keys: ${extra.join(', ')}`);
  }

  if (!Array.isArray(timeline.releases)) {
    fail('content/timeline.json key "releases" must be an array.');
  }
}

function validateCosmeticEntries(entries, groupKey, database) {
  if (!Array.isArray(entries)) {
    fail(`content/cosmetics.json key "${groupKey}" must be an array.`);
  }
  const charactersById = new Map([
    ...(database.killers || []).map((killer) => [killer.id, { ...killer, type: 'Killer' }]),
    ...(database.survivors || []).map((survivor) => [survivor.id, { ...survivor, type: 'Survivor' }])
  ]);

  entries.forEach((entry, index) => {
    const label = `content/cosmetics.json ${groupKey} entry #${index + 1}`;
    ensureObject(entry, label);

    const requiredStringFields = [
      'id',
      'name',
      'baseCharacterId',
      'baseCharacterName',
      'baseCharacterType',
      'groupKey',
      'groupLabel',
      'image',
      'sourceKind',
      'sourcePage',
      'assetProvenance',
      'status'
    ];
    requiredStringFields.forEach((field) => {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        fail(`${label} field "${field}" must be a non-empty string.`);
      }
    });

    if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== 'string' || !alias.trim())) {
      fail(`${label} field "aliases" must be an array of non-empty strings.`);
    }

    if (!Array.isArray(entry.assetFileTitleCandidates) || entry.assetFileTitleCandidates.some((title) => typeof title !== 'string' || !title.trim())) {
      fail(`${label} field "assetFileTitleCandidates" must be an array of non-empty strings.`);
    }

    if (/^https?:\/\//i.test(entry.image) || !entry.image.startsWith('./')) {
      fail(`${label} field "image" must be a local web path starting with "./".`);
    }

    if (!['Killer', 'Survivor'].includes(entry.baseCharacterType)) {
      fail(`${label} field "baseCharacterType" must be either "Killer" or "Survivor".`);
    }
    if (!['ready', 'blocked_art', 'blocked_mapping', 'excluded'].includes(entry.status)) {
      fail(`${label} field "status" must be one of ready, blocked_art, blocked_mapping, excluded.`);
    }

    const baseCharacter = charactersById.get(entry.baseCharacterId);
    if (!baseCharacter) {
      fail(`${label} references an unknown base character id: ${entry.baseCharacterId}`);
    }
    if (baseCharacter && baseCharacter.name !== entry.baseCharacterName) {
      fail(`${label} baseCharacterName "${entry.baseCharacterName}" does not match database character "${baseCharacter.name}".`);
    }
    if (baseCharacter && baseCharacter.type !== entry.baseCharacterType) {
      fail(`${label} baseCharacterType "${entry.baseCharacterType}" does not match database character type "${baseCharacter.type}".`);
    }

    if (entry.status === 'ready') {
      const imagePath = path.join(WEB_ROOT, entry.image.replace(/^\.\//, ''));
      if (!fs.existsSync(imagePath)) {
        fail(`${label} references a missing local asset: ${path.relative(ROOT, imagePath)}`);
      }
    }
  });
}

function validateCosmeticsCatalog(catalog, database) {
  ensureObject(catalog, 'content/cosmetics.json');
  const keys = Object.keys(catalog);
  const requiredKeys = ['generatedAt', 'metadata', 'characterSwaps', 'fullSets'];
  const missing = requiredKeys.filter((key) => !(key in catalog));
  if (missing.length) {
    fail(`content/cosmetics.json is missing required keys: ${missing.join(', ')}`);
  }

  validateCosmeticEntries(catalog.characterSwaps, 'characterSwaps', database);
  validateCosmeticEntries(catalog.fullSets, 'fullSets', database);

  const seenIds = new Set();
  [...catalog.characterSwaps, ...catalog.fullSets].forEach((entry) => {
    if (seenIds.has(entry.id)) {
      fail(`content/cosmetics.json has a duplicate cosmetic id: ${entry.id}`);
    }
    seenIds.add(entry.id);
  });
}

function validateCommunityContent(snapshot) {
  ensureObject(snapshot, 'content/community-content.json');

  if (typeof snapshot.generatedAt !== 'string' || !snapshot.generatedAt.trim()) {
    fail('content/community-content.json field "generatedAt" must be a non-empty string.');
  }

  ensureObject(snapshot.metadata, 'content/community-content.json metadata');
  if (!Array.isArray(snapshot.metadata.sources)) {
    fail('content/community-content.json metadata.sources must be an array.');
  }

  ensureObject(snapshot.addonTierlist, 'content/community-content.json addonTierlist');
  if (!Array.isArray(snapshot.addonTierlist.killers)) {
    fail('content/community-content.json addonTierlist.killers must be an array.');
  }

  ensureObject(snapshot.builds, 'content/community-content.json builds');
  ensureObject(snapshot.builds.roles, 'content/community-content.json builds.roles');
  if (!Array.isArray(snapshot.builds.roles.killers) || !Array.isArray(snapshot.builds.roles.survivors)) {
    fail('content/community-content.json builds.roles.killers and builds.roles.survivors must be arrays.');
  }

  ensureObject(snapshot.characterInfo, 'content/community-content.json characterInfo');
  if (!Array.isArray(snapshot.characterInfo.killers) || !Array.isArray(snapshot.characterInfo.survivors)) {
    fail('content/community-content.json characterInfo.killers and characterInfo.survivors must be arrays.');
  }
}

function toJson(value) {
  return JSON.stringify(value, null, 2);
}

function generateDatabaseModule(database) {
  return [
    `var DATABASE = ${toJson(database)};`,
    '',
    "if (typeof module !== 'undefined' && module.exports) {",
    '  module.exports = DATABASE;',
    '}',
    ''
  ].join('\n');
}

function generateTimelineModule(timeline) {
  return [
    '// Dead by Daylight Lore Timeline Data',
    '// Complete chapter history with release dates, characters, maps, and lore summaries',
    '// Data compiled from official DBD Wiki and sources',
    '',
    'var TIMELINE_DATA = {',
    `  releases: ${toJson(timeline.releases).replace(/\n/g, '\n  ')},`,
    '',
    '  getReleaseById: function (id) {',
    '    return this.releases.find(r => r.id === id);',
    '  },',
    '',
    '  getAllKillers: function () {',
    '    return this.releases.flatMap(r => r.killers);',
    '  },',
    '',
    '  getAllSurvivors: function () {',
    '    return this.releases.flatMap(r => r.survivors);',
    '  },',
    '',
    '  getChronological: function () {',
    '    return [...this.releases].sort((a, b) => new Date(a.date) - new Date(b.date));',
    '  }',
    '};',
    '',
    "if (typeof module !== 'undefined' && module.exports) {",
    '  module.exports = TIMELINE_DATA;',
    '}',
    ''
  ].join('\n');
}

function generateCosmeticsModule(catalog) {
  return [
    `var COSMETICS_CATALOG = ${toJson(catalog)};`,
    '',
    "if (typeof module !== 'undefined' && module.exports) {",
    '  module.exports = COSMETICS_CATALOG;',
    '}',
    ''
  ].join('\n');
}

function generateCommunityContentModule(snapshot) {
  return [
    `var COMMUNITY_CONTENT = ${toJson(snapshot)};`,
    '',
    "if (typeof module !== 'undefined' && module.exports) {",
    '  module.exports = COMMUNITY_CONTENT;',
    '}',
    ''
  ].join('\n');
}

function compareOutput(filePath, nextContent) {
  const currentContent = fs.readFileSync(filePath, 'utf8');
  return currentContent === nextContent;
}

function writeOutput(filePath, content) {
  writeFileAtomic(filePath, content, 'utf8');
  console.log(`build-data: wrote ${path.relative(ROOT, filePath)}`);
}

function main() {
  const database = readJson(DATABASE_PATH);
  const timeline = readJson(TIMELINE_PATH);
  const cosmeticsCatalog = readJson(COSMETICS_PATH);
  const communityContent = readJson(COMMUNITY_CONTENT_PATH);

  validateDatabase(database);
  validateTimeline(timeline);
  validateCosmeticsCatalog(cosmeticsCatalog, database);
  validateCommunityContent(communityContent);

  const nextDatabaseModule = generateDatabaseModule(database);
  const nextTimelineModule = generateTimelineModule(timeline);
  const nextCosmeticsModule = generateCosmeticsModule(cosmeticsCatalog);
  const nextCommunityContentModule = generateCommunityContentModule(communityContent);

  if (checkMode) {
    const staleFiles = [];
    if (!compareOutput(WEB_DATABASE_PATH, nextDatabaseModule)) staleFiles.push('web/data.js');
    if (!compareOutput(WEB_TIMELINE_PATH, nextTimelineModule)) staleFiles.push('web/lore.js');
    if (!compareOutput(WEB_COSMETICS_PATH, nextCosmeticsModule)) staleFiles.push('web/cosmetics.js');
    if (!compareOutput(WEB_COMMUNITY_CONTENT_PATH, nextCommunityContentModule)) staleFiles.push('web/community-content.js');

    if (staleFiles.length) {
      console.error(`build-data: generated output is stale: ${staleFiles.join(', ')}`);
      process.exit(1);
    }

    console.log('build-data: generated runtime data is up to date.');
    return;
  }

  writeOutput(WEB_DATABASE_PATH, nextDatabaseModule);
  writeOutput(WEB_TIMELINE_PATH, nextTimelineModule);
  writeOutput(WEB_COSMETICS_PATH, nextCosmeticsModule);
  writeOutput(WEB_COMMUNITY_CONTENT_PATH, nextCommunityContentModule);
}

main();
