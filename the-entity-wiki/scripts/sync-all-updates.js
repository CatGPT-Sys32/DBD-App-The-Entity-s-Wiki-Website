#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic-write');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'review', 'sync-all-updates-report.json');
const RELEASE_SUMMARY_PATH = path.join(ROOT, 'review', 'release-summary.md');
const DATABASE_PATH = path.join(ROOT, 'content', 'database.json');
const DESCRIPTION_REPORT_PATH = path.join(ROOT, 'review', 'description-sync-report.json');
const MAP_AUDIT_REPORT_PATH = path.join(ROOT, 'review', 'map-layouts-audit.json');

const args = new Set(process.argv.slice(2));

const TRACKED_PATHS = [
  'content/database.json',
  'content/community-content.json',
  'content/perk-description-report.json',
  'content/addon-description-report.json',
  'review/map-layouts-audit.json',
  'review/description-sync-report.json',
  'review/release-summary.md',
  'web/data.js',
  'web/lore.js',
  'web/community-content.js',
  'web/cosmetics.js',
  'web/dbd_images/addons',
  'web/dbd_images/killers',
  'web/dbd_images/map_layouts_hens',
  'web/dbd_images/perks',
  'web/dbd_images/powers',
  'web/dbd_images/survivors'
];

function fail(message) {
  console.error(`sync-all-updates: ${message}`);
  process.exit(1);
}

function resolveIncludeAssets() {
  const hasIncludeAssets = args.has('--include-assets');
  const hasSkipAssets = args.has('--skip-assets');

  if (hasIncludeAssets && hasSkipAssets) {
    fail('cannot use --include-assets and --skip-assets together');
  }

  if (hasIncludeAssets) return true;
  if (hasSkipAssets) return false;
  return true;
}

const includeAssets = resolveIncludeAssets();

function runStep(step) {
  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    timeout: 30 * 60 * 1000
  });

  return {
    name: step.name,
    command: [step.command, ...step.args].join(' '),
    durationMs: Date.now() - startedAt,
    exitCode: result.status === null ? 1 : result.status,
    signal: result.signal || null,
    status: result.status === 0 ? 'ok' : 'failed'
  };
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function collectFilesRecursive(rootPath, relativePrefix, output) {
  const children = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const child of children) {
    const absChild = path.join(rootPath, child.name);
    const relChild = path.join(relativePrefix, child.name).replace(/\\/g, '/');
    if (child.isDirectory()) {
      collectFilesRecursive(absChild, relChild, output);
      continue;
    }
    if (!child.isFile()) continue;
    output.set(relChild, {
      hash: hashFile(absChild),
      size: fs.statSync(absChild).size
    });
  }
}

function takeSnapshot() {
  const snapshot = new Map();
  for (const target of TRACKED_PATHS) {
    const absoluteTarget = path.join(ROOT, target);
    if (!fs.existsSync(absoluteTarget)) continue;

    const stat = fs.statSync(absoluteTarget);
    if (stat.isFile()) {
      snapshot.set(target, {
        hash: hashFile(absoluteTarget),
        size: stat.size
      });
      continue;
    }

    if (stat.isDirectory()) {
      collectFilesRecursive(absoluteTarget, target, snapshot);
    }
  }
  return snapshot;
}

