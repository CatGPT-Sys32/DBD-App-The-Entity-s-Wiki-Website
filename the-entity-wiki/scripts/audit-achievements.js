#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'web', 'index.html');
const WIKI_API_URL = 'https://deadbydaylight.wiki.gg/api.php';

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; audit-achievements/1.0)' } }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`status ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      });
    } catch (error) {
      reject(error);
      return;
    }
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
  });
}

async function fetchWikiAchievementPages() {
  const titles = [];
  let continueToken = null;
  for (let page = 0; page < 20; page += 1) {
    const apiUrl = new URL(WIKI_API_URL);
    apiUrl.searchParams.set('action', 'query');
    apiUrl.searchParams.set('list', 'categorymembers');
    apiUrl.searchParams.set('cmtitle', 'Category:Achievements');
    apiUrl.searchParams.set('cmlimit', '500');
    apiUrl.searchParams.set('format', 'json');
    if (continueToken) apiUrl.searchParams.set('cmcontinue', continueToken);
    const payload = await fetchJson(apiUrl.toString());
    for (const member of payload?.query?.categorymembers || []) {
      if (member?.ns === 0) titles.push(member.title);
    }
    continueToken = payload?.continue?.cmcontinue;
    if (!continueToken) break;
  }
  return titles;
}

function main() {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const ids = [...html.matchAll(/id:\s*'ach_(\d+)'/g)].map((match) => Number(match[1]));
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const duplicates = ids.length - unique.length;
  const max = unique.length ? unique[unique.length - 1] : 0;
  const holes = [];
  for (let n = 1; n <= max; n += 1) {
    if (!unique.includes(n)) holes.push(n);
  }

  console.log(`audit-achievements: total=${ids.length} unique=${unique.length} range=1..${max}`);
  console.log(`audit-achievements: duplicates=${duplicates}`);
  console.log(`audit-achievements: numbering holes (${holes.length}): ${holes.length ? holes.join(', ') : 'none'}`);

  if (process.argv.includes('--fetch-wiki')) {
    fetchWikiAchievementPages().then(
      (titles) => {
        console.log(`audit-achievements: wiki.gg Category:Achievements pages=${titles.length} (compare manually against the in-app list)`);
      },
      (error) => {
        console.warn(`audit-achievements: wiki fetch skipped (${error.message})`);
      }
    );
  }
}

main();
