#!/usr/bin/env python3
"""
GIES site refresh — autonomous content updater.

Scrapes giesweekly.substack.com archive + youtube.com/@giesweekly,
downloads cover images, regenerates dynamic blocks in index.html and
research/index.html between AUTO:* HTML comment markers, and (with
--deploy) zips the site and posts to the Netlify deploy endpoint.

Designed for GitHub Actions cron. Idempotent, fail-loud, fallback to
last-known-good state if any source is unreachable.

Usage:
    python tools/refresh.py              # update HTML only, no deploy
    python tools/refresh.py --deploy     # update HTML + push to Netlify
    python tools/refresh.py --dry-run    # parse sources, print summary, write nothing

Env vars (deploy mode):
    NETLIFY_PAT   Netlify Personal Access Token (required)
    NETLIFY_SITE_ID  Site ID (default: gies-jamaros)
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, unquote

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SITE_ROOT = Path(__file__).resolve().parent.parent
STATE_PATH = SITE_ROOT / 'tools' / 'state.json'

SUBSTACK_API = 'https://giesweekly.substack.com/api/v1/archive'
YT_HANDLE_URL = 'https://www.youtube.com/@giesweekly'
YT_FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id={cid}'
NETLIFY_DEPLOY_URL = 'https://api.netlify.com/api/v1/sites/{site_id}/deploys'
NETLIFY_SITE_ID_DEFAULT = '32bd51d3-9349-4db5-88bd-4b7dc87eb2a3'

UA = 'Mozilla/5.0 (compatible; GIES-Refresh/1.0; +https://gies.jamaros.com)'
HEADERS = {'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9'}

# How many issues to feature in each surface
N_LEAD = 1
N_RECENT = 5  # the 5 cards after the lead
N_WATCH = 3   # YouTube tiles on homepage (channel card stays static)

# Excluded folders when zipping for deploy
EXCLUDE_DIRS = {'_backup_', 'redesign-', 'tools', '.github', '.git', 'node_modules', '__pycache__'}

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class Issue:
    title: str
    url: str
    date: str       # ISO YYYY-MM-DD
    cover_url: str
    is_takeaway: bool = False
    is_special: bool = False
    week: Optional[str] = None       # "W16", "Monthly", "Special"
    short_title: str = ''            # condensed for cards

    @property
    def year(self) -> str:
        return self.date[:4] if self.date else ''

    @property
    def date_short(self) -> str:
        # "2026-04-24" -> "Apr 24"
        try:
            return datetime.strptime(self.date, '%Y-%m-%d').strftime('%b %d')
        except Exception:
            return self.date


@dataclass
class Video:
    id: str
    title: str
    url: str
    thumb_url: str
    is_short: bool = False


@dataclass
class State:
    yt_channel_id: Optional[str] = None
    last_lead_url: Optional[str] = None
    last_run: Optional[str] = None

    @classmethod
    def load(cls) -> 'State':
        if STATE_PATH.exists():
            return cls(**json.loads(STATE_PATH.read_text()))
        return cls()

    def save(self):
        STATE_PATH.write_text(json.dumps(self.__dict__, indent=2))


# ---------------------------------------------------------------------------
# Substack scrape
# ---------------------------------------------------------------------------

N_ARCHIVE = 30  # cap research-page archive at most-recent N issues


def fetch_substack_archive() -> list[Issue]:
    """Pull recent issues via Substack's paginated JSON API. Returns newest-first."""
    issues: list[Issue] = []
    offset = 0
    page_size = 25
    while len(issues) < N_ARCHIVE + 5:  # small buffer for filtering
        params = {'sort': 'new', 'search': '', 'offset': offset, 'limit': page_size}
        r = requests.get(SUBSTACK_API, params=params, headers=HEADERS, timeout=30)
        r.raise_for_status()
        page = r.json()
        if not isinstance(page, list) or not page:
            break
        for p in page:
            title = _clean(p.get('title', '') or '')
            slug = p.get('slug', '')
            url = p.get('canonical_url') or f'https://giesweekly.substack.com/p/{slug}'
            cover = p.get('cover_image') or ''
            date = ''
            pd = p.get('post_date') or ''
            if pd:
                try:
                    date = datetime.fromisoformat(pd.replace('Z', '+00:00')).date().isoformat()
                except Exception:
                    pass
            subtitle = p.get('subtitle', '') or ''
            is_takeaway = bool(re.search(r'monthly\s*takeaway', title + ' ' + subtitle, re.I)) or '/monthly-takeaway' in url or '/gies-monthly-takeaway' in url
            is_special = bool(re.search(r'special\s*report', title + ' ' + subtitle, re.I)) or '/gies-special' in url
            week = ''
            wm = (
                re.search(r'/p/(?:gies-)?w(\d{1,2})-?\d{4}', url)
                or re.search(r'\bGIES\s*W(\d{1,2})\b', subtitle, re.I)
                or re.search(r'\bW(\d{1,2})\b', subtitle)
                or re.search(r'\bW(\d{1,2})\b', title)
            )
            if wm:
                week = f'W{int(wm.group(1)):02d}'
            if is_takeaway:
                week = 'Monthly'
            if is_special:
                week = 'Special'
            short = title.split('|')[0].strip()
            if len(short) > 90:
                short = short[:87].rsplit(' ', 1)[0] + '…'
            issues.append(Issue(
                title=title,
                url=url,
                date=date,
                cover_url=cover,
                is_takeaway=is_takeaway,
                is_special=is_special,
                week=week,
                short_title=short,
            ))
        offset += page_size
    issues.sort(key=lambda i: (i.date or '0000'), reverse=True)
    return issues[:N_ARCHIVE]


