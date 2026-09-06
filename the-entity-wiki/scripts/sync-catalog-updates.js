#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const { fetchJsonWithRetry, formatFetchError } = require('./network-resilience');
const { writeJsonAtomic } = require('./atomic-write');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'content', 'database.json');
const WEB_IMAGE_ROOT = path.join(ROOT, 'web', 'dbd_images');
const API_BASE = 'https://dbd.tricky.lol/api';
const WIKI_API_URL = 'https://deadbydaylight.wiki.gg/api.php';

const NETWORK_OPTIONS = {
  retries: 3,
  timeoutMs: 15000,
  baseDelayMs: 400,
  maxDelayMs: 5000
};

function fail(message) {
  console.error(`sync-catalog-updates: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeJsonAtomic(filePath, value, { backup: true });
}

async function requestJson(url) {
  try {
    return await fetchJsonWithRetry(url, {
      ...NETWORK_OPTIONS,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; sync-catalog-updates/1.0)',
        accept: 'application/json,text/plain,*/*'
      }
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  }
}

function requestBuffer(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; sync-catalog-updates/1.0)',
          Accept: 'image/webp,image/png,image/*,*/*;q=0.8'
        }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          requestBuffer(response.headers.location, timeoutMs).then(succeed, fail);
          response.resume();
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`request failed with status ${response.statusCode} for ${url}`));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => succeed(Buffer.concat(chunks)));
        response.on('error', fail);
      });
    } catch (error) {
      fail(error);
      return;
    }
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms for ${url}`));
    });
  });
}

function isPng(buffer) {
  return buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A;
}

function isWebP(buffer) {
  return buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP';
}

function normalizeToPng(buffer) {
  if (isPng(buffer)) return buffer;

  if (isWebP(buffer)) {
    const result = spawnSync('convert', ['webp:-', 'png:-'], {
      input: buffer,
      maxBuffer: 64 * 1024 * 1024
    });

    if (result.status !== 0) {
      throw new Error(`ImageMagick failed to convert WEBP to PNG: ${result.stderr?.toString('utf8') || 'unknown error'}`);
    }

    return result.stdout;
  }

  throw new Error('unsupported image format returned by source');
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<li>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\xa0/g, ' ');
}

function cleanInlineText(text) {
  return stripHtml(text)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s*\/\s*/g, '/')
    .replace(/([0-9])\s*%/g, '$1%')
    .trim();
}

function normalizeMultilineText(text) {
  const lines = [];
  let previousBlank = false;
  for (const rawLine of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const match = rawLine.match(/^(\s*)(-\s+)?(.*)$/);
    const indent = (match && match[1]) || '';
    const bullet = match && match[2] ? '- ' : '';
    const body = cleanInlineText((match && match[3]) || '');

    if (!body) {
      if (lines.length > 0 && !previousBlank) lines.push('');
      previousBlank = true;
      continue;
    }

    lines.push(`${indent}${bullet}${body}`);
    previousBlank = false;
  }

  while (lines[0] === '') lines.shift();
  while (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function formatTunableValue(tier) {
  return Array.isArray(tier) ? tier.map((entry) => String(entry)).join('/') : String(tier);
}

function normalizeTunableKey(key) {
  return String(key || '').toLowerCase();
}

function toReadableTokenLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function resolveInputToken(value) {
  const inputLabels = {
    ActivatableButton1: 'Active Ability Button 1',
    ActivatableButton2: 'Active Ability Button 2',
    UseItem: 'the Use Item button'
  };
  return inputLabels[value] || toReadableTokenLabel(value);
}

function replaceNamedTemplateTokens(text, tunableLookup = new Map()) {
  return String(text || '')
    .replace(/\{Tunable\.[^.}]+\.([^}]+)\}/g, (token, key) => {
      const value = tunableLookup.get(normalizeTunableKey(key));
      return typeof value === 'undefined' ? token : value;
    })
    .replace(/\{Keyword\.([^}]+)\}/g, (_token, key) => toReadableTokenLabel(key))
    .replace(/\{Input\.([^}]+)\}/g, (_token, key) => resolveInputToken(key));
}

