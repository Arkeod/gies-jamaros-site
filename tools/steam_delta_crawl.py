#!/usr/bin/env python3
"""Crawl Steam store search (released games, newest first) down to a cutoff date.

Fills the gap left by the FronkonGames dataset, whose catalog crawl stopped
around late February 2026. No API key needed: the public search JSON endpoint
carries appid, name and release date, which is all the Name Your Game word
analysis requires. Writes one JSON object per line: {"appid","name","date"}.

Usage: python steam_delta_crawl.py <cutoff YYYY-MM-DD> <out.jsonl>
"""
import urllib.request, json, re, sys, time

MON = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
DRE = re.compile(r"([A-Z][a-z]{2})\w*\s+(\d{1,2}),\s+(\d{4})")
ROW = re.compile(r'data-ds-appid="(\d+)".*?title">([^<]+)</span>.*?search_released[^>]*>\s*([^<]*?)\s*</div>', re.DOTALL)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

def iso(txt):
    m = DRE.search(txt)
    if not m or m.group(1) not in MON:
        return None
    return f"{int(m.group(3)):04d}-{MON[m.group(1)]:02d}-{int(m.group(2)):02d}"

def main(cutoff, outpath):
    seen = set()
    out = open(outpath, "w", encoding="utf-8")
    start, kept, stop = 0, 0, False
    while not stop:
        url = (f"https://store.steampowered.com/search/results/?query&start={start}&count=50"
               f"&sort_by=Released_DESC&category1=998&infinite=1&cc=us&l=english")
        for attempt in range(4):
            try:
                d = json.loads(urllib.request.urlopen(
                    urllib.request.Request(url, headers=UA), timeout=30).read())
                break
            except Exception as e:
                if attempt == 3:
                    raise
                time.sleep(5 * (attempt + 1))
        rows = ROW.findall(d["results_html"])
        if not rows:
            break
        dates = []
        for appid, name, dtxt in rows:
            di = iso(dtxt)
            if di:
                dates.append(di)
            if not di or di < cutoff or appid in seen:
                continue
            seen.add(appid)
            out.write(json.dumps({"appid": int(appid), "name": name, "date": di},
                                 ensure_ascii=False) + "\n")
            kept += 1
        if dates and max(dates) < cutoff:
            stop = True
        start += 50
        if start % 1000 == 0:
            print(f"  start={start} kept={kept} last={dates[-1] if dates else '?'}", flush=True)
        time.sleep(0.7)
    out.close()
    print(f"done: {kept} games since {cutoff} ({start//50} requests)")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
