/** Fetch build events for a failing Vercel deployment. */
const TOKEN = "vcp_1QC4skvTCp5i2AzJJGXjz7JxfsEYtoHn6RpGwguTLKdzZbvOFN1Oyy1I";
const TEAM = "team_GNdBOfbmGh6IvtRPBoDbSGtK";
const id = process.argv[2] || "dpl_CLT42cdLhTsydTW3ZYr6JUjhK8re";

const res = await fetch(
  `https://api.vercel.com/v2/deployments/${id}/events?limit=60&builds=1&teamId=${TEAM}`,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
);
const events = await res.json();
const interesting = [];
for (const e of events) {
  const text = e.payload?.text ?? e.payload?.errorMessage ?? "";
  if (!text) continue;
  if (
    /error|Error|ERROR|failed|Failed|ESLint|Type error|Cannot find|Module not found|not found|Command exited|Build failed/.test(
      text,
    )
  ) {
    interesting.push(text);
  }
}
// print the tail of the interesting lines and the last 30 raw lines
for (const t of interesting.slice(-25)) console.log("!!", t.slice(0, 400));
console.log("----- last 30 build lines -----");
for (const e of events.slice(-30)) {
  const text = e.payload?.text ?? e.payload?.errorMessage ?? "";
  if (text) console.log(text.slice(0, 240));
}
