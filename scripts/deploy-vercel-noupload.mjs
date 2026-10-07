/**
 * Minimal-upload deploy — the Hobby plan caps uploads at 5,000/day and the
 * window is nearly spent, so this variant:
 *   1. builds the same manifest (git ls-files minus excludes)
 *   2. uploads ONLY the files whose bytes changed since the last full upload
 *      (everything else already lives on Vercel, sha-addressed)
 *   3. creates the deployment referencing ALL manifest shas
 *   4. polls to READY/ERROR
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const PROJECT = "prj_6pNaqSVELOpQ5uvQsfLW6kjLPudq";
const ROOT = process.cwd();

const EXCLUDE = [
  /^scripts\//,
  /^tool-results\//,
  /^tsconfig\.tsbuildinfo$/,
  /^db\/anilist-cache\//,
  /^db\/zoko-stream\//,
  /^db\/megaplay\//, // pure resolved-stream cache — prod re-resolves live; 2,355 files blew the upload budget
  /^dev\.log$/,
  /^server\.log$/,
];

// files whose CURRENT bytes are known-missing from the server (the Sep 7
// full upload died mid-loop; Sep 8's partial covered db/*; the 10 src edits
// went up in the previous run)
const MUST_UPLOAD = [
  // the packaged catalog DB (no-op when the sha already exists server-side)
  "src/db/custom.db",
];

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return res;
};

// ---------- manifest ----------
const all = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  .split("\n")
  .filter(Boolean);
const manifest = all.filter((f) => !EXCLUDE.some((re) => re.test(f)));
console.log(`manifest: ${manifest.length} of ${all.length} tracked files`);
const missing = manifest.filter((f) => !statSync(join(ROOT, f)).isFile());
if (missing.length) { console.error("missing:", missing); process.exit(1); }

// ---------- upload only what changed ----------
let uploaded = 0;
for (const rel of MUST_UPLOAD) {
  if (!manifest.includes(rel)) { console.error(`MUST_UPLOAD not in manifest: ${rel}`); process.exit(1); }
  const buf = readFileSync(join(ROOT, rel));
  const sha = createHash("sha1").update(buf).digest("hex");
  const res = await api("/v2/files", {
    method: "POST",
    headers: { "x-vercel-digest": sha, "Content-Type": "application/octet-stream" },
    body: buf,
  });
  const ok = res.ok || res.status === 409;
  console.log(`upload ${rel}: ${res.status}${ok ? "" : " " + (await res.text()).slice(0, 160)}`);
  if (!ok) process.exit(1);
  uploaded++;
}
console.log(`uploaded ${uploaded} changed files`);

// ---------- create deployment ----------
const shaOf = new Map(); // sha -> rel (first file wins; caches can collide-free)
const files = manifest.map((rel) => {
  const buf = readFileSync(join(ROOT, rel));
  const sha = createHash("sha1").update(buf).digest("hex");
  if (!shaOf.has(sha)) shaOf.set(sha, rel);
  return { file: rel, sha, size: buf.length };
});

async function uploadFile(rel) {
  const buf = readFileSync(join(ROOT, rel));
  const sha = createHash("sha1").update(buf).digest("hex");
  const res = await api("/v2/files", {
    method: "POST",
    headers: { "x-vercel-digest": sha, "Content-Type": "application/octet-stream" },
    body: buf,
  });
  const ok = res.ok || res.status === 409;
  console.log(`upload ${rel}: ${res.status}${ok ? "" : " " + (await res.text()).slice(0, 160)}`);
  return ok;
}

// Cache files (db/anivexa-cache, db/anikoto, custom.db) churn while the dev
// server runs, so a manifest computed a moment ago can reference shas the
// server hasn't seen. On `missing_files`, hash-match the reported shas back
// to local files, upload them, retry — up to 3 rounds.
async function createDeployment() {
  for (let round = 0; round < 3; round++) {
    const createRes = await api("/v13/deployments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "temporary-spry-granite-1f0h7ae",
        target: "production",
        files,
        meta: { deployedBy: "api-script-minimal" },
      }),
    });
    const created = await createRes.json();
    if (createRes.ok) return created;
    const missing = created?.error?.missing ?? [];
    if (created?.error?.code === "missing_files" && missing.length) {
      console.log(`deploy create: ${missing.length} file(s) missing server-side — backfilling (round ${round + 1})`);
      let allOk = true;
      for (const sha of missing) {
        const rel = shaOf.get(sha);
        if (!rel) { console.error(`  cannot map sha ${sha} to a local file`); allOk = false; continue; }
        if (!(await uploadFile(rel))) allOk = false;
      }
      if (!allOk) process.exit(1);
      continue; // retry create
    }
    console.error("deploy create failed:", createRes.status, JSON.stringify(created).slice(0, 900));
    process.exit(1);
  }
  console.error("deploy create: still missing files after 3 backfill rounds");
  process.exit(1);
}
const created = await createDeployment();
const dplId = created.id;
console.log(`deployment created: ${dplId} -> ${created.url}`);

// ---------- poll ----------
const started = Date.now();
let dpl = null;
while (Date.now() - started < 9 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 12_000));
  const res = await api(`/v13/deployments/${dplId}`);
  dpl = await res.json();
  console.log(`  ${Math.round((Date.now() - started) / 1000)}s: ${dpl.readyState} ${dpl.readySubstate ?? ""}`);
  if (dpl.readyState === "READY" || dpl.readyState === "ERROR" || dpl.readyState === "CANCELED") break;
}

if (dpl?.readyState === "READY") {
  console.log(`READY: https://${dpl.url}`);
  console.log(`crons on deployment: ${JSON.stringify(dpl.crons ?? [])}`);
} else {
  console.error(`deployment ended as ${dpl?.readyState}: ${dpl?.errorMessage ?? ""}`);
  process.exit(1);
}
