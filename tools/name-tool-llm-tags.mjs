// Benchmark for option 1: a Claude pre-pass that turns a pitch into Steam tags + two comps,
// which are then appended to the pitch and fed to the unchanged matcher (stated-tag path).
//
//   node tools/name-tool-llm-tags.mjs --cases tools/name-tool-eval-cases.json --model claude-sonnet-5 [--out DIR] [--concurrency 4]
//
// Credentials: $ANTHROPIC_API_KEY, else the file named by $ANTHROPIC_KEY_FILE, else %USERPROFILE%\.anthropic_key.
// The key is never printed. Outputs: <out>/<cases-basename>.<model>.tags.json (raw LLM answers),
// <out>/<cases-basename>.<model>.aug.json (augmented cases: pitch + tags + comps, target unchanged),
// <out>/<cases-basename>.<model>.tagsonly.json (tags + comps only, no pitch text).
// Score them with: node tools/name-tool-eval.mjs --score <aug file>

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i >= 0 ? process.argv[i + 1] : d; };

const casesPath = arg("cases");
const model = arg("model", "claude-sonnet-5");
const outDir = arg("out", path.join(site, "tools", "llm-bench"));
const concurrency = +arg("concurrency", 4);
if (!casesPath) { console.error("--cases required"); process.exit(1); }

let key = process.env.ANTHROPIC_API_KEY || "";
if (!key) {
  const kf = process.env.ANTHROPIC_KEY_FILE || path.join(process.env.USERPROFILE || process.env.HOME || "", ".anthropic_key");
  if (fs.existsSync(kf)) key = fs.readFileSync(kf, "utf8").replace(/^﻿/, "").trim().replace(/^["']|["']$/g, "").trim();
}
if (!key) { console.error("no API key: set ANTHROPIC_API_KEY or create %USERPROFILE%\\.anthropic_key"); process.exit(1); }

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(site, "its-in-the-name", "similar.js"), "utf8") + ";this.T=NL_TAGS;this.G=NL_GAMES;", ctx);
const TAGS = ctx.T;
const tagByLower = new Map(TAGS.map((t) => [t.toLowerCase(), t]));
const nameById = new Map(ctx.G.map((g) => { const p = g.split("|"); return [p[0], p[1]]; }));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

const SYSTEM = `You classify a video game pitch into Steam's tag vocabulary so a comparables matcher can use it.

Return ONLY a JSON object, no prose, no code fence:
{"tags": [...], "perspective": ... , "mode": ..., "comps": [...]}

Rules:
- "tags": 3 to 6 tag names copied EXACTLY from the tag list below, most defining first. Prefer genre and mechanic tags (what the player does) over tone or setting. Include tone or setting tags only after the genre is covered.
- "perspective": one of First-Person, Third Person, Top-Down, Isometric, Side Scroller, 2D, 3D, Pixel Graphics, Hand-drawn, Anime, VR, or null when the pitch neither states nor strongly implies it.
- "mode": one of Singleplayer, Multiplayer, Co-op, Online Co-Op, Local Co-Op, Local Multiplayer, PvP, Massively Multiplayer, or null when not stated.
- "comps": up to 2 real, released Steam games that play like this pitch, exact official titles. Prefer well-known titles with two or more words. If you recognize the specific game the pitch describes, do NOT name it; name two OTHER similar games.
- Never invent tags. Never output a tag that is not in the list.

Tag list:
${TAGS.join(", ")}`;

async function callClaude(pitch, attempt = 0) {
  const body = {
    model, max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low" },
    messages: [{ role: "user", content: `Pitch:\n${pitch}` }],
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if ((r.status === 429 || r.status >= 500) && attempt < 5) {
    const wait = Math.min(30000, 1500 * 2 ** attempt);
    await new Promise((res) => setTimeout(res, wait));
    return callClaude(pitch, attempt + 1);
  }
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const usage = d.usage || {};
  return { text, usage, stop: d.stop_reason };
}

function parse(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function clean(ans) {
  const tags = [];
  for (const t of (ans?.tags || [])) { const k = tagByLower.get(String(t).toLowerCase()); if (k && !tags.includes(k)) tags.push(k); }
  const p = ans?.perspective ? tagByLower.get(String(ans.perspective).toLowerCase()) : null;
  const mo = ans?.mode ? tagByLower.get(String(ans.mode).toLowerCase()) : null;
  const comps = (ans?.comps || []).map(String).filter((c) => c.trim()).slice(0, 2);
  return { tags: tags.slice(0, 6), perspective: p || null, mode: mo || null, comps };
}

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const base = path.basename(casesPath, ".json");
const results = new Array(cases.length);
let done = 0, inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;

async function worker(idx) {
  for (let i = idx; i < cases.length; i += concurrency) {
    const c = cases[i];
    try {
      const { text, usage } = await callClaude(c.pitch);
      inTok += usage.input_tokens || 0; outTok += usage.output_tokens || 0;
      cacheRead += usage.cache_read_input_tokens || 0; cacheWrite += usage.cache_creation_input_tokens || 0;
      const ans = clean(parse(text));
      results[i] = { id: c.id, target: c.target ?? c.id, ...ans, raw: text.slice(0, 600) };
    } catch (e) {
      results[i] = { id: c.id, target: c.target ?? c.id, tags: [], perspective: null, mode: null, comps: [], error: String(e.message || e) };
    }
    done++;
    if (done % 10 === 0 || done === cases.length) console.error(`${done}/${cases.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, (_, k) => worker(k)));

// augmented cases: original pitch + tags + comps (comps that equal the target's own title are dropped)
const aug = [], tagsOnly = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], r = results[i];
  const targetName = norm(nameById.get(String(r.target)) || "");
  const comps = r.comps.filter((x) => norm(x) !== targetName);
  const parts = [...r.tags];
  if (r.perspective && !parts.includes(r.perspective)) parts.push(r.perspective);
  if (r.mode && !parts.includes(r.mode)) parts.push(r.mode);
  const tagLine = parts.join(", ") + (parts.length ? "." : "");
  const compLine = comps.length ? ` Like ${comps.join(" meets ")}.` : "";
  aug.push({ id: c.id, target: c.target ?? c.id, pitch: `${c.pitch.trim()} ${tagLine}${compLine}`.trim() });
  tagsOnly.push({ id: c.id, target: c.target ?? c.id, pitch: `${tagLine}${compLine}`.trim() || c.pitch });
}
const stem = `${base}.${model}`;
fs.writeFileSync(path.join(outDir, `${stem}.tags.json`), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(outDir, `${stem}.aug.json`), JSON.stringify(aug, null, 1));
fs.writeFileSync(path.join(outDir, `${stem}.tagsonly.json`), JSON.stringify(tagsOnly, null, 1));
const errors = results.filter((r) => r.error).length;
const empty = results.filter((r) => !r.error && !r.tags.length).length;
console.log(JSON.stringify({ model, cases: cases.length, errors, emptyTagSets: empty, usage: { input: inTok, output: outTok, cacheRead, cacheWrite }, out: outDir }));
