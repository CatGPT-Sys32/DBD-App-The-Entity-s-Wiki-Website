#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { isExplicitLocalImagePath, normalizeLocalPath } = require('./normalize-images');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_ROOT = path.join(ROOT, 'content');
const WEB_ROOT = path.join(ROOT, 'web');
const DATABASE_PATH = path.join(CONTENT_ROOT, 'database.json');

function fail(message) {
  console.error(`verify-teachables: ${message}`);
  process.exit(1);
}

function readDatabase() {
  return JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf8'));
}

function fileExists(relPathFromWebRoot) {
  return fs.existsSync(path.join(WEB_ROOT, relPathFromWebRoot));
}

function warn(message) {
  console.warn(`verify-teachables: WARNING ${message}`);
}

function main() {
  const db = readDatabase();
  const characterNames = new Set([
    ...(db.survivors || []).map((character) => character.name),
    ...(db.killers || []).map((character) => character.name)
  ]);

  const unknownOwners = [...new Set(
    (db.perks || [])
      .map((perk) => perk.owner)
      .filter(Boolean)
      .filter((owner) => owner !== 'All Survivors' && owner !== 'All Killers')
      .filter((owner) => !characterNames.has(owner))
  )];
  if (unknownOwners.length) {
    fail(`Unknown perk owners found in content/database.json: ${unknownOwners.join(', ')}`);
  }

  const teachablePerks = (db.perks || []).filter((perk) => characterNames.has(perk.owner));
  const zeroTeachableCharacters = [];
  const nonStandardTeachableCharacters = [];

  for (const characterName of characterNames) {
    const count = teachablePerks.filter((perk) => perk.owner === characterName).length;
    if (count === 0) {
      zeroTeachableCharacters.push(characterName);
    } else if (count !== 3) {
      nonStandardTeachableCharacters.push(`${characterName} (${count})`);
    }
  }

  if (zeroTeachableCharacters.length) {
    fail(`Characters with no teachable perks: ${zeroTeachableCharacters.join(', ')}`);
  }

  if (nonStandardTeachableCharacters.length) {
    warn(`Characters without exactly 3 teachable perks (allowed, verify roster change): ${nonStandardTeachableCharacters.join(', ')}`);
  }

  const unresolvedIcons = [];
  for (const perk of teachablePerks) {
    if (!isExplicitLocalImagePath(perk.image)) {
      unresolvedIcons.push(`${perk.owner} :: ${perk.name} (${perk.image})`);
      continue;
    }
    const localPath = normalizeLocalPath(perk.image);
    if (!fileExists(localPath)) {
      unresolvedIcons.push(`${perk.owner} :: ${perk.name} (${localPath})`);
    }
  }

  if (unresolvedIcons.length) {
    fail(`Teachable perks without a local icon file: ${unresolvedIcons.join(', ')}`);
  }

  console.log(`verify-teachables: characters=${characterNames.size} teachable_perks=${teachablePerks.length}`);
}

main();
