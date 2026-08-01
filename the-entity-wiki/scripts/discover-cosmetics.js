#!/usr/bin/env node

const { File } = require('buffer');

if (typeof globalThis.File === 'undefined') {
  globalThis.File = File;
}

const cheerio = require('cheerio');

const {
  DATABASE_PATH,
  DISCOVERY_PATH,
  CHARACTER_SWAP_CATEGORIES,
  OFFICIAL_FILE_OVERRIDES,
  readJson,
  writeJson,
  uniq,
  normalizeKey,
  fetchCategoryMembers,
  fetchPageImages,
  fetchWikitext,
  fetchRenderedHtml,
  extractRenderedImageTitles,
  scorePortraitImageTitle,
  buildCharacterLookup,
  requestJson,
  stripWikiMarkup,
  slugify
} = require('./cosmetics-shared');

const IGNORED_TITLES = new Set(['Eddie']);
const CHARACTER_COSMETIC_TEMPLATE_REGEX = /^Template:(.+?)'(?:s)? (.+) Cosmetics$/i;
const FEATURED_COSMETIC_TEMPLATE_REGEX = /^Template:(.+?) (?:Event )?Featured Cosmetics$/i;
const RIFT_COSMETIC_TEMPLATE_REGEX = /^Template:.*Rift.*Cosmetics$/i;
const ROW_MARKER_REGEX = /^\|-\s*style\s*=\s*"text-align:center[^"]*"\s*$/i;
const TEMPLATE_FILE_REGEX = /\[\[(File:[^\]|]+)\|[^\]]*\]\]/i;
const NAME_REGEX = /\n!\s*([^\n]+)\n/;
const RARITY_DESCRIPTION_REGEX = /\{\{#Invoke:Utils\|clr\|[^|]+\|([^}]+)\}\}\s*(?:\|\|\s*([^\n]+))?/i;
const BODY_ICON_REGEX = /\[\[File:(CategoryIcon[^|\]]+)\|[^\]]*\]\]/i;
const BOUND_SLOT_REGEX = /''\s*([A-Za-z][A-Za-z ]+?)\s*''/g;
const ICON_LINK_SECTION_REGEX = /\{\{#Invoke:Utils\|IconLink\|([^}|]+)\}\}/gi;
const COLLECTION_PAGE_REGEX = /Collection$/i;
const LIMITED_COLLECTION_KEYWORDS = [
  'blood moon',
  'moonrise',
  'lunar',
  'festival',
  'hallowed',
  'blight',
  'masquerade',
  'bone chill',
  'anniversary',
  'haunted',
  'winter',
  'event'
];
const KNOWN_LIMITED_COLLECTION_PAGES = [
  'Blood Moon Collection',
  'Lunar New Year Collection',
  'Fire Moon Festival Collection'
];

function buildCharactersList(database) {
  return [
    ...(database.killers || []).map((killer) => ({ ...killer, type: 'Killer' })),
    ...(database.survivors || []).map((survivor) => ({ ...survivor, type: 'Survivor' }))
  ];
}

function formatSlotLabel(slot = '') {
  const normalized = normalizeKey(slot);
  if (!normalized) return '';
  if (normalized.includes('head') || normalized.includes('hair') || normalized.includes('mask')) return 'Head';
  if (normalized.includes('torso')) return 'Body';
  if (normalized.includes('legs')) return 'Legs';
  if (normalized.includes('body')) return 'Body';
  if (normalized.includes('weapon')) return 'Weapon';
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferOutfitLinkMode(pieceType = 'Cosmetic', boundSlots = []) {
  if (pieceType !== 'Outfit') return 'unlinked';
  if (boundSlots.length >= 2) return 'linked';
  if (boundSlots.length === 1) return 'partially_linked';
  return 'unlinked';
}

function sanitizeCharacterSwapCandidates(titles, scoreFn) {
  return uniq(
    (titles || [])
      .filter((title) => Boolean(title) && scoreFn(title) > 0)
      .sort((a, b) => scoreFn(b) - scoreFn(a) || a.localeCompare(b))
      .slice(0, 12)
  );
}

function sanitizeAssetCandidates(titles = []) {
  return uniq(
    (titles || [])
      .map((title) => String(title || '').trim())
      .filter((title) => /^File:/i.test(title))
      .filter((title) => !/CategoryIcon|IconHelp/i.test(title))
      .slice(0, 8)
  );
}

function parsePageTitle(pageTitle) {
  const parts = String(pageTitle || '').split('/');
  if (parts.length !== 2) return null;
  const [basePageTitle, cosmeticName] = parts;
  if (!basePageTitle || !cosmeticName) return null;
  return { basePageTitle, cosmeticName };
}

function resolveCharacterFromLabel(rawLabel, lookup, characters = []) {
  const cleaned = stripWikiMarkup(String(rawLabel || ''))
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  const tryLookup = (value) => {
    const key = normalizeKey(value);
    if (!key) return null;
    return lookup.get(key) || null;
  };

  const direct = [
    cleaned,
    cleaned.replace(/^The\s+/i, '').trim(),
    cleaned.startsWith('The ') ? cleaned : `The ${cleaned}`
  ];
  for (const candidate of direct) {
    const resolved = tryLookup(candidate);
    if (resolved) return resolved;
  }

  const tokens = normalizeKey(cleaned).split(' ').filter(Boolean);
  if (!tokens.length) return null;

  const firstToken = tokens[0];
  const firstTokenMatches = characters.filter((character) => {
    const nameToken = normalizeKey(character.name || '').split(' ')[0];
    const realToken = normalizeKey(character.realName || '').split(' ')[0];
    return nameToken === firstToken || realToken === firstToken;
  });
  if (firstTokenMatches.length === 1) return firstTokenMatches[0];

  const broadMatches = characters.filter((character) => {
    const nameKey = normalizeKey(character.name || '');
    const realNameKey = normalizeKey(character.realName || '');
    return tokens.every((token) => nameKey.includes(token) || realNameKey.includes(token));
  });
  if (broadMatches.length === 1) return broadMatches[0];

  return null;
}

function resolveBaseCharacter(basePageTitle, lookup, characters) {
  return resolveCharacterFromLabel(basePageTitle, lookup, characters);
}

async function fetchCosmeticsTemplateInventory() {
  const characterTemplates = [];
  const featuredTemplates = [];
  const riftTemplates = [];
  let nextContinue = null;
  do {
    const params = {
      action: 'query',
      list: 'allpages',
      apnamespace: '10',
      aplimit: '500'
    };
    if (nextContinue) params.apcontinue = nextContinue;
    const data = await requestJson(params);
    const pages = Array.isArray(data.query?.allpages) ? data.query.allpages : [];
    pages.forEach((page) => {
      const title = page?.title || '';
      if (CHARACTER_COSMETIC_TEMPLATE_REGEX.test(title)) {
        characterTemplates.push(title);
        return;
      }
      if (FEATURED_COSMETIC_TEMPLATE_REGEX.test(title)) {
        featuredTemplates.push(title);
        return;
      }
      if (RIFT_COSMETIC_TEMPLATE_REGEX.test(title)) {
        riftTemplates.push(title);
      }
    });
    nextContinue = data.continue?.apcontinue || null;
  } while (nextContinue);

  return {
    characterTemplates: uniq(characterTemplates).sort((a, b) => a.localeCompare(b)),
    featuredTemplates: uniq(featuredTemplates).sort((a, b) => a.localeCompare(b)),
    riftTemplates: uniq(riftTemplates).sort((a, b) => a.localeCompare(b))
  };
}

async function fetchLimitedCollectionPageTitles() {
  const collectedTitles = [...KNOWN_LIMITED_COLLECTION_PAGES];

  for (const keyword of LIMITED_COLLECTION_KEYWORDS) {
    let nextOffset = 0;
    let iteration = 0;
    while (iteration < 6) {
      const params = {
        action: 'query',
        list: 'search',
        srsearch: `${keyword} Collection`,
        srnamespace: '0',
        srlimit: '50',
        sroffset: String(nextOffset)
      };
      const data = await requestJson(params);
      const results = Array.isArray(data.query?.search) ? data.query.search : [];
      results.forEach((result) => {
        const title = String(result?.title || '').trim();
        if (!title || !COLLECTION_PAGE_REGEX.test(title)) return;
        collectedTitles.push(title);
      });

      const upcoming = data.continue?.sroffset;
      if (typeof upcoming !== 'number') break;
      if (upcoming <= nextOffset) break;
      nextOffset = upcoming;
      iteration += 1;
    }
  }

  return uniq(collectedTitles).sort((a, b) => a.localeCompare(b));
}

function parseCharacterCosmeticTemplateTitle(templateTitle) {
  const match = String(templateTitle || '').match(CHARACTER_COSMETIC_TEMPLATE_REGEX);
  if (!match) return null;
  return {
    ownerLabel: stripWikiMarkup(match[1]),
    bucketLabel: stripWikiMarkup(match[2])
  };
}

function templateBucketLabelFromTitle(templateTitle = '') {
  return String(templateTitle || '')
    .replace(/^Template:/i, '')
    .replace(/\s+Cosmetics$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTemplateRows(templateWikitext = '') {
  const rows = [];
  const lines = String(templateWikitext || '').split('\n');
  let activeRow = null;

  const flushActiveRow = () => {
    if (!activeRow || activeRow.length === 0) return;
    rows.push(activeRow.join('\n'));
    activeRow = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isDataRowStart = ROW_MARKER_REGEX.test(trimmed);
    if (isDataRowStart) {
      flushActiveRow();
      activeRow = [line];
      continue;
    }

    if (!activeRow) continue;
    if (trimmed === '|}' || /^\|-/.test(trimmed)) {
      flushActiveRow();
      continue;
    }
    activeRow.push(line);
  }

  flushActiveRow();
  return rows;
}

function inferPieceType(bodyIconFile = '', assetFileTitle = '', boundSlots = []) {
  const iconKey = normalizeKey(String(bodyIconFile || '').replace(/^CategoryIcon\s*/i, '').replace(/\.[a-z]+$/i, ''));
  const fileKey = normalizeKey(assetFileTitle);

  if (/outfit/.test(iconKey) || /outfit/.test(fileKey)) return 'Outfit';
  if (/head|mask|hair|face/.test(iconKey) || /head|mask|hair/.test(fileKey)) return 'Head';
  if (/torso|body|upper/.test(iconKey) || /torso|body/.test(fileKey)) return 'Body';
  if (/legs|pants|lower/.test(iconKey) || /legs|pants/.test(fileKey)) return 'Legs';
  if (/weapon/.test(iconKey) || /weapon/.test(fileKey)) return 'Weapon';

  if (boundSlots.length >= 2) return 'Outfit';
  if (boundSlots.length === 1) return boundSlots[0];

  return 'Cosmetic';
}

function extractCollectionName(rowText, offset = 0) {
  const tail = rowText.slice(Math.max(0, offset));
  const lines = tail.split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    let rawValue = line.replace(/^\|+\s*/, '');
    if (/^(class|style)=/i.test(rawValue) && rawValue.includes('|')) {
      const parts = rawValue.split('|').map((part) => part.trim()).filter(Boolean);
      rawValue = parts.length ? parts[parts.length - 1] : '';
    }
    if (!rawValue || rawValue === '-') continue;
    if (/^(class|style)=/i.test(rawValue)) continue;
    if (/\{\{#invoke:currency/i.test(rawValue)) continue;
    if (/IconHelp|Auric|Shards|Bloodpoints|Iridescent/i.test(rawValue)) continue;
    if (/<div/i.test(rawValue)) continue;
    if (/^\[\[File:/i.test(rawValue)) continue;
    const cleaned = stripWikiMarkup(rawValue);
    if (!cleaned) continue;
    if (/^(Head|Body|Torso|Legs|Weapon|Mask|Hair)$/i.test(cleaned)) continue;
    if (/^\d+([.,]\d+)?$/.test(cleaned)) continue;
    return cleaned;
  }
  return '';
}

function parseTemplateRow(rowWikitext) {
  const rowText = String(rowWikitext || '');

  const fileMatch = rowText.match(TEMPLATE_FILE_REGEX);
  const extractNameFromRow = () => {
    const strictName = rowText.match(NAME_REGEX);
    if (strictName) return stripWikiMarkup(strictName[1]);

    const lines = rowText.split('\n').map((line) => line.trim());
    for (const line of lines) {
      if (!line.startsWith('!') && !line.startsWith('|')) continue;
      let rawValue = line.replace(/^[!|]+\s*/, '');
      if (!rawValue || rawValue === '-') continue;
      if (/\[\[File:/i.test(rawValue)) continue;
      if (/^-\s*style\s*=/i.test(rawValue)) continue;
      if (/^(class|style)=/i.test(rawValue) && rawValue.includes('|')) {
        const parts = rawValue.split('|').map((part) => part.trim()).filter(Boolean);
        rawValue = parts.length ? parts[parts.length - 1] : '';
      }
      if (!rawValue) continue;
      if (/^\d+px\]\]$/i.test(rawValue)) continue;
      if (/\[\[File:/i.test(rawValue)) continue;
      if (/^-\s*style\s*=/i.test(rawValue)) continue;
      if (/^(class|style)=/i.test(rawValue)) continue;
      if (/^\[\[File:/i.test(rawValue)) continue;
      if (/\{\{#invoke:utils\|clr/i.test(rawValue)) continue;
      if (/\{\{#invoke:currency/i.test(rawValue)) continue;
      if (/IconHelp|Auric|Shards|Bloodpoints|Iridescent/i.test(rawValue)) continue;

      const cleaned = stripWikiMarkup(rawValue);
      if (!cleaned) continue;
      if (/^(Head|Body|Torso|Legs|Weapon|Mask|Hair|Outfit)$/i.test(cleaned)) continue;
      if (/^\d+([.,]\d+)?$/.test(cleaned)) continue;
      if (/^(Yes|No)$/i.test(cleaned)) continue;
      return cleaned;
    }
    return '';
  };

  const parsedName = extractNameFromRow();
  if (!fileMatch || !parsedName) return null;

  const rarityDescriptionMatch = rowText.match(RARITY_DESCRIPTION_REGEX);
  const rarity = rarityDescriptionMatch ? stripWikiMarkup(rarityDescriptionMatch[1]) : '';
  const description = rarityDescriptionMatch ? stripWikiMarkup(rarityDescriptionMatch[2] || '') : '';
  const bodyIconMatch = rowText.match(BODY_ICON_REGEX);
  const boundSlots = uniq(
    [...rowText.matchAll(BOUND_SLOT_REGEX)]
      .map((match) => formatSlotLabel(stripWikiMarkup(match[1])))
      .filter(Boolean)
  );
  const pieceType = inferPieceType(bodyIconMatch?.[1] || '', fileMatch[1], boundSlots);
  const outfitLinkMode = inferOutfitLinkMode(pieceType, boundSlots);
  const rarityOffset = rarityDescriptionMatch
    ? rowText.indexOf(rarityDescriptionMatch[0]) + rarityDescriptionMatch[0].length
    : 0;
  const collectionName = extractCollectionName(rowText, rarityOffset);

  return {
    assetFileTitle: fileMatch[1].trim(),
    name: parsedName,
    rarity,
    description,
    collectionName,
    pieceType,
    boundSlots,
    outfitLinkMode
  };
}

function resolveCharacterFromRow(rowWikitext, characterLookup, characters) {
  const lines = String(rowWikitext || '').split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const rawValue = line.replace(/^\|+\s*/, '');
    if (!rawValue || rawValue === '-') continue;
    if (/^(class|style)=/i.test(rawValue)) continue;
    if (/^\[\[File:/i.test(rawValue)) continue;
    if (/\{\{#invoke:utils\|clr/i.test(rawValue)) continue;
    if (/\{\{#invoke:utils\|iconlink/i.test(rawValue)) continue;
    if (/\{\{#invoke:currency/i.test(rawValue)) continue;
    if (/^\d+([&\s,]+\d+)*$/i.test(rawValue)) continue;
    if (/^(yes|no)$/i.test(rawValue)) continue;
    const cleaned = stripWikiMarkup(rawValue);
    if (!cleaned) continue;
    const resolved = resolveCharacterFromLabel(cleaned, characterLookup, characters);
    if (resolved) return resolved;
  }
  return null;
}

function extractIconLinkSections(templateWikitext = '') {
  const content = String(templateWikitext || '');
  const matches = [...content.matchAll(ICON_LINK_SECTION_REGEX)];
  if (!matches.length) return [];

  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index || content.length) : content.length;
    return {
      characterLabel: stripWikiMarkup(match[1]),
      sectionText: content.slice(start, end)
    };
  });
}

async function discoverCharacterSwaps(characterLookup, characters) {
  const entries = [];
  const ignored = [];

  for (const category of CHARACTER_SWAP_CATEGORIES) {
    const titles = await fetchCategoryMembers(category.title);
    console.log(`discover-cosmetics: scanning ${category.label} swaps (${titles.length} pages)`);
    let scanned = 0;
    for (const pageTitle of titles) {
      scanned += 1;
      if (IGNORED_TITLES.has(pageTitle)) {
        ignored.push(pageTitle);
        continue;
      }
      const parsed = parsePageTitle(pageTitle);
      if (!parsed) continue;
      const baseCharacter = resolveBaseCharacter(parsed.basePageTitle, characterLookup, characters);
      const renderedHtml = OFFICIAL_FILE_OVERRIDES[pageTitle] ? '' : await fetchRenderedHtml(pageTitle);
      const imageCandidates = OFFICIAL_FILE_OVERRIDES[pageTitle] || uniq([
        ...(await fetchPageImages(pageTitle)),
        ...extractRenderedImageTitles(renderedHtml)
      ]);
      entries.push({
        kind: 'characterSwap',
        groupKey: category.key,
        groupLabel: category.label,
        outfitLinkMode: 'character_swap',
        boundSlots: [],
        bindSummary: '',
        pageTitle,
        name: parsed.cosmeticName.trim(),
        basePageTitle: parsed.basePageTitle.trim(),
        baseCharacterId: baseCharacter?.id || '',
        baseCharacterName: baseCharacter?.name || '',
        baseCharacterType: baseCharacter?.type || '',
        assetFileTitleCandidates: sanitizeCharacterSwapCandidates(imageCandidates, scorePortraitImageTitle),
        sourceKind: 'wiki-category',
        sourcePage: pageTitle,
        slugHint: slugify(parsed.cosmeticName),
        statusHint: !baseCharacter ? 'blocked_mapping' : (imageCandidates.length > 0 ? 'ready' : 'blocked_art')
      });

      if (scanned % 20 === 0 || scanned === titles.length) {
        console.log(`discover-cosmetics: ${category.label} swaps ${scanned}/${titles.length}`);
      }
    }
  }

  entries.sort((a, b) =>
    a.baseCharacterType.localeCompare(b.baseCharacterType) ||
    a.baseCharacterName.localeCompare(b.baseCharacterName) ||
    a.groupLabel.localeCompare(b.groupLabel) ||
    a.name.localeCompare(b.name)
  );

  return { entries, ignored: uniq(ignored).sort() };
}

function buildCharacterSwapLookup(entries) {
  const lookup = new Set();
  (entries || []).forEach((entry) => {
    if (!entry?.baseCharacterId || !entry?.name) return;
    lookup.add(`${entry.baseCharacterId}::${normalizeKey(entry.name)}`);
  });
  return lookup;
}

function parseTemplateRows(templateWikitext) {
  return splitTemplateRows(templateWikitext)
    .map((rowWikitext) => {
      const parsed = parseTemplateRow(rowWikitext);
      if (!parsed) return null;
      return { parsed, rowWikitext };
    })
    .filter(Boolean);
}

function inferRarityFromClassName(className = '') {
  const match = String(className || '').match(/BG-(\d+)-enh/i);
  if (!match) return '';
  const code = Number(match[1]);
  const map = {
    1: 'Common',
    2: 'Uncommon',
    3: 'Rare',
    4: 'Very Rare',
    5: 'Ultra Rare',
    6: 'Ultra Rare',
    14: 'Event'
  };
  return map[code] || '';
}

function toCollectionAssetFileTitle(imageAlt = '') {
  const cleaned = String(imageAlt || '').trim();
  if (!cleaned) return '';
  if (/^categoryicon|^iconhelp/i.test(cleaned)) return '';
  if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(cleaned)) return '';
  return `File:${cleaned.replace(/^File:/i, '')}`;
}

function parseCollectionOutfitRows(renderedHtml, pageTitle, characterLookup, characters) {
  const $ = cheerio.load(String(renderedHtml || ''));
  const entries = [];
  const unmappedRows = [];
  const bucketLabel = String(pageTitle || '').replace(/\s+Collection$/i, '').trim();

  $('.outfitView .cosmeticPiece').each((_, element) => {
    const node = $(element);
    const name = node.find('.pieceName.cellHeader').first().text().trim();
    const baseCharacterLabel = node.find('.pieceCharacter a').first().text().trim();
    const baseCharacter = resolveCharacterFromLabel(baseCharacterLabel, characterLookup, characters);
    const thumbnail = node.find('.pieceThumbnail img').first();
    const thumbnailAlt = thumbnail.attr('alt') || '';
    const assetFileTitle = toCollectionAssetFileTitle(thumbnailAlt);
    const rarity = inferRarityFromClassName(node.find('.pieceThumbnail').attr('class') || '');
    const collectionName = node.find('.collectionValue .collectionNameWrapper').first().text().trim() || bucketLabel;
    const description = node.find('.pieceDescValue .descText').first().text().trim() || node.find('.pieceDescValue').first().text().trim();
    const boundSlots = uniq(
      node.find('.outfitPieces img').toArray()
        .map((img) => $(img).attr('alt') || '')
        .map((alt) => alt.replace(/^CategoryIcon[_\s]*/i, '').replace(/\.[a-z0-9]+$/i, ''))
        .map((slot) => formatSlotLabel(slot))
        .filter(Boolean)
    );

    if (!name || !baseCharacterLabel || !assetFileTitle) return;
    if (!baseCharacter) {
      unmappedRows.push(`${pageTitle}::${name}::${baseCharacterLabel}`);
      return;
    }

    const fileStem = assetFileTitle.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
    entries.push({
      kind: 'cosmetic',
      groupKey: 'cosmetic',
      groupLabel: bucketLabel || 'Collection',
      pageTitle,
      templateName: pageTitle,
      sourceBucket: bucketLabel,
      name,
      rarity,
      description,
      collectionName,
      pieceType: 'Outfit',
      outfitLinkMode: 'unlinked',
      boundSlots,
      bindSummary: boundSlots.join(' + '),
      basePageTitle: baseCharacter.name,
      baseCharacterId: baseCharacter.id,
      baseCharacterName: baseCharacter.name,
      baseCharacterType: baseCharacter.type,
      assetFileTitleCandidates: sanitizeAssetCandidates([assetFileTitle]),
      sourceKind: 'wiki-collection-page',
      sourcePage: pageTitle,
      slugHint: `${slugify(baseCharacter.name)}--${slugify(name)}--${slugify(collectionName)}--${slugify(fileStem)}`,
      statusHint: 'ready'
    });
  });

  return { entries, unmappedRows };
}

function appendRowsToEntries(rows, {
  entries,
  templateTitle,
  bucketLabel,
  baseCharacter,
  characterSwapLookup,
  sourceKind
}) {
  rows.forEach(({ parsed: row }) => {
    const isCharacterSwapOutfit = row.pieceType === 'Outfit'
      && characterSwapLookup.has(`${baseCharacter.id}::${normalizeKey(row.name)}`);
    if (isCharacterSwapOutfit) return;

    const fileStem = row.assetFileTitle.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
    entries.push({
      kind: 'cosmetic',
      groupKey: 'cosmetic',
      groupLabel: bucketLabel || 'Cosmetics',
      pageTitle: templateTitle,
      templateName: templateTitle.replace(/^Template:/i, ''),
      sourceBucket: bucketLabel || '',
      name: row.name,
      rarity: row.rarity,
      description: row.description,
      collectionName: row.collectionName,
      pieceType: row.pieceType,
      outfitLinkMode: row.outfitLinkMode,
      boundSlots: row.boundSlots,
      bindSummary: row.boundSlots.length ? row.boundSlots.join(' + ') : '',
      basePageTitle: baseCharacter.name,
      baseCharacterId: baseCharacter.id,
      baseCharacterName: baseCharacter.name,
      baseCharacterType: baseCharacter.type,
      assetFileTitleCandidates: sanitizeAssetCandidates([row.assetFileTitle]),
      sourceKind,
      sourcePage: templateTitle,
      slugHint: `${slugify(baseCharacter.name)}--${slugify(row.name)}--${slugify(row.pieceType)}--${slugify(fileStem)}--${slugify(bucketLabel)}`,
      statusHint: row.assetFileTitle ? 'ready' : 'blocked_art'
    });
  });
}

function sortCosmeticEntries(entries) {
  return [...entries].sort((a, b) =>
    a.baseCharacterType.localeCompare(b.baseCharacterType)
    || a.baseCharacterName.localeCompare(b.baseCharacterName)
    || (a.rarity || '').localeCompare(b.rarity || '')
    || (a.pieceType || '').localeCompare(b.pieceType || '')
    || a.name.localeCompare(b.name)
  );
}

function dedupeCosmeticEntries(entries = []) {
  const priority = {
    'wiki-template': 4,
    'wiki-template-featured': 3,
    'wiki-template-rift': 2,
    'wiki-collection-page': 1
  };

  const byKey = new Map();
  entries.forEach((entry) => {
    const key = [
      String(entry.baseCharacterId || ''),
      normalizeKey(entry.name || ''),
      normalizeKey(entry.pieceType || ''),
      normalizeKey(entry.collectionName || entry.sourceBucket || '')
    ].join('::');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      return;
    }

    const currentPriority = priority[existing.sourceKind] || 0;
    const incomingPriority = priority[entry.sourceKind] || 0;
    if (incomingPriority > currentPriority) {
      byKey.set(key, {
        ...entry,
        assetFileTitleCandidates: sanitizeAssetCandidates([
          ...(existing.assetFileTitleCandidates || []),
          ...(entry.assetFileTitleCandidates || [])
        ])
      });
      return;
    }

    existing.assetFileTitleCandidates = sanitizeAssetCandidates([
      ...(existing.assetFileTitleCandidates || []),
      ...(entry.assetFileTitleCandidates || [])
    ]);
  });

  return sortCosmeticEntries([...byKey.values()]);
}

async function discoverCollectionPages(characterLookup, characters, characterSwapLookup, pageTitles = []) {
  console.log(`discover-cosmetics: collection pages=${pageTitles.length}`);
  const entries = [];
  const missingPages = [];
  const unmappedRows = [];
  const pagesWithoutRows = [];
  let parsedPages = 0;
  const progressEvery = 5;

  for (let index = 0; index < pageTitles.length; index += 1) {
    const pageTitle = pageTitles[index];
    let renderedHtml = '';
    try {
      renderedHtml = await fetchRenderedHtml(pageTitle);
    } catch (error) {
      if (/missingtitle/i.test(error.message)) {
        missingPages.push(pageTitle);
        continue;
      }
      throw error;
    }

    parsedPages += 1;
    const parsed = parseCollectionOutfitRows(renderedHtml, pageTitle, characterLookup, characters);
    if (!parsed.entries.length) pagesWithoutRows.push(pageTitle);

    parsed.entries.forEach((entry) => {
      const isCharacterSwapOutfit = entry.pieceType === 'Outfit'
        && characterSwapLookup.has(`${entry.baseCharacterId}::${normalizeKey(entry.name)}`);
      if (isCharacterSwapOutfit) return;
      entries.push(entry);
    });
    unmappedRows.push(...parsed.unmappedRows);

    const processed = index + 1;
    if (processed % progressEvery === 0 || processed === pageTitles.length) {
      console.log(
        `discover-cosmetics: collection pages ${processed}/${pageTitles.length} parsed=${parsedPages} rows=${entries.length} unmappedRows=${unmappedRows.length}`
      );
    }
  }

  return {
    entries: sortCosmeticEntries(entries),
    templateCount: pageTitles.length,
    parsedTemplates: parsedPages,
    missingTemplates: uniq(missingPages).sort(),
    unmappedTemplates: uniq(unmappedRows).sort(),
    templatesWithoutRows: uniq(pagesWithoutRows).sort()
  };
}

async function discoverCharacterTemplates(characterLookup, characters, characterSwapLookup, templateTitles = []) {
  console.log(`discover-cosmetics: character templates=${templateTitles.length}`);
  const entries = [];
  const missingTemplates = [];
  const unmappedTemplates = [];
  const templatesWithoutRows = [];
  let parsedTemplates = 0;
  const progressEvery = 25;

  for (let index = 0; index < templateTitles.length; index += 1) {
    const templateTitle = templateTitles[index];
    const templateInfo = parseCharacterCosmeticTemplateTitle(templateTitle);
    if (!templateInfo) continue;

    const baseCharacter = resolveCharacterFromLabel(templateInfo.ownerLabel, characterLookup, characters);
    if (!baseCharacter) {
      unmappedTemplates.push(templateTitle);
      continue;
    }

    let templateWikitext = '';
    try {
      templateWikitext = await fetchWikitext(templateTitle);
    } catch (error) {
      if (/missingtitle/.test(error.message)) {
        missingTemplates.push(templateTitle);
        continue;
      }
      throw error;
    }
    parsedTemplates += 1;
    const rows = parseTemplateRows(templateWikitext);
    if (!rows.length) {
      templatesWithoutRows.push(templateTitle);
      continue;
    }

    appendRowsToEntries(rows, {
      entries,
      templateTitle,
      bucketLabel: templateInfo.bucketLabel,
      baseCharacter,
      characterSwapLookup,
      sourceKind: 'wiki-template'
    });

    const processed = index + 1;
    if (processed % progressEvery === 0 || processed === templateTitles.length) {
      console.log(
        `discover-cosmetics: character templates ${processed}/${templateTitles.length} parsed=${parsedTemplates} rows=${entries.length} unmapped=${unmappedTemplates.length}`
      );
    }
  }

  return {
    entries: sortCosmeticEntries(entries),
    templateCount: templateTitles.length,
    parsedTemplates,
    missingTemplates: uniq(missingTemplates).sort(),
    unmappedTemplates: uniq(unmappedTemplates).sort(),
    templatesWithoutRows: uniq(templatesWithoutRows).sort()
  };
}

async function discoverFeaturedTemplates(characterLookup, characters, characterSwapLookup, templateTitles = []) {
  console.log(`discover-cosmetics: featured templates=${templateTitles.length}`);
  const entries = [];
  const missingTemplates = [];
  const unmappedRows = [];
  const templatesWithoutRows = [];
  let parsedTemplates = 0;
  const progressEvery = 10;

  for (let index = 0; index < templateTitles.length; index += 1) {
    const templateTitle = templateTitles[index];
    let templateWikitext = '';
    try {
      templateWikitext = await fetchWikitext(templateTitle);
    } catch (error) {
      if (/missingtitle/.test(error.message)) {
        missingTemplates.push(templateTitle);
        continue;
      }
      throw error;
    }

    parsedTemplates += 1;
    const rows = parseTemplateRows(templateWikitext);
    if (!rows.length) {
      templatesWithoutRows.push(templateTitle);
      continue;
    }

    const bucketLabel = templateBucketLabelFromTitle(templateTitle);
    rows.forEach((rowEntry) => {
      const baseCharacter = resolveCharacterFromRow(rowEntry.rowWikitext, characterLookup, characters);
      if (!baseCharacter) {
        unmappedRows.push(`${templateTitle}::${rowEntry.parsed.name}`);
        return;
      }
      appendRowsToEntries([rowEntry], {
        entries,
        templateTitle,
        bucketLabel,
        baseCharacter,
        characterSwapLookup,
        sourceKind: 'wiki-template-featured'
      });
    });

    const processed = index + 1;
    if (processed % progressEvery === 0 || processed === templateTitles.length) {
      console.log(
        `discover-cosmetics: featured templates ${processed}/${templateTitles.length} parsed=${parsedTemplates} rows=${entries.length} unmappedRows=${unmappedRows.length}`
      );
    }
  }

  return {
    entries: sortCosmeticEntries(entries),
    templateCount: templateTitles.length,
    parsedTemplates,
    missingTemplates: uniq(missingTemplates).sort(),
    unmappedTemplates: uniq(unmappedRows).sort(),
    templatesWithoutRows: uniq(templatesWithoutRows).sort()
  };
}

async function discoverRiftTemplates(characterLookup, characters, characterSwapLookup, templateTitles = []) {
  console.log(`discover-cosmetics: rift templates=${templateTitles.length}`);
  const entries = [];
  const missingTemplates = [];
  const unmappedSections = [];
  const templatesWithoutRows = [];
  let parsedTemplates = 0;
  const progressEvery = 10;

  for (let index = 0; index < templateTitles.length; index += 1) {
    const templateTitle = templateTitles[index];
    let templateWikitext = '';
    try {
      templateWikitext = await fetchWikitext(templateTitle);
    } catch (error) {
      if (/missingtitle/.test(error.message)) {
        missingTemplates.push(templateTitle);
        continue;
      }
      throw error;
    }

    parsedTemplates += 1;
    const sections = extractIconLinkSections(templateWikitext);
    if (!sections.length) {
      templatesWithoutRows.push(templateTitle);
      continue;
    }

    const bucketLabel = templateBucketLabelFromTitle(templateTitle);
    let sectionRowCount = 0;
    sections.forEach((section) => {
      const baseCharacter = resolveCharacterFromLabel(section.characterLabel, characterLookup, characters);
      if (!baseCharacter) {
        unmappedSections.push(`${templateTitle}::${section.characterLabel}`);
        return;
      }
      const rows = parseTemplateRows(section.sectionText);
      if (!rows.length) return;
      sectionRowCount += rows.length;
      appendRowsToEntries(rows, {
        entries,
        templateTitle,
        bucketLabel,
        baseCharacter,
        characterSwapLookup,
        sourceKind: 'wiki-template-rift'
      });
    });

    if (sectionRowCount === 0) {
      templatesWithoutRows.push(templateTitle);
    }

    const processed = index + 1;
    if (processed % progressEvery === 0 || processed === templateTitles.length) {
      console.log(
        `discover-cosmetics: rift templates ${processed}/${templateTitles.length} parsed=${parsedTemplates} rows=${entries.length} unmappedSections=${unmappedSections.length}`
      );
    }
  }

  return {
    entries: sortCosmeticEntries(entries),
    templateCount: templateTitles.length,
    parsedTemplates,
    missingTemplates: uniq(missingTemplates).sort(),
    unmappedTemplates: uniq(unmappedSections).sort(),
    templatesWithoutRows: uniq(templatesWithoutRows).sort()
  };
}

async function main() {
  console.log('discover-cosmetics: starting discovery run');
  const database = readJson(DATABASE_PATH);
  const characters = buildCharactersList(database);
  const characterLookup = buildCharacterLookup(database);
  const templateInventory = await fetchCosmeticsTemplateInventory();
  const collectionPages = await fetchLimitedCollectionPageTitles();
  console.log(
    `discover-cosmetics: inventory character=${templateInventory.characterTemplates.length} featured=${templateInventory.featuredTemplates.length} rift=${templateInventory.riftTemplates.length} collections=${collectionPages.length}`
  );

  const characterSwap = await discoverCharacterSwaps(characterLookup, characters);
  const characterSwapLookup = buildCharacterSwapLookup(characterSwap.entries);
  const characterCosmetics = await discoverCharacterTemplates(
    characterLookup,
    characters,
    characterSwapLookup,
    templateInventory.characterTemplates
  );
  const featuredCosmetics = await discoverFeaturedTemplates(
    characterLookup,
    characters,
    characterSwapLookup,
    templateInventory.featuredTemplates
  );
  const riftCosmetics = await discoverRiftTemplates(
    characterLookup,
    characters,
    characterSwapLookup,
    templateInventory.riftTemplates
  );
  const collectionCosmetics = await discoverCollectionPages(
    characterLookup,
    characters,
    characterSwapLookup,
    collectionPages
  );

  const mergedEntries = dedupeCosmeticEntries([
    ...characterCosmetics.entries,
    ...featuredCosmetics.entries,
    ...riftCosmetics.entries,
    ...collectionCosmetics.entries
  ]);

  const cosmetics = {
    entries: mergedEntries,
    templateCount: characterCosmetics.templateCount + featuredCosmetics.templateCount + riftCosmetics.templateCount + collectionCosmetics.templateCount,
    parsedTemplates: characterCosmetics.parsedTemplates + featuredCosmetics.parsedTemplates + riftCosmetics.parsedTemplates + collectionCosmetics.parsedTemplates,
    missingTemplates: uniq([
      ...characterCosmetics.missingTemplates,
      ...featuredCosmetics.missingTemplates,
      ...riftCosmetics.missingTemplates,
      ...collectionCosmetics.missingTemplates
    ]).sort(),
    unmappedTemplates: uniq([
      ...characterCosmetics.unmappedTemplates,
      ...featuredCosmetics.unmappedTemplates,
      ...riftCosmetics.unmappedTemplates,
      ...collectionCosmetics.unmappedTemplates
    ]).sort(),
    templatesWithoutRows: uniq([
      ...characterCosmetics.templatesWithoutRows,
      ...featuredCosmetics.templatesWithoutRows,
      ...riftCosmetics.templatesWithoutRows,
      ...collectionCosmetics.templatesWithoutRows
    ]).sort(),
    sourceBreakdown: {
      characterTemplates: characterCosmetics.entries.length,
      featuredTemplates: featuredCosmetics.entries.length,
      riftTemplates: riftCosmetics.entries.length,
      collectionPages: collectionCosmetics.entries.length
    }
  };

  const discovery = {
    generatedAt: new Date().toISOString(),
    sources: {
      characterSwapCategories: CHARACTER_SWAP_CATEGORIES.map((category) => ({ key: category.key, title: category.title })),
      templatePattern: [
        "Template:<Character>'s <Bucket> Cosmetics",
        'Template:<Name> Featured Cosmetics',
        'Template:*Rift*Cosmetics',
        '*Collection pages rendered outfit cards'
      ],
      templateCount: cosmetics.templateCount,
      parsedTemplateCount: cosmetics.parsedTemplates,
      missingTemplateCount: cosmetics.missingTemplates.length,
      unmappedTemplateCount: cosmetics.unmappedTemplates.length,
      sourceBreakdown: {
        characterTemplates: templateInventory.characterTemplates.length,
        featuredTemplates: templateInventory.featuredTemplates.length,
        riftTemplates: templateInventory.riftTemplates.length,
        collectionPages: collectionPages.length
      },
      extractedBreakdown: cosmetics.sourceBreakdown
    },
    stats: {
      characterSwapCandidates: characterSwap.entries.length,
      fullSetCandidates: cosmetics.entries.length,
      cosmeticCandidates: cosmetics.entries.length,
      templatesWithoutRows: cosmetics.templatesWithoutRows.length,
      ignoredTitles: characterSwap.ignored.length
    },
    ignoredTitles: characterSwap.ignored,
    missingTemplates: cosmetics.missingTemplates,
    unmappedTemplates: cosmetics.unmappedTemplates,
    templatesWithoutRows: cosmetics.templatesWithoutRows,
    characterSwaps: characterSwap.entries,
    fullSets: cosmetics.entries
  };

  writeJson(DISCOVERY_PATH, discovery);
  console.log(`discover-cosmetics: wrote ${DISCOVERY_PATH}`);
  console.log(`discover-cosmetics: characterSwaps=${characterSwap.entries.length} cosmetics=${cosmetics.entries.length}`);
}

main().catch((error) => {
  console.error(`discover-cosmetics: ${error.message}`);
  process.exit(1);
});