function diffSnapshots(beforeSnapshot, afterSnapshot) {
  const added = [];
  const removed = [];
  const modified = [];

  for (const [filePath, beforeMeta] of beforeSnapshot.entries()) {
    if (!afterSnapshot.has(filePath)) {
      removed.push(filePath);
      continue;
    }

    const afterMeta = afterSnapshot.get(filePath);
    if (beforeMeta.hash !== afterMeta.hash) {
      modified.push(filePath);
    }
  }

  for (const filePath of afterSnapshot.keys()) {
    if (!beforeSnapshot.has(filePath)) {
      added.push(filePath);
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort()
  };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function normalizeMultilineText(text) {
  if (!text) return '';

  const lines = [];
  let previousBlank = false;
  for (const rawLine of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const match = rawLine.match(/^(\s*)(-\s+)?(.*)$/);
    const indent = (match && match[1]) || '';
    const bullet = match && match[2] ? '- ' : '';
    const body = ((match && match[3]) || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();

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

function compareDatabaseDescriptionChanges(beforeDatabase, afterDatabase) {
  if (!beforeDatabase || !afterDatabase) {
    return null;
  }

  const beforePerkById = new Map((beforeDatabase.perks || []).map((perk) => [perk.id, perk]));
  const beforeAddonByInternalId = new Map((beforeDatabase.addons || []).map((addon) => [addon.internalId || addon.id, addon]));

  const perkPost95 = {
    added: 0,
    removed: 0,
    updated: 0,
    sample: []
  };
  const addonDescriptions = {
    updated: 0,
    sample: []
  };

  for (const perk of afterDatabase.perks || []) {
    const beforePerk = beforePerkById.get(perk.id) || {};
    const beforeModern = semanticNormalize(beforePerk.descriptionPost95 || '');
    const afterModern = semanticNormalize(perk.descriptionPost95 || '');

    if (!beforeModern && afterModern) {
      perkPost95.added += 1;
      if (perkPost95.sample.length < 20) {
        perkPost95.sample.push({ name: perk.name, kind: 'added' });
      }
      continue;
    }

    if (beforeModern && !afterModern) {
      perkPost95.removed += 1;
      if (perkPost95.sample.length < 20) {
        perkPost95.sample.push({ name: perk.name, kind: 'removed' });
      }
      continue;
    }

    if (beforeModern && afterModern && beforeModern !== afterModern) {
      perkPost95.updated += 1;
      if (perkPost95.sample.length < 20) {
        perkPost95.sample.push({ name: perk.name, kind: 'updated' });
      }
    }
  }

  for (const addon of afterDatabase.addons || []) {
    const key = addon.internalId || addon.id;
    const beforeAddon = beforeAddonByInternalId.get(key) || {};
    const beforeDescription = semanticNormalize(beforeAddon.description || '');
    const afterDescription = semanticNormalize(addon.description || '');
    if (beforeDescription !== afterDescription) {
      addonDescriptions.updated += 1;
      if (addonDescriptions.sample.length < 20) {
        addonDescriptions.sample.push({ name: addon.name, internalId: addon.internalId || '' });
      }
    }
  }

  return {
    perkPost95,
    addonDescriptions
  };
}

function buildSteps() {
  const steps = [
    { name: 'health-check-community-sources', command: 'node', args: ['scripts/sync-community-content.js', '--health-check'] },
    { name: 'health-check-map-layout-sources', command: 'node', args: ['scripts/sync-map-layouts.js', '--health-check'] },
    { name: 'health-check-description-sources', command: 'node', args: ['scripts/sync-descriptions.js', '--health-check'] },
    { name: 'sync-catalog-updates', command: 'node', args: ['scripts/sync-catalog-updates.js'] },
    { name: 'sync-community-content', command: 'node', args: ['scripts/sync-community-content.js'] },
    { name: 'sync-map-layouts', command: 'node', args: ['scripts/sync-map-layouts.js', '--upgrade-legacy'] },
    { name: 'sync-descriptions', command: 'node', args: ['scripts/sync-descriptions.js'] }
  ];

  if (includeAssets) {
    steps.push(
      { name: 'sync-game-icons', command: 'node', args: ['scripts/sync-game-icons.js'] },
      { name: 'sync-offering-fixes', command: 'node', args: ['scripts/sync-offering-fixes.js'] },
      { name: 'discover-cosmetics', command: 'node', args: ['scripts/discover-cosmetics.js'] },
      { name: 'normalize-cosmetics', command: 'node', args: ['scripts/normalize-cosmetics.js'] },
      { name: 'sync-cosmetic-assets', command: 'node', args: ['scripts/sync-cosmetic-assets.js'] }
    );
  }

  steps.push(
    { name: 'build-data', command: 'node', args: ['scripts/build-data.js'] },
    { name: 'normalize-images-check', command: 'node', args: ['scripts/normalize-images.js', '--check'] },
    { name: 'build-data-check', command: 'node', args: ['scripts/build-data.js', '--check'] },
    { name: 'audit-cosmetics', command: 'node', args: ['scripts/audit-cosmetics.js'] },
    { name: 'verify-teachables', command: 'node', args: ['scripts/verify-teachables.js'] },
    { name: 'verify-perk-descriptions', command: 'node', args: ['scripts/verify-perk-descriptions.js'] },
    { name: 'verify-data-contracts', command: 'node', args: ['scripts/verify-data-contracts.js'] },
    { name: 'verify-offline-runtime', command: 'node', args: ['scripts/verify-offline-runtime.js'] }
  );

  return steps;
}

function main() {
  const runStartedAt = Date.now();
  const stepResults = [];
  const beforeSnapshot = takeSnapshot();
  const beforeDatabase = readJsonIfExists(DATABASE_PATH);

  console.log(`sync-all-updates: mode=${includeAssets ? 'full' : 'fast'} (assets ${includeAssets ? 'enabled' : 'disabled'})`);

  let failedStep = null;
  for (const step of buildSteps()) {
    console.log(`sync-all-updates: running ${step.name}...`);
    const result = runStep(step);
    stepResults.push(result);
    if (result.exitCode !== 0) {
      failedStep = result;
      break;
    }
  }

  const afterSnapshot = takeSnapshot();
  const afterDatabase = readJsonIfExists(DATABASE_PATH);
  const fileChanges = diffSnapshots(beforeSnapshot, afterSnapshot);
  const databaseChanges = compareDatabaseDescriptionChanges(beforeDatabase, afterDatabase);
  const descriptionReport = readJsonIfExists(DESCRIPTION_REPORT_PATH);
  const mapAuditReport = readJsonIfExists(MAP_AUDIT_REPORT_PATH);

  const report = {
    generatedAt: new Date().toISOString(),
    artifacts: {
      reportPath: path.relative(ROOT, REPORT_PATH),
      releaseSummaryPath: path.relative(ROOT, RELEASE_SUMMARY_PATH)
    },
    options: {
      includeAssets,
      mode: includeAssets ? 'full' : 'fast',
      rawArgs: Array.from(args).sort()
    },
    durationMs: Date.now() - runStartedAt,
    status: failedStep ? 'failed' : 'ok',
    failedStep: failedStep
      ? {
          name: failedStep.name,
          command: failedStep.command,
          exitCode: failedStep.exitCode,
          signal: failedStep.signal
        }
      : null,
    steps: stepResults,
    changes: {
      addedFiles: fileChanges.added,
      removedFiles: fileChanges.removed,
      modifiedFiles: fileChanges.modified,
      totals: {
        added: fileChanges.added.length,
        removed: fileChanges.removed.length,
        modified: fileChanges.modified.length,
        all: fileChanges.added.length + fileChanges.removed.length + fileChanges.modified.length
      }
    },
    databaseDescriptionChanges: databaseChanges,
    descriptionSyncSummary: descriptionReport
      ? {
          perks: descriptionReport.perks || null,
          addons: descriptionReport.addons || null
        }
      : null,
    mapLayoutSummary: mapAuditReport
      ? {
          stats: mapAuditReport.stats || null,
          missingSourceMaps: mapAuditReport.missingSourceMaps || [],
          unresolvedMaps: mapAuditReport.unresolvedMaps || []
        }
      : null
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeJsonAtomic(REPORT_PATH, report, { backup: false });

  const releaseSummaryResult = spawnSync(
    'node',
    [
      'scripts/generate-release-summary.js',
      '--report',
      path.relative(ROOT, REPORT_PATH),
      '--output',
      path.relative(ROOT, RELEASE_SUMMARY_PATH)
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      timeout: 10 * 60 * 1000
    }
  );

  if (releaseSummaryResult.status !== 0) {
    fail(`release summary generation failed (exit ${releaseSummaryResult.status})`);
  }

  console.log(`sync-all-updates: report=${path.relative(ROOT, REPORT_PATH)}`);
  console.log(`sync-all-updates: release_summary=${path.relative(ROOT, RELEASE_SUMMARY_PATH)}`);
  console.log(`sync-all-updates: changed files added=${fileChanges.added.length} removed=${fileChanges.removed.length} modified=${fileChanges.modified.length}`);

  if (failedStep) {
    fail(`step failed: ${failedStep.name} (exit ${failedStep.exitCode})`);
  }
}

main();
