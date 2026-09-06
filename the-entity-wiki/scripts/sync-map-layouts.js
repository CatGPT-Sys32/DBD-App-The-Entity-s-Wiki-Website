#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { File } = require('buffer');

if (typeof globalThis.File === 'undefined') {
  globalThis.File = File;
}

const cheerio = require('cheerio');
const { fetchTextWithRetry, fetchBinaryWithRetry, formatFetchError } = require('./network-resilience');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'content', 'database.json');
const INDEX_PATH = path.join(ROOT, 'web', 'index.html');
const OUTPUT_ROOT = path.join(ROOT, 'web', 'dbd_images');
const REPORT_PATH = path.join(ROOT, 'review', 'map-layouts-audit.json');

const HENS_CALLOUTS_URL = 'https://hens333.com/callouts';
const HENS_BASE_URL = 'https://hens333.com/img/dbd/callouts';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const refresh = args.has('--refresh');
const checkMode = args.has('--check');
const upgradeLegacy = args.has('--upgrade-legacy');
const healthCheckOnly = args.has('--health-check');
const NETWORK_OPTIONS = {
  retries: 3,
  timeoutMs: 15000,
  baseDelayMs: 400,
  maxDelayMs: 4500
};

function fail(message) {
  console.error(`sync-map-layouts: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(filePath) {
  fs.mkdirSync(filePath, { recursive: true });
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2019']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2019']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'map_layout';
}

function normalizeMapName(value) {
  return String(value || '').replace(/\u2019/g, "'").replace(/\s+/g, ' ').trim();
}

function parseObjectLiteralFromIndex(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Marker not found: ${marker}`);
  }

  const objectStart = html.indexOf('{', markerIndex);
  if (objectStart < 0) {
    throw new Error(`Could not find object start after marker: ${marker}`);
  }

  let depth = 0;
  let objectEnd = -1;
  for (let index = objectStart; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        objectEnd = index;
        break;
      }
    }
  }

  if (objectEnd < 0) {
    throw new Error(`Could not find object end for marker: ${marker}`);
  }

  const objectLiteral = html.slice(objectStart, objectEnd + 1);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`DATA = ${objectLiteral};`, sandbox, { timeout: 3000 });
  return sandbox.DATA;
}

