#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ICON_ROOT = path.join(ROOT, 'web', 'dbd_images', 'game_icons');
const API_URL = 'https://deadbydaylight.wiki.gg/api.php';
const REQUEST_TIMEOUT_MS = 15000;

const ICON_SOURCES = [
  { local: 'healthy.png', titles: ['IconHelp_healthy.png'] },
  { local: 'injured.png', titles: ['IconHelp_injured.png'] },
  { local: 'dying.png', titles: ['IconHelp_dying.png'] },
  { local: 'hooked.png', titles: ['IconHelpLoading_hook.png'] },
  { local: 'carried.png', titles: ['IconHelp_carrySurvivor.png'] },
  { local: 'sacrificed.png', titles: ['IconHelp_Sacrificed.png'] },
  { local: 'bledout.png', titles: ['IconHelp_BleedOutDeath.png'] },
  { local: 'dead.png', titles: ['IconHelp_BleedOutDeath.png'] },
  { local: 'disconnected.png', titles: ['DC_Icon.png'] },
  { local: 'obsession.png', titles: ['IconHelp_obsession.png'] },
  { local: 'caged.png', titles: ['IconStatus_cagedSurvivor.png'] },

  { local: 'blessed.png', titles: ['FulliconStatusEffects_blessed.png'] },
  { local: 'bloodlust.png', titles: ['FulliconStatusEffects_bloodlust.png'] },
  { local: 'endurance.png', titles: ['FulliconStatusEffects_enduranceSurvivor.png'] },
  { local: 'haste.png', titles: ['FulliconStatusEffects_haste.png'] },
  { local: 'undetectable.png', titles: ['FulliconStatusEffects_undetectable.png'] },

  { local: 'blindness.png', titles: ['FulliconStatusEffects_blindness.png'] },
  { local: 'broken.png', titles: ['FulliconStatusEffects_broken.png'] },
  { local: 'cursed.png', titles: ['FulliconStatusEffects_cursed.png'] },
  { local: 'deepwound.png', titles: ['FulliconStatusEffects_deepWound.png'] },
  { local: 'exhausted.png', titles: ['FulliconStatusEffects_exhausted.png'] },
  { local: 'exposed.png', titles: ['FulliconStatusEffects_exposed.png'] },
  { local: 'haemorrhage.png', titles: ['FulliconStatusEffects_bleeding.png'] },
  { local: 'hindered.png', titles: ['FulliconStatusEffects_hindered.png'] },
  { local: 'incapacitated.png', titles: ['FulliconStatusEffects_incapacitated.png'] },
  { local: 'madness.png', titles: ['FulliconStatusEffects_madness.png', 'IconStatusEffects_madness.png'] },
  { local: 'mangled.png', titles: ['FulliconStatusEffects_mangled.png'] },
  { local: 'oblivious.png', titles: ['FulliconStatusEffects_oblivious.png'] },
  { local: 'revealed.png', titles: ['FulliconStatusEffects_revealed.png'] },

  { local: 'marked.png', titles: ['IconHUD_markedState.png'] },
  { local: 'marked_progress.png', titles: ['IconHUD_marking.png'] },
  { local: 'condemned.png', titles: ['IconHUD_condemned.png'] },
  { local: 'condemnation.png', titles: ['IconHUD_condemnation.png'] },
  { local: 'infected.png', titles: ['IconHUD_infected.png'] },
  { local: 'infection_progress.png', titles: ['IconHUD_infection.png'] },
  { local: 'contaminated.png', titles: ['IconHUD_infection.png'] },
  { local: 'sickness.png', titles: ['IconHUD_sicknessState_3.png'] },
  { local: 'sickness_progress.png', titles: ['IconHUD_sicknessState_2.png'] },
  { local: 'chainhunt.png', titles: ['UI_Rip_-_ChainHunt.png'] },
  { local: 'lacerated.png', titles: ['UI_Rip_-_Lacerated_Full.png'] },
  { local: 'lacerated_progress.png', titles: ['UI_Rip_-_Lacerated.png', 'UI_Rip_-_Lacerated_Empty.png'] },
  { local: 'swarmed.png', titles: ['UI_Rip_-_Swarmed.png', 'UI_Rip_-_Swarmed_2.png'] },
  { local: 'tormented.png', titles: ['UI_Rip_-_Torment_1.png'] },
  { local: 'hunted.png', titles: ['IconHUD_patrolhunt.png'] },
  { local: 'latchedon.png', titles: ['IconHUD_latchedOnState.png'] },
  { local: 'trapped.png', titles: ['StatusIcon_trap.png'] },
  { local: 'rbt.png', titles: ['IconHelp_reverseBearTrap_timerStart.png'] },
  { local: 'rbt_timer_active.png', titles: ['IconHelp_reverseBearTrap_timerStart.png'] },
  { local: 'rbt_timer_paused.png', titles: ['IconHelp_reverseBearTrap_timerStop.png'] },
  { local: 'magic_disabled.png', titles: ['T_UI_hud_umg_survivorMagicItems_DispellingSphere.png'] },
  { local: 'puzzle.png', titles: ['UI_Rip_-_Puzzle_Solve.png'] },
  { local: 'efficiency.png', titles: ['FulliconStatusEffects_efficiency.png', 'IconStatusEffects_efficiency.png'] },
  { local: 'healing_speed.png', titles: ['FulliconStatusEffects_healing.png', 'IconStatusEffects_healing.png'] },
  { local: 'progression_speed.png', titles: ['FulliconStatusEffects_progressionSpeed.png', 'IconStatusEffects_progressionSpeed.png'] },
  { local: 'repairing.png', titles: ['FulliconStatusEffects_repairing.png', 'IconStatusEffects_repairing.png'] },
  { local: 'sabotaging.png', titles: ['FulliconStatusEffects_sabotaging.png', 'IconStatusEffects_sabotaging.png'] },
  { local: 'skillcheck_difficulty.png', titles: ['FulliconStatusEffects_skillCheckDifficulty.png', 'IconStatusEffects_skillCheckDifficulty.png'] },
  { local: 'skillcheck_probability.png', titles: ['FulliconStatusEffects_skillCheckProbability.png', 'IconStatusEffects_skillCheckProbability.png'] },

  { local: 'activity_gen.png', titles: ['T_survivorActivity_iconGenerator.png'] },
  { local: 'activity_heal.png', titles: ['T_survivorActivity_iconHealing.png'] },
  { local: 'activity_totem.png', titles: ['T_survivorActivity_iconTotems.png'] },
  { local: 'activity_exitgate.png', titles: ['T_survivorActivity_iconGates.png'] },
  { local: 'activity_recovery.png', titles: ['T_survivorActivity_iconRecovery.png'] },
  { local: 'activity_chest.png', titles: ['T_survivorActivity_iconChests.png'] },
  { local: 'activity_killerpower.png', titles: ['T_survivorActivity_iconKiller.png'] },
  { local: 'activity_invocation.png', titles: ['T_survivorActivity_Invocation.png'] },
];

