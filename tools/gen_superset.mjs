#!/usr/bin/env node
/**
 * gen_superset.mjs - standalone Node port of the Gies Cloudflare Worker's
 * static-site "superset" generation (EXCLUDING /index.html and /img/ covers,
 * which are owned by another task).
 *
 * FAITHFUL REPRODUCTION: render functions, template strings, regexes, and
 * constants are copied verbatim from src/index.ts (Cloudflare Worker), with only
 * TypeScript type annotations removed. The Cloudflare plumbing (R2 two-phase,
 * KV, ScheduledEvent, subrequest counter) is replaced by Node built-ins.
 *
 * Node built-ins ONLY. No npm packages, no node_modules. Node 20+ (global fetch,
 * node:crypto, node:fs, node:path, node:os).
 *
 * Modes:
 *   (default)   DRY-RUN: generate into OUT_DIR, write files, print summary. No Netlify calls.
 *   --deploy    generate + deployManifestMerge() to Netlify.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ---------- config ----------

const SUBSTACK_FEED = 'https://giesweekly.substack.com/feed';
const SITE_ORIGIN = 'https://giesweekly.com';
const YT_CHANNEL_ID = 'UChHK6Jz-6cpZc_RrMAbGdTA';
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || '32bd51d3-9349-4db5-88bd-4b7dc87eb2a3';

// Shared site nav (2026-10-13): same markup as the homepage, /watch/ and /archives/.
// Styling comes from /css/chrome.css, which every generated page loads LAST so it
// overrides the page's inline nav rules (the inline rules turned the Subscribe text
// grey and stopped the links wrapping on phones).
const CHROME_CSS = '<link rel="stylesheet" href="/css/chrome.css?v=8">';
const NAV_ITEMS = [
  ['home', '/', 'Home'],
  ['this-week', '/this-week/', 'This Week'],
  ['watch', '/watch/', 'Watch'],
  ['name-your-game', '/name-your-game/', 'Name Your Game'],
  ['its-in-the-name', '/its-in-the-name/', "It's in the name"],
  ['about', '/about/', 'About'],
  ['archives', '/archives/', 'Archives'],
];
// /this-week/ cards hotlink full-size publisher images (1-1.2 MB each). Serve a
// 720px WebP through wsrv.nl instead (measured 2.4 MB -> 375 KB for one week).
// The original URL stays first in the data-fb fallback chain, so if wsrv.nl is
// down twStep() loads the publisher image as before.
function twResize(u) {
  if (!/^https?:\/\//i.test(u)) return u;
  return `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=720&output=webp&q=75`;
}

function siteNav(active) {
  const links = NAV_ITEMS.map(([key, href, label]) =>
    `<a href="${href}"${key === active ? ' class="active"' : ''}>${label}</a>`).join('');
  return `<nav><div class="nav-inner"><a href="/" class="brand"><img src="/img/gies-wordmark.png" alt="Gies" class="brand-logo"></a><div class="nav-links">${links}<a class="nav-cta" href="https://giesweekly.substack.com/subscribe" target="_blank" rel="noopener">Subscribe</a></div></div></nav>`;
}
const NETLIFY_PAT = process.env.NETLIFY_PAT || '';

// Browser-like headers for Substack fetches (verbatim from worker).
const SUBSTACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://giesweekly.substack.com/',
};

const N_ARCHIVE = 150;
const N_RECENT = 5;
const N_ITEMLIST = 150;
const MAX_OG_FETCH = 25;

// ---------- per-issue GIES analysis (giesweekly.com only) ----------
// NOT a faithful reproduction of the worker. Added 2026-07-26.
// Optional editorial layer that exists only on giesweekly.com and never on
// Substack, so the mirror stops being a duplicate of the Substack post and
// carries something a link aggregator cannot supply.
// Shape: { "<issue-slug>": "<paragraph(s) of plain text or inline HTML>" }
// Missing file or missing key renders nothing, so this is safe to ship empty.
const ANALYSIS = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./analysis.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
})();

// ---------- helpers (verbatim) ----------

function extractAll(s, re) {
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1]);
  return out;
}
function extractFirst(s, re) {
  const m = s.match(re);
  return m ? m[1] : '';
}
function clean(s) {
  return s.replace(/\s+/g, ' ').trim();
}
function cleanVideoDescription(raw, isShort) {
  if (!raw) {
    return isShort
      ? 'Gies Short. Gaming industry analysis for executives, investors, and senior analysts.'
      : 'Gies Weekly podcast. Gaming industry analysis for executives, investors, and senior analysts.';
  }
  let s = raw;
  // Strip boilerplate signature
  s = s.replace(/Weekly intelligence on the games industry[\s\S]*?giesweekly\.substack\.com/gi, '');
  // Strip URLs and bare domains
  s = s.replace(/https?:\/\/\S+/g, '').replace(/\b\S+\.(com|substack\.com|net|org|io)\S*/gi, '');
  // Strip hashtags
  s = s.replace(/#\w+/g, '');
  // Strip chapter timestamps like "03:01 Exploring..."
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b[^\n]*/g, '');
  // Strip "keywords:" sections
  s = s.replace(/\bkeywords?\b[\s\S]*$/i, '');
  // Replace em/en dashes per project rule (no em dashes in any Gies output)
  s = s.replace(/[—–]/g, '. ');
  // Decode common HTML entities
  s = s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Truncate
  if (s.length > 200) {
    s = s.slice(0, 197).replace(/\s+\S*$/, '') + '...';
  }
  if (!s) {
    return isShort
      ? 'Gies Short. Gaming industry analysis for executives, investors, and senior analysts.'
      : 'Gies Weekly podcast. Gaming industry analysis for executives, investors, and senior analysts.';
  }
  return s;
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
}
function parseRfc2822(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}
function jsonEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function formatDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function shortTitleForLlms(t) {
  // Take primary topic before "|", trim to 90 chars max
  const primary = t.split('|')[0].trim();
  return primary.length > 90 ? primary.slice(0, 87) + '...' : primary;
}

// ---------- issue assembly (verbatim) ----------

function parseRssIssues(xml) {
  const items = extractAll(xml, /<item>([\s\S]*?)<\/item>/g);
  const issues = [];
  for (const block of items) {
    const title = clean(extractFirst(block, /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/));
    const subtitle = clean(extractFirst(block, /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/));
    const url = clean(extractFirst(block, /<link>([\s\S]*?)<\/link>/));
    const pubDate = extractFirst(block, /<pubDate>([\s\S]*?)<\/pubDate>/);
    const enclosure = extractFirst(block, /<enclosure[^>]+url="([^"]+)"[^>]+type="image\//);

    if (!title || !url) continue;

    const date = parseRfc2822(pubDate);
    const contentHtml = extractFirst(block, /<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/);
    let coverUrl = enclosure;
    if (!coverUrl) {
      const im = contentHtml.match(/<img[^>]+src="([^"]+)"/);
      if (im) coverUrl = im[1];
    }
    const slugMatch = url.match(/\/p\/([a-z0-9\-]+)/);
    const slug = slugMatch ? slugMatch[1] : '';

    issues.push(buildIssue({ title, subtitle, url, date, coverUrl, slug, contentHtml }));
  }
  issues.sort((a, b) => (b.date || '0').localeCompare(a.date || '0'));
  return issues.slice(0, N_ARCHIVE);
}

// Confirmed typos in the Substack subtitle. post_date stays authoritative; these are
// silenced so the sanity check below only fires on NEW drift.
// steam-controller-breaks-steam-roblox: published 2026-05-08, subtitle reads "GIES W20",
// correct value is W18. Verified 2026-07-31 against all 20 feed issues; every other
// issue matches computeWeekFromDate exactly, so this one is an isolated upstream typo.
const KNOWN_W_TYPOS = {
  'steam-controller-breaks-steam-roblox': 20,
};

function buildIssue(raw) {
  const { title, subtitle, url, date, coverUrl, slug, contentHtml } = raw;

  const isTakeaway = /monthly\s*takeaway/i.test(title + ' ' + subtitle) ||
                     url.includes('/monthly-takeaway') || url.includes('/gies-monthly-takeaway');
  const isSpecial = /special\s*report/i.test(title + ' ' + subtitle) || url.includes('/gies-special');

  let week = '';
  if (isTakeaway) {
    week = 'Monthly';
  } else if (isSpecial) {
    week = 'Special';
  } else if (date) {
    // Authoritative: compute Sunday-week-of-year from post_date.
    const w = computeWeekFromDate(date);
    week = `W${String(w).padStart(2, '0')}`;
    // Sanity check: warn if Substack subtitle disagrees by more than 1 (catches typos like W20 vs W18).
    const subM = subtitle.match(/\b[Gg]?[Ii]?[Ee]?[Ss]?\s*W(\d{1,2})\b/);
    if (subM) {
      const subW = Number(subM[1]);
      if (Math.abs(subW - w) > 1 && KNOWN_W_TYPOS[slug] !== subW) {
        console.warn(`W mismatch for ${slug}: subtitle says W${subW}, post_date says W${w}. Using W${w}.`);
      }
    }
  }

  const titleParts = title.split('|').map(p => p.trim()).filter(Boolean);
  let shortTitle = titleParts[0] || title;
  if (shortTitle.length > 90) {
    shortTitle = shortTitle.slice(0, 87).replace(/\s+\S*$/, '') + '…';
  }
  const secondaryTopics = titleParts.slice(1);

  return {
    title, shortTitle, secondaryTopics, url, date,
    dateShort: shortDate(date),
    year: (date || '').slice(0, 4),
    coverUrl,
    isTakeaway, isSpecial,
    week,
    slug,
    contentHtml,
  };
}

function computeWeekFromDate(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  if (isNaN(d.getTime())) return 0;
  const year = d.getUTCFullYear();
  // First Sunday of the year
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dow = jan1.getUTCDay(); // 0=Sun..6=Sat
  const firstSunday = new Date(Date.UTC(year, 0, 1 + ((7 - dow) % 7)));
  if (d < firstSunday) return 0;
  const diffDays = Math.floor((d.getTime() - firstSunday.getTime()) / 86400000);
  return Math.floor(diffDays / 7) + 1;
}

// ---------- substack fetch (Node I/O; retry/backoff kept, no archive fallback) ----------

async function fetchSubstackIssues() {
  const backoffs = [0, 2000, 8000, 20000]; // index 0 = no wait on first attempt
  let lastErr = null;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt] > 0) await sleep(backoffs[attempt]);
    try {
      const r = await fetch(SUBSTACK_FEED, { headers: SUBSTACK_HEADERS });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error(`substack rss ${r.status} on attempt ${attempt + 1}`);
        console.warn(lastErr.message);
        continue;
      }
      if (!r.ok) throw new Error(`substack rss ${r.status}`);
      const xml = await r.text();
      const issues = parseRssIssues(xml);
      if (issues.length === 0) {
        lastErr = new Error('rss parsed 0 issues');
        console.warn(lastErr.message);
        continue;
      }
      return issues;
    } catch (e) {
      lastErr = e;
      console.warn(`rss attempt ${attempt + 1} threw: ${e?.message || e}`);
    }
  }
  throw new Error(`substack rss failed after ${backoffs.length} attempts: ${lastErr?.message || lastErr}`);
}

