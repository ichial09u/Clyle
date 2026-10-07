/** Probe deployment file-list + content endpoints on the CURRENT prod deployment. */
const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const DPL = process.argv[2] ?? "dpl_6a9KS8Y3oxrAoYX3LUrg5WKwtzSz";

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    ...init,
    signal: AbortSignal.timeout(25_000),
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return res;
};

for (const ep of [`/v13/deployments/${DPL}/files`, `/v5/deployments/${DPL}/files`, `/v6/deployments/${DPL}/files`]) {
  const res = await api(ep).catch((e) => { console.log("ERR", ep.slice(0, 60), String(e).slice(0, 120)); return null; });
  if (!res) continue;
  const text = await res.text();
  console.log(`GET ${ep} -> ${res.status} (${text.length} bytes)`);
  if (res.ok) {
    const json = JSON.parse(text);
    const arr = Array.isArray(json) ? json : json.files ?? json.data ?? [];
    console.log("count:", arr.length, "sample:", JSON.stringify(arr[0]));
    const pick = arr.find((f) => JSON.stringify(f).includes("auth"));
    console.log("auth-ish sample:", JSON.stringify(pick ?? null));
    break;
  }
}
