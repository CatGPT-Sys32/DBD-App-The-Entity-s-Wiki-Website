#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'review', 'sync-all-updates-report.json');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'review', 'release-summary.md');

function fail(message) {
  console.error(`generate-release-summary: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    reportPath: DEFAULT_REPORT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) fail('missing value for --report');
      options.reportPath = path.resolve(ROOT, value);
      index += 1;
      continue;
    }

    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value) fail('missing value for --output');
      options.outputPath = path.resolve(ROOT, value);
      index += 1;
      continue;
    }
  }

  return options;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing report file: ${path.relative(ROOT, filePath)}`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`invalid JSON in ${path.relative(ROOT, filePath)}: ${error.message}`);
  }
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatStepStatus(status) {
  if (status === 'ok') return 'OK';
  if (status === 'failed') return 'FAILED';
  return String(status || '').toUpperCase() || 'UNKNOWN';
}

function renderFileList(title, files) {
  const safeFiles = Array.isArray(files) ? files : [];
  const lines = [`### ${title} (${safeFiles.length})`];
  if (safeFiles.length === 0) {
    lines.push('- None');
    lines.push('');
    return lines;
  }

  safeFiles.forEach((filePath) => {
    lines.push(`- ${filePath}`);
  });
  lines.push('');
  return lines;
}

function buildSummaryMarkdown(report) {
  const options = report.options || {};
  const changes = report.changes || {};
  const totals = changes.totals || {};
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const description = report.descriptionSyncSummary || {};
  const mapSummary = report.mapLayoutSummary || {};

  const perkSummary = description.perks || {};
  const addonSummary = description.addons || {};
  const perkChanges = perkSummary.changes || {};
  const addonChanges = addonSummary.changes || {};
  const mapStats = mapSummary.stats || {};

  const lines = [];
  lines.push('# Release Sync Summary');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Run generatedAt: ${report.generatedAt || 'n/a'}`);
  lines.push(`Status: ${report.status || 'unknown'}`);
  lines.push(`Mode: ${options.mode || (options.includeAssets ? 'full' : 'fast')}`);
  lines.push(`Duration: ${formatDuration(report.durationMs)}`);
  lines.push('');

  lines.push('## File Delta Overview');
  lines.push('');
  lines.push(`- Added: ${Number(totals.added || 0)}`);
  lines.push(`- Modified: ${Number(totals.modified || 0)}`);
  lines.push(`- Removed: ${Number(totals.removed || 0)}`);
  lines.push(`- Total changed: ${Number(totals.all || 0)}`);
  lines.push('');

  lines.push('## Description Sync Overview');
  lines.push('');
  lines.push(`- Perks total: ${Number(perkSummary.total || 0)}`);
  lines.push(`- Perks unresolved: ${Number(perkSummary.unresolvedCount || 0)}`);
  lines.push(`- Perk descriptionPost95 changes: added=${Number(perkChanges.added || 0)} updated=${Number(perkChanges.updated || 0)} removed=${Number(perkChanges.removed || 0)}`);
  lines.push(`- Addons total: ${Number(addonSummary.total || 0)}`);
  lines.push(`- Addons unresolved: ${Number(addonSummary.unresolvedCount || 0)}`);
  lines.push(`- Addon description changes: updated=${Number(addonChanges.updated || 0)} unchanged=${Number(addonChanges.unchanged || 0)}`);
  lines.push('');

  lines.push('## Map Layout Sync Overview');
  lines.push('');
  lines.push(`- Missing source maps: ${Array.isArray(mapSummary.missingSourceMaps) ? mapSummary.missingSourceMaps.length : 0}`);
  lines.push(`- Unresolved maps: ${Array.isArray(mapSummary.unresolvedMaps) ? mapSummary.unresolvedMaps.length : 0}`);
  lines.push(`- Downloaded assets: ${Number(mapStats.downloadedCount || 0)}`);
  lines.push(`- Reused assets: ${Number(mapStats.reusedCount || 0)}`);
  lines.push(`- Upgrade candidates: ${Number(mapStats.upgradeCandidateCount || 0)}`);
  lines.push('');

  lines.push('## Step Results');
  lines.push('');
  if (steps.length === 0) {
    lines.push('- No steps were recorded.');
  } else {
    steps.forEach((step) => {
      lines.push(`- [${formatStepStatus(step.status)}] ${step.name} (${formatDuration(step.durationMs)})`);
    });
  }
  lines.push('');

  if (report.failedStep) {
    lines.push('## Failed Step');
    lines.push('');
    lines.push(`- Name: ${report.failedStep.name || 'n/a'}`);
    lines.push(`- Command: ${report.failedStep.command || 'n/a'}`);
    lines.push(`- Exit code: ${report.failedStep.exitCode ?? 'n/a'}`);
    if (report.failedStep.signal) {
      lines.push(`- Signal: ${report.failedStep.signal}`);
    }
    lines.push('');
  }

  lines.push(...renderFileList('Added Files', changes.addedFiles || []));
  lines.push(...renderFileList('Modified Files', changes.modifiedFiles || []));
  lines.push(...renderFileList('Removed Files', changes.removedFiles || []));

  return `${lines.join('\n').trimEnd()}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = readJson(options.reportPath);
  const output = buildSummaryMarkdown(report);

  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  writeFileAtomic(options.outputPath, output, 'utf8');

  console.log(`generate-release-summary: report=${path.relative(ROOT, options.reportPath)}`);
  console.log(`generate-release-summary: wrote ${path.relative(ROOT, options.outputPath)}`);
}

main();
