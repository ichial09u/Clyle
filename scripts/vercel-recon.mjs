/**
 * Recon: find the current production deployment and check whether we can
 * download its file list + file CONTENTS (sandbox rollback recovery).
 */
const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const PROJECT = "prj_6pNaqSVELOpQ5uvQsfLW6kjLPudq";

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return res;
};

// 1. latest production deployments
const list = await (await api(`/v6/deployments?projectId=${PROJECT}&target=production&limit=6`)).json();
if (!list.deployments) { console.error("no deployments:", JSON.stringify(list).slice(0, 400)); process.exit(1); }
for (const d of list.deployments) {
  console.log(`${d.uid} ${d.readyState} created=${new Date(d.created).toISOString()} url=${d.url}`);
}
const current = list.deployments.find((d) => d.readyState === "READY");
if (!current) { console.error("no READY deployment"); process.exit(1); }
console.log("\n=== inspecting", current.uid, "===");

// 2. deployment detail — does it embed a files array?
const detail = await (await api(`/v13/deployments/${current.uid}`)).json();
const files = detail.files ?? [];
console.log("detail keys:", Object.keys(detail).join(","));
console.log("files count:", files.length);
if (files.length) console.log("file[0]:", JSON.stringify(files[0]));
if (files.length) {
  const interesting = files.filter((f) => /auth|signin|profile|progress|crunchyroll|smoke/.test(f.name ?? ""));
  console.log("auth-related entries:", JSON.stringify(interesting.slice(0, 20), null, 1));
}

// 3. can we fetch a file's CONTENT?
if (files.length) {
  const f = files.find((x) => (x.name ?? "").startsWith("src/")) ?? files[0];
  const id = f.uid ?? f.sha ?? f.name;
  for (const ep of [
    `/v13/deployments/${current.uid}/files/${encodeURIComponent(f.name ?? f.file)}`,
    `/v13/deployments/${current.uid}/files/${id}`,
  ]) {
    const res = await api(ep);
    const text = await res.text();
    console.log(`\nGET ${ep.slice(0, 90)} -> ${res.status} ${res.headers.get("content-type")}`);
    console.log("body[:300]:", text.slice(0, 300).replace(/\n/g, "\\n"));
    if (res.ok) break;
  }
}
