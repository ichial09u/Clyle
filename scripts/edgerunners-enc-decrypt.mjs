/**
 * Decrypt megaplay.buzz getSources `enc` payloads.
 * Recipe from newclient.min.js v4.9: AES-256-CBC, key "i?LMTAx0Q6,:}50U"
 * zero-padded to 32 bytes, IV "W0;27ToaUpl_P%'c", data = base64url(enc).
 */
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY = Buffer.concat([Buffer.from("i?LMTAx0Q6,:}50U", "utf8"), Buffer.alloc(16, 0)]);
const IV = Buffer.from("W0;27ToaUpl_P%'c", "utf8");

function decryptEnc(enc) {
  const b64 = enc.replace(/-/g, "+").replace(/_/g, "/");
  const data = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-cbc", KEY, IV);
  const out = Buffer.concat([d.update(data), d.final()]);
  return out.toString("utf8");
}

for (const tag of process.argv.slice(2).length ? process.argv.slice(2) : ["ep8", "ep1", "koto-ep8"]) {
  try {
    const j = JSON.parse(readFileSync(`/tmp/edg-${tag}.json`, "utf8"));
    if (!j.enc) { console.log(`${tag}: no enc (keys: ${Object.keys(j).join(",")})`); continue; }
    const plain = decryptEnc(j.enc);
    console.log(`=== ${tag} ===`);
    console.log(plain.slice(0, 600));
    try {
      const pj = JSON.parse(plain);
      const file = pj?.sources?.file || pj?.source || (Array.isArray(pj?.sources) ? pj.sources[0]?.file : null);
      console.log(`>> file: ${file ?? "(none)"}`);
    } catch { /* raw text */ }
    console.log();
  } catch (e) {
    console.log(`${tag}: decrypt fail — ${e.message.slice(0, 100)}`);
  }
}