def _legacy_html_scrape_unused() -> None:
    """Original HTML scraping (kept for reference). Not called."""
    pass


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------

def resolve_youtube_channel_id(state: State) -> Optional[str]:
    """Return UC… channel ID, caching in state.json."""
    if state.yt_channel_id:
        return state.yt_channel_id
    try:
        r = requests.get(YT_HANDLE_URL, headers=HEADERS, timeout=30, allow_redirects=True)
        r.raise_for_status()
        m = re.search(r'"channelId":"(UC[A-Za-z0-9_-]{20,30})"', r.text) or \
            re.search(r'channel/(UC[A-Za-z0-9_-]{20,30})', r.text)
        if m:
            state.yt_channel_id = m.group(1)
            return m.group(1)
    except Exception as e:
        print(f'WARN: yt channel resolve failed: {e}', file=sys.stderr)
    return None


def fetch_youtube_videos(channel_id: str, n: int = 5) -> list[Video]:
    """Parse the public uploads RSS feed. No API key needed."""
    url = YT_FEED_URL.format(cid=channel_id)
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    xml = r.text
    videos = []
    # Each entry is wrapped in <entry>...</entry>
    for em in re.finditer(r'<entry>(.*?)</entry>', xml, re.DOTALL):
        block = em.group(1)
        vid_m = re.search(r'<yt:videoId>([^<]+)</yt:videoId>', block)
        title_m = re.search(r'<title>([^<]+)</title>', block)
        if not vid_m or not title_m:
            continue
        vid = vid_m.group(1)
        title = _clean(title_m.group(1))
        # Length isn't in the feed; we infer Short by checking media:description for #shorts
        is_short = '#shorts' in block.lower() or '#short' in title.lower()
        videos.append(Video(
            id=vid,
            title=title,
            url=f'https://www.youtube.com/watch?v={vid}',
            thumb_url=f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg',
            is_short=is_short,
        ))
        if len(videos) >= n:
            break
    return videos


# ---------------------------------------------------------------------------
# Image download
# ---------------------------------------------------------------------------

