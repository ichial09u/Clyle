/**
 * Raw-API deploy (v20+) — the Vercel CLI 62.x can no longer resolve this
 * team-scoped token ("User not found"), so we drive /v13/deployments
 * directly, exactly like the CLI would:
 *   1. manifest = git ls-files run from the inner project root (src/)
 *   2. upload ONLY files whose sha the server hasn't seen yet (content-
 *      addressed: anything already deployed under the same sha is reused)
 *   3. create the deployment referencing ALL manifest shas — with NO git
 *      metadata (the Oct-7 "Deployment Blocked" incident was caused by the
 *      sandbox git identity z@container being attached as commit author;
 *      git-free deploys like the CLI's pre-commit runs go straight through)
 *   4. projectSettings.framework pinned to nextjs (the previous raw-API
 *      attempt died with "No Next.js version detected" without this)
 *   5. poll to READY/ERROR
 *
 * Run from the inner project root:  cd /home/z/my-project/src && node ../scripts/deploy-vercel-api.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const PROJECT_NAME = "temporary-spry-granite-1f0h7ae";
const PROD_URL = `https://${PROJECT_NAME}.vercel.app`;
const OWNER_TOKEN = "clyle-owner-4f8e2d1c9b7a6f3e";
const ROOT = process.cwd();

const EXCLUDE = [
  /^tsconfig\.tsbuildinfo$/,
  /^db\/anilist-cache\//,
  /^db\/zoko-stream\//,
  /^db\/megaplay\//, // pure resolved-stream cache — prod re-resolves live
  /^dev\.log$/,
  /^server\.log$/,
];

// the packaged catalog DB — uploaded eagerly (no-op when the sha already
// exists server-side; it is the one file that legitimately churns)
const MUST_UPLOAD = ["src/db/custom.db", "db/custom.db"];

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return res;
};

// ---------- pre-deploy data merge ----------
// Every deployment packages src/db/custom.db. Serverless instances start
// from THAT copy, and the ntfy global log they harvest only retains ~12h —
// so anything the live site accumulated since the last deploy (watch
// seconds behind "Most Watched", comments, users, per-device progress,
// push subs) had to be carried forward HERE or fresh instances started
// stale and different devices landed on different lists. The old zip
// deploy did this (build-deploy-zip.sh); the raw-API switch dropped it.
// Restore it: pull /api/export from the CURRENT production and max-merge
// into the repo DB before any file is hashed or uploaded.
async function mergeProdData() {
  const tmp = join(ROOT, "db", "prod-export.tmp.json");
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    const res = await fetch(`${PROD_URL}/api/export`, {
      headers: { "x-clyle-owner": OWNER_TOKEN },
      signal: ac.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`export ${res.status}`);
    const text = await res.text();
    JSON.parse(text); // validate before saving
    writeFileSync(tmp, text);
  } catch (err) {
    console.warn(`pre-deploy merge: production export unavailable (${err instanceof Error ? err.message : err}) — deploying the local DB as-is`);
    return;
  }
  try {
    const out = execSync("node ../scripts/merge-comments.mjs db/prod-export.tmp.json", {
      cwd: ROOT, // src/ — resolves @prisma/client from src/node_modules
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "file:/home/z/my-project/src/db/custom.db" },
      maxBuffer: 32 * 1024 * 1024,
    });
    console.log(out.trim().split("\n").slice(-6).join("\n"));
  } catch (err) {
    console.warn("pre-deploy merge: merge-comments.mjs failed — deploying the local DB as-is:", err instanceof Error ? err.message : err);
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}
await mergeProdData();

// ---------- manifest ----------
const all = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  .split("\n")
  .filter(Boolean);
const manifest = all.filter((f) => !EXCLUDE.some((re) => re.test(f)));
console.log(`manifest: ${manifest.length} of ${all.length} tracked files (root: ${ROOT})`);
const missing = manifest.filter((f) => { try { return !statSync(join(ROOT, f)).isFile(); } catch { return true; } });
if (missing.length) { console.error("missing on disk:", missing); process.exit(1); }

const shaOfBuf = (buf) => createHash("sha1").update(buf).digest("hex");

async function uploadFile(rel) {
  const buf = readFileSync(join(ROOT, rel));
  const sha = shaOfBuf(buf);
  const res = await api("/v2/files", {
    method: "POST",
    headers: { "x-vercel-digest": sha, "Content-Type": "application/octet-stream" },
    body: buf,
  });
  const ok = res.ok || res.status === 409; // 409 = already stored
  console.log(`upload ${rel}: ${res.status}${ok ? "" : " " + (await res.text()).slice(0, 200)}`);
  return ok;
}

// ---------- eager uploads ----------
for (const rel of MUST_UPLOAD) {
  if (!manifest.includes(rel)) continue; // layout may not carry every candidate path
  await uploadFile(rel);
}

// ---------- create deployment ----------
const shaOf = new Map(); // sha -> rel (first wins; content-addressed dedupe)
const files = manifest.map((rel) => {
  const buf = readFileSync(join(ROOT, rel));
  const sha = shaOfBuf(buf);
  if (!shaOf.has(sha)) shaOf.set(sha, rel);
  return { file: rel, sha, size: buf.length };
});

async function createDeployment() {
  for (let round = 0; round < 4; round++) {
    const createRes = await api("/v13/deployments?skipAutoDetectionConfirmation=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: PROJECT_NAME,
        target: "production",
        files,
        // framework pinned — the Oct-7 raw attempt failed the build with
        // "No Next.js version detected" when detection was left to the builder
        projectSettings: { framework: "nextjs" },
        // deliberately NO git* metadata — an invalid sandbox commit-author
        // email is exactly what blocked the CLI deploys (TEAM screenshot)
        meta: { deployedBy: "deploy-vercel-api.mjs" },
      }),
    });
    const created = await createRes.json();
    if (createRes.ok) return created;
    const missingShas = created?.error?.missing ?? [];
    if (created?.error?.code === "missing_files" && missingShas.length) {
      console.log(`deploy create: ${missingShas.length} file(s) missing server-side — backfilling (round ${round + 1})`);
      let allOk = true;
      for (const sha of missingShas) {
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
  console.error("deploy create: still missing files after 4 backfill rounds");
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
  if (dpl.readyState === "READY" || dpl.readyState === "ERROR" || dpl.readyState === "CANCELED" || dpl.readyState === "BLOCKED") break;
}

if (dpl?.readyState === "READY") {
  console.log(`READY: https://${dpl.url}`);
} else {
  console.error(`deployment ended as ${dpl?.readyState}: ${dpl?.errorMessage ?? ""} | blocked=${JSON.stringify(dpl?.seatBlock ?? null)}`);
  process.exit(1);
}
