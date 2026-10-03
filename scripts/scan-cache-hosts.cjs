// Scan stream caches for every CDN hostname in use (src + subtitles).
const fs = require("fs"), path = require("path");
const hosts = {};
const dirs = ["db/megaplay", "db/anikoto", "db/zoko-stream", "db/supaplay"];
const collect = (j) => {
  const out = [];
  if (j?.data?.src) out.push(j.data.src);
  if (j?.src) out.push(j.src);
  for (const s of j?.data?.subtitles ?? []) if (s?.src) out.push(s.src);
  for (const s of j?.subtitles ?? []) if (s?.src) out.push(s.src);
  return out;
};
for (const dir of dirs) {
  let files = [];
  try { files = fs.readdirSync(dir); } catch { continue; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const u of collect(j)) {
        try { const h = new URL(u).hostname; hosts[h] = (hosts[h] || 0) + 1; } catch {}
      }
    } catch {}
  }
}
console.log(Object.entries(hosts).sort((a, b) => b[1] - a[1]).map(([h, c]) => `${h} x${c}`).join("\n"));