function applyTunables(text, tunables) {
  if (!text) return '';

  let output = String(text);
  const tunableLookup = new Map();
  if (tunables && typeof tunables === 'object') {
    for (const [key, tier] of Object.entries(tunables)) {
      const value = formatTunableValue(tier);
      tunableLookup.set(normalizeTunableKey(key), value);
      output = output.split(`{${key}}`).join(value);
    }
  }

  return replaceNamedTemplateTokens(output, tunableLookup);
}

function cleanDescription(text, tunables) {
  return normalizeMultilineText(applyTunables(text || '', tunables));
}

function slugName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function compactName(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '');
}

function sourceBaseName(imagePath) {
  return path.basename(String(imagePath || ''), path.extname(String(imagePath || '')));
}

function localPerkImage(imagePath) {
  const baseName = sourceBaseName(imagePath)
    .replace(/^T_UI_iconsPerks_/i, '')
    .replace(/^T_UI_iconPerks_/i, '')
    .replace(/^iconPerks_/i, '')
    .replace(/^IconsPerks_/i, '');
  return `dbd_images/perks/IconPerks_${baseName}.png`;
}

function localAddonImage(imagePath) {
  const baseName = sourceBaseName(imagePath)
    .replace(/^T_UI_iconAddon_/i, '')
    .replace(/^iconAddon_/i, '')
    .replace(/^icons_Addon_/i, '');
  return `dbd_images/addons/iconaddon_${baseName.toLowerCase()}.png`;
}

function localCharacterImage(character) {
  if (character.role === 'killer') {
    return `dbd_images/killers/${String(character.id).toLowerCase()}_${slugName(character.name).replace(/-/g, '')}_portrait.png`;
  }

  return `dbd_images/survivors/${character.id}_${compactName(character.name)}_Portrait.png`;
}

function localPowerImage(character) {
  return `dbd_images/powers/${slugName(character.name).replace(/-/g, '_')}_power.png`;
}

