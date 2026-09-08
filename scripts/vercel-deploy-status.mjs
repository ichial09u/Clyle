/** Check recent Vercel deployments for the project (status + URL). */
const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const PROJECT = "prj_6pNaqSVELOpQ5uvQsfLW6kjLPudq";

const res = await fetch(
  `https://api.vercel.com/v6/deployments?projectId=${PROJECT}&limit=3&target=production&teamId=${TEAM}`,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
);
const data = await res.json();
for (const d of data.deployments ?? []) {
  console.log(
    `${d.uid} state=${d.readyState} created=${new Date(d.createdAt).toISOString()} url=${d.url}`,
  );
}
// deep-check the newest one if building
const newest = data.deployments?.[0];
if (newest && (newest.readyState === "BUILDING" || newest.readyState === "QUEUED" || newest.readyState === "INITIALIZING")) {
  console.log(`\nnewest deployment ${newest.uid} is still ${newest.readyState}...`);
}
