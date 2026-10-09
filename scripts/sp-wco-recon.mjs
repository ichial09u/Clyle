#!/usr/bin/env node
/**
 * Time-boxed WCO recon (Task 28):
 *  A. Do the 3 login-gated Movies & Specials pages really have no embed?
 *  B. Does a TV episode page offer ALTERNATE embed servers (a second dub
 *     source we could wire as "DUB Server #2")?
 *  C. Do mirror domains (wcoflix.tv / wcostream.org) carry the same slugs
 *     with an EMBED present (a fallback for the gated items)?
 */
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const get = (url) =>
  new Promise((resolve) => {
    execFile("curl", ["-sS", "--max-time", "20", "-A", UA, "--compressed", "-w", "\n__STATUS__%{http_code}", url], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const m = stdout.match(/__STATUS__(\d+)\s*$/);
      resolve(m ? { status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") } : null);
    });
  });

const summarize = (label, out) => {
  if (!out) return console.log(`${label}: TRANSPORT FAIL`);
  const embeds = [...out.body.matchAll(/embed\.wcostream\.com\/inc\/embed\/index\.php\?[^"]+/g)].map((m) => m[0]);
  const loginGate = /check-login|create-an-account|login/i.test(out.body) ? " (login UI present)" : "";
  console.log(`${label}: http=${out.status} embeds=${embeds.length}${loginGate}`);
  for (const e of embeds.slice(0, 3)) console.log(`   ${e.slice(0, 130)}`);
};

// A. gated pages
for (const slug of ["south-park-streaming-wars-part-2", "south-park-streaming-wars", "south-park-bigger-longer-uncut"]) {
  summarize(`A wcostream.tv/${slug}`, await get(`https://www.wcostream.tv/${slug}`));
}
// B. a normal TV episode — how many embeds/servers does it offer?
summarize("B wcostream.tv/south-park-season-1-episode-1-cartman-gets-an-anal-probe", await get("https://www.wcostream.tv/south-park-season-1-episode-1-cartman-gets-an-anal-probe"));
// C. mirrors of the gated movie
summarize("C wcoflix.tv movie", await get("https://wcoflix.tv/south-park-bigger-longer-uncut"));
summarize("C wcostream.org movie", await get("https://www.wcostream.org/south-park-bigger-longer-uncut"));
