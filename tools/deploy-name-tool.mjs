// Manifest-merge deploy of one or more local files to giesweekly.com (Netlify).
// Same pattern as gen_superset.mjs deployManifestMerge(): GET live manifest, overlay only the given
// paths, POST a full manifest, upload what Netlify asks for, poll until ready. Every other live file
// is preserved by sha. Token comes from $NETLIFY_PAT only.
//
//   node tools/deploy-name-tool.mjs <localFile>=<sitePath> [...]
//   e.g. node tools/deploy-name-tool.mjs its-in-the-name/index.improved.html=/its-in-the-name/index.html

import fs from "node:fs";
import { createHash } from "node:crypto";

const SITE_ID = process.env.NETLIFY_SITE_ID || "32bd51d3-9349-4db5-88bd-4b7dc87eb2a3";
const PAT = process.env.NETLIFY_PAT || "";
if (!PAT) { console.error("NETLIFY_PAT missing"); process.exit(1); }
const auth = { Authorization: `Bearer ${PAT}` };

const pairs = process.argv.slice(2).map((a) => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)]; });
if (!pairs.length || pairs.some(([f, p]) => !f || !p.startsWith("/"))) { console.error("usage: local=/site/path ..."); process.exit(1); }
if (pairs.length > 10) { console.error("refusing bulk deploy (>10 files)"); process.exit(1); }

const files = new Map();
for (const [local, sitePath] of pairs) {
  const body = fs.readFileSync(local);
  if (!body.toString("utf8").trimEnd().endsWith("</html>") && sitePath.endsWith(".html")) { console.error(`${local} does not end with </html>`); process.exit(1); }
  files.set(sitePath, body);
}

const mRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/files`, { headers: auth });
if (!mRes.ok) throw new Error(`manifest ${mRes.status}: ${await mRes.text()}`);
const manifest = {};
for (const f of await mRes.json()) manifest[f.path] = f.sha;
const liveCount = Object.keys(manifest).length;
for (const [p, body] of files) {
  const sha = createHash("sha1").update(body).digest("hex");
  console.error(`${p}: live sha ${manifest[p] ? manifest[p].slice(0, 8) : "(new)"} -> ${sha.slice(0, 8)}`);
  manifest[p] = sha;
}
console.error(`manifest: ${liveCount} live files, ${Object.keys(manifest).length} after merge`);

const cRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/deploys`, {
  method: "POST", headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ files: manifest, async: false }),
});
if (!cRes.ok) throw new Error(`create deploy ${cRes.status}: ${await cRes.text()}`);
const deploy = await cRes.json();
const required = deploy.required || [];
console.error(`deploy ${deploy.id}: ${required.length} files need upload`);

let uploaded = 0;
for (const [p, body] of files) {
  const sha = createHash("sha1").update(body).digest("hex");
  if (!required.includes(sha)) continue;
  const uRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}/files${p}`, {
    method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body,
  });
  if (!uRes.ok) throw new Error(`upload ${p} ${uRes.status}: ${await uRes.text()}`);
  uploaded++;
}

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const sRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deploy.id}`, { headers: auth });
  const cur = await sRes.json();
  if (cur.state === "ready") { console.log(JSON.stringify({ id: deploy.id, uploaded, state: cur.state, url: cur.ssl_url || cur.url })); process.exit(0); }
  if (cur.state === "error" || cur.state === "rejected") throw new Error(`deploy ${cur.state}`);
}
throw new Error("deploy did not reach ready in ~60s");
