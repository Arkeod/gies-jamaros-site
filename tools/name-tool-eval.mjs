// Headless harness for the "Games like yours" matcher in its-in-the-name/index.html.
// Runs the page's own inline script (verbatim, via vm) against similar.js + words.js with a stub DOM,
// so results are byte-identical to the browser as long as index.html is the deployed build.
//
//   node tools/name-tool-eval.mjs --pitch "..." [--target APPID] [--html path/to/index.html]
//   node tools/name-tool-eval.mjs --cases cases.json [--html ...]      # [{id, pitch, target}]
//   node tools/name-tool-eval.mjs --sample 20 --seed 7 --minrev 200    # random catalog games
//
// Output is JSON on stdout.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const htmlPath = arg("html", path.join(site, "its-in-the-name", "index.html"));

function fakeEl(store = {}) {
  const el = {};
  return new Proxy(el, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === "classList") return { add() {}, remove() {}, contains() { return false; }, toggle() {} };
      if (p === "value") return t.value ?? "";
      if (p === "style") return {};
      if (typeof p === "symbol") return undefined;
      return (...a) => fakeEl();
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

function buildContext() {
  const els = new Map();
  const byId = (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); };
  const document = {
    getElementById: byId,
    createElement: () => fakeEl(),
    createTextNode: (t) => ({ textContent: t }),
    querySelector: () => fakeEl(),
    body: fakeEl(),
  };
  const ctx = { window: {}, document, console, setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout, AbortController, fetch: () => Promise.reject(new Error("no network in harness")) };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(site, "name-your-game", "words.js"), "utf8"), ctx, { filename: "words.js" });
  vm.runInContext(fs.readFileSync(path.join(site, "its-in-the-name", "similar.js"), "utf8"), ctx, { filename: "similar.js" });
  const html = fs.readFileSync(htmlPath, "utf8");
  const m = html.match(/<script src="\/name-your-game\/words\.js"><\/script>\s*<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("inline tool script not found in " + htmlPath);
  vm.runInContext(m[1], ctx, { filename: "index.html" });
  // capture the final comparables list instead of rendering it
  vm.runInContext(`
    var __sims=null, __contentTokens=null, __tokens=null;
    renderNames=function(ct,s){__contentTokens=ct;__sims=s;};
    requestAI=function(raw,t,ct,s){__tokens=t;};
  `, ctx);
  return { ctx, byId };
}

function fmtRev(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : (v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v)); }