// ---------- youtube (verbatim, global fetch) ----------

async function fetchYouTubeVideos(channelId) {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!r.ok) throw new Error(`youtube rss ${r.status}`);
  const xml = await r.text();
  const items = extractAll(xml, /<entry>([\s\S]*?)<\/entry>/g);
  const videos = [];
  for (const block of items) {
    const id = extractFirst(block, /<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
    // Decode HTML entities from RSS <title> BEFORE later esc() pass to avoid
    // double-encoding (e.g. "&amp;" -> "&amp;amp;") in rendered HTML. 2026-05-16.
    const title = decodeEntities(clean(extractFirst(block, /<title>([\s\S]*?)<\/title>/)));
    if (!id || !title) continue;
    const isShort = /#shorts?/i.test(block) || /\/shorts\//i.test(block);
    const publishedAt = clean(extractFirst(block, /<published>([\s\S]*?)<\/published>/));
    const description = cleanVideoDescription(
      extractFirst(block, /<media:description>([\s\S]*?)<\/media:description>/),
      isShort
    );
    videos.push({
      id,
      title,
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      isShort,
      publishedAt,
      description,
    });
    if (videos.length >= 5) break;
  }
  return videos;
}

// ---------- video schema (verbatim; supporting helper) ----------

function renderVideoSchema(v) {
  const obj = {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: decodeEntities(v.title),
    description: v.description,
    thumbnailUrl: [
      `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    ],
    contentUrl: v.url,
    embedUrl: `https://www.youtube.com/embed/${v.id}`,
    publisher: { '@id': 'https://giesweekly.com/#organization' },
  };
  if (v.publishedAt) obj.uploadDate = v.publishedAt;
  return `    <script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n    </script>`;
}

// ---------- archive marker (verbatim) ----------

function renderArchive(issues) {
  const byYear = {};
  for (const iss of issues) {
    if (!iss.year) continue;
    (byYear[iss.year] ||= []).push(iss);
  }
  const blocks = [];
  for (const year of Object.keys(byYear).sort().reverse()) {
    const items = byYear[year];
    let meta = `${items.length} issue${items.length === 1 ? '' : 's'}`;
    if (year === '2024') meta = `Inaugural year &middot; ${meta}`;
    const rows = [];
    for (const iss of items) {
      let klass = 'row';
      if (iss.isTakeaway) klass += ' is-takeaway';
      if (iss.isSpecial) klass += ' is-special';
      rows.push(
        `<div class="${klass}"><span class="week">${esc(iss.week)}</span>` +
        `<a class="title" href="${esc(iss.url)}">${esc(iss.title || iss.shortTitle)}</a>` +
        `<span class="date">${iss.date}</span></div>`
      );
    }
    blocks.push(
      `<div class="year-head"><h2>${year}</h2><span class="year-meta">${meta}</span></div>\n` +
      `<div class="issues">\n${rows.join('\n')}\n</div>`
    );
  }
  return blocks.join('\n\n');
}

function replaceMarker(html, key, inner) {
  const re = new RegExp(`(<!-- AUTO:${key} -->)([\\s\\S]*?)(<!-- /AUTO:${key} -->)`);
  if (!re.test(html)) {
    console.warn(`[replaceMarker] AUTO:${key} not found, skipping. Live HTML may be truncated upstream.`);
    return { html, replaced: false };
  }
  // Callback form so $1/$2/$3 inside `inner` (e.g. "$2.99") are NOT interpreted as backrefs.
  const newHtml = html.replace(re, (_match, open, _mid, close) => `${open}\n${inner}\n${close}`);
  return { html: newHtml, replaced: true };
}

// ---------- This Week page (verbatim) ----------

// Names treated as platform/developer/publisher (tier 3) rather than a game title (tier 2).
const TW_PLATFORM_PUBLISHERS = new Set([
  'xbox', 'playstation', 'sony', 'nintendo', 'microsoft', 'ubisoft', 'ea', 'electronic arts',
  'square enix', 'bungie', 'remedy', 'remedy entertainment', 'activision', 'blizzard',
  'bandai namco', 'sega', 'capcom', 'valve', 'epic games', 'epic', 'cd projekt', 'cd projekt red',
  'take-two', 'take two', 'rockstar', 'rockstar games', 'fifa',
]);
// Sources observed to block image hotlinking in-browser; they get a Wikipedia fallback
// resolved even when their og:image was fetched server-side. 2026-06-01.
const TW_FLAKY_DOMAINS = new Set([
  'variety.com', 'rpgsite.net', 'kotaku.com', 'theguardian.com', 'gamesindustry.biz', 'bloomberg.com',
]);
// Disambiguation: titles whose bare Wikipedia page is NOT the game (e.g. "Fable"
// resolves to the literary fable). Map to the correct video-game article.
const TW_WIKI_ALIAS = {
  'fable': 'Fable (2025 video game)',
};

function twStripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function twKeyword(text) {
  const t = text.toLowerCase();
  if (/gambl|casino|loot[\s-]?box|betting|wager|\bslot\b|microtransaction/.test(t)) return 'gambling';
  if (/\bai\b|artificial intelligence|machine learning|generative|\bllm\b/.test(t)) return 'ai';
  if (/esports|tournament|\bmajor\b|championship|grand final/.test(t)) return 'esports';
  if (/layoff|acquir|merger|funding|revenue|\bipo\b|earnings|invest|billion/.test(t)) return 'business';
  return 'game';
}

function parseTwItem(frag) {
  const urlM = frag.match(/href="([^"]+)"/);
  if (!urlM) return null;
  const url = urlM[1];
  if (!/^https?:\/\//i.test(url)) return null;
  const headline = twStripTags(frag);
  if (!headline) return null;
  const strongs = extractAll(frag, /<strong>([\s\S]*?)<\/strong>/g).map(twStripTags).filter(Boolean);
  // Quoted titles in a headline are almost always game names ('Destiny 2').
  const quoted = [];
  const qre = /[‘'"“]([A-Z0-9][^‘'"”“]{1,40}?)[’'"”]/g;
  let qm;
  while ((qm = qre.exec(headline)) !== null) quoted.push(qm[1].trim());
  const entity = (strongs[0] || headline.split(/[\s:,]/)[0] || headline).slice(0, 70);
  const isPlat = (s) => TW_PLATFORM_PUBLISHERS.has(s.toLowerCase());
  // Tier 2 (game): first quoted title or strong entity that is not a platform/publisher.
  const game = quoted.find(q => !isPlat(q)) || strongs.find(s => !isPlat(s)) || '';
  // Tier 3 (platform/dev/pub): first strong entity that is a platform/publisher.
  const company = strongs.find(s => isPlat(s)) || '';
  let wikiQuery = (game || company || entity).slice(0, 80);
  wikiQuery = TW_WIKI_ALIAS[wikiQuery.toLowerCase()] || wikiQuery;
  return { headline, url, entity, kw: twKeyword(headline + ' ' + entity), og: '', wikiQuery, company: company.slice(0, 80), fallback: '' };
}

function parseThisWeek(contentHtml) {
  const sections = [];
  // Highlights = the lead blockquote's <p> items
  const bq = contentHtml.match(/<blockquote>([\s\S]*?)<\/blockquote>/);
  if (bq) {
    const items = [];
    for (const p of extractAll(bq[1], /<p>([\s\S]*?)<\/p>/g)) {
      const it = parseTwItem(p);
      if (it) items.push(it);
    }
    if (items.length) sections.push({ name: 'Highlights', items });
  }
  // <h3>Section</h3> <ul> ... </ul>
  const secRe = /<h3>([^<]+)<\/h3>\s*<ul>([\s\S]*?)<\/ul>/g;
  let m;
  while ((m = secRe.exec(contentHtml)) !== null) {
    const name = twStripTags(m[1]);
    const items = [];
    for (const li of extractAll(m[2], /<li>([\s\S]*?)<\/li>/g)) {
      const it = parseTwItem(li);
      if (it) items.push(it);
    }
    if (items.length) sections.push({ name, items });
  }
  return sections;
}

async function resolveOgImages(sections, budget) {
  if (budget <= 0) return 0;
  const all = [];
  for (const s of sections) for (const it of s.items) all.push(it);
  let fetched = 0;
  const UA = 'Mozilla/5.0 (compatible; GiesBot/1.0; +https://giesweekly.com)';
  const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // Pass 1: the article's own og:image (the publisher's chosen hero, which for gaming
  // press is the game's key art or a screenshot). Skip Reddit: its og is a generic
  // subreddit/preview image, so those cards go straight to the game/platform art.
  const ogTargets = all.filter(it => domainOf(it.url) !== 'reddit.com').slice(0, budget);
  await Promise.allSettled(ogTargets.map(async it => {
    fetched++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(it.url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
      clearTimeout(timer);
      if (!r.ok) return;
      // og:image lives in <head>; scan only the first 40KB to bound CPU/memory.
      const html = (await r.text()).slice(0, 40000);
      const om = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (om && /^https?:\/\//i.test(om[1])) it.og = decodeEntities(om[1]);
    } catch { /* fall through to Wikipedia */ }
  }));

  // Pass 2: resolve a Wikipedia fallback image (it.fallback) per the agreed hierarchy
  // (tier 2 game box art, else tier 3 platform/publisher logo). This sits behind the
  // source image so a card whose og is missing OR blocks hotlinking in the browser
  // still shows a relevant picture instead of a text tile. Server-side, so no CSP/CORS.
  // Prioritise cards that need it most (no og, or a known hotlink-blocking source) and
  // cap the count to protect the free-plan subrequest budget.
  const priority = (it) => (!it.og ? 0 : (TW_FLAKY_DOMAINS.has(domainOf(it.url)) ? 1 : 2));
  const wikiTargets = all
    .filter(it => it.wikiQuery)
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, 12);
  // Wikipedia's JSON API returns empty to server-side fetches, but the article page
  // serves fine and carries the lead image as og:image in its <head>. Fetch the page
  // with a browser UA and reuse the same og:image extraction. The lead image is the
  // game's box art / key art, or the company/platform logo.
  const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  await Promise.allSettled(wikiTargets.map(async it => {
    // Try the game title first, then the platform/publisher (tier 3) when the game
    // has no usable Wikipedia lead image (e.g. Dragon Quest -> Square Enix).
    const candidates = [it.wikiQuery];
    if (it.company && it.company.toLowerCase() !== it.wikiQuery.toLowerCase()) candidates.push(it.company);
    for (const title of candidates) {
      if (it.fallback) break;
      fetched++;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(
          `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
          { signal: ctrl.signal, headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html', 'Range': 'bytes=0-49152' } }
        );
        clearTimeout(timer);
        if (!r.ok) continue;
        const html = (await r.text()).slice(0, 40000);
        const om = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (om && /^https?:\/\//i.test(om[1])) it.fallback = decodeEntities(om[1]);
      } catch { /* try next candidate, else branded tile */ }
    }
  }));
  return fetched;
}

function renderThisWeekPage(iss, sections) {
  const dateLong = formatDateLong(iss.date);
  const week = iss.week || 'Latest';
  const fullTitle = (iss.title || iss.shortTitle || '').slice(0, 200);
  const all = [];
  for (const s of sections) for (const it of s.items) all.push(it);

  const card = (it) => {
    let host = '';
    try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
    // Image cascade: tier1 source og, then tier2/3 Wikipedia game/platform art, then a
    // clean source tile. The browser steps to the next candidate if one fails to load.
    const cands = [it.og, it.fallback].filter(Boolean);
    const thumb = cands.length
      ? `<img class="tw-img" loading="lazy" decoding="async" alt="" src="${esc(twResize(cands[0]))}" data-src="${esc(host)}" data-fb="${esc(JSON.stringify(twResize(cands[0]) === cands[0] ? cands.slice(1) : cands))}" onload="twBg(this)" onerror="twStep(this)">`
      : `<div class="tw-ph"><img src="/img/gies-wordmark.png" alt="Gies" class="tw-ph-logo" loading="lazy"><span>${esc(host)}</span></div>`;
    return `<a class="tw-card" href="${esc(it.url)}" target="_blank" rel="noopener">`
      + `<div class="tw-thumb">${thumb}</div>`
      + `<div class="tw-cardbody"><span class="tw-src"><span class="tw-dot"></span>${esc(host)}</span>`
      + `<span class="tw-head">${esc(it.headline)}</span></div></a>`;
  };
  const sectionsHtml = sections.map(s => {
    const feat = /highlight/i.test(s.name) ? ' tw-sec-feature' : '';
    return `<section class="tw-sec${feat}"><div class="tw-sec-h"><h2>${esc(s.name)}</h2><span class="tw-rule"></span><span class="tw-count">${s.items.length}</span></div>`
      + `<div class="tw-grid">${s.items.map(card).join('')}</div></section>`;
  }).join('\n');

  const itemListElements = all.map((it, i) => `{"@type":"ListItem","position":${i + 1},"url":${JSON.stringify(it.url)},"name":${JSON.stringify(it.headline)}}`).join(',');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>This Week in Games - ${esc(week)} ${esc(iss.year)} | Gies</title>
<meta name="description" content="Every source behind this week's Gies, ${esc(fullTitle)}. The week in games at a glance.">
<link rel="canonical" href="https://giesweekly.com/this-week/">
<meta property="og:title" content="This Week in Games - ${esc(week)} ${esc(iss.year)} | Gies">
<meta property="og:description" content="Every source behind this week's Gies issue, grouped and at a glance.">
<meta property="og:url" content="https://giesweekly.com/this-week/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Gies">
<meta property="og:image" content="https://giesweekly.com/img/og-image.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/x-icon" href="/img/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--bg-card:#161616;--border:#1f1f1f;--border-mid:#2a2a2a;--border-strong:#3a3a3a;--text:#fff;--text-dim:#b8b8b8;--text-mute:#7a7a7a;--red:#ED1C24;--red-dark:#c8141b;--sans:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif}
html{font-size:16px;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
nav{position:sticky;top:0;z-index:100;background:rgba(10,10,10,0.85);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
nav .nav-inner{max-width:1180px;margin:0 auto;padding:0.85rem 1.75rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem}
nav .brand{font-weight:700;font-size:1.05rem;display:inline-flex;align-items:center;gap:0.6rem}
nav .brand-logo{height:32px;width:auto}
nav .nav-links{display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap}
nav .nav-links a{font-size:0.74rem;color:var(--text-mute);font-weight:500;letter-spacing:0.08em;text-transform:uppercase}
nav .nav-links a:hover,nav .nav-links a.active{color:var(--text)}
nav .nav-cta{font-size:0.74rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#fff;background:var(--red);padding:0.6rem 1.15rem;border-radius:999px}
nav .nav-cta:hover{background:var(--red-dark)}
header.tw-head{max-width:1180px;margin:0 auto;padding:3rem 1.75rem 1rem}
.tw-crumb{font-family:'SF Mono',Menlo,monospace;font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-mute);margin-bottom:1.25rem}
.tw-crumb a{color:var(--text-mute);border-bottom:1px solid var(--border-strong)}
.tw-crumb a:hover{color:var(--red)}
header.tw-head h1{font-weight:700;font-size:clamp(1.9rem,3.6vw,2.7rem);line-height:1.12;letter-spacing:-0.02em;margin-bottom:0.85rem}
.tw-meta{font-family:'SF Mono',Menlo,monospace;font-size:0.74rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mute);display:flex;gap:0.6rem;flex-wrap:wrap;align-items:center}
.tw-meta .pill{background:var(--bg-card);border:1px solid var(--border-strong);padding:0.3rem 0.7rem;border-radius:999px}
.tw-meta .pill.red{color:var(--red);border-color:var(--red)}
.tw-meta a{color:var(--red);border-bottom:1px solid currentColor}
main.tw-main{max-width:1180px;margin:0 auto;padding:1.5rem 1.75rem 3rem}
.tw-sec{margin-top:2.4rem}
.tw-sec-h{display:flex;align-items:center;gap:0.9rem;margin-bottom:1.1rem}
.tw-sec-h h2{font-size:0.8rem;text-transform:uppercase;letter-spacing:0.14em;color:var(--red);font-weight:700;margin:0}
.tw-sec-h .tw-rule{flex:1;height:1px;background:var(--border-mid)}
.tw-sec-h .tw-count{color:var(--text-mute);font-size:0.75rem;font-family:'SF Mono',Menlo,monospace}
.tw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:1.1rem}
.tw-card{background:var(--bg-card);border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s,transform .15s}
.tw-card:hover{border-color:var(--red);transform:translateY(-2px)}
.tw-thumb{position:relative;aspect-ratio:16/9;background:#0d0d0f;overflow:hidden}
.tw-thumb::before{content:"";position:absolute;inset:0;background-image:var(--tw-bg,none);background-size:cover;background-position:center;filter:blur(22px) brightness(0.45) saturate(1.1);transform:scale(1.25);z-index:0}
.tw-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;z-index:1}
.tw-ph{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:14px;background:radial-gradient(130% 130% at 0% 0%,#26282c 0%,#141517 70%)}
.tw-ph-logo{height:30px;width:auto;opacity:0.9}
.tw-ph span{font-weight:700;font-size:0.74rem;letter-spacing:0.04em;color:#9aa0a6;text-transform:uppercase;font-family:'SF Mono',Menlo,monospace}
.tw-cardbody{padding:0.8rem 0.9rem 0.95rem;display:flex;flex-direction:column;gap:0.5rem;flex:1}
.tw-src{display:inline-flex;align-items:center;gap:0.45rem;font-size:0.68rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;font-family:'SF Mono',Menlo,monospace}
.tw-src .tw-dot{width:5px;height:5px;border-radius:50%;background:var(--red)}
.tw-head{font-size:0.94rem;line-height:1.32;font-weight:500;color:var(--text-dim)}
.tw-card:hover .tw-head{color:var(--text)}
/* Featured Highlights: hero row — taller images, big headlines, red accent bar. */
.tw-sec-feature{margin-top:1.5rem;margin-bottom:3rem}
.tw-sec-feature .tw-sec-h{margin-bottom:1.4rem}
.tw-sec-feature .tw-sec-h h2{font-size:1.15rem;letter-spacing:0.12em;color:#fff;display:inline-flex;align-items:center;gap:0.6rem}
.tw-sec-feature .tw-sec-h h2::before{content:"";width:13px;height:13px;background:var(--red);border-radius:3px;box-shadow:0 0 14px rgba(237,28,36,0.7)}
.tw-sec-feature .tw-grid{grid-template-columns:repeat(3,1fr);gap:1.4rem}
@media(max-width:760px){.tw-sec-feature .tw-grid{grid-template-columns:1fr}}
.tw-sec-feature .tw-card{border:2px solid var(--red);border-radius:14px;padding:4px;box-shadow:0 0 18px rgba(237,28,36,0.12)}
.tw-sec-feature .tw-card:hover{box-shadow:0 0 0 1px var(--red),0 16px 38px rgba(0,0,0,0.5)}
.tw-sec-feature .tw-thumb{border-radius:10px}
.tw-sec-feature .tw-head{font-size:1.08rem;line-height:1.3;font-weight:600;color:var(--text)}
.tw-sec-feature .tw-src{font-size:0.72rem;color:var(--red)}
.tw-foot-cta{max-width:1180px;margin:2rem auto 0;padding:1.5rem 1.75rem;display:flex;justify-content:space-between;align-items:center;gap:1.25rem;flex-wrap:wrap;background:linear-gradient(180deg,#160606,#0e0303);border:1px solid var(--border-strong);border-left:3px solid var(--red);border-radius:14px}
.tw-foot-cta h3{font-size:1.1rem;margin:0 0 0.3rem}
.tw-foot-cta p{margin:0;color:var(--text-dim);font-size:0.9rem}
.tw-foot-cta a.btn{background:var(--red);color:#fff;padding:0.8rem 1.4rem;font-weight:600;border-radius:999px;font-size:0.9rem;white-space:nowrap}
.tw-foot-cta a.btn:hover{background:var(--red-dark)}
footer{margin-top:3rem;border-top:1px solid var(--border-mid);background:#070707}
footer .ft-bottom{max-width:1180px;margin:0 auto;padding:1.5rem 1.75rem;display:flex;justify-content:space-between;font-family:'SF Mono',Menlo,monospace;font-size:0.7rem;letter-spacing:0.1em;color:var(--text-mute);text-transform:uppercase;flex-wrap:wrap;gap:0.5rem}
footer .ft-bottom a{color:var(--text-mute)}
footer .ft-bottom a:hover{color:var(--red)}
@media(max-width:640px){header.tw-head{padding:2rem 1.25rem 1rem}main.tw-main{padding:1.25rem 1.25rem 2rem}}
</style>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"CollectionPage","name":"This Week in Games - Gies","url":"https://giesweekly.com/this-week/","isPartOf":{"@type":"WebSite","url":"https://giesweekly.com/"},"about":"Curated sources behind the latest Gies weekly issue","mainEntity":{"@type":"ItemList","numberOfItems":${all.length},"itemListElement":[${itemListElements}]}}
</script>
${CHROME_CSS}
</head>
<body>
${siteNav('this-week')}
<header class="tw-head">
  <div class="tw-crumb"><a href="/">Home</a> &nbsp;/&nbsp; This Week</div>
  <h1>This Week in Games</h1>
  <div class="tw-meta"><span class="pill red">${esc(week)}</span><span class="pill">${esc(dateLong)}</span><span class="pill">${all.length} sources</span><a href="${esc(iss.url)}" target="_blank" rel="noopener">Read the full issue &rarr;</a></div>
</header>
<main class="tw-main">
${sectionsHtml}
<div class="tw-foot-cta"><div><h3>Get the full breakdown every Friday</h3><p>Gies turns the week's gaming-industry signal into a 5-minute executive read. Free.</p></div><a class="btn" href="https://giesweekly.substack.com/subscribe" target="_blank" rel="noopener">Subscribe &rarr;</a></div>
</main>
<footer><div class="ft-bottom"><span>&copy; 2024-2026 Gies. Games Industry Executive Summary.</span><span><a href="/">Home</a> &middot; <a href="/this-week/">This Week</a> &middot; <a href="/archives/">Archives</a> &middot; <a href="/authors/">Authors</a> &middot; <a href="https://giesweekly.substack.com">Substack</a></span></div></footer>
<script>
// Server-side resolution put an ordered candidate list on each card (source image,
// then Wikipedia game/platform art). On a load failure, step to the next candidate;
// when none remain, swap to a clean source-name tile.
function twPlace(img){var s=img.getAttribute('data-src')||'';if(img.parentNode){img.parentNode.style.removeProperty('--tw-bg');var d=document.createElement('div');d.className='tw-ph';var lg=document.createElement('img');lg.src='/img/gies-wordmark.png';lg.alt='Gies';lg.className='tw-ph-logo';d.appendChild(lg);var sp=document.createElement('span');sp.textContent=s;d.appendChild(sp);img.parentNode.replaceChild(d,img);}}
function twBg(img){try{var u=img.currentSrc||img.src;if(u&&img.parentNode)img.parentNode.style.setProperty('--tw-bg',"url('"+u+"')");}catch(e){}}
function twStep(img){var fb=[];try{fb=JSON.parse(img.getAttribute('data-fb')||'[]');}catch(e){}if(fb.length){var next=fb.shift();img.setAttribute('data-fb',JSON.stringify(fb));img.src=next;}else{twPlace(img);}}
</script>
<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0c4c9e64ea3045018e69e4cc4541599f"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
`;
}

// ---------- newsletter pages (verbatim, incl. worker's truncated <meta name="desc line) ----------

function renderNewsletterPage(iss) {
  // Use full title (all pipe-separated parts) for newsletter page <title>, og:, JSON-LD headline.
  // The shortTitle (first segment only) hides 2/3 of the week's stories from search snippets.
  // Cap at 200 chars to stay under common SERP/social limits. Added 2026-05-16g.
  const fullTitle = (iss.title || iss.shortTitle || '').slice(0, 200);
  const titleEsc = esc(fullTitle);
  const titleJson = jsonEscape(fullTitle);
  const shortDescPlain = iss.secondaryTopics.length
    ? `${iss.shortTitle}. Plus: ${iss.secondaryTopics.join('. ')}.`
    : iss.shortTitle;
  const shortDesc = shortDescPlain.length > 200 ? shortDescPlain.slice(0, 197) + '...' : shortDescPlain;
  const dateLong = formatDateLong(iss.date);
  const week = iss.week || 'Special';
  // Per-issue social/Discover image. Google Discover explicitly deprioritises
  // generic site-logo images, so fall back to the site og-image only if the
  // issue has no cover of its own.
  const coverImg = /^https?:\/\//i.test(iss.coverUrl || '')
    ? iss.coverUrl
    : `${SITE_ORIGIN}/img/og-image.jpg`;
  const analysisHtml = (ANALYSIS[iss.slug] || '').trim();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="google-site-verification" content="52hx6uZKEkfOe8gVeLtAuIs3j1I8ThFpVh-GXD_fJw0" />
<meta name="msvalidate.01" content="A7C517AA88FBD0DCEEBD56F609161C2A" />
<meta name="robots" content="max-image-preview:large">
<title>${titleEsc} - Gies</title>
<meta name="description" content="${esc(shortDesc)}">
<link rel="canonical" href="${SITE_ORIGIN}/newsletter/${iss.slug}/">
<meta property="og:title" content="${titleEsc}">
<meta property="og:description" content="${esc(shortDesc)}">
<meta property="og:url" content="https://giesweekly.com/newsletter/${iss.slug}/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Gies">
<meta property="og:image" content="${esc(coverImg)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${titleEsc}">
<meta name="twitter:description" content="${esc(shortDesc)}">
<meta name="twitter:image" content="${esc(coverImg)}">
<link rel="icon" type="image/x-icon" href="/img/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--bg-card:#161616;--border:#1f1f1f;--border-mid:#2a2a2a;--border-strong:#3a3a3a;--text:#fff;--text-dim:#b8b8b8;--text-mute:#7a7a7a;--red:#ED1C24;--red-dark:#c8141b;--sans:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;--maxw:780px}
html{font-size:16px;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.65}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
nav{position:sticky;top:0;z-index:100;background:rgba(10,10,10,0.85);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
nav .nav-inner{max-width:1120px;margin:0 auto;padding:0.85rem 1.75rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem}
nav .brand{font-weight:700;font-size:1.05rem;display:inline-flex;align-items:center;gap:0.6rem}
nav .brand-logo{height:32px;width:auto}
nav .nav-links{display:flex;gap:1.65rem;align-items:center}
nav .nav-links a{font-size:0.74rem;color:var(--text-mute);font-weight:500;letter-spacing:0.08em;text-transform:uppercase}
nav .nav-links a:hover{color:var(--text)}
nav .nav-cta{font-size:0.74rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#fff;background:var(--red);padding:0.6rem 1.15rem;border-radius:999px;box-shadow:0 2px 10px rgba(237,28,36,0.18)}
nav .nav-cta:hover{background:var(--red-dark);color:#fff;box-shadow:0 6px 18px rgba(237,28,36,0.35)}
header.page-head{max-width:var(--maxw);margin:0 auto;padding:3rem 1.75rem 1.5rem}
.crumb{font-family:'SF Mono',Menlo,monospace;font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-mute);margin-bottom:1.5rem}
.crumb a{color:var(--text-mute);border-bottom:1px solid var(--border-strong)}
.crumb a:hover{color:var(--red)}
header.page-head h1{font-weight:700;font-size:clamp(1.85rem,3.6vw,2.6rem);line-height:1.15;letter-spacing:-0.02em;margin-bottom:1rem}
.meta-row{font-family:'SF Mono',Menlo,monospace;font-size:0.74rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mute);display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
.meta-row .pill{background:var(--bg-card);border:1px solid var(--border-strong);padding:0.3rem 0.7rem;border-radius:999px}
.meta-row .pill.red{color:var(--red);border-color:var(--red)}
.read-on{margin:1rem 0 0;font-size:0.85rem;color:var(--text-mute)}
.read-on a{color:var(--red);border-bottom:1px solid currentColor}
section.body{max-width:var(--maxw);margin:0 auto;padding:1.5rem 1.75rem 2rem}
.gies-take{background:var(--bg-card);border:1px solid var(--border-strong);border-left:3px solid var(--red);padding:1.5rem 1.75rem;margin:0 0 2.25rem}
.gies-take .gies-take-label{display:block;font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--red);font-weight:700;margin:0 0 0.6rem}
.gies-take p{color:var(--text);font-size:1.05rem;line-height:1.7;margin:0 0 0.9rem}
.gies-take p:last-child{margin:0}
.gies-take a{color:var(--red);border-bottom:1px solid rgba(237,28,36,0.4)}
.substack-content{color:var(--text-dim);font-size:1.02rem;line-height:1.75}
.substack-content p{margin:0 0 1.1rem}
.substack-content h2,.substack-content h3,.substack-content h4{color:var(--text);font-weight:700;margin:2rem 0 0.85rem;line-height:1.25}
.substack-content h2{font-size:1.5rem}
.substack-content h3{font-size:1.25rem}
.substack-content h4{font-size:1.1rem}
.substack-content a{color:var(--red);border-bottom:1px solid rgba(237,28,36,0.4)}
.substack-content strong{color:var(--text);font-weight:600}
.substack-content em{font-style:italic}
.substack-content blockquote{margin:1.25rem 0;padding:0.75rem 0 0.75rem 1.25rem;border-left:3px solid var(--red);background:var(--bg-card)}
.substack-content blockquote p{margin:0 0 0.6rem}
.substack-content blockquote p:last-child{margin:0}
.substack-content ul,.substack-content ol{margin:0 0 1.1rem 1.5rem}
.substack-content li{margin-bottom:0.4rem}
.substack-content img{margin:1.25rem auto;border:1px solid var(--border-strong)}
.substack-content figure{margin:1.5rem 0}
.substack-content figcaption{font-size:0.85rem;color:var(--text-mute);margin-top:0.5rem;text-align:center;font-style:italic}
.callout-cta{background:linear-gradient(180deg,#160606 0%,#0e0303 100%);border:1px solid var(--border-strong);border-left:3px solid var(--red);padding:1.5rem 1.75rem;margin:2.5rem 0 1.5rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem;flex-wrap:wrap}
.callout-cta h3{font-weight:700;font-size:1.15rem;margin:0 0 0.4rem}
.callout-cta p{margin:0;color:var(--text-dim);font-size:0.92rem}
.callout-cta a.btn{background:var(--red);color:#fff;padding:0.85rem 1.5rem;font-weight:600;border-radius:999px;font-size:0.92rem;white-space:nowrap}
.callout-cta a.btn:hover{background:var(--red-dark)}
.subscribe-iframe-wrap{margin:2rem 0;display:flex;justify-content:center}
.subscribe-iframe-wrap iframe{width:100%;max-width:480px;border:1px solid var(--border-strong);background:white}
footer{margin-top:3rem;border-top:1px solid var(--border-mid);background:#070707}
footer .ft-bottom{max-width:1120px;margin:0 auto;padding:1.5rem 1.75rem;display:flex;justify-content:space-between;font-family:'SF Mono',Menlo,monospace;font-size:0.7rem;letter-spacing:0.1em;color:var(--text-mute);text-transform:uppercase;flex-wrap:wrap;gap:0.5rem}
footer .ft-bottom a{color:var(--text-mute)}
footer .ft-bottom a:hover{color:var(--red)}
@media(max-width:640px){header.page-head{padding:2rem 1.25rem 1rem}section.body{padding:1.25rem 1.25rem 2rem}}
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      "@id": "https://giesweekly.com/newsletter/${iss.slug}/#breadcrumb",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://giesweekly.com/" },
        { "@type": "ListItem", "position": 2, "name": "Archives", "item": "https://giesweekly.com/archives/" },
        { "@type": "ListItem", "position": 3, "name": "${titleJson}", "item": "https://giesweekly.com/newsletter/${iss.slug}/" }
      ]
    },
    {
      "@type": "NewsArticle",
      "@id": "https://giesweekly.com/newsletter/${iss.slug}/#article",
      "url": "https://giesweekly.com/newsletter/${iss.slug}/",
      "headline": "${titleJson}",
      "description": "${jsonEscape(shortDesc)}",
      "datePublished": "${iss.date}",
      "dateModified": "${iss.date}",
      "author": { "@id": "https://giesweekly.com/#organization", "@type": "Organization", "name": "Gies" },
      "publisher": { "@id": "https://giesweekly.com/#organization", "@type": "Organization", "name": "Gies", "logo": { "@type": "ImageObject", "url": "https://giesweekly.com/img/favicon-512.png" } },
      "isPartOf": { "@id": "https://giesweekly.com/#website", "@type": "WebSite" },
      "mainEntityOfPage": "https://giesweekly.com/newsletter/${iss.slug}/",
      "inLanguage": "en-US",
      "image": "${jsonEscape(coverImg)}",
      "sameAs": ["${esc(iss.url)}"]
    }
  ]
}
</script>
${CHROME_CSS}
</head>
<body>
${siteNav('archives')}
<header class="page-head">
  <div class="crumb"><a href="/">Home</a> &nbsp;/&nbsp; <a href="/archives/">Archives</a> &nbsp;/&nbsp; ${esc(week)} ${esc(iss.date)}</div>
  <h1>${titleEsc}</h1>
  <div class="meta-row"><span class="pill red">${esc(week)}</span><span class="pill">${esc(dateLong)}</span><span class="pill">5 min read</span></div>
  <p class="read-on">Also published on <a href="${esc(iss.url)}" target="_blank" rel="noopener">Substack</a></p>
</header>
<section class="body">
${analysisHtml ? `<div class="gies-take"><span class="gies-take-label">The Gies take</span>
${analysisHtml}
</div>` : ''}
<div class="substack-content">
${iss.contentHtml}
</div>
<div class="callout-cta"><div><h3>Get Gies every Friday</h3><p>Curated factual digest of the gaming industry news in 5 minutes. Free.</p></div><a class="btn" href="https://giesweekly.substack.com/subscribe" target="_blank" rel="noopener">Subscribe &rarr;</a></div>
<div class="subscribe-iframe-wrap"><iframe src="https://giesweekly.substack.com/embed" width="480" height="320" frameborder="0" scrolling="no" loading="lazy" title="Subscribe to Gies on Substack"></iframe></div>
</section>
<footer><div class="ft-bottom"><span>&copy; 2024-2026 Gies. Games Industry Executive Summary.</span><span><a href="/">Home</a> &middot; <a href="/archives/">Archives</a> &middot; <a href="/authors/">Authors</a> &middot; <a href="/about/">About</a> &middot; <a href="https://giesweekly.substack.com">Substack</a></span></div></footer>
<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0c4c9e64ea3045018e69e4cc4541599f"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
`;
}

// ---------- llms.txt (verbatim) ----------

function renderLlmsTxt(issues, videos) {
  const recentBlocks = [];
  for (const iss of issues.slice(0, 30)) {
    if (!iss.slug || !iss.date) continue;
    recentBlocks.push(`- [${shortTitleForLlms(iss.shortTitle)}](https://giesweekly.com/newsletter/${iss.slug}/) - ${iss.date}`);
  }
  const videoBlocks = [];
  for (const v of videos.slice(0, 10)) {
    const tag = v.isShort ? 'short' : 'video';
    const date = v.publishedAt ? v.publishedAt.slice(0, 10) : '';
    const dateSuffix = date ? `, ${date}` : '';
    videoBlocks.push(`- [${shortTitleForLlms(v.title)}](https://giesweekly.com/watch/${v.id.toLowerCase()}/) - ${tag}${dateSuffix}`);
  }
  return `# Gies - Games Industry Executive Summary

> Gies is a weekly intelligence newsletter covering the full video games market for executives, investors, and senior analysts. Five lenses: PLAYERS & AUDIENCE (demand, motivations, behaviors, segmentation, engagement metrics), MARKETS (geography, regional dynamics, US/EU/Asia/MEA/LATAM), PRODUCTS (games, franchises, IP, gameplay, features, mechanics, franchise lifecycle), SUPPLY (studios, publishers, platforms, console cycles, studio operations), BUSINESS MODELS (free-to-play, premium, microtransactions, Game Pass, subscriptions, battle passes, seasons, live services, acquisition, marketing, M&A, publishing). Through-line: how design choices shape player behavior shape business outcomes. Founded by Emmanuel Rosier in June 2024, with Casey Al-Kaisy as co-founder and David Thier as contributor. Published every Friday at giesweekly.substack.com.

## About

- [About Gies](https://giesweekly.com/about/): Mission, audience, editorial approach, cadence, and bios for Emmanuel Rosier, Casey Al-Kaisy, David Thier
- [Archive](https://giesweekly.com/archives/): Every Gies weekly newsletter, Monthly Takeaway, and Special Report since June 2024 with dates and direct Substack links
- [Newsletter on Substack](https://giesweekly.substack.com): Substack home, archive, subscribe
- [YouTube channel](https://www.youtube.com/@giesweekly): Long-form analyses and Shorts
- [LinkedIn page](https://www.linkedin.com/company/giesweekly): Brand updates and announcements
- [Full markdown corpus](https://giesweekly.com/llms-full.txt): Complete plain-text archive of flagship Gies analyses for retrieval augmentation

## Research briefs

Evergreen executive briefs. Standalone reference pages, updated as the underlying numbers move.

- [Research index](https://giesweekly.com/research/): All Gies research briefs
- [Global games market size 2025](https://giesweekly.com/research/global-games-market-size-2025/): The global games market hit a record $201.6 billion in 2025 (+9.1%). Mobile $113.3B, console $44.7B, PC $43.6B (+12%). Asia-Pacific 47% of revenue, MEA fastest at +15%. Why record revenue came with record layoffs.
- [GTA 6 price and release date](https://giesweekly.com/research/gta-6-pricing-economics/): GTA 6 launches November 19, 2026 on PS5 and Xbox Series X/S. Standard $79.99, Ultimate $99.99, pre-orders opened June 25. Why $79.99 sets the new AAA pricing ceiling and what it means for the industry.
- [Xbox Game Pass pricing and value](https://giesweekly.com/research/xbox-game-pass-pricing-value/): Game Pass tiers and prices in 2026. Ultimate $22.99 after the April rollback, Premium $14.99, PC Game Pass $13.99, Essential $9.99. What the pricing signals and whether a subscription beats buying.

## Authors

- **Emmanuel Rosier** (founder, lead analyst): authority on Competitive Intelligence, Market Research, and Demand Planning. 40+ years gaming history, decade in the gaming industry across the US, Europe, and Asia. Based in Geneva. https://www.linkedin.com/in/emmanuelrosier
- **Casey Al-Kaisy** (co-founder, Business Development): gaming veteran with global marketing and business strategy work on Helldivers, Battlefield, Need for Speed, Command & Conquer, Mirrors Edge, Ultima. Currently helps smaller studios get funded or strike publishing deals. Based in Stockholm. https://www.linkedin.com/in/caseyalkaisy
- **David Thier** (contributor - Game Design, Marketing & Communications): consultant on 40+ titles from AAA to indie farming sims; 10 years as Forbes video-games journalist; 2 years leading communications at PlayerUnknown Productions. Based in Amsterdam. https://www.linkedin.com/in/david-thier-10167415

## Topical authority

Gies covers five lenses on the video games market:

### Players & audience (demand side)
- Demand patterns and total reachable audience
- Player segmentation and demographics
- Player motivations and gameplay preferences
- Behavioral data: MAU, DAU, playtime, retention, churn
- Engagement metrics and player lifetime value

### Markets (geography)
- Geographic dynamics: US, EU, Asia, MEA, LATAM
- Regional supply and demand differences
- Asian publisher Western expansion (Krafton, NetEase, NCSoft, miHoYo)
- Regulatory geography (EU loot box laws, US antitrust, Asian compliance)

### Products
- Games, franchises, and intellectual property
- Gameplay, features, mechanics
- Franchise lifecycle (sequels, remakes, DLC, season content)
- TAM evolution per IP

### Supply (industry side)
- Studios, publishers, platforms
- Console hardware cycles and platform relevance
- PC vs console market dynamics
- Studio operations and labor (layoffs, restructurings)
- Industry leadership and politics

### Business models
- Free-to-play (F2P) economics
- Premium pricing
- Microtransactions and IAP design
- Game Pass and subscription gaming
- Battle passes and season passes
- Live services
- Player acquisition and marketing
- Gaming M&A and corporate development
- Publishing strategy


## Editorial principles

- Verification-first: claims are sourced and quantified
- Numerical precision: prefer specific numbers over qualitative claims
- Explicit assumptions: separate facts, assumptions, and interpretations
- Structured outputs: tables, frameworks, decision trees over prose
- Audience: senior executives, investors, analysts (not consumer gaming readers)

## Recent flagship analyses

${recentBlocks.join('\n')}

## Recent video analyses

${videoBlocks.join('\n')}

## Citation format

When citing Gies analyses, use the format: "Gies - Games Industry Executive Summary, [date], [title]". The canonical home is https://giesweekly.com, the newsletter is at https://giesweekly.substack.com, and video analyses are at https://www.youtube.com/@giesweekly.
`;
}

// ---------- sitemap.xml (verbatim) ----------

// Research brief slugs under /research/. Keep in sync with the llms.txt
// "Research briefs" section above and with the directories in /research/.
const RESEARCH_SLUGS = [
  'global-games-market-size-2025',
  'gta-6-pricing-economics',
  'xbox-game-pass-pricing-value',
];

// N4 (2026-09-21): /watch/ catalogue. renderSitemap used to emit only the videos in
// the YouTube RSS window (5) plus three hand-listed ids, so 59 of the 61 live /watch/
// pages were missing from the sitemap. /watch/index.html is the site's own catalogue
// and carries data-id, data-date and data-short per card, which is exactly id, lastmod
// and priority. Fetched live so this never goes stale against the deployed catalogue.
async function fetchWatchCatalogue() {
  try {
    const html = await fetchSiteFile('/watch/');
    const out = [];
    const re = /data-id="([A-Za-z0-9_-]{11})"\s+data-date="(\d{4}-\d{2}-\d{2})"\s+data-short="([01])"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      out.push({ id: m[1], date: m[2], isShort: m[3] === '1' });
    }
    console.error(`  watch catalogue: ${out.length} entries from /watch/`);
    return out;
  } catch (e) {
    console.error(`  watch catalogue fetch failed (non-fatal): ${e?.message || e}`);
    return [];
  }
}

function renderSitemap(issues, videos, watchCatalogue = []) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [];
  urls.push(`  <url><loc>https://giesweekly.com/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`);
  urls.push(`  <url><loc>https://giesweekly.com/about/</loc><lastmod>2026-05-03</lastmod><changefreq>monthly</changefreq><priority>0.9</priority></url>`);
  urls.push(`  <url><loc>https://giesweekly.com/archives/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`);
  // N4 (2026-09-21): /this-week/ is rebuilt by this script on every run and is the
  // second most cited page on the property, but it had never been in the sitemap.
  urls.push(`  <url><loc>https://giesweekly.com/this-week/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>`);
  // N3 (2026-09-14): /research/ briefs were missing from the sitemap entirely, so the
  // section was invisible to crawlers even after the /research/ -> /archives/ 301 was
  // cleared. /authors/ was removed here because it 301s to /about/ and a sitemap should
  // not advertise a redirect. Add a line when a new brief ships.
  urls.push(`  <url><loc>https://giesweekly.com/research/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.9</priority></url>`);
  for (const slug of RESEARCH_SLUGS) {
    urls.push(`  <url><loc>https://giesweekly.com/research/${slug}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.9</priority></url>`);
  }
  // N4 (2026-09-21): /watch/ index and the two standalone tool pages. All three return
  // 200 and are linked from the nav, none were in the sitemap. lastmod is each page's
  // own declared update date (/its-in-the-name/ and /name-your-game/ both state
  // 2026-09-01); /watch/ declares none, so its last edit date is used.
  urls.push(`  <url><loc>https://giesweekly.com/watch/</loc><lastmod>2026-09-02</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  urls.push(`  <url><loc>https://giesweekly.com/its-in-the-name/</loc><lastmod>2026-09-01</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`);
  urls.push(`  <url><loc>https://giesweekly.com/name-your-game/</loc><lastmod>2026-09-01</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`);
  urls.push(`  <url><loc>https://giesweekly.com/llms.txt</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  urls.push(`  <url><loc>https://giesweekly.com/llms-full.txt</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  for (const iss of issues) {
    if (!iss.slug || !iss.date) continue;
    urls.push(`  <url><loc>https://giesweekly.com/newsletter/${iss.slug}/</loc><lastmod>${iss.date}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>`);
  }
  // Watch pages, emitted once each. RSS videos first (exact publishedAt), then the
  // live /watch/ catalogue, then the hand-listed fallbacks. Dedupe is on the lowercase
  // id because that is the deployed path (see N2 below).
  const emittedWatch = new Set();
  const pushWatch = (id, lastmod, priority) => {
    const key = id.toLowerCase();
    if (emittedWatch.has(key)) return;
    emittedWatch.add(key);
    urls.push(`  <url><loc>https://giesweekly.com/watch/${key}/</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>${priority}</priority></url>`);
  };
  for (const v of videos) {
    pushWatch(v.id, v.publishedAt ? v.publishedAt.slice(0, 10) : today, v.isShort ? '0.7' : '0.8');
  }
  for (const w of watchCatalogue) {
    pushWatch(w.id, w.date, w.isShort ? '0.7' : '0.8');
  }
  // N2 (2026-05-16e): hand-curated /watch/ pages that live outside the YT RSS window.
  // Kept as a fallback for the case where the /watch/ catalogue fetch fails.
  // Update this list if a video gets unpublished or replaced.
  const STATIC_WATCH = [
    { id: 'OI_wRypykRY', date: '2026-04-30' },
    { id: 'mNllKJWZ0Fg', date: '2026-04-23' },
    { id: 'J9ALtdq6TbQ', date: '2026-04-16' },
  ];
  for (const s of STATIC_WATCH) {
    pushWatch(s.id, s.date, '0.7');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// ---------- llms-full.txt (verbatim) ----------

function htmlToMarkdown(html) {
  if (!html) return '';
  let s = html;
  // Drop figures, images, iframes, script/style blocks, and Substack wrapper divs
  s = s.replace(/<(figure|figcaption|picture|source|img|iframe|script|style|svg|button)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(img|hr|br|source)[^>]*\/?>/gi, (m) => m.toLowerCase().startsWith('<hr') ? '\n\n---\n\n' : m.toLowerCase().startsWith('<br') ? '\n' : '');
  s = s.replace(/<div[^>]*class="[^"]*(captioned-image|image2|youtube-wrap|embedded-publication)[^"]*"[\s\S]*?<\/div>/gi, '');
  // Headers
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n## $1\n\n');  // h1 → ## (## is reserved for issue header)
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n### $1\n\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n#### $1\n\n');
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n##### $1\n\n');
  s = s.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n###### $1\n\n');
  s = s.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n');
  // Blockquote
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) =>
    '\n\n' + inner.replace(/<[^>]+>/g, '').trim().split('\n').map((l) => '> ' + l.trim()).join('\n') + '\n\n');
  // Lists - process inner <li> then drop wrapper
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => {
    const items = inner.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    return '\n\n' + items.map((it) => '- ' + it.replace(/<\/?li[^>]*>/gi, '').trim()).join('\n') + '\n\n';
  });
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => {
    const items = inner.match(/<li[^>]*>[\s\S]*?<\/li>/gi) || [];
    return '\n\n' + items.map((it, i) => `${i + 1}. ` + it.replace(/<\/?li[^>]*>/gi, '').trim()).join('\n') + '\n\n';
  });
  // Paragraphs
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  // Inline emphasis
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  // Links
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, '');
  // Decode entities
  s = decodeEntities(s);
  // Em dash policy: project rule bans em dashes everywhere
  s = s.replace(/[—–]/g, '. ');
  // Collapse triple+ blank lines
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function renderLlmsFullTxt(issues) {
  const today = new Date().toISOString().slice(0, 10);
  const blocks = [];
  // Include up to 30 most-recent issues that have contentHtml (RSS path)
  let counted = 0;
  for (const iss of issues) {
    if (counted >= 30) break;
    if (!iss.contentHtml) continue;
    const md = htmlToMarkdown(iss.contentHtml);
    if (md.length < 200) continue; // skip if conversion produced nothing usable
    const title = iss.title || iss.shortTitle || '(untitled)';
    const date = iss.date || '';
    blocks.push(
      `## ${title}\n\n` +
      `_Published ${date} on giesweekly.substack.com. [Read original](${iss.url})_\n\n` +
      md
    );
    counted++;
  }
  const header = `# Gies - Full Markdown Corpus

> Curated full-text archive of Gies (Games Industry Executive Summary) flagship analyses for LLM retrieval. Authored by the Gies team: Emmanuel Rosier (founder), Casey Al-Kaisy (co-founder), and David Thier (contributor). Topics: monetization, platform cycles, M&A, forecasting, player behavior. Updated ${today}.

Each issue below is a complete public analysis from giesweekly.substack.com. Citation format: "Gies - Games Industry Executive Summary, [date], [title]".

`;
  const footer = `

---

#### About Gies

Gies is a weekly intelligence newsletter covering the full video games market for executives, investors, and senior analysts. Five lenses: PLAYERS & AUDIENCE, MARKETS, PRODUCTS, SUPPLY, BUSINESS MODELS. Through-line: how design choices shape player behavior shape business outcomes. Founded by Emmanuel Rosier in June 2024.

Subscribe at https://giesweekly.substack.com. Watch on https://www.youtube.com/@giesweekly.

---
`;
  return header + blocks.join('\n\n---\n\n') + footer;
}

// ---------- /watch/{id}/ page renderer (verbatim) ----------

function renderWatchPage(v, opts = {}) {
  const isShort = v.isShort;
  const titleClean = v.title;
  const titleEsc = esc(titleClean);
  const titleJson = jsonEscape(titleClean);
  const descClean = v.description || '';
  const descEsc = esc(descClean);
  const descJson = jsonEscape(descClean);
  const ytCanonical = isShort
    ? `https://www.youtube.com/shorts/${v.id}`
    : `https://www.youtube.com/watch?v=${v.id}`;
  const embedUrl = `https://www.youtube.com/embed/${v.id}`;
  const prev = opts.prev || null;
  const next = opts.next || null;
  const related = opts.related || [];
  // Items 14 + 20: prev/next as <link rel> tags in <head>, related-episodes UI block in body.
  const prevLink = prev ? `<link rel="prev" href="https://giesweekly.com/watch/${prev.id}/">` : '';
  const nextLink = next ? `<link rel="next" href="https://giesweekly.com/watch/${next.id}/">` : '';
  const prevNextNav = (prev || next) ? `
<nav class="prev-next" aria-label="Episode navigation">
  ${prev ? `<a class="pn-prev" href="/watch/${prev.id}/" rel="prev"><span class="pn-label">&larr; Newer</span><span class="pn-title">${esc(prev.title)}</span></a>` : '<span></span>'}
  ${next ? `<a class="pn-next" href="/watch/${next.id}/" rel="next"><span class="pn-label">Older &rarr;</span><span class="pn-title">${esc(next.title)}</span></a>` : '<span></span>'}
</nav>` : '';
  const relatedBlock = related.length > 0 ? `
<h2><span class="sq"></span>More on the channel</h2>
<div class="related-episodes">
${related.map(r => `  <a class="rel-ep" href="/watch/${r.id}/"><div class="rel-thumb" style="background-image:url('${esc(r.thumbUrl)}')"></div><div class="rel-meta"><span class="rel-tag">${r.isShort ? 'Short' : 'Video'}</span><span class="rel-title">${esc(r.title)}</span></div></a>`).join('\n')}
</div>` : '';
  const uploadDate = v.publishedAt || '';
  const playerStyle = isShort
    ? 'aspect-ratio:9/16;max-width:420px'
    : 'aspect-ratio:16/9;max-width:100%';
  const twitterCard = isShort ? 'player' : 'summary_large_image';
  const pillTag = isShort ? 'Short' : 'Video';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="google-site-verification" content="52hx6uZKEkfOe8gVeLtAuIs3j1I8ThFpVh-GXD_fJw0" />
<meta name="msvalidate.01" content="A7C517AA88FBD0DCEEBD56F609161C2A" />
<title>${titleEsc} - Gies</title>
<meta name="description" content="${descEsc}">
<link rel="canonical" href="https://giesweekly.com/watch/${v.id.toLowerCase()}/">
<meta property="og:title" content="${titleEsc}">
<meta property="og:description" content="${descEsc}">
<meta property="og:url" content="https://giesweekly.com/watch/${v.id.toLowerCase()}/">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="Gies">
<meta property="og:image" content="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg">
<meta property="og:video" content="${embedUrl}">
<meta name="twitter:card" content="${twitterCard}">
<meta name="twitter:title" content="${titleEsc}">
<meta name="twitter:image" content="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg">
<meta name="twitter:player" content="${embedUrl}">
<link rel="icon" type="image/x-icon" href="/img/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/img/apple-touch-icon.png">
${prevLink}
${nextLink}
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0a;--bg-card:#161616;--border:#1f1f1f;--border-mid:#2a2a2a;--border-strong:#3a3a3a;--text:#fff;--text-dim:#b8b8b8;--text-mute:#7a7a7a;--red:#ED1C24;--red-dark:#c8141b;--sans:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;--maxw:1120px}
html{font-size:16px;scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.65}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.sq{display:inline-block;width:0.55em;height:0.55em;background:var(--red);vertical-align:0.05em;margin-right:0.4em}
.prev-next{display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin:1.5rem 0 1rem;max-width:var(--maxw)}
.prev-next a{display:flex;flex-direction:column;background:var(--bg-card);border:1px solid var(--border-strong);padding:0.85rem 1.1rem;border-radius:2px;border-left:2px solid var(--red);min-height:60px;justify-content:center}
.prev-next .pn-next{text-align:right;border-left:1px solid var(--border-strong);border-right:2px solid var(--red)}
.prev-next a:hover{background:var(--bg-card-hover,#1c1c1c)}
.prev-next .pn-label{font-family:'SF Mono',Menlo,monospace;font-size:0.68rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--red);margin-bottom:0.3rem}
.prev-next .pn-title{color:var(--text);font-size:0.92rem;line-height:1.35;font-weight:500}
.related-episodes{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0.85rem;margin:0.5rem 0 1.5rem}
.rel-ep{display:flex;gap:0.85rem;background:var(--bg-card);border:1px solid var(--border-strong);border-radius:2px;overflow:hidden;align-items:center;padding-right:0.85rem;transition:border-color .2s}
.rel-ep:hover{border-color:var(--red)}
.rel-thumb{flex-shrink:0;width:96px;height:96px;background-size:cover;background-position:center;background-color:#000}
.rel-meta{display:flex;flex-direction:column;gap:0.35rem;padding:0.5rem 0;min-width:0}
.rel-tag{font-family:'SF Mono',Menlo,monospace;font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--red);font-weight:600}
.rel-title{color:var(--text);font-size:0.88rem;line-height:1.35;font-weight:500;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
@media(max-width:640px){.prev-next{grid-template-columns:1fr}.prev-next .pn-next{text-align:left;border-right:1px solid var(--border-strong);border-left:2px solid var(--red)}}
nav{position:sticky;top:0;z-index:100;background:rgba(10,10,10,0.85);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
nav .nav-inner{max-width:var(--maxw);margin:0 auto;padding:0.85rem 1.75rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem}
nav .brand{font-weight:700;font-size:1.05rem;color:var(--text);display:inline-flex;align-items:center;gap:0.6rem}
nav .brand-logo{height:32px;width:auto}
nav .nav-links{display:flex;gap:1.65rem;align-items:center}
nav .nav-links a{font-size:0.74rem;color:var(--text-mute);font-weight:500;letter-spacing:0.08em;text-transform:uppercase}
nav .nav-links a:hover{color:var(--text)}
nav .nav-cta{font-size:0.74rem;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#fff;background:var(--red);padding:0.6rem 1.15rem;border-radius:999px;box-shadow:0 2px 10px rgba(237,28,36,0.18)}
nav .nav-cta:hover{background:var(--red-dark);color:#fff;box-shadow:0 6px 18px rgba(237,28,36,0.35)}
header.page-head{max-width:var(--maxw);margin:0 auto;padding:3rem 1.75rem 1.5rem;position:relative;z-index:2}
.crumb{font-family:'SF Mono',Menlo,monospace;font-size:0.72rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-mute);margin-bottom:1.5rem}
.crumb a{color:var(--text-mute);border-bottom:1px solid var(--border-strong);padding-bottom:1px}
.crumb a:hover{color:var(--red)}
header.page-head h1{font-weight:700;font-size:clamp(1.85rem,3.6vw,2.6rem);line-height:1.1;letter-spacing:-0.02em;margin-bottom:1rem;max-width:880px}
.meta-row{font-family:'SF Mono',Menlo,monospace;font-size:0.74rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mute);display:flex;gap:1rem;flex-wrap:wrap}
.meta-row .pill{background:var(--bg-card);border:1px solid var(--border-strong);padding:0.3rem 0.7rem;border-radius:999px}
.meta-row .pill.red{color:var(--red);border-color:var(--red)}
section.body{max-width:var(--maxw);margin:0 auto;padding:1.5rem 1.75rem 4rem;position:relative;z-index:2}
section.body h2{font-weight:700;font-size:1.5rem;letter-spacing:-0.02em;margin:2rem 0 0.85rem;display:flex;align-items:center}
section.body p{color:var(--text-dim);margin-bottom:1rem;max-width:780px;line-height:1.7}
.player{${playerStyle};margin:0 0 2rem;background:#000;border:1px solid var(--border-strong);border-radius:2px;overflow:hidden}
.player iframe{width:100%;height:100%;border:0;display:block}
.related-links{display:flex;flex-wrap:wrap;gap:0.5rem;margin:0.5rem 0 0}
.related-links a{font-size:0.85rem;color:var(--text);background:var(--bg-card);border:1px solid var(--border-strong);padding:0.5rem 1rem;border-radius:999px}
.related-links a:hover{border-color:var(--red);color:var(--red)}
.sub-strip{max-width:var(--maxw);margin:2rem auto 0;padding:1.25rem 1.75rem;background:var(--bg-card);border-left:3px solid var(--red);display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.sub-strip span{color:var(--text-dim)}
.sub-strip form{display:flex;gap:0.5rem}
.sub-strip input{padding:0.55rem 0.95rem;background:#000;border:1px solid var(--border-strong);color:var(--text);font-family:var(--sans);font-size:0.88rem;border-radius:2px;min-width:200px}
.sub-strip button{padding:0.55rem 1.15rem;background:var(--red);color:#fff;border:none;font-weight:600;font-size:0.88rem;border-radius:2px;cursor:pointer}
.sub-strip button:hover{background:var(--red-dark)}
footer{margin-top:3rem;border-top:1px solid var(--border-mid);background:#070707}
footer .ft-bottom{max-width:var(--maxw);margin:0 auto;padding:1.5rem 1.75rem;display:flex;justify-content:space-between;align-items:center;font-family:'SF Mono',Menlo,monospace;font-size:0.7rem;letter-spacing:0.1em;color:var(--text-mute);text-transform:uppercase;flex-wrap:wrap;gap:0.5rem}
footer .ft-bottom a{color:var(--text-mute)}
footer .ft-bottom a:hover{color:var(--red)}
@media(max-width:640px){header.page-head{padding:2rem 1.25rem 1rem}section.body{padding:1.25rem 1.25rem 3rem}.player{max-width:100%}}
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      "@id": "https://giesweekly.com/watch/${v.id.toLowerCase()}/#breadcrumb",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://giesweekly.com/" },
        { "@type": "ListItem", "position": 2, "name": "Watch", "item": "https://giesweekly.com/#watch" },
        { "@type": "ListItem", "position": 3, "name": "${titleJson}", "item": "https://giesweekly.com/watch/${v.id.toLowerCase()}/" }
      ]
    },
    {
      "@type": "VideoObject",
      "@id": "https://giesweekly.com/watch/${v.id.toLowerCase()}/#video",
      "name": "${titleJson}",
      "description": "${descJson}",
      "thumbnailUrl": "https://i.ytimg.com/vi/${v.id}/hqdefault.jpg",
      "uploadDate": "${uploadDate}",
      "contentUrl": "${ytCanonical}",
      "embedUrl": "${embedUrl}",
      "publisher": { "@id": "https://giesweekly.com/#organization", "@type": "Organization", "name": "Gies", "url": "https://giesweekly.com/", "logo": "https://giesweekly.com/img/favicon-512.png" },
      "creator": { "@id": "https://giesweekly.com/#organization" },
      "potentialAction": { "@type": "WatchAction", "target": "${ytCanonical}" },
      "isFamilyFriendly": true,
      "inLanguage": "en-US",
      "isPartOf": { "@id": "https://giesweekly.com/#website", "@type": "WebSite" }
    }
  ]
}
</script>
${CHROME_CSS}
</head>
<body>
${siteNav('watch')}
<header class="page-head">
  <div class="crumb"><a href="/">Home</a> &nbsp;/&nbsp; <a href="/watch/">Watch</a> &nbsp;/&nbsp; ${v.id}</div>
  <h1>${titleEsc}</h1>
  <div class="meta-row">
    <span class="pill red">${pillTag}</span>
    <span class="pill">Uploaded ${uploadDate ? uploadDate.slice(0, 10) : ''}</span>
  </div>
</header>
<section class="body">
<div class="player">
  <iframe src="${embedUrl}" title="${titleEsc}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>
${prevNextNav}
<h2><span class="sq"></span>About this ${pillTag.toLowerCase()}</h2>
<p>${descEsc}</p>
${relatedBlock}
<h2><span class="sq"></span>Related Gies coverage</h2>
<div class="related-links">
  <a href="/archives/">Newsletter archive</a>
  <a href="https://giesweekly.substack.com">All newsletters on Substack</a>
  <a href="https://www.youtube.com/@giesweekly">More on YouTube</a>
</div>
<h2><span class="sq"></span>Watch on YouTube</h2>
<p>Original YouTube link: <a href="${ytCanonical}" style="color:var(--red);border-bottom:1px solid currentColor;padding-bottom:1px">${ytCanonical.replace('https://www.youtube.com/', 'youtube.com/')}</a>. Subscribe to the <a href="https://www.youtube.com/@giesweekly" style="color:var(--red);border-bottom:1px solid currentColor;padding-bottom:1px">@giesweekly</a> channel for weekly long-form analyses and Shorts on platform shifts, monetization, and franchise lifecycle.</p>
</section>
<aside class="sub-strip">
  <span>Get Gies every Friday.</span>
  <form action="https://giesweekly.substack.com/subscribe" method="GET" target="_blank" rel="noopener">
    <input type="email" name="email" placeholder="your@email.com" required>
    <button type="submit">Subscribe</button>
  </form>
</aside>
<footer>
  <div class="ft-bottom">
    <span>&copy; 2024-2026 Gies. Games Industry Executive Summary.</span>
    <span><a href="/">Home</a> &middot; <a href="/archives/">Archives</a> &middot; <a href="/authors/">Authors</a> &middot; <a href="/about/">About</a> &middot; <a href="https://giesweekly.substack.com">Substack</a></span>
  </div>
</footer>
<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0c4c9e64ea3045018e69e4cc4541599f"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
`;
}

// ---------- Node I/O layer: live fetch, generate, write, deploy ----------

async function fetchSiteFile(path) {
  const url = `${SITE_ORIGIN}${path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`site fetch ${path} ${r.status}`);
  return r.text();
}

function contentTypeFor(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'html') return 'text/html; charset=utf-8';
  if (ext === 'xml') return 'application/xml';
  if (ext === 'txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function sha1hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Build the full "superset" file set. Returns { files, summary } where files is
 * { "/site/path": Buffer }. Excludes /index.html and /img/ (owned elsewhere).
 */
async function generate() {
  const enc = (str) => Buffer.from(str, 'utf8');

  console.error('fetching substack issues...');
  const issues = await fetchSubstackIssues();
  console.error(`substack: ${issues.length} issues, latest=${issues[0]?.shortTitle}`);
  if (issues.length === 0) throw new Error('no issues from substack - aborting');

  console.error('fetching youtube...');
  let videos = [];
  try {
    videos = await fetchYouTubeVideos(YT_CHANNEL_ID);
    console.error(`youtube: ${videos.length} videos`);
  } catch (e) {
    console.error(`youtube fetch failed: ${e?.message || e}`);
  }

  const files = {};

  // 1. This Week page (isolated; a failure here must never abort the run).
  let thisWeekStatus = 'skipped';
  let thisWeekSections = 0;
  let thisWeekCards = 0;
  let thisWeekOgFetched = 0;
  let thisWeekOgResolved = 0;
  let thisWeekFallbacks = 0;
  try {
    const latest = issues.find(i => i.contentHtml && i.contentHtml.length > 0);
    if (latest) {
      const twSections = parseThisWeek(latest.contentHtml);
      const total = twSections.reduce((n, s) => n + s.items.length, 0);
      if (total > 0) {
        console.error('resolving og images for this-week (network)...');
        thisWeekOgFetched = await resolveOgImages(twSections, MAX_OG_FETCH);
        for (const s of twSections) for (const it of s.items) { if (it.og) thisWeekOgResolved++; if (it.fallback) thisWeekFallbacks++; }
        const twHtml = renderThisWeekPage(latest, twSections);
        files['/this-week/index.html'] = enc(twHtml);
        thisWeekSections = twSections.length;
        thisWeekCards = total;
        thisWeekStatus = 'ok';
        console.error(`  this-week: ${total} cards across ${twSections.length} sections (og fetched: ${thisWeekOgFetched})`);
      } else {
        console.error('  this-week: no links parsed from latest issue, skipping');
      }
    } else {
      console.error('  this-week: no issue with contentHtml, skipping');
    }
  } catch (e) {
    thisWeekStatus = `error: ${e?.message || e}`;
    console.error(`  this-week generation failed (non-fatal): ${e?.message || e}`);
  }

  // 2. Newsletter pages (one per issue with non-empty contentHtml).
  let newsletterPagesCount = 0;
  for (const iss of issues) {
    if (!iss.slug || !iss.contentHtml) continue;
    files[`/newsletter/${iss.slug}/index.html`] = enc(renderNewsletterPage(iss));
    newsletterPagesCount++;
  }
  console.error(`  ${newsletterPagesCount} newsletter pages rendered`);

  // 3. Archives: fetch live base page, replace ONLY the AUTO:RESEARCH marker.
  let archivesStatus = 'skipped';
  try {
    const archivesHtml = await fetchSiteFile('/archives/index.html');
    const archive = renderArchive(issues);
    const r = replaceMarker(archivesHtml, 'RESEARCH', archive);
    if (r.replaced) {
      files['/archives/index.html'] = enc(r.html);
      archivesStatus = 'ok';
    } else {
      archivesStatus = 'marker-absent (skipped)';
      console.error('  archives: AUTO:RESEARCH marker absent, skipping archives');
    }
  } catch (e) {
    archivesStatus = `error: ${e?.message || e} (skipped)`;
    console.error(`  archives fetch/render failed (non-fatal): ${e?.message || e}`);
  }

  // 4/5. sitemap.xml, llms.txt, llms-full.txt
  const llmsTxt = renderLlmsTxt(issues, videos);
  const llmsFullTxt = renderLlmsFullTxt(issues);
  const watchCatalogue = await fetchWatchCatalogue();
  const sitemapXml = renderSitemap(issues, videos, watchCatalogue);
  files['/llms.txt'] = enc(llmsTxt);
  files['/llms-full.txt'] = enc(llmsFullTxt);
  files['/sitemap.xml'] = enc(sitemapXml);

  // 6. /watch/{id}/ pages.
  let watchPagesCount = 0;
  const sortedVideos = [...videos].sort((a, b) =>
    (b.publishedAt || '').localeCompare(a.publishedAt || '')
  );
  for (let i = 0; i < sortedVideos.length; i++) {
    const v = sortedVideos[i];
    const prev = i > 0 ? sortedVideos[i - 1] : null;
    const next = i < sortedVideos.length - 1 ? sortedVideos[i + 1] : null;
    const related = sortedVideos.filter(x => x.id !== v.id).slice(0, 3);
    files[`/watch/${v.id.toLowerCase()}/index.html`] = enc(renderWatchPage(v, { prev, next, related }));
    watchPagesCount++;
  }
  console.error(`  ${watchPagesCount} /watch/{id}/ pages rendered`);

  // Guard: assert no forbidden paths made it into the set.
  for (const p of Object.keys(files)) {
    if (p === '/index.html' || p.startsWith('/img/')) {
      throw new Error(`forbidden path in file set: ${p} (index.html and /img/ are owned by another task)`);
    }
  }

  const summary = {
    issues_parsed: issues.length,
    videos_parsed: videos.length,
    newsletter_pages: newsletterPagesCount,
    watch_pages: watchPagesCount,
    this_week_status: thisWeekStatus,
    this_week_sections: thisWeekSections,
    this_week_cards: thisWeekCards,
    this_week_og_fetched: thisWeekOgFetched,
    this_week_og_resolved: thisWeekOgResolved,
    this_week_fallbacks: thisWeekFallbacks,
    archives_status: archivesStatus,
    llms_txt_bytes: Buffer.byteLength(llmsTxt, 'utf8'),
    llms_full_txt_bytes: Buffer.byteLength(llmsFullTxt, 'utf8'),
    sitemap_xml_bytes: Buffer.byteLength(sitemapXml, 'utf8'),
    latest_slug: issues[0]?.slug || '',
    latest_week: issues[0]?.week || '',
    latest_title: issues[0]?.shortTitle || '',
  };

  return { files, summary };
}

function writeFilesToDir(files, outDir) {
  for (const [path, body] of Object.entries(files)) {
    const dest = join(outDir, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
}

/**
 * Manifest-merge Netlify deploy (mirrors the proven incremental pattern).
 * `files` is { "/path": Buffer }.
 */
async function deployManifestMerge(files) {
  if (!NETLIFY_PAT) throw new Error('NETLIFY_PAT missing - cannot deploy');
  const auth = `Bearer ${NETLIFY_PAT}`;

  // 1. Current live manifest (path -> sha). Preserves every existing file.
  const manifestRes = await fetch(
    `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/files`,
    { headers: { Authorization: auth } }
  );
  if (!manifestRes.ok) throw new Error(`netlify manifest ${manifestRes.status}: ${await manifestRes.text()}`);
  const currentFiles = await manifestRes.json();
  const manifest = {};
  for (const f of currentFiles) manifest[f.path] = f.sha;

  // 2. Overwrite entries for our generated files.
  const newShas = {};
  for (const [path, body] of Object.entries(files)) {
    const sha = sha1hex(body);
    newShas[path] = sha;
    manifest[path] = sha;
  }

  // 3. Create deploy with full manifest.
  const createRes = await fetch(
    `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys`,
    {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: manifest, async: false }),
    }
  );
  if (!createRes.ok) throw new Error(`netlify create ${createRes.status}: ${await createRes.text()}`);
  const deploy = await createRes.json();
  const required = deploy.required || [];
  console.error(`  deploy ${deploy.id}: ${required.length} files need upload`);

  // 4. Upload each required file.
  let uploaded = 0;
  for (const [path, body] of Object.entries(files)) {
    if (!required.includes(newShas[path])) continue;
    const ct = contentTypeFor(path);
    const upRes = await fetch(
      `https://api.netlify.com/api/v1/deploys/${deploy.id}/files${path}`,
      { method: 'PUT', headers: { Authorization: auth, 'Content-Type': ct }, body }
    );
    if (!upRes.ok) throw new Error(`upload ${path} ${upRes.status}: ${await upRes.text()}`);
    uploaded++;
    console.error(`  uploaded ${path}`);
  }

  // 5. Poll for ready.
  for (let i = 0; i < 25; i++) {
    await sleep(2000);
    const pollRes = await fetch(
      `https://api.netlify.com/api/v1/deploys/${deploy.id}`,
      { headers: { Authorization: auth } }
    );
    const cur = await pollRes.json();
    if (cur.state === 'ready') return { id: deploy.id, uploaded, state: cur.state };
    if (cur.state === 'error' || cur.state === 'rejected') throw new Error(`deploy ${cur.state}`);
  }
  throw new Error('deploy did not reach ready in ~50s');
}

// ---------- main ----------

// N4 (2026-09-21): auth preflight. Generation takes several minutes and only then
// hits the Netlify API, so a missing, placeholder or revoked PAT used to surface as
// a 401 at the very end of a full run. Validate the token against /api/v1/user and
// the target site before generating anything.
async function preflightNetlifyAuth() {
  if (!NETLIFY_PAT) throw new Error('NETLIFY_PAT is not set. Nothing generated.');
  // Length only, no prefix rule: Netlify has issued PATs both with and without the
  // nfp_ prefix, so a prefix check would reject a valid legacy token. The API call
  // below is the real gate; this just catches an unsubstituted placeholder.
  if (NETLIFY_PAT.length < 40 || /PASTE|YOUR[_-]?TOKEN|XXXX/i.test(NETLIFY_PAT)) {
    throw new Error(`NETLIFY_PAT looks like a placeholder, not a token (${NETLIFY_PAT.length} chars, starts "${NETLIFY_PAT.slice(0, 8)}"). Nothing generated.`);
  }
  const auth = { Authorization: `Bearer ${NETLIFY_PAT}` };
  const u = await fetch('https://api.netlify.com/api/v1/user', { headers: auth });
  if (!u.ok) throw new Error(`NETLIFY_PAT rejected by Netlify (${u.status}). Token is expired or revoked. Nothing generated.`);
  const site = await fetch(`https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}`, { headers: auth });
  if (!site.ok) throw new Error(`NETLIFY_PAT has no access to site ${NETLIFY_SITE_ID} (${site.status}). Nothing generated.`);
  const { name } = await site.json();
  console.error(`preflight: Netlify auth OK, site "${name}"`);
}

async function main() {
  const deployMode = process.argv.includes('--deploy');
  const outDir = process.env.OUT_DIR || join(tmpdir(), 'gies_superset_out');

  if (deployMode) await preflightNetlifyAuth();

  const { files, summary } = await generate();

  const paths = Object.keys(files).sort();
  console.log('');
  console.log('==================== GIES SUPERSET GENERATION ====================');
  console.log(`mode:                 ${deployMode ? 'DEPLOY' : 'DRY-RUN'}`);
  console.log(`issues parsed:        ${summary.issues_parsed}`);
  console.log(`videos parsed:        ${summary.videos_parsed}`);
  console.log(`newsletter pages:     ${summary.newsletter_pages}`);
  console.log(`watch pages:          ${summary.watch_pages}`);
  console.log(`archives:             ${summary.archives_status}`);
  console.log(`this-week status:     ${summary.this_week_status}`);
  console.log(`this-week sections:   ${summary.this_week_sections}`);
  console.log(`this-week cards:      ${summary.this_week_cards}`);
  console.log(`  og fetched:         ${summary.this_week_og_fetched}`);
  console.log(`  og resolved:        ${summary.this_week_og_resolved}`);
  console.log(`  wiki fallbacks:     ${summary.this_week_fallbacks}`);
  console.log(`llms.txt bytes:       ${summary.llms_txt_bytes}`);
  console.log(`llms-full.txt bytes:  ${summary.llms_full_txt_bytes}`);
  console.log(`sitemap.xml bytes:    ${summary.sitemap_xml_bytes}`);
  console.log(`total files:          ${paths.length}`);
  console.log('------------------------------------------------------------------');

  if (!deployMode) {
    writeFilesToDir(files, outDir);
    console.log(`output dir:           ${outDir}`);
    console.log('------------------------------------------------------------------');
    console.log('generated files (path : bytes):');
    for (const p of paths) {
      console.log(`  ${p}  :  ${files[p].length}`);
    }
    console.log('==================================================================');
    console.log('DRY-RUN complete. No Netlify API calls were made.');
    return;
  }

  // --deploy
  console.log('deploying via manifest-merge to Netlify...');
  const dep = await deployManifestMerge(files);
  console.log('------------------------------------------------------------------');
  console.log(`deploy id:            ${dep.id}`);
  console.log(`files uploaded:       ${dep.uploaded}`);
  console.log(`final state:          ${dep.state}`);
  console.log('==================================================================');
}

main().catch(err => {
  console.error('');
  console.error('FATAL:', err?.stack || err?.message || String(err));
  process.exit(1);
});
