#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { File } = require('buffer');

if (typeof globalThis.File === 'undefined') {
  globalThis.File = File;
}

const cheerio = require('cheerio');
const { fetchTextWithRetry, formatFetchError } = require('./network-resilience');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_PATH = path.join(ROOT, 'content', 'community-content.json');
const DATABASE_PATH = path.join(ROOT, 'content', 'database.json');

const SOURCES = {
  home: 'https://otzdarva.com/',
  addonTierlist: 'https://otz-addon-tierlist.pages.dev/',
  buildsHome: 'https://otzdarva-builds.com/',
  buildsPanels: 'https://otzdarva-builds.com/assets/modules/XMLHttpRequest/returnCharacterPanels.php',
  buildsPerkDetails: 'https://otzdarva-builds.com/assets/modules/XMLHttpRequest/showPerkDetails.php',
  characterInfo: 'https://otzdarva.com/dbd/character-info',
  beginnerGuides: 'https://otzdarva.com/dbd/beginner-guides',
  killerGuides: 'https://otzdarva.com/dbd/killer-guides',
  tierlists: 'https://otzdarva.com/dbd/tierlists',
  opinions: 'https://otz-opinions.pages.dev/'
};

const COMBO_LABELS = {
  'best-combo': { tier: 'best', label: 'Best Combo' },
  'solid-combo': { tier: 'solid', label: 'Solid Combo' },
  'good-combo': { tier: 'good', label: 'Good Combo' },
  'fun-combo': { tier: 'fun', label: 'Fun Combo' }
};

const TIERLIST_CATEGORY_LABELS = {
  '1': 'Killer Focus',
  '2': 'Survivor Focus',
  '3': 'General'
};

const TIERLIST_LINK_OVERRIDES = {
  'killer perk tierlist': {
    description: 'Latest Otz perk-tierlist stream found on YouTube; use this for current perk rankings until the official tierlists page is refreshed.',
    patch: '9.5.0',
    dateLabel: 'Mar 23rd, 2026',
    dateIso: '2026-03-22T23:00:00.000Z',
    imageUrl: 'https://i.ytimg.com/vi/K2ZqYJqkbxY/maxresdefault.jpg',
    url: 'https://www.youtube.com/watch?v=K2ZqYJqkbxY',
    sourceType: 'video',
    sourceNote: 'Manual YouTube freshness override; otzdarva.com/dbd/tierlists still points to the Oct 2024 edited video.'
  },
  'survivor perk tierlist': {
    description: 'All 170 Survivor Perks: Tierlist & Full Explanation.',
    patch: '9.5.0',
    dateLabel: 'Apr 29th, 2026',
    dateIso: '2026-04-28T22:00:00.000Z',
    imageUrl: 'https://i.ytimg.com/vi_webp/pqHHCN9Po-4/maxresdefault.webp',
    url: 'https://www.youtube.com/watch?v=pqHHCN9Po-4',
    sourceType: 'video',
    sourceNote: 'Manual YouTube freshness override; otzdarva.com/dbd/tierlists still points to the Oct 2024 edited video.'
  }
};

const SCRAPER_VERSION = 2;
const NETWORK_OPTIONS = {
  retries: 3,
  timeoutMs: 15000,
  baseDelayMs: 400,
  maxDelayMs: 4500
};
const args = new Set(process.argv.slice(2));
const healthCheckOnly = args.has('--health-check');

function fail(message) {
  console.error(`sync-community-content: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeCompact(value) {
  let normalized = normalizeKey(value);
  const spellingTweaks = [
    [/colou?r/g, 'color'],
    [/sceptre/g, 'scepter'],
    [/traveller/g, 'traveler'],
    [/theatre/g, 'theater'],
    [/judgement/g, 'judgment'],
    [/granma/g, 'grandma']
  ];

  spellingTweaks.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, replacement);
  });

  return normalized.replace(/[^a-z0-9]+/g, '');
}

function slugify(value) {
  const compact = normalizeKey(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return compact || 'entry';
}

function uniqBy(list, toKey) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const key = toKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function decodeHtmlEntities(value) {
  if (!value) return '';
  return String(value)
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([\da-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeDecodeURIComponent(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function htmlToText(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`);
  return normalizeText($.text());
}

function portableTextToPlain(blocks) {
  if (!Array.isArray(blocks)) return '';
  const lines = blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (!Array.isArray(block.children)) return '';
      const rawLine = normalizeText(block.children.map((child) => String(child?.text || '')).join(''));
      if (!rawLine) return '';
      return block.listItem ? `- ${rawLine}` : rawLine;
    })
    .filter(Boolean);
  return lines.join('\n');
}

function resolveUrl(base, href) {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch (error) {
    return String(href || '');
  }
}

function parseImageBasename(url) {
  if (!url) return '';
  try {
    const absolute = new URL(url, SOURCES.addonTierlist);
    return decodeURIComponent(path.basename(absolute.pathname, path.extname(absolute.pathname)));
  } catch (error) {
    const raw = String(url || '');
    return decodeURIComponent(path.basename(raw.split('?')[0], path.extname(raw.split('?')[0])));
  }
}

function toDateIso(value) {
  const normalized = normalizeText(String(value || '').replace(/(\d+)(st|nd|rd|th)/gi, '$1'));
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function inferResourceType(url) {
  const normalized = normalizeText(url).toLowerCase();
  if (!normalized) return 'link';
  if (normalized.includes('youtu.be') || normalized.includes('youtube.com')) return 'video';
  if (normalized.includes('docs.google.com')) return 'document';
  if (normalized.includes('imgur.com') || normalized.endsWith('.jpg') || normalized.endsWith('.jpeg') || normalized.endsWith('.png') || normalized.endsWith('.webp')) return 'image';
  if (normalized.includes('reddit.com') || normalized.includes('steamcommunity.com')) return 'community';
  if (normalized.includes('pages.dev')) return 'interactive';
  return 'link';
}

function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (error) {
    return '';
  }
}

