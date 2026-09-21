// Local smoke test for tools/name-tool-worker.js "tags" mode: runs the worker module in Node with an in-memory KV
// and the key from %USERPROFILE%\.anthropic_key (never printed). Usage: node tools/name-tool-worker-test.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const keyFile = process.env.ANTHROPIC_KEY_FILE || path.join(process.env.USERPROFILE || process.env.HOME || "", ".anthropic_key");
const key = process.env.ANTHROPIC_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "");
if (!key) { console.error("no API key"); process.exit(1); }

const store = new Map();
const env = {
  ANTHROPIC_API_KEY: key,
  KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
};
const worker = (await import(pathToFileURL(path.resolve("tools/name-tool-worker.js")).href)).default;

const pitches = [
  "you and your friends just woke up, the house is a mess and your parents are on their way home. Tidy up fast or you are grounded!",
  "a gritty post-apocalyptic role playing game that allows players to discover the horrors of the apocalypse through a harsh struggle for survival.",
];
for (const pitch of pitches) {
  for (const pass of [1, 2]) {
    const req = new Request("https://name-tool.arkeod.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://giesweekly.com", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ mode: "tags", pitch }),
    });
    const t0 = Date.now();
    const res = await worker.fetch(req, env);
    const body = await res.text();
    console.log(`pass ${pass} | ${Date.now() - t0} ms | http ${res.status} | ${body.slice(0, 300)}`);
  }
}
console.log("KV keys:", [...store.keys()].map((k) => k.slice(0, 12)).join(", "));
