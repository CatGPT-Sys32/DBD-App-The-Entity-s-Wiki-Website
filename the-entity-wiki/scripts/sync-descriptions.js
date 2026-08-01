#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { fetchJsonWithRetry, formatFetchError } = require('./network-resilience');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'content', 'database.json');
const PERK_REPORT_PATH = path.join(ROOT, 'content', 'perk-description-report.json');
const ADDON_REPORT_PATH = path.join(ROOT, 'content', 'addon-description-report.json');
const SUMMARY_REPORT_PATH = path.join(ROOT, 'review', 'description-sync-report.json');

const PERKS_API_URL = 'https://dbd.tricky.lol/api/perks';
const ADDONS_API_URL = 'https://dbd.tricky.lol/api/addons';
const OFFICIAL_960_PERK_DESCRIPTION_OVERRIDES = new Map([
  [
    'fast track',
    [
      'Whenever you unhook another Survivor, you earn 1 Token, up to 1/2/3.',
      '',
      'While repairing, whenever you hit a great basic Skill Check, spend all Tokens. For each Token spent, the Generator gains 5% permanent progress.'
    ].join('\n')
  ]
]);
const OFFICIAL_960_ADDON_DESCRIPTION_OVERRIDES = new Map([
  [
    'ADDON_Lastbreath_HeavyPanting',
    "The slow and bulging breath stolen from the orderly. Dimly oscillates at The Nurse's touch.\n\nExtends the duration of a lunge after more than one Blink by 10%."
  ],
  [
    'Addon_Ghost_WalleyesMatchbook',
    "A sheet of matches from Walleye's, a small bar in Northern Roseville. A victim's phone number is scribbled in blue. One of the incriminating pieces of evidence found.\n\nDecreases Night Shroud recovery time by 2 seconds."
  ],
  [
    'Addon_K29_05',
    'To the person whose only tool is a crank, the whole world looks like a crank-shaped hole. Increases movement speed between the first and second Virulent Bounds by 15%.'
  ],
  [
    'Addon_K29_14',
    'A highly coveted foodstuff. The cash worth is second only to its regenerative effects. Increases the Chain Bound window by 20%.'
  ],
  [
    'Addon_K40_03',
    'The lamination is peeling and crusty. How appetizing.\n\nDecreases the minimum time required to retrieve an axe embedded in the environment by 10%.'
  ],
  [
    'Addon_K40_16',
    'Gaining control over the security doors is key to getting the job done.\n\nYour Axe gains the ability to travel through Security Doors, and will exit straight through the connected Security Door.\n\nWhen aiming your Axe:Gain Killer Instinct on Survivors within 6 meters of any Security Door.Reveals the auras of all Security Door numbers.'
  ]
]);
const STATUS_EXPLANATION_RE = /^(?:Blindness|Broken|Exhausted|Exposed|Haste|Hindered|Oblivious|Undetectable)\b.*(?:prevents|increases|reduces|hides|downed)/i;
const NETWORK_OPTIONS = {
  retries: 3,
  timeoutMs: 15000,
  baseDelayMs: 400,
  maxDelayMs: 5000
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const checkMode = args.has('--check');
const allowUnresolved = args.has('--allow-unresolved');
const healthCheckOnly = args.has('--health-check');

function fail(message) {
  console.error(`sync-descriptions: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function requestJson(url) {
  try {
    return await fetchJsonWithRetry(url, {
      ...NETWORK_OPTIONS,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; sync-descriptions/1.0)',
        accept: 'application/json,text/plain,*/*'
      }
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  }
}

function validateSourcePayloads(perksPayload, addonsPayload) {
  const validPerksPayload = perksPayload && typeof perksPayload === 'object' && !Array.isArray(perksPayload);
  const validAddonsPayload = addonsPayload && typeof addonsPayload === 'object' && !Array.isArray(addonsPayload);

  if (!validPerksPayload) {
    fail('source health check failed: perks payload is not a JSON object');
  }

  if (!validAddonsPayload) {
    fail('source health check failed: addons payload is not a JSON object');
  }

  const sourcePerkCount = Object.keys(perksPayload).length;
  const sourceAddonCount = Object.keys(addonsPayload).length;
  if (sourcePerkCount === 0 || sourceAddonCount === 0) {
    fail(`source health check failed: empty payload(s) perks=${sourcePerkCount} addons=${sourceAddonCount}`);
  }

  return { sourcePerkCount, sourceAddonCount };
}

async function fetchSourcePayloads() {
  const [perksPayload, addonsPayload] = await Promise.all([
    requestJson(PERKS_API_URL),
    requestJson(ADDONS_API_URL)
  ]);

  const sourceCounts = validateSourcePayloads(perksPayload, addonsPayload);
  return { perksPayload, addonsPayload, sourceCounts };
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
  if (Array.isArray(tunables)) {
    tunables.forEach((tier, index) => {
      const token = `{${index}}`;
      const value = formatTunableValue(tier);
      output = output.split(token).join(value);
    });
    return replaceNamedTemplateTokens(output);
  }

  const tunableLookup = new Map();
  if (tunables && typeof tunables === 'object') {
    for (const [key, tier] of Object.entries(tunables)) {
      const token = `{${key}}`;
      const value = formatTunableValue(tier);
      tunableLookup.set(normalizeTunableKey(key), value);
      output = output.split(token).join(value);
    }
  }

  return replaceNamedTemplateTokens(output, tunableLookup);
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
  let output = stripHtml(text);
  output = output.replace(/\s+/g, ' ');
  output = output.replace(/\s+([,.;:!?])/g, '$1');
  output = output.replace(/\s*\/\s*/g, '/');
  output = output.replace(/([0-9])\s*%/g, '$1%');
  output = output.replace(/([+\-][0-9]+)\s*%/g, '$1%');
  output = output.replace(/\(\s+/g, '(');
  output = output.replace(/\s+\)/g, ')');
  return output.trim();
}

function normalizeMultilineText(text) {
  if (!text) return '';

  const lines = [];
  let previousBlank = false;
  for (const rawLine of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const match = rawLine.match(/^(\s*)(-\s+)?(.*)$/);
    const indent = (match && match[1]) || '';
    const bullet = match && match[2] ? '- ' : '';
    const body = cleanInlineText((match && match[3]) || '');

    if (!body) {
      if (lines.length > 0 && !previousBlank) {
        lines.push('');
      }
      previousBlank = true;
      continue;
    }

    lines.push(`${indent}${bullet}${body}`);
    previousBlank = false;
  }

  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return lines.join('\n');
}

function semanticNormalize(text) {
  return normalizeMultilineText(text).replace(/^\s*-\s+/gm, '').replace(/\s+/g, ' ').trim();
}

function isFlavorOrHelpLine(line) {
  const stripped = cleanInlineText(line);
  if (!stripped) return false;
  if (/^["“].*["”]\s*(?:[-—–].+)?$/.test(stripped)) return true;
  if (STATUS_EXPLANATION_RE.test(stripped)) return true;
  return false;
}

function sanitizeDescriptionBlock(text) {
  const kept = [];
  for (const rawLine of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (isFlavorOrHelpLine(rawLine)) break;
    kept.push(rawLine);
  }
  const output = normalizeMultilineText(kept.join('\n'));
  if (!output) {
    return normalizeMultilineText(text);
  }
  return output;
}

function normalizePerkImageToken(imagePath) {
  const base = path.basename(String(imagePath || '').toLowerCase(), path.extname(String(imagePath || '').toLowerCase()));
  return base.replace(/^iconperks[_-]?/i, '').replace(/[^a-z0-9]/g, '');
}

function buildPerkIndexes(perksPayload) {
  const byExactName = new Map();
  const byLowerName = new Map();
  const byImageToken = new Map();

  for (const [sourceKey, sourcePerk] of Object.entries(perksPayload || {})) {
    if (!sourcePerk || typeof sourcePerk !== 'object') continue;
    const name = String(sourcePerk.name || '').trim();
    if (!name) continue;

    const entry = {
      key: sourceKey,
      name,
      image: sourcePerk.image || '',
      tunables: sourcePerk.tunables,
      description: sourcePerk.description || '',
      sourceUrl: `${PERKS_API_URL}#${encodeURIComponent(sourceKey)}`
    };

    byExactName.set(name, entry);
    byLowerName.set(name.toLowerCase(), entry);

    const token = normalizePerkImageToken(entry.image);
    if (token) {
      if (!byImageToken.has(token)) byImageToken.set(token, []);
      byImageToken.get(token).push(entry);
    }
  }

  return { byExactName, byLowerName, byImageToken };
}

