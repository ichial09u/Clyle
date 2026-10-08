#!/usr/bin/env node
/**
 * One-time provisioning: create the Vercel Edge Config store that carries the
 * GLOBALLY-CONSISTENT state (Most Watched aggregate, ANN news subscriptions,
 * seen-news guids) across all serverless instances — the packaged SQLite is
 * copied to /tmp per instance, so its writes can never be shared.
 *
 * Prints the store id; paste it into src/lib/global-store.ts.
 */
const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";

const api = (path, init) =>
  fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

const list = await api("/v1/edge-config").then((r) => r.json());
const existing = Array.isArray(list) ? list.find((s) => s.slug === "clyle-global") : null;
if (existing) {
  console.log("EXISTS:", existing.id);
  process.exit(0);
}
const res = await api("/v1/edge-config", { method: "POST", body: JSON.stringify({ slug: "clyle-global", name: "clyle-global" }) });
const store = await res.json();
console.log(res.ok ? "CREATED:" : "ERROR:", JSON.stringify(store).slice(0, 400));
