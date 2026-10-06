// Scrape animefrenzy watch pages for flixcloud embed ids (via agent-browser)
import { execFileSync } from "node:child_process";

const malId = process.argv[2] || "59145";
const eps = parseInt(process.argv[3] || "12", 10);
const ab = (args) => execFileSync("agent-browser", args, { maxBuffer: 10 * 1024 * 1024 }).toString("utf8");

const ids = {};
for (let ep = 1; ep <= eps; ep++) {
  try {
    ab(["open", `https://animefrenzy.cc/watch/${malId}/${ep}`]);
    ab(["wait", "--load", "networkidle"]);
    ab(["wait", "3500"]);
    const out = ab(["eval", "JSON.stringify([...document.querySelectorAll('iframe')].map(f=>f.src))"]);
    // eval output is itself JSON-encoded — unwrap until we hit the array
    let parsed = out.trim().split("\n").filter((l) => l.trim().startsWith("[") || l.trim().startsWith("\"")).pop();
    let srcs = JSON.parse(parsed);
    while (typeof srcs === "string") srcs = JSON.parse(srcs);
    const flix = srcs.find((s) => s.includes("flixcloud.cc/e/"));
    if (flix) {
      const aid = flix.match(/\/e\/([a-z0-9]+)/)?.[1];
      ids[ep] = { aid, src: flix };
      console.log(`ep${ep}: ${aid} (${flix})`);
    } else {
      ids[ep] = { aid: null, src: srcs };
      console.log(`ep${ep}: NO FLIX — ${JSON.stringify(srcs)}`);
    }
  } catch (e) {
    console.log(`ep${ep}: ERROR ${String(e.message).slice(0, 100)}`);
    ids[ep] = { aid: null, error: true };
  }
}
console.log("\nFINAL MAP:");
console.log(JSON.stringify(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.aid])), null, 1));