def download_covers(issues: list[Issue], dest_dir: Path) -> dict[int, str]:
    """Download covers for issues[0..N_RECENT]; return {index: relative_path}."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    out: dict[int, str] = {}
    for i, iss in enumerate(issues[: N_LEAD + N_RECENT]):
        if not iss.cover_url:
            continue
        # Use the substackcdn URL as-is (its built-in size variant is fine)
        url = iss.cover_url
        local = dest_dir / f'issue-{i+1:02d}.webp'
        try:
            r = requests.get(url, headers=HEADERS, timeout=30)
            r.raise_for_status()
            local.write_bytes(r.content)
            out[i] = f'img/issues/{local.name}'
        except Exception as e:
            print(f'WARN: cover download failed for issue {i+1}: {e}', file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# HTML rendering
# ---------------------------------------------------------------------------

def render_lead(issue: Issue, cover_local: str) -> str:
    label = 'Monthly Takeaway' if issue.is_takeaway else ('Special Report' if issue.is_special else 'Latest Issue')
    cover_class = 'lead-cover is-takeaway' if issue.is_takeaway else 'lead-cover'
    week_label = issue.week or '—'
    date_label = issue.date_short
    # Lede: derive a 1-sentence opener from the title (keep original for now;
    # script can be extended later to fetch post body).
    lede = (
        f"Latest GIES issue covers: {issue.short_title}. "
        "Read the full analysis on Substack for our take on what this means for executives, investors, and senior analysts."
    )
    return (
        f'    <a class="{cover_class}" href="{_h(issue.url)}">\n'
        f'      <img src="{cover_local}" alt="{_h(issue.short_title)}" loading="eager">\n'
        f'    </a>\n'
        f'    <div class="lead-text">\n'
        f'      <div class="lead-meta">\n'
        f'        <span class="issue-no">Issue {week_label} / {issue.year}</span>\n'
        f'        <span>{date_label}, {issue.year}</span>\n'
        f'        <span>5 min read</span>\n'
        f'      </div>\n'
        f'      <h3><a href="{_h(issue.url)}">{_h(issue.short_title)}</a></h3>\n'
        f'      <p class="lead-lede">{_h(lede)}</p>\n'
        f'      <a class="lead-cta" href="{_h(issue.url)}">Read on Substack\n'
        f'        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>\n'
        f'      </a>\n'
        f'    </div>'
    )


def render_recent(issues: list[Issue], covers: dict[int, str]) -> str:
    cards = []
    # issues[0] is the lead; cards are issues[1..N_RECENT]
    for i, iss in enumerate(issues[1: 1 + N_RECENT]):
        idx = i + 1  # original index in issues list
        cover_local = covers.get(idx, 'img/issues/issue-{:02d}.webp'.format(idx + 1))
        klass = 'issue-card is-takeaway' if iss.is_takeaway else ('issue-card is-special' if iss.is_special else 'issue-card')
        cards.append(
            f'    <a class="{klass}" href="{_h(iss.url)}">\n'
            f'      <div class="ic-cover"><img src="{cover_local}" alt="" loading="lazy"></div>\n'
            f'      <div class="ic-body">\n'
            f'        <div class="ic-meta"><span class="ic-week">{iss.week or ""}</span> &middot; {iss.date_short}</div>\n'
            f'        <h4>{_h(iss.short_title)}</h4>\n'
            f'        <span class="ic-arrow">Read &rarr;</span>\n'
            f'      </div>\n'
            f'    </a>'
        )
    return '\n\n'.join(cards)


def render_watch(videos: list[Video]) -> Optional[str]:
    if not videos:
        return None
    tiles = []
    for v in videos[:N_WATCH]:
        tag = 'Short' if v.is_short else 'Video'
        tiles.append(
            f'    <a class="video-tile" href="{_h(v.url)}" target="_blank" rel="noopener">\n'
            f'      <div class="vt-thumb" style="background-image:url(\'{_h(v.thumb_url)}\')"></div>\n'
            f'      <div class="vt-overlay"><span class="vt-tag">{tag}</span><span class="vt-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg></span><div class="vt-title">{_h(v.title)}</div></div>\n'
            f'    </a>'
        )
    return '\n\n'.join(tiles)


def render_research(issues: list[Issue]) -> str:
    by_year: dict[str, list[Issue]] = {}
    for iss in issues:
        if not iss.year:
            continue
        by_year.setdefault(iss.year, []).append(iss)

    blocks = []
    for year in sorted(by_year.keys(), reverse=True):
        items = by_year[year]
        meta = (
            f'{len(items)} issue' + ('' if len(items) == 1 else 's')
        )
        if year == '2024':
            meta = f'Inaugural year &middot; {meta}'
        rows = []
        for iss in items:
            klass = 'row'
            if iss.is_takeaway:
                klass += ' is-takeaway'
            if iss.is_special:
                klass += ' is-special'
            rows.append(
                f'<div class="{klass}"><span class="week">{iss.week or ""}</span>'
                f'<a class="title" href="{_h(iss.url)}">{_h(iss.short_title)}</a>'
                f'<span class="date">{iss.date}</span></div>'
            )
        blocks.append(
            f'<div class="year-head"><h2>{year}</h2><span class="year-meta">{meta}</span></div>\n'
            f'<div class="issues">\n' + '\n'.join(rows) + '\n</div>'
        )
    return '\n\n'.join(blocks)


def render_itemlist(issues: list[Issue]) -> str:
    items = []
    for i, iss in enumerate(issues[:10], start=1):
        items.append({
            '@type': 'ListItem',
            'position': i,
            'url': iss.url,
            'name': iss.short_title or iss.title,
        })
    obj = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        'name': 'GIES Research Archive',
        'description': 'Complete archive of GIES weekly issues, monthly takeaways, and special reports.',
        'url': 'https://gies.jamaros.com/research/',
        'numberOfItems': len(issues),
        'itemListElement': items,
    }
    return json.dumps(obj, indent=2)


# ---------------------------------------------------------------------------
# HTML mutation
# ---------------------------------------------------------------------------

MARKER_RE = {
    'LEAD':     re.compile(r'(<!-- AUTO:LEAD -->)(.*?)(<!-- /AUTO:LEAD -->)', re.DOTALL),
    'RECENT':   re.compile(r'(<!-- AUTO:RECENT -->)(.*?)(<!-- /AUTO:RECENT -->)', re.DOTALL),
    'WATCH':    re.compile(r'(<!-- AUTO:WATCH -->)(.*?)(<!-- /AUTO:WATCH -->)', re.DOTALL),
    'ITEMLIST': re.compile(r'(<!-- AUTO:ITEMLIST -->)(.*?)(<!-- /AUTO:ITEMLIST -->)', re.DOTALL),
    'RESEARCH': re.compile(r'(<!-- AUTO:RESEARCH -->)(.*?)(<!-- /AUTO:RESEARCH -->)', re.DOTALL),
}


def replace_block(src: str, key: str, new_inner: str) -> str:
    pattern = MARKER_RE[key]
    if not pattern.search(src):
        raise RuntimeError(f'Marker {key} not found in source')
    return pattern.sub(lambda m: f'{m.group(1)}\n{new_inner}\n{m.group(3)}', src)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _first(xs):
    return xs[0] if xs else ''


def _clean(s: str) -> str:
    return re.sub(r'\s+', ' ', s).strip()


def _h(s: str) -> str:
    return (
        s.replace('&', '&amp;')
         .replace('"', '&quot;')
         .replace('<', '&lt;')
         .replace('>', '&gt;')
    )


# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

def build_zip(out_path: Path):
    """Zip the site, excluding tools, .github, backup folders."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in SITE_ROOT.rglob('*'):
            if p.is_dir():
                continue
            rel = p.relative_to(SITE_ROOT)
            top = rel.parts[0]
            if any(top.startswith(prefix) for prefix in EXCLUDE_DIRS):
                continue
            z.write(p, str(rel))