function extractOpinionDateLabel(text) {
  const dateMatch = String(text || '').match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i);
  return dateMatch ? normalizeText(dateMatch[0]) : '';
}

function extractPatchLabel(text) {
  const patchMatch = String(text || '').match(/\b\d+\.\d+\.\d+\b(?:\s*(?:ptb|live|hotfix\s*\d*))?/i);
  return patchMatch ? normalizeText(patchMatch[0]).toUpperCase() : '';
}

function detectOpinionTags(text) {
  const value = String(text || '').toLowerCase();
  const tags = [];
  const rules = [
    { tag: 'ptb', pattern: /\bptb\b/ },
    { tag: 'hotfix', pattern: /\bhotfix\b|\bbugfix\b|\bfix\b/ },
    { tag: 'buffs', pattern: /\bbuff\b|\bstronger\b|\bimprov/ },
    { tag: 'nerfs', pattern: /\bnerf\b|\bweaker\b|\bdownside\b/ },
    { tag: 'maps', pattern: /\bmap\b|\brpd\b|\brealm\b/ },
    { tag: 'killers', pattern: /\bkiller\b|\bkillers\b/ },
    { tag: 'survivors', pattern: /\bsurvivor\b|\bsurvivors\b/ },
    { tag: 'perks', pattern: /\bperk\b|\bperks\b/ },
    { tag: 'balance', pattern: /\bbalance\b|\bmeta\b/ }
  ];

  rules.forEach((rule) => {
    if (rule.pattern.test(value)) tags.push(rule.tag);
  });

  return [...new Set(tags)];
}

function extractPortableTextLinks(blocks, baseUrl = '') {
  if (!Array.isArray(blocks)) return [];
  const links = [];

  blocks.forEach((block) => {
    if (!block || typeof block !== 'object') return;
    const markDefs = new Map(
      (Array.isArray(block.markDefs) ? block.markDefs : [])
        .filter((entry) => entry && entry._type === 'link' && entry.href)
        .map((entry) => [entry._key, entry])
    );

    const children = Array.isArray(block.children) ? block.children : [];
    const blockText = normalizeText(children.map((child) => String(child?.text || '')).join(' '));

    children.forEach((child) => {
      const marks = Array.isArray(child?.marks) ? child.marks : [];
      marks.forEach((mark) => {
        const markDef = markDefs.get(mark);
        if (!markDef) return;
        const url = resolveUrl(baseUrl || SOURCES.home, markDef.href);
        const label = normalizeText(child?.text || '') || blockText || 'Resource';
        if (url) links.push({ label, url });
      });
    });
  });

  return uniqBy(links, (entry) => entry.url);
}

function extractPortableTextLinkedEntries(blocks, baseUrl = '') {
  if (!Array.isArray(blocks)) return [];
  const entries = [];

  blocks.forEach((block, blockIndex) => {
    if (!block || typeof block !== 'object') return;
    const markDefs = new Map(
      (Array.isArray(block.markDefs) ? block.markDefs : [])
        .filter((entry) => entry && entry._type === 'link' && entry.href)
        .map((entry) => [entry._key, entry])
    );

    const children = Array.isArray(block.children) ? block.children : [];
    const blockText = normalizeText(children.map((child) => String(child?.text || '')).join(' '));

    children.forEach((child, childIndex) => {
      const marks = Array.isArray(child?.marks) ? child.marks : [];
      marks.forEach((mark) => {
        const markDef = markDefs.get(mark);
        if (!markDef) return;
        const url = resolveUrl(baseUrl || SOURCES.home, markDef.href);
        if (!url) return;

        const rawLabel = normalizeText(child?.text || '') || blockText || `Resource ${blockIndex + 1}`;
        const label = rawLabel.replace(/^\[|\]$/g, '') || `Resource ${blockIndex + 1}`;

        entries.push({
          id: `pt-${blockIndex + 1}-${childIndex + 1}-${slugify(label)}`,
          label,
          context: blockText,
          url
        });
      });
    });
  });

  return uniqBy(entries, (entry) => entry.url);
}