function resolvePerkSource(perk, indexes) {
  const name = String(perk?.name || '');
  const exact = indexes.byExactName.get(name);
  if (exact) return { ...exact, matchType: 'name' };

  const lower = indexes.byLowerName.get(name.toLowerCase());
  if (lower) return { ...lower, matchType: 'name-insensitive' };

  const token = normalizePerkImageToken(perk?.image || '');
  if (token) {
    const candidates = indexes.byImageToken.get(token) || [];
    if (candidates.length === 1) {
      return { ...candidates[0], matchType: 'image-token' };
    }
  }

  return null;
}

function processPerks(database, perksPayload) {
  const indexes = buildPerkIndexes(perksPayload);
  const counts = {
    different: 0,
    same_as_legacy: 0
  };
  const changes = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    total: 0
  };

  const entries = [];
  const unresolved = [];
  const samples = [];

  for (const perk of database.perks || []) {
    const source = resolvePerkSource(perk, indexes);
    if (!source) {
      unresolved.push(perk.name);
      entries.push({
        id: perk.id,
        name: perk.name,
        status: 'unresolved',
        sourceUrl: '',
        sourceKey: '',
        matchType: 'none'
      });
      continue;
    }

    let sourceDescription = sanitizeDescriptionBlock(applyTunables(source.description, source.tunables));
    const officialOverride = OFFICIAL_960_PERK_DESCRIPTION_OVERRIDES.get(source.name.toLowerCase());
    if (officialOverride) {
      sourceDescription = normalizeMultilineText(officialOverride);
    }
    const legacyDescription = normalizeMultilineText(perk.description || '');
    const existingPost95 = normalizeMultilineText(perk.descriptionPost95 || '');

    const status = semanticNormalize(sourceDescription) === semanticNormalize(legacyDescription)
      ? 'same_as_legacy'
      : 'different';
    counts[status] += 1;

    if (status === 'same_as_legacy') {
      if (Object.prototype.hasOwnProperty.call(perk, 'descriptionPost95')) {
        changes.removed += 1;
        if (samples.length < 20) {
          samples.push({ name: perk.name, kind: 'removedPost95', matchType: source.matchType });
        }
        if (!dryRun && !checkMode) {
          delete perk.descriptionPost95;
        }
      } else {
        changes.unchanged += 1;
      }
    } else {
      if (!existingPost95) {
        changes.added += 1;
        if (samples.length < 20) {
          samples.push({ name: perk.name, kind: 'addedPost95', matchType: source.matchType });
        }
        if (!dryRun && !checkMode) {
          perk.descriptionPost95 = sourceDescription;
        }
      } else if (semanticNormalize(existingPost95) !== semanticNormalize(sourceDescription)) {
        changes.updated += 1;
        if (samples.length < 20) {
          samples.push({ name: perk.name, kind: 'updatedPost95', matchType: source.matchType });
        }
        if (!dryRun && !checkMode) {
          perk.descriptionPost95 = sourceDescription;
        }
      } else {
        changes.unchanged += 1;
      }
    }

    entries.push({
      id: perk.id,
      name: perk.name,
      status,
      sourceUrl: source.sourceUrl,
      sourceKey: source.key,
      matchType: source.matchType
    });
  }

  changes.total = changes.added + changes.updated + changes.removed;
  return { counts, changes, entries, unresolved, samples };
}

