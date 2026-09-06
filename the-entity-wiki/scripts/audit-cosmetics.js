#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const {
  CONTENT_PATH,
  DATABASE_PATH,
  AUDIT_PATH,
  readJson
} = require('./cosmetics-shared');

function fail(message) {
  console.error(`audit-cosmetics: ${message}`);
  process.exit(1);
}

function main() {
  const cosmetics = readJson(CONTENT_PATH);
  const database = readJson(DATABASE_PATH);
  const charactersById = new Map([
    ...(database.killers || []).map((killer) => [killer.id, { ...killer, type: 'Killer' }]),
    ...(database.survivors || []).map((survivor) => [survivor.id, { ...survivor, type: 'Survivor' }])
  ]);

  const groups = [
    { key: 'characterSwaps', label: 'Character Swaps' },
    { key: 'fullSets', label: 'Cosmetics' }
  ];
  const seenIds = new Set();
  const lines = [];
  let readyCount = 0;
  let blockedCount = 0;
  const blockedEntries = [];

  groups.forEach((group) => {
    const entries = Array.isArray(cosmetics[group.key]) ? cosmetics[group.key] : [];
    lines.push(`${group.label}: ${entries.length}`);
    entries.forEach((entry) => {
      if (!entry || typeof entry !== 'object') fail(`${group.key} contains a non-object entry.`);
      if (!entry.id || !entry.name) fail(`${group.key} has an entry with missing id or name.`);
      if (seenIds.has(entry.id)) fail(`duplicate cosmetic id: ${entry.id}`);
      seenIds.add(entry.id);
      if (!['ready', 'blocked_art', 'blocked_mapping', 'excluded'].includes(entry.status)) {
        fail(`invalid status on ${entry.id}: ${entry.status}`);
      }
      if (entry.baseCharacterId) {
        const baseCharacter = charactersById.get(entry.baseCharacterId);
        if (!baseCharacter) fail(`unknown base character on ${entry.id}: ${entry.baseCharacterId}`);
      }
      if (entry.status === 'ready') {
        readyCount += 1;
        const imagePath = path.join(path.resolve(__dirname, '..', 'web'), String(entry.image || '').replace(/^\.\//, ''));
        if (!fs.existsSync(imagePath)) {
          fail(`missing local image for ready cosmetic ${entry.id}: ${path.relative(path.resolve(__dirname, '..'), imagePath)}`);
        }
      } else {
        blockedCount += 1;
        blockedEntries.push({
          id: entry.id,
          name: entry.name,
          status: entry.status,
          baseCharacterName: entry.baseCharacterName,
          groupLabel: entry.groupLabel
        });
      }
    });
  });

  const portraitExceptions = (cosmetics.characterSwaps || []).filter((entry) => entry.status === 'ready' && entry.assetProvenance !== 'official-headshot');
  lines.unshift(`Ready cosmetics: ${readyCount}`);
  lines.unshift(`Blocked cosmetics: ${blockedCount}`);
  lines.unshift(`Generated: ${new Date().toISOString()}`);
  lines.unshift('Cosmetics Audit');
  lines.push('');
  lines.push(`Blocked entries: ${blockedEntries.length}`);
  blockedEntries
    .sort((a, b) => a.status.localeCompare(b.status) || a.baseCharacterName.localeCompare(b.baseCharacterName) || a.name.localeCompare(b.name))
    .forEach((entry) => lines.push(`- ${entry.status} | ${entry.groupLabel} | ${entry.baseCharacterName} -> ${entry.name} (${entry.id})`));
  lines.push('');
  lines.push(`Portrait exceptions: ${portraitExceptions.length}`);
  portraitExceptions.forEach((entry) => lines.push(`- ${entry.baseCharacterName} -> ${entry.name} | ${entry.assetProvenance}`));

  writeFileAtomic(AUDIT_PATH, `${lines.join('\n')}\n`, 'utf8');
  console.log(`audit-cosmetics: wrote ${AUDIT_PATH}`);
  console.log(`audit-cosmetics: ready=${readyCount} blocked=${blockedCount}`);
}

main();