async function fetchText(url, init = {}) {
  try {
    return await fetchTextWithRetry(url, {
      ...NETWORK_OPTIONS,
      method: init.method || 'GET',
      body: init.body,
      headers: {
        'user-agent': 'The-Entity-Wiki Community Scraper/1.0',
        ...(init.headers || {})
      }
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  }
}

function assertHealthySourcePayload(sourceLabel, payload, minLength = 120) {
  const payloadSize = String(payload || '').trim().length;
  if (payloadSize < minLength) {
    fail(`source health check failed: ${sourceLabel} payload too small (${payloadSize} chars)`);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const size = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = null;
      }
    }
  }

  const workerCount = Math.min(size, Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function extractSvelteRoutePayload(html, pageLabel) {
  const startIndex = html.indexOf('const data = ');
  if (startIndex < 0) {
    throw new Error(`Unable to locate "const data =" in ${pageLabel}.`);
  }

  const endIndex = html.indexOf('Promise.all([', startIndex);
  if (endIndex < 0) {
    throw new Error(`Unable to locate Svelte bootstrap boundary in ${pageLabel}.`);
  }

  const snippet = html.slice(startIndex, endIndex);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${snippet}; this.__DATA__ = data;`, sandbox, { timeout: 4000 });

  const data = sandbox.__DATA__;
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected Svelte payload shape in ${pageLabel}.`);
  }

  const payload = data.find((entry) => entry && entry.type === 'data')?.data || data[1]?.data;
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Missing route payload object in ${pageLabel}.`);
  }

  return payload;
}

function buildKillerResolver(database) {
  const map = new Map();
  (database.killers || []).forEach((killer) => {
    const fullName = String(killer.name || '').trim();
    if (!fullName) return;
    map.set(normalizeKey(fullName), fullName);
    map.set(normalizeKey(fullName.replace(/^the\s+/i, '')), fullName);
  });

  const aliases = {
    'myers': 'The Shape',
    'shape': 'The Shape',
    'leatherface': 'The Cannibal',
    'cannibal': 'The Cannibal',
    'freddy': 'The Nightmare',
    'nightmare': 'The Nightmare',
    'ghostface': 'The Ghost Face',
    'ghost face': 'The Ghost Face',
    'pinhead': 'The Cenobite',
    'cenobite': 'The Cenobite',
    'wesker': 'The Mastermind',
    'mastermind': 'The Mastermind',
    'onryo': 'The Onryō',
    'onryō': 'The Onryō',
    'pyramid head': 'The Executioner',
    'executioner': 'The Executioner',
    'chucky': 'The Good Guy',
    'good guy': 'The Good Guy',
    'vecna': 'The Lich',
    'lich': 'The Lich',
    'dracula': 'The Dark Lord',
    'dark lord': 'The Dark Lord',
    'springtrap': 'The Animatronic',
    'animatronic': 'The Animatronic'
  };

  Object.entries(aliases).forEach(([alias, canonical]) => {
    map.set(normalizeKey(alias), canonical);
  });

  return (candidates) => {
    for (const candidate of candidates) {
      const key = normalizeKey(candidate);
      if (!key) continue;
      if (map.has(key)) return map.get(key);
    }
    return '';
  };
}

function buildAddonLookup(database) {
  const lookup = new Map();

  (database.addons || [])
    .filter((addon) => addon && addon.role === 'killer' && addon.killerName)
    .forEach((addon) => {
      const killerName = String(addon.killerName);
      if (!lookup.has(killerName)) {
        lookup.set(killerName, { byName: new Map(), byImage: new Map() });
      }
      const bucket = lookup.get(killerName);
      const nameKey = normalizeCompact(addon.name);
      const imageKey = normalizeCompact(parseImageBasename(addon.image).replace(/^iconaddon_/, ''));

      if (nameKey) {
        if (!bucket.byName.has(nameKey)) bucket.byName.set(nameKey, []);
        bucket.byName.get(nameKey).push(addon);
      }

      if (imageKey) {
        if (!bucket.byImage.has(imageKey)) bucket.byImage.set(imageKey, []);
        bucket.byImage.get(imageKey).push(addon);
      }
    });

  return lookup;
}

function pickAddonMatch(localKillerName, addonName, addonImageUrl, addonLookup) {
  if (!localKillerName || !addonLookup.has(localKillerName)) return null;
  const bucket = addonLookup.get(localKillerName);
  const nameKey = normalizeCompact(addonName);
  const imageKey = normalizeCompact(parseImageBasename(addonImageUrl));

  const nameMatches = bucket.byName.get(nameKey) || [];
  if (nameMatches.length === 1) {
    const match = nameMatches[0];
    return {
      addonId: match.id,
      internalId: match.internalId,
      localName: match.name,
      localImage: match.image,
      localRarity: match.rarity,
      method: 'name'
    };
  }

  if (nameMatches.length > 1 && imageKey) {
    const filtered = nameMatches.filter((entry) => normalizeCompact(parseImageBasename(entry.image).replace(/^iconaddon_/, '')) === imageKey);
    if (filtered.length === 1) {
      const match = filtered[0];
      return {
        addonId: match.id,
        internalId: match.internalId,
        localName: match.name,
        localImage: match.image,
        localRarity: match.rarity,
        method: 'name+image'
      };
    }
  }

  const imageMatches = bucket.byImage.get(imageKey) || [];
  if (imageMatches.length === 1) {
    const match = imageMatches[0];
    return {
      addonId: match.id,
      internalId: match.internalId,
      localName: match.name,
      localImage: match.image,
      localRarity: match.rarity,
      method: 'image'
    };
  }

  return null;
}

function parseComboRanks(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((chunk) => Number.parseInt(chunk.trim(), 10))
    .filter((rank) => Number.isFinite(rank) && rank > 0);
}

function parseAddonCombos($, groupEl, addons) {
  const addonByRank = new Map(addons.map((addon) => [addon.rank, addon]));
  const combos = $(groupEl)
    .find('.addon-combo-side .text-combo')
    .map((_, comboEl) => {
      const comboNode = $(comboEl);
      const classList = String(comboNode.attr('class') || '').split(/\s+/).filter(Boolean);
      const comboClass = Object.keys(COMBO_LABELS).find((className) => classList.includes(className));
      if (!comboClass) return null;

      const comboMeta = COMBO_LABELS[comboClass];
      const addonRanks = parseComboRanks(comboNode.attr('data-comment'));
      if (addonRanks.length < 2) return null;

      const comboAddons = addonRanks
        .map((rank) => addonByRank.get(rank))
        .filter(Boolean)
        .slice(0, 2)
        .map((addon) => ({
          rank: addon.rank,
          name: addon.name,
          imageUrl: addon.imageUrl,
          localMatch: addon.localMatch || null
        }));

      if (comboAddons.length < 2) return null;

      return {
        tier: comboMeta.tier,
        label: comboMeta.label,
        addonRanks: addonRanks.slice(0, 2),
        addons: comboAddons
      };
    })
    .get()
    .filter(Boolean);

  return uniqBy(combos, (combo) => `${combo.tier}:${combo.addonRanks.join('-')}`);
}

function parseAddonTierlist(html, database) {
  const resolveKillerName = buildKillerResolver(database);
  const addonLookup = buildAddonLookup(database);
  const $ = cheerio.load(html);

  const title = normalizeText($('.heading').first().text()) || 'Otz Add-on Tierlist';
  const notes = $('.notification').map((_, el) => normalizeText($(el).text())).get().filter(Boolean);
  const killers = [];

  $('.killerGroup').each((groupIndex, groupEl) => {
    const killerImg = $(groupEl).find('.killer img').first();
    const killerAlt = normalizeText(killerImg.attr('alt') || '');
    const killerAliases = killerAlt.split(',').map((value) => normalizeText(value)).filter(Boolean);
    const killerImageUrl = resolveUrl(SOURCES.addonTierlist, killerImg.attr('src') || '');
    const killerSlug = normalizeText(parseImageBasename(killerImageUrl));
    const localKillerName = resolveKillerName([...killerAliases, killerSlug]);

    const addons = [];
    $(groupEl).find('.addons .addon-back').each((addonIndex, addonWrap) => {
      const classList = String($(addonWrap).attr('class') || '').split(/\s+/).filter(Boolean);
      const tierBucket = classList.find((cls) => cls !== 'addon-back') || 'unknown';
      const addonNode = $(addonWrap).find('.addon').first();
      const addonImg = addonNode.find('img').first();
      const addonName = normalizeText(addonImg.attr('alt') || '');
      const addonImageUrl = resolveUrl(SOURCES.addonTierlist, addonImg.attr('src') || '');

      const commentHtml = decodeHtmlEntities(addonNode.attr('data-comment') || '');
      const commentText = htmlToText(commentHtml);

      const rawDescription = decodeHtmlEntities(addonNode.find('.addon-desc').attr('data-comment') || '');
      const descriptionHtml = safeDecodeURIComponent(rawDescription);
      const descriptionText = htmlToText(descriptionHtml);

      const localMatch = pickAddonMatch(localKillerName, addonName, addonImageUrl, addonLookup);

      addons.push({
        rank: addonIndex + 1,
        tierBucket,
        name: addonName,
        imageUrl: addonImageUrl,
        otzComment: commentText,
        description: descriptionText,
        localMatch: localMatch || null
      });
    });

    const combos = parseAddonCombos($, groupEl, addons);

    killers.push({
      order: groupIndex + 1,
      killerName: killerAliases[0] || killerSlug,
      killerAliases,
      killerSlug,
      killerImageUrl,
      localKillerName: localKillerName || null,
      addons,
      combos
    });
  });

  const allAddons = killers.flatMap((killer) => killer.addons);
  const allCombos = killers.flatMap((killer) => (Array.isArray(killer.combos) ? killer.combos : []));
  const matchedAddons = allAddons.filter((entry) => entry.localMatch);
  const unmatchedAddons = allAddons
    .filter((entry) => !entry.localMatch)
    .slice(0, 80)
    .map((entry) => ({ name: entry.name, tierBucket: entry.tierBucket }));

  return {
    title,
    notes,
    killers,
    stats: {
      killerCount: killers.length,
      addonCount: allAddons.length,
      comboCount: allCombos.length,
      matchedAddonCount: matchedAddons.length,
      unmatchedAddonCount: allAddons.length - matchedAddons.length,
      unmatchedAddonSample: unmatchedAddons
    }
  };
}

function extractBuildFromNode($, buildNode) {
  const buildName = normalizeText($(buildNode).find('> .build-name').first().text()) || 'Unnamed Build';
  const perks = [];

  $(buildNode).find('> .perks-list > li').each((_, li) => {
    const mainPerkImg = $(li).find('> img.perk-icon').first();
    const perkName = normalizeText(mainPerkImg.attr('alt') || '');
    const perkIconUrl = resolveUrl(SOURCES.buildsHome, mainPerkImg.attr('src') || '');

    const alternatives = $(li)
      .find('.alt-perks-list img.perk-icon')
      .map((__, altImg) => ({
        name: normalizeText($(altImg).attr('alt') || ''),
        iconUrl: resolveUrl(SOURCES.buildsHome, $(altImg).attr('src') || '')
      }))
      .get()
      .filter((entry) => entry.name);

    if (perkName) {
      perks.push({
        name: perkName,
        iconUrl: perkIconUrl,
        alternatives
      });
    }
  });

  const details = uniqBy(
    $(buildNode)
      .find('.build-info-wrapper .build-info li, .build-info-wrapper .main-build-info li')
      .map((_, li) => normalizeText($(li).text()))
      .get()
      .filter(Boolean),
    (value) => value
  );

  return {
    name: buildName,
    perks,
    details
  };
}

function parseBuildPanels(html, role) {
  const $ = cheerio.load(`<div id="panels">${html}</div>`);
  const profiles = [];

  $('#panels .character-profile').each((_, profileNode) => {
    const profile = $(profileNode);
    const panelId = normalizeText(profile.attr('id') || '');
    const characterName = normalizeText(profile.find('.character-name').first().text()) || panelId;
    const characterImageUrl = resolveUrl(SOURCES.buildsHome, profile.find('.character-image img').first().attr('src') || '');

    const builds = [];
    profile.find('.builds-list .dialog-form-content > .build').each((__, buildNode) => {
      const parsedBuild = extractBuildFromNode($, buildNode);
      if (parsedBuild.name) builds.push(parsedBuild);
    });

    if (builds.length === 0) {
      const fallbackMainBuild = profile.find('.build.main-build').first();
      if (fallbackMainBuild.length) {
        const parsedBuild = extractBuildFromNode($, fallbackMainBuild);
        if (parsedBuild.name) builds.push(parsedBuild);
      }
    }

    const dedupedBuilds = uniqBy(builds, (entry) => `${entry.name}::${entry.perks.map((perk) => perk.name).join('|')}`);

    profiles.push({
      id: slugify(panelId || characterName),
      role,
      panelId,
      name: characterName,
      imageUrl: characterImageUrl,
      featuredBuildName: dedupedBuilds[0]?.name || '',
      buildCount: dedupedBuilds.length,
      builds: dedupedBuilds
    });
  });

  return profiles;
}

function parseBuilds(homeHtml, killerPanelsHtml, survivorPanelsHtml) {
  const $home = cheerio.load(homeHtml);
  const updateLabel = normalizeText($home('.update-info').first().text().replace(/^Last update:\s*/i, ''));

  const killers = parseBuildPanels(killerPanelsHtml, 'killer');
  const survivors = parseBuildPanels(survivorPanelsHtml, 'survivor');

  return {
    lastUpdateLabel: updateLabel || null,
    roles: {
      killers,
      survivors
    },
    stats: {
      killerProfileCount: killers.length,
      survivorProfileCount: survivors.length,
      totalBuildCount:
        killers.reduce((count, profile) => count + profile.buildCount, 0) +
        survivors.reduce((count, profile) => count + profile.buildCount, 0)
    }
  };
}

function collectBuildPerkNames(profiles) {
  const names = new Set();
  (profiles || []).forEach((profile) => {
    (profile.builds || []).forEach((build) => {
      (build.perks || []).forEach((perk) => {
        if (perk?.name) names.add(normalizeText(perk.name));
        (perk.alternatives || []).forEach((alternative) => {
          if (alternative?.name) names.add(normalizeText(alternative.name));
        });
      });
    });
  });
  return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

async function fetchBuildPerkDetails(perkName, role) {
  const body = new URLSearchParams({ xml: JSON.stringify({ name: perkName, role }) }).toString();
  return fetchText(SOURCES.buildsPerkDetails, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Referer: SOURCES.buildsHome
    },
    body
  });
}

function parseBuildPerkDetail(html, perkName, role) {
  const $ = cheerio.load(html);
  const pageText = normalizeText($.text()).toLowerCase();
  if (!pageText || pageText.includes('nothing to see here')) {
    return null;
  }

  const name = normalizeText($('.about-perk h2').first().text()) || normalizeText(perkName);
  if (!name) return null;

  const obtainmentLine = normalizeText($('h3').first().text());
  const obtainedFrom = normalizeText(obtainmentLine.replace(/^This perk is obtained from\s*/i, ''));

  const detailsHolder = $('.details-holder').first();
  const descriptionHtml = detailsHolder.length ? detailsHolder.html() || '' : '';
  const descriptionText = htmlToText(descriptionHtml);

  const iconUrl = resolveUrl(SOURCES.buildsHome, $('.perk-image img').first().attr('src') || '');

  const links = uniqBy(
    detailsHolder
      .find('a[href]')
      .map((_, anchor) => {
        const href = $(anchor).attr('href');
        const label = normalizeText($(anchor).text());
        const url = resolveUrl(SOURCES.buildsHome, href);
        return { label: label || url, url };
      })
      .get()
      .filter((entry) => entry.url),
    (entry) => entry.url
  );

  return {
    id: `${role}-${slugify(name)}`,
    role,
    key: normalizeCompact(name),
    name,
    obtainedFrom: obtainedFrom || '',
    iconUrl,
    descriptionText,
    links
  };
}

async function enrichBuildsWithPerkDetails(builds) {
  const killerPerks = collectBuildPerkNames(builds.roles?.killers || []);
  const survivorPerks = collectBuildPerkNames(builds.roles?.survivors || []);

  const [killerDetailsRaw, survivorDetailsRaw] = await Promise.all([
    mapWithConcurrency(killerPerks, 8, async (perkName) => {
      const html = await fetchBuildPerkDetails(perkName, 'killers');
      return parseBuildPerkDetail(html, perkName, 'killers');
    }),
    mapWithConcurrency(survivorPerks, 8, async (perkName) => {
      const html = await fetchBuildPerkDetails(perkName, 'survivors');
      return parseBuildPerkDetail(html, perkName, 'survivors');
    })
  ]);

  const killerDetails = killerDetailsRaw.filter(Boolean);
  const survivorDetails = survivorDetailsRaw.filter(Boolean);

  return {
    ...builds,
    perkDetails: {
      killers: killerDetails,
      survivors: survivorDetails
    },
    stats: {
      ...builds.stats,
      uniqueKillerPerksInBuilds: killerPerks.length,
      uniqueSurvivorPerksInBuilds: survivorPerks.length,
      killerPerkDetailsResolved: killerDetails.length,
      survivorPerkDetailsResolved: survivorDetails.length,
      perkDetailsResolvedTotal: killerDetails.length + survivorDetails.length,
      perkDetailsMissingTotal: (killerPerks.length - killerDetails.length) + (survivorPerks.length - survivorDetails.length)
    }
  };
}

function toCharacterSummary(character, role, perksById) {
  const parsedUnlockPriority = Number(character.unlockPriority);
  const unlockPriority = Number.isFinite(parsedUnlockPriority) ? parsedUnlockPriority : null;
  const refs = Array.isArray(character?.perks) ? character.perks : [];
  const resolvedPerks = refs
    .map((entry) => perksById.get(entry?._ref))
    .filter(Boolean)
    .map((perk) => ({
      id: perk._id,
      name: normalizeText(perk.name),
      belongsTo: normalizeText(perk.belongsTo),
      value: Number.isFinite(Number(perk.value)) ? Number(perk.value) : null,
      iconUrl: perk.iconUrl ? String(perk.iconUrl) : ''
    }));

  return {
    id: character._id,
    role,
    name: normalizeText(character.name),
    iconUrl: character.iconUrl ? String(character.iconUrl) : '',
    unlockPriority,
    licensed: role === 'killer' ? Boolean(character.licensed) : null,
    difficulty: role === 'killer' ? normalizeText(character.difficulty || '') : '',
    cost: normalizeText(character.cost || ''),
    availableIn: normalizeText(character.availableIn || ''),
    speed: role === 'killer' ? normalizeText(character.speed || '') : '',
    terrorRadius: role === 'killer' ? normalizeText(character.terrorRadius || '') : '',
    stealth: role === 'survivor' ? normalizeText(character.stealth || '') : '',
    loudnessHealthy: role === 'survivor' ? normalizeText(character.loudnessHealthy || '') : '',
    loudnessInjured: role === 'survivor' ? normalizeText(character.loudnessInjured || '') : '',
    mostRecentGuideUrl: role === 'killer' ? normalizeText(character.mostRecentGuideUrl || '') : '',
    addOnBreakdownUrl: role === 'killer' ? normalizeText(character.addOnBreakdownUrl || '') : '',
    otzComment: portableTextToPlain(character.otzdarvaComment),
    perks: resolvedPerks
  };
}

function parseCharacterInfo(html) {
  const payload = extractSvelteRoutePayload(html, 'character-info');
  const allPerks = Array.isArray(payload.perks) ? payload.perks : [];
  const perksById = new Map(allPerks.map((perk) => [perk._id, perk]));

  const killersRaw = Array.isArray(payload.characters?.killers) ? payload.characters.killers : [];
  const survivorsRaw = Array.isArray(payload.characters?.survivors) ? payload.characters.survivors : [];

  const killers = killersRaw.map((character) => toCharacterSummary(character, 'killer', perksById));
  const survivors = survivorsRaw.map((character) => toCharacterSummary(character, 'survivor', perksById));

  const perks = allPerks.map((perk) => ({
    id: perk._id,
    name: normalizeText(perk.name),
    belongsTo: normalizeText(perk.belongsTo),
    value: Number.isFinite(Number(perk.value)) ? Number(perk.value) : null,
    iconUrl: perk.iconUrl ? String(perk.iconUrl) : ''
  }));

  const killerPriorityValues = killers.map((entry) => entry.unlockPriority).filter((value) => Number.isFinite(value));
  const survivorPriorityValues = survivors.map((entry) => entry.unlockPriority).filter((value) => Number.isFinite(value));

  return {
    title: normalizeText(payload.section?.title || payload.section?.sectionName || 'Character Info'),
    sectionName: normalizeText(payload.section?.sectionName || 'Character Info'),
    description: portableTextToPlain(payload.section?.description),
    killers,
    survivors,
    perks,
    stats: {
      killerCount: killers.length,
      survivorCount: survivors.length,
      perkCount: perks.length,
      killerPriorityRange: {
        min: killerPriorityValues.length ? Math.min(...killerPriorityValues) : null,
        max: killerPriorityValues.length ? Math.max(...killerPriorityValues) : null
      },
      survivorPriorityRange: {
        min: survivorPriorityValues.length ? Math.min(...survivorPriorityValues) : null,
        max: survivorPriorityValues.length ? Math.max(...survivorPriorityValues) : null
      }
    }
  };
}

function parseBeginnerGuides(html) {
  const payload = extractSvelteRoutePayload(html, 'beginner-guides');
  const rawGuides = Array.isArray(payload.beginnerGuides) ? payload.beginnerGuides : [];

  const entries = rawGuides
    .map((guide, index) => ({
      id: guide._id || `beginner-guide-${index + 1}`,
      title: normalizeText(guide.title || ''),
      description: typeof guide.description === 'string' ? normalizeText(guide.description) : portableTextToPlain(guide.description),
      imageUrl: resolveUrl(SOURCES.home, guide.image || ''),
      url: resolveUrl(SOURCES.home, guide.url || ''),
      sourceType: inferResourceType(guide.url || '')
    }))
    .filter((entry) => entry.title);

  return {
    title: normalizeText(payload.section?.title || payload.section?.sectionName || 'Beginner Guides'),
    description: portableTextToPlain(payload.section?.description),
    entries,
    stats: {
      guideCount: entries.length,
      withLinkCount: entries.filter((entry) => entry.url).length
    }
  };
}

function parseTierlists(html) {
  const payload = extractSvelteRoutePayload(html, 'tierlists');
  const rawTierlists = Array.isArray(payload.tierlists) ? payload.tierlists : [];

  const entries = rawTierlists
    .map((entry, index) => {
      const dateLabel = normalizeText(entry.date || '');
      const dateIso = toDateIso(dateLabel);
      const category = normalizeText(entry.category || '');
      const title = normalizeText(entry.title || '');
      const override = TIERLIST_LINK_OVERRIDES[normalizeKey(title)] || {};
      return {
        id: entry._id || `tierlist-${index + 1}`,
        title,
        description: normalizeText(override.description || entry.description || ''),
        patch: normalizeText(override.patch || entry.patch || ''),
        dateLabel: override.dateLabel || dateLabel,
        dateIso: override.dateIso || dateIso,
        category,
        categoryLabel: TIERLIST_CATEGORY_LABELS[category] || category || 'General',
        imageUrl: override.imageUrl || resolveUrl(SOURCES.home, entry.image || ''),
        url: override.url || resolveUrl(SOURCES.home, entry.url || ''),
        sourceType: override.sourceType || inferResourceType(entry.url || ''),
        ...(override.sourceNote ? { sourceNote: override.sourceNote } : {})
      };
    })
    .filter((entry) => entry.title)
    .sort((a, b) => {
      if (a.dateIso && b.dateIso) return b.dateIso.localeCompare(a.dateIso);
      if (a.dateIso) return -1;
      if (b.dateIso) return 1;
      return a.title.localeCompare(b.title);
    });

  const categoryCounts = entries.reduce((accumulator, entry) => {
    const key = entry.categoryLabel;
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  return {
    title: normalizeText(payload.section?.title || payload.section?.sectionName || 'Tierlists'),
    description: portableTextToPlain(payload.section?.description),
    entries,
    stats: {
      tierlistCount: entries.length,
      categoryCounts,
      datedCount: entries.filter((entry) => entry.dateIso).length
    }
  };
}

function parseFaq(html) {
  const payload = extractSvelteRoutePayload(html, 'faq');
  const rawCategories = Array.isArray(payload.faqCategories) ? payload.faqCategories : [];

  const categories = rawCategories.map((category, index) => {
    const questions = Array.isArray(category.faq) ? category.faq : [];
    return {
      id: category._id || `faq-category-${index + 1}`,
      categoryCode: normalizeText(category.category || String(index + 1)),
      title: normalizeText(category.title || `Category ${index + 1}`),
      questionCount: questions.length
    };
  });

  const entries = rawCategories.flatMap((category, categoryIndex) => {
    const categoryTitle = normalizeText(category.title || `Category ${categoryIndex + 1}`);
    const categoryCode = normalizeText(category.category || String(categoryIndex + 1));
    const questions = Array.isArray(category.faq) ? category.faq : [];

    return questions
      .map((questionEntry, questionIndex) => {
        const answerBlocks = Array.isArray(questionEntry.answer) ? questionEntry.answer : [];
        return {
          id: `${categoryCode}-${questionIndex + 1}-${slugify(questionEntry.question || '')}`,
          category: categoryTitle,
          categoryCode,
          question: normalizeText(questionEntry.question || ''),
          answer: portableTextToPlain(answerBlocks),
          links: extractPortableTextLinks(answerBlocks, SOURCES.home),
          tags: Array.isArray(questionEntry.tags) ? questionEntry.tags.map((tag) => normalizeText(tag)).filter(Boolean) : []
        };
      })
      .filter((entry) => entry.question && entry.answer);
  });

  return {
    title: normalizeText(payload.section?.title || payload.section?.sectionName || 'FAQ'),
    description: portableTextToPlain(payload.section?.description),
    categories,
    entries,
    stats: {
      categoryCount: categories.length,
      questionCount: entries.length,
      dbdQuestionCount: entries.filter((entry) => entry.categoryCode === '1').length
    }
  };
}

function parseGuideVault(html) {
  const payload = extractSvelteRoutePayload(html, 'killer-guides');
  const section = payload.section?.killerGuideSection || {};
  const linkedEntries = extractPortableTextLinkedEntries(section.description, SOURCES.home);

  const entries = linkedEntries.map((entry, index) => ({
    id: `${entry.id}-${index + 1}`,
    label: entry.label,
    context: entry.context,
    url: entry.url,
    host: safeHost(entry.url),
    sourceType: inferResourceType(entry.url)
  }));

  return {
    title: normalizeText(section.title || section.sectionName || 'Guide Vault'),
    description: portableTextToPlain(section.description),
    entries,
    stats: {
      linkCount: entries.length,
      sourceTypeCounts: entries.reduce((accumulator, entry) => {
        accumulator[entry.sourceType] = (accumulator[entry.sourceType] || 0) + 1;
        return accumulator;
      }, {})
    }
  };
}

function parseOpinions(html) {
  const $ = cheerio.load(html);
  const entries = [];

  $('.opinion').each((index, node) => {
    const opinionNode = $(node);
    const fullText = normalizeText(opinionNode.text());
    if (!fullText) return;

    const strongTitle = normalizeText(opinionNode.find('p strong').first().text()) || normalizeText(opinionNode.find('strong').first().text());
    const title = strongTitle || (fullText.length > 90 ? `${fullText.slice(0, 87)}...` : fullText);

    const patchLabel = extractPatchLabel(`${title} ${fullText}`);
    const dateLabel = extractOpinionDateLabel(`${title} ${fullText}`);
    const dateIso = dateLabel ? toDateIso(dateLabel) : null;

    const links = uniqBy(
      opinionNode
        .find('a[href]')
        .map((_, anchor) => {
          const href = $(anchor).attr('href');
          const label = normalizeText($(anchor).text());
          const url = resolveUrl(SOURCES.opinions, href);
          return { label: label || url, url };
        })
        .get()
        .filter((entry) => entry.url),
      (entry) => entry.url
    );

    const tags = detectOpinionTags(`${title} ${fullText}`);
    const summary = fullText.length > 320 ? `${fullText.slice(0, 317)}...` : fullText;

    entries.push({
      id: `${slugify(title)}-${index + 1}`,
      order: index + 1,
      title,
      patchLabel: patchLabel || '',
      dateLabel: dateLabel || '',
      dateIso,
      summary,
      text: fullText,
      tags,
      links
    });
  });

  const dedupedEntries = uniqBy(entries, (entry) => `${entry.title}|${entry.patchLabel}|${entry.dateLabel}|${entry.summary}`)
    .sort((a, b) => {
      if (a.dateIso && b.dateIso) return b.dateIso.localeCompare(a.dateIso);
      if (a.dateIso) return -1;
      if (b.dateIso) return 1;
      return a.order - b.order;
    });

  return {
    title: 'Otz Opinions',
    entries: dedupedEntries,
    stats: {
      entryCount: dedupedEntries.length,
      withPatchLabelCount: dedupedEntries.filter((entry) => entry.patchLabel).length,
      withDateCount: dedupedEntries.filter((entry) => entry.dateIso).length
    }
  };
}

function extractLinkCatalog(homeHtml) {
  const $ = cheerio.load(homeHtml);
  const links = $('a[href]')
    .map((_, anchor) => {
      const href = $(anchor).attr('href');
      const label = normalizeText($(anchor).text());
      const url = resolveUrl(SOURCES.home, href);
      return { label, url };
    })
    .get()
    .filter((entry) => entry.url.startsWith('http'));

  const filtered = links.filter((entry) => {
    return (
      entry.url.includes('otzdarva.com/dbd') ||
      entry.url.includes('otzdarva-builds.com') ||
      entry.url.includes('otz-addon-tierlist.pages.dev')
    );
  });

  return uniqBy(filtered, (entry) => entry.url);
}

async function fetchBuildPanels(role) {
  const body = new URLSearchParams({ xml: role }).toString();
  return fetchText(SOURCES.buildsPanels, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  });
}

async function main() {
  const database = readJson(DATABASE_PATH);

  const [
    homeHtml,
    addonTierlistHtml,
    buildsHomeHtml,
    killerPanelsHtml,
    survivorPanelsHtml,
    characterInfoHtml,
    beginnerGuidesHtml,
    tierlistsHtml,
    killerGuidesHtml
  ] = await Promise.all([
    fetchText(SOURCES.home),
    fetchText(SOURCES.addonTierlist),
    fetchText(SOURCES.buildsHome),
    fetchBuildPanels('killers'),
    fetchBuildPanels('survivors'),
    fetchText(SOURCES.characterInfo),
    fetchText(SOURCES.beginnerGuides),
    fetchText(SOURCES.tierlists),
    fetchText(SOURCES.killerGuides)
  ]);

  assertHealthySourcePayload('home', homeHtml, 400);
  assertHealthySourcePayload('addonTierlist', addonTierlistHtml, 400);
  assertHealthySourcePayload('buildsHome', buildsHomeHtml, 400);
  assertHealthySourcePayload('buildsPanels(killers)', killerPanelsHtml, 100);
  assertHealthySourcePayload('buildsPanels(survivors)', survivorPanelsHtml, 100);
  assertHealthySourcePayload('characterInfo', characterInfoHtml, 400);
  assertHealthySourcePayload('beginnerGuides', beginnerGuidesHtml, 300);
  assertHealthySourcePayload('tierlists', tierlistsHtml, 300);
  assertHealthySourcePayload('killerGuides', killerGuidesHtml, 300);

  if (healthCheckOnly) {
    console.log('sync-community-content: health-check ok');
    return;
  }

  const addonTierlist = parseAddonTierlist(addonTierlistHtml, database);
  const parsedBuilds = parseBuilds(buildsHomeHtml, killerPanelsHtml, survivorPanelsHtml);
  const builds = await enrichBuildsWithPerkDetails(parsedBuilds);
  const characterInfo = parseCharacterInfo(characterInfoHtml);
  const beginnerGuides = parseBeginnerGuides(beginnerGuidesHtml);
  const tierlists = parseTierlists(tierlistsHtml);
  const guideVault = parseGuideVault(killerGuidesHtml);

  const links = extractLinkCatalog(homeHtml);
  const generatedAt = new Date().toISOString();

  const output = {
    generatedAt,
    metadata: {
      scraperVersion: SCRAPER_VERSION,
      attribution: 'Data sourced from Otzdarva web properties. Keep attribution when redistributing.',
      sources: [
        { id: 'home', url: SOURCES.home, fetchedAt: generatedAt },
        { id: 'addonTierlist', url: SOURCES.addonTierlist, fetchedAt: generatedAt },
        { id: 'buildsHome', url: SOURCES.buildsHome, fetchedAt: generatedAt },
        { id: 'buildsPanels', url: SOURCES.buildsPanels, fetchedAt: generatedAt },
        { id: 'buildsPerkDetails', url: SOURCES.buildsPerkDetails, fetchedAt: generatedAt },
        { id: 'characterInfo', url: SOURCES.characterInfo, fetchedAt: generatedAt },
        { id: 'beginnerGuides', url: SOURCES.beginnerGuides, fetchedAt: generatedAt },
        { id: 'tierlists', url: SOURCES.tierlists, fetchedAt: generatedAt },
        { id: 'killerGuides', url: SOURCES.killerGuides, fetchedAt: generatedAt }
      ],
      stats: {
        addonTierlist: addonTierlist.stats,
        builds: builds.stats,
        characterInfo: characterInfo.stats,
        beginnerGuides: beginnerGuides.stats,
        tierlists: tierlists.stats,
        guideVault: guideVault.stats,
        linkCount: links.length
      }
    },
    links,
    addonTierlist,
    builds,
    characterInfo,
    beginnerGuides,
    tierlists,
    guideVault
  };

  writeJson(CONTENT_PATH, output);

  console.log(`sync-community-content: wrote ${path.relative(ROOT, CONTENT_PATH)}`);
  console.log(`sync-community-content: killers(addon tierlist)=${addonTierlist.stats.killerCount} addons=${addonTierlist.stats.addonCount} matched=${addonTierlist.stats.matchedAddonCount}`);
  console.log(`sync-community-content: builds killers=${builds.stats.killerProfileCount} survivors=${builds.stats.survivorProfileCount} totalBuilds=${builds.stats.totalBuildCount} perkDetails=${builds.stats.perkDetailsResolvedTotal}`);
  console.log(`sync-community-content: character info killers=${characterInfo.stats.killerCount} survivors=${characterInfo.stats.survivorCount} perks=${characterInfo.stats.perkCount}`);
  console.log(`sync-community-content: beginnerGuides=${beginnerGuides.stats.guideCount} tierlists=${tierlists.stats.tierlistCount} guideVault=${guideVault.stats.linkCount}`);
}

main().catch((error) => {
  fail(error.message);
});