function processAddons(database, addonsPayload) {
  const counts = {
    updated: 0,
    unchanged: 0,
    unresolved: 0
  };
  const changes = {
    updated: 0,
    unchanged: 0,
    total: 0
  };

  const entries = [];
  const unresolved = [];
  const samples = [];

  for (const addon of database.addons || []) {
    const source = addonsPayload?.[addon.internalId];
    if (!source) {
      counts.unresolved += 1;
      unresolved.push(addon.name);
      entries.push({
        id: addon.id,
        internalId: addon.internalId || '',
        name: addon.name,
        status: 'unresolved',
        sourceUrl: ''
      });
      continue;
    }

    let sourceDescription = normalizeMultilineText(applyTunables(source.description || '', source.modifiers));
    const officialOverride = OFFICIAL_960_ADDON_DESCRIPTION_OVERRIDES.get(addon.internalId);
    if (officialOverride) {
      sourceDescription = normalizeMultilineText(officialOverride);
    }
    const localDescription = normalizeMultilineText(addon.description || '');
    const changed = semanticNormalize(sourceDescription) !== semanticNormalize(localDescription);

    if (changed) {
      counts.updated += 1;
      changes.updated += 1;
      if (samples.length < 20) {
        samples.push({ name: addon.name, internalId: addon.internalId });
      }
      if (!dryRun && !checkMode) {
        addon.description = sourceDescription;
      }
    } else {
      counts.unchanged += 1;
      changes.unchanged += 1;
    }

    entries.push({
      id: addon.id,
      internalId: addon.internalId || '',
      name: addon.name,
      status: changed ? 'updated' : 'unchanged',
      sourceUrl: `${ADDONS_API_URL}#${encodeURIComponent(addon.internalId || addon.id || '')}`
    });
  }

  changes.total = changes.updated;
  return { counts, changes, entries, unresolved, samples };
}