async function runPitch(env, pitch, target) {
  const { ctx, byId } = env;
  byId("pitch").value = pitch;
  vm.runInContext("__sims=null;__tokens=null;analyze();", ctx);
  await new Promise((r) => setTimeout(r, 15)); // let the (rejected) tag fetch settle so requestAI runs
  const sims = vm.runInContext("__sims", ctx);
  const tokens = vm.runInContext("__tokens", ctx);
  const nicheTags = vm.runInContext("nicheTags", ctx);
  if (!sims) return { pitch, error: "no sims" };
  const used = new Set();
  const take = (pool, n) => { const out = []; for (const g of pool) { if (used.has(g.id)) continue; used.add(g.id); out.push(g); if (out.length >= n) break; } return out; };
  const rel = sims.slice(0, 40);
  const row = (g) => ({ id: g.id, name: g.name, yr: g.yr, rat: g.rat, rev: g.rev });
  const cols = {
    closest_2020: take(sims.filter((g) => g.yr >= 2020), 4).map(row),
    best_reviewed: take([...rel].sort((a, b) => b.rat - a.rat || b.rev - a.rev), 4).map(row),
    most_reviewed: take([...rel].sort((a, b) => b.rev - a.rev), 4).map(row),
  };
  const mentioned = sims.filter((g) => g.score === 999).map(row);
  let targetRank = null, targetRankExPins = null, targetInCatalog = null;
  if (target) {
    const i = sims.findIndex((g) => String(g.id) === String(target));
    targetRank = i >= 0 ? i + 1 : null;
    const unpinned = sims.filter((g) => g.score !== 999);
    const j = unpinned.findIndex((g) => String(g.id) === String(target));
    targetRankExPins = j >= 0 ? j + 1 : null;
    targetInCatalog = vm.runInContext(`NL_GAMES.some(g=>g.split("|")[0]==="${String(target)}")`, ctx);
  }
  return {
    pitch, target: target ?? null, targetInCatalog, targetRank, targetRankExPins,
    matches: sims.length, nicheTags, mentioned, tokens, cols,
    gate: (byId("gate").innerHTML || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || null,
    readTags: byId("readtags").textContent || null,
    top10: sims.slice(0, 10).map((g) => ({ ...row(g), score: +g.score.toFixed(2), cov: g.cov })),
  };
}

function sample(env, n, seed, minrev) {
  const games = vm.runInContext("NL_GAMES", env.ctx).map((g) => g.split("|")).filter((p) => +p[4] >= minrev);
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const out = [];
  const seen = new Set();
  while (out.length < n) {
    const p = games[Math.floor(rnd() * games.length)];
    if (seen.has(p[0])) continue;
    seen.add(p[0]);
    out.push({ id: p[0], name: p[1], yr: +p[2], rat: +p[3], rev: +p[4], url: `https://store.steampowered.com/app/${p[0]}/` });
  }
  return out;
}

// Objective score for a cases file: self-match rank, niche-tag overlap with the target's own tags,
// and mean tag-Jaccard between the target and the displayed comps (target itself excluded).
async function scoreCases(env, cases) {
  const tagsOf = new Map(vm.runInContext("NL_GAMES", env.ctx).map((g) => { const p = g.split("|"); return [p[0], new Set(p[5].split(".").map(Number))]; }));
  const NL_TAGS = vm.runInContext("NL_TAGS", env.ctx);
  const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
  const out = [];
  for (const c of cases) {
    const r = await runPitch(env, c.pitch, c.target ?? c.id);
    const tt = tagsOf.get(String(r.target)) || new Set();
    const shown = [...r.cols.closest_2020, ...r.cols.best_reviewed, ...r.cols.most_reviewed].filter((g) => String(g.id) !== String(r.target));
    const compJac = shown.length ? shown.reduce((a, g) => a + jac(tt, tagsOf.get(String(g.id)) || new Set()), 0) / shown.length : 0;
    const nicheOverlap = (r.nicheTags || []).filter((t) => tt.has(NL_TAGS.indexOf(t))).length;
    out.push({ id: c.id, targetRank: r.targetRank, targetRankExPins: r.targetRankExPins, matches: r.matches, nicheOverlap, compJac: +compJac.toFixed(3), shown: shown.length, mentioned: r.mentioned.map((m) => m.name) });
  }
  const n = out.length;
  const sum = (f) => out.reduce((a, x) => a + f(x), 0);
  const summary = {
    n, found: sum((x) => x.targetRank != null ? 1 : 0), top1: sum((x) => x.targetRankExPins === 1 ? 1 : 0), top10: sum((x) => x.targetRankExPins != null && x.targetRankExPins <= 10 ? 1 : 0),
    mrr: +(sum((x) => x.targetRankExPins ? 1 / x.targetRankExPins : 0) / n).toFixed(3),
    nicheOverlap: +(sum((x) => x.nicheOverlap) / n).toFixed(2), compJac: +(sum((x) => x.compJac) / n).toFixed(3),
    spuriousMentions: sum((x) => x.mentioned.length),
  };
  return { summary, cases: out };
}

const env = buildContext();
if (arg("score")) {
  const cases = JSON.parse(fs.readFileSync(arg("score"), "utf8"));
  const res = await scoreCases(env, cases);
  if (process.argv.includes("--verbose")) console.log(JSON.stringify(res, null, 1));
  else console.log(JSON.stringify(res.summary));
} else if (arg("sample")) {
  console.log(JSON.stringify(sample(env, +arg("sample"), +arg("seed", 1), +arg("minrev", 200)), null, 2));
} else if (arg("cases")) {
  const cases = JSON.parse(fs.readFileSync(arg("cases"), "utf8"));
  const outs = []; for (const c of cases) outs.push({ id: c.id, ...(await runPitch(env, c.pitch, c.target ?? c.id)) }); console.log(JSON.stringify(outs, null, 2));
} else if (arg("pitch")) {
  console.log(JSON.stringify(await runPitch(env, arg("pitch"), arg("target")), null, 2));
} else {
  console.error("usage: --pitch TEXT [--target APPID] | --cases FILE | --sample N [--seed S] [--minrev R]");
  process.exit(1);
}
