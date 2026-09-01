/**
 * Deploy the local working tree to the user's Vercel project via REST API.
 *
 * The provided vcp_ token is project-scoped (fine-grained), so the Vercel CLI
 * rejects it at `whoami` — but the REST API accepts it. Flow:
 *   1. manifest = git ls-files minus cache/debug paths
 *   2. upload each file  -> POST /v2/files  (x-vercel-digest: sha1; 409 = ok)
 *   3. create deployment -> POST /v13/deployments?teamId=... target=production
 *   4. poll status until READY/ERROR, print alias + build events on failure
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
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
  /^dev\.log$/,
  /^server\.log$/,
];

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return res;
};

// ---------- 0) carry forward prod user data ----------
// The bundled SQLite resets on every deploy, so before building we fetch the
// comments (and Top 10 history) the live site has accumulated and merge them
// into the local db — comments survive site updates instead of vanishing.
const PROD_URL = process.env.PROD_URL || "https://temporary-spry-granite-1f0h7ae.vercel.app";
try {
  console.log(`preserving live data: fetching ${PROD_URL}/api/export ...`);
  const res = await fetch(`${PROD_URL}/api/export`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  const total = (data.comments?.length ?? 0) + (data.watchStats?.length ?? 0);
  writeFileSync(join(ROOT, "db", "export-comments.tmp.json"), JSON.stringify(data));
  execSync("node scripts/merge-comments.mjs db/export-comments.tmp.json", { cwd: ROOT, stdio: "inherit" });
  console.log(`carried forward ${data.comments?.length ?? 0} comments + ${data.watchStats?.length ?? 0} watchStat rows (${total} rows total)`);
} catch (err) {
  console.log(`no live data carried forward (${String(err).slice(0, 120)}) — deploying as-is`);
}

// ---------- 1) manifest ----------
const all = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const manifest = all.filter((f) => !EXCLUDE.some((re) => re.test(f)));
console.log(`manifest: ${manifest.length} of ${all.length} tracked files`);
const missing = manifest.filter((f) => !statSync(join(ROOT, f)).isFile());
if (missing.length) { console.error("missing:", missing); process.exit(1); }

// ---------- 2) upload files ----------
const files = [];
let uploaded = 0, skipped = 0;
for (const rel of manifest) {
  const buf = readFileSync(join(ROOT, rel));
  const sha = createHash("sha1").update(buf).digest("hex");
  const res = await api("/v2/files", {
    method: "POST",
    headers: { "x-vercel-digest": sha, "Content-Type": "application/octet-stream" },
    body: buf,
  });
  if (res.ok) uploaded++;
  else if (res.status === 409) skipped++;
  else {
    const t = await res.text();
    console.error(`upload failed ${rel}: ${res.status} ${t.slice(0, 200)}`);
    process.exit(1);
  }
  files.push({ file: rel, sha, size: buf.length });
  process.stdout.write(`\rupload ${uploaded + skipped}/${manifest.length} (new ${uploaded}, dup ${skipped})`);
}
console.log("");

// ---------- 3) create deployment ----------
const createRes = await api("/v13/deployments", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "temporary-spry-granite-1f0h7ae",
    target: "production",
    files,
    meta: { deployedBy: "api-script" },
  }),
});
const created = await createRes.json();
if (!createRes.ok) {
  console.error("deploy create failed:", createRes.status, JSON.stringify(created).slice(0, 800));
  process.exit(1);
}
const dplId = created.id;
console.log(`deployment created: ${dplId} -> ${created.url}`);

// ---------- 4) poll ----------
const started = Date.now();
let dpl = null;
while (Date.now() - started < 10 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 10_000));
  const res = await api(`/v13/deployments/${dplId}`);
  dpl = await res.json();
  const st = dpl.readyState;
  console.log(`  ${(Math.round((Date.now() - started) / 1000))}s: ${st} ${dpl.readySubstate ?? ""}`);
  if (st === "READY" || st === "ERROR" || st === "CANCELED") break;
}

if (dpl?.readyState === "READY") {
  console.log(`READY: https://${dpl.url}`);
  console.log(`aliases: ${(dpl.alias ?? []).join(", ")}`);
} else {
  console.error(`deployment ended as ${dpl?.readyState}`);
  const ev = await api(`/v2/deployments/${dplId}/events?limit=100&builds=1`);
  const events = await ev.json();
  for (const e of (Array.isArray(events) ? events : []).slice(-40)) {
    const text = e.payload?.text ?? e.payload?.errorMessage ?? JSON.stringify(e.payload ?? e).slice(0, 300);
    if (text) console.log("  |", text.slice(0, 300));
  }
  process.exit(1);
}