async function main() {
  const { perksPayload, addonsPayload, sourceCounts } = await fetchSourcePayloads();

  if (healthCheckOnly) {
    console.log(`sync-descriptions: health-check ok perks=${sourceCounts.sourcePerkCount} addons=${sourceCounts.sourceAddonCount}`);
    return;
  }

  if (!fs.existsSync(DATABASE_PATH)) {
    fail(`missing ${path.relative(ROOT, DATABASE_PATH)}`);
  }

  const database = readJson(DATABASE_PATH);
  if (!Array.isArray(database.perks) || !Array.isArray(database.addons)) {
    fail('content/database.json must contain perks and addons arrays');
  }

  const perkResult = processPerks(database, perksPayload);
  const addonResult = processAddons(database, addonsPayload);
  const unresolved = [...perkResult.unresolved, ...addonResult.unresolved];

  const summaryReport = {
    generatedAt: new Date().toISOString(),
    options: {
      dryRun,
      checkMode,
      allowUnresolved
    },
    source: {
      perksApi: PERKS_API_URL,
      addonsApi: ADDONS_API_URL,
      sourcePerkCount: sourceCounts.sourcePerkCount,
      sourceAddonCount: sourceCounts.sourceAddonCount
    },
    perks: {
      total: (database.perks || []).length,
      counts: perkResult.counts,
      changes: perkResult.changes,
      unresolvedCount: perkResult.unresolved.length,
      unresolved: perkResult.unresolved,
      sampleChanges: perkResult.samples
    },
    addons: {
      total: (database.addons || []).length,
      counts: addonResult.counts,
      changes: addonResult.changes,
      unresolvedCount: addonResult.unresolved.length,
      unresolved: addonResult.unresolved,
      sampleChanges: addonResult.samples
    }
  };

  const hasUnresolved = unresolved.length > 0;
  if (hasUnresolved && !allowUnresolved) {
    fail(`unresolved entries found (${unresolved.length}). Re-run with --allow-unresolved to continue.`);
  }

  const hasChanges = perkResult.changes.total + addonResult.changes.total > 0;
  if (checkMode) {
    console.log(`sync-descriptions: check mode unresolved=${unresolved.length} changes=${hasChanges ? 'yes' : 'no'}`);
    if (hasChanges || (hasUnresolved && !allowUnresolved)) {
      process.exit(1);
    }
    return;
  }

  if (!dryRun) {
    const perkReport = {
      totalPerks: (database.perks || []).length,
      counts: perkResult.counts,
      entries: perkResult.entries
    };

    const addonReport = {
      totalAddons: (database.addons || []).length,
      counts: addonResult.counts,
      entries: addonResult.entries
    };

    writeJson(DATABASE_PATH, database);
    writeJson(PERK_REPORT_PATH, perkReport);
    writeJson(ADDON_REPORT_PATH, addonReport);
    writeJson(SUMMARY_REPORT_PATH, summaryReport);
  }

  console.log(`sync-descriptions: perks different=${perkResult.counts.different} same_as_legacy=${perkResult.counts.same_as_legacy}`);
  console.log(`sync-descriptions: perks changed added=${perkResult.changes.added} updated=${perkResult.changes.updated} removed=${perkResult.changes.removed}`);
  console.log(`sync-descriptions: addons updated=${addonResult.changes.updated} unchanged=${addonResult.changes.unchanged}`);

  if (dryRun) {
    console.log('sync-descriptions: dry-run mode, no files were written');
    return;
  }

  console.log(`sync-descriptions: wrote ${path.relative(ROOT, DATABASE_PATH)}`);
  console.log(`sync-descriptions: wrote ${path.relative(ROOT, PERK_REPORT_PATH)}`);
  console.log(`sync-descriptions: wrote ${path.relative(ROOT, ADDON_REPORT_PATH)}`);
  console.log(`sync-descriptions: wrote ${path.relative(ROOT, SUMMARY_REPORT_PATH)}`);
}

main().catch((error) => {
  fail(error.message || String(error));
});
