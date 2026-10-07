/**
 * Sandbox-rollback recovery: restore the deployed source tree (Task 17/18 era)
 * from the current production deployment on Vercel.
 *
 *  1. GET /v13/deployments/{id}/files      -> file tree with uid (= sha1 hex)
 *  2. sha1 every local git-tracked file    -> classify: match / differ / local-missing / local-extra
 *  3. download missing+differ via GET /v8/deployments/{id}/files/{uid} (base64)
 *  4. write them into the working tree
 *
 * Excludes db churn dirs from *download* (caches) — only real source + custom.db.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const DPL = process.argv[2] ?? "dpl_6a9KS8Y3oxrAoYX3LUrg5WKwtzSz";
const ROOT = process.cwd();

const api = async (path) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
};

// 1. flatten tree
const tree = await (await api(`/v13/deployments/${DPL}/files`)).json();
const flat = [];
(function walk(nodes, prefix) {
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === "directory") walk(n.children ?? [], p);
    else flat.push({ path: p, uid: n.uid });
  }
})(tree, "");
console.log(`deployment files: ${flat.length}`);

// sanity: uid must equal sha1 of local bytes for at least one identical file
const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");

// 2. classify
const missing = [], differ = [], match = [];
const localTracked = execSync("git ls-files", { encoding: "utf8", maxBuffer: 256e6 }).split("\n").filter(Boolean);
const deployedSet = new Set(flat.map((f) => f.path));
const extraLocal = [];
for (const f of flat) {
  try {
    const h = sha1(readFileSync(join(ROOT, f.path)));
    if (h === f.uid) match.push(f.path);
    else differ.push(f);
  } catch { missing.push(f); }
}
for (const l of localTracked) if (!deployedSet.has(l)) extraLocal.push(l);
console.log(`match=${match.length} differ=${differ.length} local-missing=${missing.length} local-extra(tracked,not-deployed)=${extraLocal.length}`);

console.log("\n-- differ (local bytes != deployment):");
for (const d of differ) console.log("   ", d.path);
console.log("\n-- local-missing (on deployment, not on disk):");
for (const d of missing) console.log("   ", d.path);
console.log("\n-- local-extra (tracked locally, not in deployment) [first 40]:");
for (const d of extraLocal.slice(0, 40)) console.log("   ", d);

// 3+4. download & write missing + differ (parallel, resumable)
const toFetch = [...missing, ...differ];
console.log(`\ndownloading ${toFetch.length} files with concurrency 12 ...`);
let ok = 0, fail = [], cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= toFetch.length) return;
    const { path, uid } = toFetch[i];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await api(`/v8/deployments/${DPL}/files/${uid}`);
        const { data } = await res.json();
        const buf = Buffer.from(data, "base64");
        if (sha1(buf) !== uid) throw new Error("sha mismatch after decode");
        const abs = join(ROOT, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, buf);
        ok++;
        break;
      } catch (e) {
        if (attempt === 3) { console.error(`FAIL ${path}: ${String(e).slice(0, 140)}`); fail.push(path); }
        else await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
console.log(`\nrestored ${ok}/${toFetch.length} files${fail.length ? " — FAILURES: " + fail.slice(0, 20).join(", ") : ""}`);