def deploy_to_netlify(zip_path: Path):
    pat = os.environ.get('NETLIFY_PAT')
    site_id = os.environ.get('NETLIFY_SITE_ID', NETLIFY_SITE_ID_DEFAULT)
    if not pat:
        raise RuntimeError('NETLIFY_PAT env var is required for --deploy')
    url = NETLIFY_DEPLOY_URL.format(site_id=site_id)
    with open(zip_path, 'rb') as f:
        r = requests.post(url, headers={
            'Authorization': f'Bearer {pat}',
            'Content-Type': 'application/zip',
        }, data=f.read(), timeout=120)
    r.raise_for_status()
    data = r.json()
    deploy_id = data.get('id')
    print(f'Netlify deploy uploaded: id={deploy_id} state={data.get("state")}')
    # Poll until ready
    for _ in range(20):
        rs = requests.get(f'https://api.netlify.com/api/v1/deploys/{deploy_id}',
                          headers={'Authorization': f'Bearer {pat}'}, timeout=30)
        rs.raise_for_status()
        state = rs.json().get('state')
        if state in ('ready', 'error', 'rejected'):
            print(f'Netlify deploy state: {state}')
            if state != 'ready':
                raise RuntimeError(f'Deploy failed: {state}')
            return data
        time.sleep(3)
    raise RuntimeError('Deploy timed out before ready')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--deploy', action='store_true', help='zip and POST to Netlify after refresh')
    ap.add_argument('--dry-run', action='store_true', help='parse sources, print summary, write nothing')
    args = ap.parse_args()

    state = State.load()

    print('Fetching Substack archive...')
    issues = fetch_substack_archive()
    print(f'  parsed {len(issues)} issues; latest: {issues[0].title if issues else "<none>"}')
    if not issues:
        raise SystemExit('No issues parsed; aborting (will keep last good HTML)')

    print('Resolving YouTube channel...')
    cid = resolve_youtube_channel_id(state)
    videos: list[Video] = []
    if cid:
        print(f'  channel id: {cid}')
        try:
            videos = fetch_youtube_videos(cid, n=5)
            print(f'  parsed {len(videos)} videos; latest: {videos[0].title if videos else "<none>"}')
        except Exception as e:
            print(f'WARN: YouTube fetch failed: {e}', file=sys.stderr)
    else:
        print('WARN: could not resolve YouTube channel id; watch row will be left unchanged', file=sys.stderr)

    if args.dry_run:
        print('\n--- DRY RUN SUMMARY ---')
        for i, iss in enumerate(issues[:8]):
            print(f'  [{i:>2}] {iss.date}  {iss.week or "—":>7}  {iss.short_title[:80]}')
        for v in videos[:5]:
            print(f'  YT  {v.id}  {"SHORT" if v.is_short else "VIDEO"}  {v.title[:80]}')
        return

    print('\nDownloading covers...')
    covers = download_covers(issues, SITE_ROOT / 'img' / 'issues')
    print(f'  saved {len(covers)} covers')

    # ----- index.html -----
    idx_path = SITE_ROOT / 'index.html'
    src = idx_path.read_text()

    src = replace_block(src, 'LEAD', render_lead(issues[0], covers.get(0, 'img/issues/issue-01.webp')))
    src = replace_block(src, 'RECENT', render_recent(issues, covers))
    watch_html = render_watch(videos)
    if watch_html:
        src = replace_block(src, 'WATCH', watch_html)
    else:
        print('  watch row left unchanged (no video data)', file=sys.stderr)

    idx_path.write_text(src)
    print(f'  index.html updated ({len(src)}B)')

    # ----- research/index.html -----
    res_path = SITE_ROOT / 'research' / 'index.html'
    src = res_path.read_text()
    src = replace_block(src, 'ITEMLIST', render_itemlist(issues))
    src = replace_block(src, 'RESEARCH', render_research(issues))
    res_path.write_text(src)
    print(f'  research/index.html updated ({len(src)}B)')

    # State
    state.last_lead_url = issues[0].url
    state.last_run = datetime.utcnow().isoformat() + 'Z'
    state.save()

    # ----- Deploy -----
    if args.deploy:
        zip_path = Path('/tmp') / 'gies-deploy.zip'
        print(f'\nZipping site -> {zip_path}')
        build_zip(zip_path)
        print(f'  zip size: {zip_path.stat().st_size}B')
        print('Deploying to Netlify...')
        deploy_to_netlify(zip_path)
        print('Done.')
    else:
        print('\nSkipping deploy (use --deploy to push to Netlify).')


if __name__ == '__main__':
    main()