function maxApiNumberFromImages(entries, prefix) {
  let max = 0;
  const regex = new RegExp(`(?:^|/)${prefix}(\\d+)[_A-Za-z-]*`, 'i');
  for (const entry of entries || []) {
    const match = String(entry.image || '').match(regex);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function splitCharacterId(value) {
  const match = String(value || '').match(/^([KS])(\d+)$/i);
  if (!match) return null;
  return { prefix: match[1].toUpperCase(), number: Number(match[2]) };
}

function hasCharacter(database, sourceCharacter) {
  const expectedImage = localCharacterImage(sourceCharacter).toLowerCase();
  const sourceId = splitCharacterId(sourceCharacter.id);
  return [...database.killers, ...database.survivors].some((character) => {
    if (String(character.name || '').toLowerCase() === String(sourceCharacter.name || '').toLowerCase()) return true;
    if (String(character.image || '').toLowerCase() === expectedImage) return true;
    if (!sourceId) return false;
    const localBase = String(character.image || '').split('/').pop().toLowerCase();
    const localMatch = localBase.match(/^([ks])(\d+)[-_]/);
    return !!localMatch &&
      localMatch[1].toUpperCase() === sourceId.prefix &&
      Number(localMatch[2]) === sourceId.number;
  });
}

function resolveOwnerName(ownerId, charactersPayload) {
  const owner = charactersPayload?.[ownerId];
  return owner?.name || 'General';
}

function buildKillerPowerText(character) {
  return normalizeMultilineText(stripHtml(character.bio || character.power || character.description || ''));
}

function stableEntryId(prefix, key) {
  return `${prefix}-${slugName(String(key || 'unknown')) || 'unknown'}`;
}

function toCharacterEntry(character) {
  if (character.role === 'killer') {
    return {
      id: stableEntryId('character', character.id),
      name: character.name,
      realName: character.real_name || character.name,
      power: buildKillerPowerText(character),
      difficulty: character.difficulty || 'intermediate',
      image: localCharacterImage(character),
      lore: cleanDescription(character.story || character.lore || '')
    };
  }

  return {
    id: stableEntryId('character', character.id),
    name: character.name,
    role: 'Survivor',
    difficulty: character.difficulty || 'intermediate',
    image: localCharacterImage(character),
    lore: cleanDescription(character.story || character.lore || '')
  };
}

function toPerkEntry(sourceKey, perk, ownerName) {
  const legacyDescription = cleanDescription(perk.description || '', perk.tunables);
  return {
    id: `${sourceKey.toLowerCase()}-${slugName(perk.name)}`,
    name: perk.name,
    owner: ownerName,
    type: String(perk.role || 'survivor').replace(/^\w/, (match) => match.toUpperCase()),
    description: legacyDescription,
    image: localPerkImage(perk.image),
    descriptionPost95: legacyDescription
  };
}

function toPowerItemEntry(sourceKey, item, character) {
  return {
    id: stableEntryId('poweritem', sourceKey),
    internalId: sourceKey,
    name: item.name,
    type: item.type || 'power',
    itemType: item.item_type || null,
    description: cleanDescription(item.description || '', item.modifiers),
    role: item.role || 'killer',
    rarity: item.rarity || 'common',
    bloodweb: item.bloodweb === 1,
    event: item.event || null,
    image: localPowerImage(character)
  };
}

function toAddonEntry(sourceKey, addon, killerName) {
  return {
    id: stableEntryId('addon', sourceKey),
    internalId: sourceKey,
    name: addon.name,
    type: addon.type || 'poweraddon',
    itemType: addon.item_type || null,
    parents: Array.isArray(addon.parents) ? addon.parents : [],
    killerName,
    description: cleanDescription(addon.description || '', addon.modifiers),
    role: addon.role || 'killer',
    rarity: addon.rarity || 'common',
    bloodweb: addon.bloodweb === 1,
    image: localAddonImage(addon.image)
  };
}

function wikiTitleCandidates(sourcePath, localPath, sourceCharacter = null) {
  const candidates = [];
  const sourceBase = sourceBaseName(sourcePath);
  if (sourceBase) candidates.push(`${sourceBase}.png`);

  if (sourceCharacter) {
    candidates.push(`${sourceCharacter.id}_${compactName(sourceCharacter.name)}_Portrait.png`);
    candidates.push(`${sourceCharacter.id}_${sourceCharacter.name.replace(/\s+/g, '')}_Portrait.png`);
  }

  const localBase = path.basename(localPath);
  if (localBase) candidates.push(localBase);
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function resolveImageUrl(titles) {
  for (const title of titles) {
    const apiUrl = new URL(WIKI_API_URL);
    apiUrl.searchParams.set('action', 'query');
    apiUrl.searchParams.set('titles', `File:${title}`);
    apiUrl.searchParams.set('prop', 'imageinfo');
    apiUrl.searchParams.set('iiprop', 'url');
    apiUrl.searchParams.set('format', 'json');

    const payload = await requestJson(apiUrl.toString());
    const page = Object.values(payload?.query?.pages || {})[0];
    const imageUrl = page?.imageinfo?.[0]?.url;
    if (imageUrl) return { imageUrl, title };
  }

  return null;
}

async function syncImage(sourcePath, localPath, sourceCharacter = null) {
  const absolutePath = path.join(ROOT, 'web', localPath.replace(/^dbd_images\//, 'dbd_images/'));
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 100) {
    return { status: 'skipped', localPath };
  }

  const titles = wikiTitleCandidates(sourcePath, localPath, sourceCharacter);
  const resolved = await resolveImageUrl(titles);
  if (!resolved) {
    return { status: 'missing', localPath, titles };
  }

  const rawBuffer = await requestBuffer(resolved.imageUrl);
  const pngBuffer = normalizeToPng(rawBuffer);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, pngBuffer);
  return { status: 'downloaded', localPath, title: resolved.title };
}

function collectNewApiCharacters(database, charactersPayload) {
  const maxKiller = maxApiNumberFromImages(database.killers, 'k');
  const maxSurvivor = maxApiNumberFromImages(database.survivors, 's');
  const newCharacters = [];

  for (const [apiKey, character] of Object.entries(charactersPayload || {})) {
    if (!character || !character.name || !character.id || !character.role) continue;
    const prefix = character.role === 'killer' ? 'K' : 'S';
    const number = Number(String(character.id).replace(/^[KS]/i, ''));
    if (!Number.isFinite(number)) continue;
    if (character.role === 'killer' && number <= maxKiller) continue;
    if (character.role === 'survivor' && number <= maxSurvivor) continue;
    if (hasCharacter(database, character)) continue;

    newCharacters.push({ apiKey, character });
  }

  return newCharacters.sort((a, b) => {
    const left = Number(String(a.character.id).replace(/^[KS]/i, ''));
    const right = Number(String(b.character.id).replace(/^[KS]/i, ''));
    return left - right;
  });
}

async function main() {
  if (!fs.existsSync(DATABASE_PATH)) {
    fail(`missing ${path.relative(ROOT, DATABASE_PATH)}`);
  }

  const database = readJson(DATABASE_PATH);
  const [charactersPayload, perksPayload, itemsPayload, addonsPayload] = await Promise.all([
    requestJson(`${API_BASE}/characters`),
    requestJson(`${API_BASE}/perks`),
    requestJson(`${API_BASE}/items`),
    requestJson(`${API_BASE}/addons`)
  ]);

  const newCharacters = collectNewApiCharacters(database, charactersPayload);
  const newCharacterApiKeys = new Set(newCharacters.map(({ apiKey }) => String(apiKey)));
  const newPowerIds = new Set(newCharacters
    .map(({ character }) => character.item)
    .filter(Boolean));

  const changes = {
    killers: [],
    survivors: [],
    perks: [],
    items: [],
    addons: [],
    images: {
      downloaded: [],
      skipped: [],
      missing: []
    }
  };

  for (const { character } of newCharacters) {
    const entry = toCharacterEntry(character);
    if (character.role === 'killer') {
      database.killers.push(entry);
      changes.killers.push(entry.name);
    } else {
      database.survivors.push(entry);
      changes.survivors.push(entry.name);
    }

    const imageResult = await syncImage(character.image, entry.image, character);
    changes.images[imageResult.status].push(imageResult);
  }

  for (const [sourceKey, perk] of Object.entries(perksPayload || {})) {
    if (!perk || !perk.name || !newCharacterApiKeys.has(String(perk.character))) continue;
    if (database.perks.some((entry) => entry.name.toLowerCase() === perk.name.toLowerCase())) continue;

    const ownerName = resolveOwnerName(perk.character, charactersPayload);
    const entry = toPerkEntry(sourceKey, perk, ownerName);
    database.perks.push(entry);
    changes.perks.push(entry.name);

    const imageResult = await syncImage(perk.image, entry.image);
    changes.images[imageResult.status].push(imageResult);
  }

  for (const [sourceKey, item] of Object.entries(itemsPayload || {})) {
    if (!item || !item.name || !newPowerIds.has(sourceKey)) continue;
    if (database.items.some((entry) => entry.internalId === sourceKey)) continue;

    const character = newCharacters.find(({ character: candidate }) => candidate.item === sourceKey)?.character;
    if (!character) continue;

    const entry = toPowerItemEntry(sourceKey, item, character);
    database.items.push(entry);
    changes.items.push(entry.name);

    const imageResult = await syncImage(item.image, entry.image);
    changes.images[imageResult.status].push(imageResult);
  }

  for (const [sourceKey, addon] of Object.entries(addonsPayload || {})) {
    const parents = Array.isArray(addon?.parents) ? addon.parents : [];
    const parentMatchesNewPower = parents.some((parent) => newPowerIds.has(parent));
    if (!addon || !addon.name || !parentMatchesNewPower) continue;
    if (database.addons.some((entry) => entry.internalId === sourceKey)) continue;

    const owningCharacter = newCharacters.find(({ character }) => parents.includes(character.item))?.character;
    const entry = toAddonEntry(sourceKey, addon, owningCharacter?.name || null);
    database.addons.push(entry);
    changes.addons.push(entry.name);

    const imageResult = await syncImage(addon.image, entry.image);
    changes.images[imageResult.status].push(imageResult);
  }

  writeJson(DATABASE_PATH, database);

  console.log(`sync-catalog-updates: killers added=${changes.killers.length} survivors added=${changes.survivors.length}`);
  console.log(`sync-catalog-updates: perks added=${changes.perks.length} items added=${changes.items.length} addons added=${changes.addons.length}`);
  console.log(`sync-catalog-updates: images downloaded=${changes.images.downloaded.length} skipped=${changes.images.skipped.length} missing=${changes.images.missing.length}`);

  if (changes.images.missing.length > 0) {
    for (const missing of changes.images.missing) {
      console.warn(`sync-catalog-updates: missing image ${missing.localPath} candidates=${missing.titles.join(', ')}`);
    }
  }
}

main().catch((error) => {
  fail(error.message || String(error));
});