function request(url, timeoutMs = REQUEST_TIMEOUT_MS) {
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
          'User-Agent': 'Mozilla/5.0 (compatible; Codex sync-game-icons)',
        },
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location, timeoutMs).then(succeed, fail);
          response.resume();
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`Request failed with status ${response.statusCode} for ${url}`));
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
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms for ${url}`));
    });
  });
}

async function fetchJson(url) {
  const data = await request(url);
  return JSON.parse(data.toString('utf8'));
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
  if (isPng(buffer)) {
    return buffer;
  }

  if (isWebP(buffer)) {
    const result = spawnSync('convert', ['webp:-', 'png:-'], {
      input: buffer,
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.status !== 0) {
      throw new Error(`ImageMagick failed to convert WEBP to PNG: ${result.stderr?.toString('utf8') || 'unknown error'}`);
    }

    return result.stdout;
  }

  throw new Error('Unsupported image format returned by source API');
}

async function resolveImageUrl(title) {
  const apiUrl = new URL(API_URL);
  apiUrl.searchParams.set('action', 'query');
  apiUrl.searchParams.set('titles', `File:${title}`);
  apiUrl.searchParams.set('prop', 'imageinfo');
  apiUrl.searchParams.set('iiprop', 'url');
  apiUrl.searchParams.set('format', 'json');

  const payload = await fetchJson(apiUrl.toString());
  const pages = payload?.query?.pages || {};
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url || null;
}

async function resolveFromTitles(titles) {
  for (const title of titles) {
    const imageUrl = await resolveImageUrl(title);
    if (imageUrl) {
      return { imageUrl, title };
    }
  }

  throw new Error(`Could not resolve any image URL for: ${titles.join(', ')}`);
}

async function main() {
  fs.mkdirSync(ICON_ROOT, { recursive: true });

  let synced = 0;
  let skipped = 0;
  const failures = [];
  for (const icon of ICON_SOURCES) {
    const localPath = path.join(ICON_ROOT, icon.local);
    try {
      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 100) {
        skipped += 1;
        continue;
      }
      const { imageUrl, title } = await resolveFromTitles(icon.titles);
      const rawBuffer = await request(imageUrl);
      const pngBuffer = normalizeToPng(rawBuffer);
      fs.writeFileSync(localPath, pngBuffer);
      synced += 1;
      console.log(`synced ${icon.local} <- ${title}${icon.note ? ` (${icon.note})` : ''}`);
    } catch (error) {
      failures.push(`${icon.local}: ${error.message}`);
    }
  }

  console.log(`sync-game-icons: synced=${synced} skipped=${skipped} failed=${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`sync-game-icons: FAILED ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`sync-game-icons failed: ${error.message}`);
  process.exit(1);
});