function buildMapCandidates(mapName) {
  const normalized = normalizeMapName(mapName);
  const candidates = [normalized];

  const withoutThe = normalized.replace(/^The\s+/i, '').trim();
  if (withoutThe && withoutThe !== normalized) {
    candidates.push(withoutThe);
  }
  if (withoutThe) {
    candidates.push(`The ${withoutThe}`);
  }

  if (/^Raccoon City Police Station\s+/i.test(normalized)) {
    candidates.push(normalized.replace(/^Raccoon City\s+/i, ''));
  }

  if (/^Badham Preschool\s+/i.test(normalized)) {
    candidates.push(normalized.replace(/^Badham\s+/i, ''));
  }

  if (/Treatment Theater/i.test(normalized)) {
    candidates.push(normalized.replace(/Treatment Theater/gi, 'Treatment Theatre'));
  }
  if (/Treatment Theatre/i.test(normalized)) {
    candidates.push(normalized.replace(/Treatment Theatre/gi, 'Treatment Theater'));
  }

  if (/Rancid Abattoir/i.test(normalized)) {
    candidates.push(normalized.replace(/Abattoir/gi, 'Abbatoir'));
  }

  return [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
}

function resolveCurrentMapLayouts(mapLayouts, mapName) {
  const normalized = normalizeMapName(mapName);
  const withoutThe = normalized.replace(/^The\s+/i, '').trim();
  const withThe = withoutThe ? `The ${withoutThe}` : normalized;

  const direct = mapLayouts[normalized];
  if (Array.isArray(direct)) return direct;

  const noThe = mapLayouts[withoutThe];
  if (Array.isArray(noThe)) return noThe;

  const yesThe = mapLayouts[withThe];
  if (Array.isArray(yesThe)) return yesThe;

  return [];
}

function toUniqueMapNames(maps) {
  const byName = new Map();
  for (const map of maps || []) {
    const name = normalizeMapName(map?.name || '');
    if (!name) continue;
    const key = normalizeKey(name);
    if (!byName.has(key)) {
      byName.set(key, {
        name,
        realm: map?.realm || '',
        ids: map?.id ? [map.id] : []
      });
      continue;
    }
    const current = byName.get(key);
    if (map?.id && !current.ids.includes(map.id)) current.ids.push(map.id);
  }
  return [...byName.values()];
}

function buildHensLookup(entries) {
  const lookup = new Map();
  for (const entry of entries) {
    const key = normalizeKey(entry.label);
    if (!key) continue;
    if (!lookup.has(key)) lookup.set(key, []);
    lookup.get(key).push(entry);
  }
  return lookup;
}

function encodePathSegments(dataPath) {
  return dataPath
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch (error) {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
}

async function fetchText(url) {
  try {
    return await fetchTextWithRetry(url, {
      ...NETWORK_OPTIONS,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; map-layout-sync/1.0)',
        accept: 'text/html,application/xhtml+xml'
      }
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  }
}

async function fetchBinary(url) {
  let buffer;
  try {
    buffer = await fetchBinaryWithRetry(url, {
      ...NETWORK_OPTIONS,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; map-layout-sync/1.0)',
        accept: 'image/webp,image/gif,image/png,image/*,*/*;q=0.8',
        referer: 'https://hens333.com/'
      }
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  }

  if (buffer.length < 1024) {
    throw new Error('Downloaded file is too small to be a valid map image');
  }
  return buffer;
}

function parseHensCallouts(html) {
  const $ = cheerio.load(html);
  const entries = [];

  $('button[data-path]').each((_, element) => {
    const dataPath = String($(element).attr('data-path') || '').trim();
    const label = String($(element).text() || '').trim();
    if (!dataPath || !label) return;
    entries.push({ label, dataPath });
  });

  const deduped = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.label}::${entry.dataPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

async function main() {
  const database = readJson(DATABASE_PATH);
  const indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  const mapLayouts = parseObjectLiteralFromIndex(indexHtml, 'const MAP_LAYOUTS = {');

  const uniqueMaps = toUniqueMapNames(database.maps || []);
  const hensHtml = await fetchText(HENS_CALLOUTS_URL);
  const hensEntries = parseHensCallouts(hensHtml);
  if (hensEntries.length === 0) {
    fail('source health check failed: Hens callouts page returned zero entries');
  }

  if (healthCheckOnly) {
    console.log(`sync-map-layouts: health-check ok callout_entries=${hensEntries.length}`);
    return;
  }

  const hensLookup = buildHensLookup(hensEntries);

  ensureDir(path.dirname(REPORT_PATH));

  let downloadedCount = 0;
  let reusedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const reportRows = [];
  const missingKeySuggestions = {};
  const legacyUpgradeSuggestions = {};

  for (const map of uniqueMaps) {
    const candidates = buildMapCandidates(map.name);

    let matchedHens = null;
    for (const candidate of candidates) {
      const matched = hensLookup.get(normalizeKey(candidate));
      if (matched && matched.length) {
        matchedHens = matched[0];
        break;
      }
    }

    const currentEntries = resolveCurrentMapLayouts(mapLayouts, map.name);
    const hasMapLayoutKey = currentEntries.length > 0;

    const existingPaths = currentEntries
      .map((entry) => String(entry?.path || '').trim())
      .filter(Boolean);

    const existingResolvedPaths = existingPaths.map((relPath) => {
      const absolutePath = path.join(OUTPUT_ROOT, relPath);
      return {
        relPath,
        absolutePath,
        exists: fs.existsSync(absolutePath)
      };
    });

    const firstExistingEntry = existingResolvedPaths[0] || null;
    const hasExistingFile = existingResolvedPaths.some((entry) => entry.exists);
    const hasLegacyOnly = hasMapLayoutKey && existingPaths.length > 0 && existingPaths.every((value) => !value.startsWith('map_layouts_hens/'));
    const sourceExt = path.extname(matchedHens?.dataPath || '').toLowerCase() || '.webp';
    const generatedRelPath = `map_layouts_hens/${slugify(map.name)}${sourceExt}`;
    const preferGeneratedForUpgrade = Boolean(upgradeLegacy && hasLegacyOnly);
    const targetRelPath = preferGeneratedForUpgrade
      ? generatedRelPath
      : (firstExistingEntry?.relPath || generatedRelPath);
    const targetAbsPath = path.join(OUTPUT_ROOT, targetRelPath);

    let status = 'covered';
    let sourceUrl = '';
    let downloaded = false;
    let errorMessage = '';

    const needsSyncBecauseMissing = !hasMapLayoutKey || !hasExistingFile;
    const needsSyncBecauseUpgrade = Boolean(upgradeLegacy && hasLegacyOnly);
    const shouldSync = needsSyncBecauseMissing || needsSyncBecauseUpgrade;

    if (shouldSync && matchedHens) {
      sourceUrl = `${HENS_BASE_URL}/${encodePathSegments(matchedHens.dataPath)}`;

      const targetExists = fs.existsSync(targetAbsPath);
      if (targetExists && !refresh) {
        reusedCount += 1;
        status = needsSyncBecauseUpgrade ? 'ready-upgrade-alias' : 'ready-existing-file';
      } else if (dryRun) {
        skippedCount += 1;
        status = 'dry-run';
      } else {
        try {
          ensureDir(path.dirname(targetAbsPath));
          const bytes = await fetchBinary(sourceUrl);
          fs.writeFileSync(targetAbsPath, bytes);
          downloadedCount += 1;
          downloaded = true;
          status = needsSyncBecauseUpgrade ? 'downloaded-upgrade-alias' : 'downloaded';
        } catch (error) {
          failedCount += 1;
          status = 'download-failed';
          errorMessage = String(error?.message || error);
        }
      }
    } else if (shouldSync && !matchedHens) {
      status = 'missing-source';
    }

    if (!hasMapLayoutKey && (status.startsWith('downloaded') || status.startsWith('ready-'))) {
      missingKeySuggestions[map.name] = [{ path: targetRelPath, label: '' }];
    }

    if (hasLegacyOnly && (status === 'downloaded-upgrade-alias' || status === 'ready-upgrade-alias')) {
      legacyUpgradeSuggestions[map.name] = [{ path: generatedRelPath, label: '' }];
    }

    reportRows.push({
      mapName: map.name,
      realm: map.realm,
      mapIds: map.ids,
      hasMapLayoutKey,
      hasExistingFile,
      hasLegacyOnly,
      currentPrimaryRelPath: firstExistingEntry?.relPath || '',
      candidates,
      matchedSourceLabel: matchedHens?.label || '',
      matchedSourcePath: matchedHens?.dataPath || '',
      matchedSourceUrl: sourceUrl,
      generatedRelPath,
      targetRelPath,
      status,
      downloaded,
      error: errorMessage
    });
  }

  const missingSourceMaps = reportRows.filter((entry) => entry.status === 'missing-source').map((entry) => entry.mapName);
  const unresolvedMaps = reportRows.filter((entry) => !entry.hasMapLayoutKey).map((entry) => entry.mapName);
  const upgradeCandidates = reportRows
    .filter((entry) => entry.hasLegacyOnly && entry.matchedSourcePath)
    .map((entry) => entry.mapName);

  const report = {
    generatedAt: new Date().toISOString(),
    options: {
      dryRun,
      refresh,
      checkMode,
      upgradeLegacy
    },
    source: {
      calloutsPage: HENS_CALLOUTS_URL,
      calloutsBase: HENS_BASE_URL,
      calloutEntryCount: hensEntries.length
    },
    stats: {
      databaseMapCount: (database.maps || []).length,
      uniqueDatabaseMapNames: uniqueMaps.length,
      currentMapLayoutKeyCount: Object.keys(mapLayouts).length,
      missingMapLayoutKeyCount: unresolvedMaps.length,
      missingSourceCount: missingSourceMaps.length,
      downloadedCount,
      reusedCount,
      skippedCount,
      failedCount,
      upgradeCandidateCount: upgradeCandidates.length
    },
    missingSourceMaps,
    unresolvedMaps,
    upgradeCandidates,
    suggestions: {
      missingKeys: missingKeySuggestions,
      legacyUpgrades: legacyUpgradeSuggestions
    },
    rows: reportRows
  };

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`sync-map-layouts: callout entries=${hensEntries.length}`);
  console.log(`sync-map-layouts: maps(unique)=${uniqueMaps.length} missingSource=${missingSourceMaps.length} missingMapLayoutKeys=${unresolvedMaps.length}`);
  console.log(`sync-map-layouts: downloaded=${downloadedCount} reused=${reusedCount} skipped=${skippedCount} failed=${failedCount}`);
  console.log(`sync-map-layouts: report=${path.relative(ROOT, REPORT_PATH)}`);

  if (upgradeCandidates.length > 0) {
    console.log(`sync-map-layouts: legacy layout upgrade candidates=${upgradeCandidates.length}`);
  }

  if (checkMode && (missingSourceMaps.length > 0 || failedCount > 0)) {
    fail(`check mode failed (missingSource=${missingSourceMaps.length}, failedDownloads=${failedCount})`);
  }
}

main().catch((error) => {
  fail(error.message || String(error));
});
