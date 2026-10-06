// FlixCloud embed → real HLS URL resolver (proof of concept for /api/stream flix provider)
// Flow (reverse-engineered from flixcloud.cc player bundle):
//   1. GET https://flixcloud.cc/e/{aid}?v=1&a=1  (SvelteKit page)
//   2. Extract the SSR `data:{...}` payload (contains obfuscated crypto data + WASM payload)
//   3. Derive field names from obfuscation_seed (3x SHA-256 chain, + 3 more for keyFrag2)
//   4. Pull frag1 (kf_), iv (ivf_), keyFrag2 (a-chain field), token (e[48..64]_e[56..64] field)
//   5. GET /api/m3u8/{token}  → { <oe(b+"vid")[0:10]>: encManifestB64, <oe(b+"key")[0:10]>: keyB64 }
//   6. WASM _s(seedInt)/_r(frag1,frag2,key→out) → PBKDF2(seed salt, 1000 iters) → XOR seed chars
//      → SHA-256 → AES-CBC-decrypt(iv, encManifest) → plaintext m3u8 URL
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ORIGIN = "https://flixcloud.cc";

// Cloudflare 403s node-fetch TLS fingerprints — curl passes (same as MAL scraping pattern)
function curlText(url, extraHeaders = []) {
  const args = [
    "-sS", "-m", "30", "-L", "-A", UA,
    "-H", "accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "accept-language: en-US,en;q=0.9",
    "-b", "/tmp/flix-cookies.txt", "-c", "/tmp/flix-cookies.txt",
    ...extraHeaders,
    url,
  ];
  return execFileSync("curl", args, { maxBuffer: 20 * 1024 * 1024 }).toString("utf8");
}

function curlJson(url, referer) {
  const out = execFileSync("curl", [
    "-sS", "-m", "30", "-A", UA,
    "-H", "accept: */*",
    "-H", `referer: ${referer}`,
    "-H", `origin: ${ORIGIN}`,
    "-w", "\n%{http_code}",
    url,
  ], { maxBuffer: 10 * 1024 * 1024 }).toString("utf8");
  const nl = out.lastIndexOf("\n");
  const code = parseInt(out.slice(nl + 1), 10);
  const body = out.slice(0, nl);
  return { code, body };
}

const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const b64buf = (s) => Buffer.from(s, "base64");

function extractData(html) {
  // locate `{type:"data",data:{` — the SSR payload for the player node
  const k = html.indexOf('{type:"data",data:{');
  if (k < 0) throw new Error("no typed data payload");
  const start = k + '{type:"data",data:'.length; // at the '{' of the data object
  // brace-match to the end (strings may contain braces; walk carefully)
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { end = p + 1; break; } }
  }
  if (end < 0) throw new Error("unterminated data payload");
  // SvelteKit emits a JS object literal (unquoted keys), not strict JSON
  const literal = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal})`)();
}

function deriveFields(seed) {
  let e = seed;
  for (let s = 0; s < 3; s++) e = sha256hex(e + s.toString());
  let a = e;
  for (let s = 0; s < 3; s++) a = sha256hex(a + s.toString());
  return {
    e, a,
    videoField: `vf_${e.slice(0, 8)}`,
    keyField: `kf_${e.slice(8, 16)}`,
    ivField: `ivf_${e.slice(16, 24)}`,
    containerName: `cd_${e.slice(24, 32)}`,
    arrayName: `ad_${e.slice(32, 40)}`,
    objectName: `od_${e.slice(40, 48)}`,
    tokenField: `${e.slice(48, 64)}_${e.slice(56, 64)}`,
    keyFrag2Field: `${a.slice(0, 16)}_${a.slice(16, 24)}`,
  };
}

function wasmMix(wPayloadB64, frag1, frag2, tokKey, seedInt) {
  const wasmBytes = b64buf(wPayloadB64);
  const mod = new WebAssembly.Module(wasmBytes);
  const inst = new WebAssembly.Instance(mod, {});
  const b = inst.exports;
  const mem = b.memory;
  if (mem.buffer.byteLength === 0) mem.grow(1);
  let w = new Uint8Array(mem.buffer);
  const T = frag1.length, BASE = 1000;
  const E = BASE + T, Y = E + T, B = Y + T;
  // memory may grow inside _r — re-wrap after calls
  w.set(frag1, BASE);
  w = new Uint8Array(mem.buffer); // in case grow happened before (not yet)
  w.set(frag2, E);
  w.set(tokKey, Y);
  b._s(seedInt);
  b._r(BASE, E, Y, B, T);
  w = new Uint8Array(mem.buffer);
  // __pk = 32 bytes at the pointer _c() returns (AFTER _s/_r) — the playlist XOR key
  let pk = null;
  try {
    const p = b._c();
    pk = w.slice(p, p + 32);
  } catch { /* _c missing */ }
  return { mixed: w.slice(B, B + T), pk };
}

/** XOR-decrypt a flixcloud playlist payload with the __pk key */
function xorPk(buf, pk) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length; i++) out[i] ^= pk[i % pk.length];
  return out;
}

async function resolve(aid) {
  const html = curlText(`${ORIGIN}/e/${aid}?v=1&a=1`);
  if (!html.includes("node_ids:")) throw new Error(`embed page failed (no kit payload)`);
  const data = extractData(html);
  const seed = data.obfuscation_seed;
  const f = deriveFields(seed);
  console.log("fields:", JSON.stringify(f, null, 1));

  const cryptoData = data.obfuscated_crypto_data;
  const container = cryptoData && cryptoData[f.containerName];
  if (!container) {
    console.error("seed:", seed);
    console.error("derived:", JSON.stringify(f, null, 1));
    console.error("crypto structure:", JSON.stringify(cryptoData, null, 1).slice(0, 600));
    throw new Error(`missing container ${f.containerName}`);
  }
  const arr = container[f.arrayName];
  const obj = arr[0][f.objectName];
  const frag1B64 = obj[f.keyField];
  const ivB64 = obj[f.ivField];
  const frag2 = data[f.keyFrag2Field];
  const token = data[f.tokenField];
  if (!frag1B64 || !ivB64 || !frag2 || !token) {
    throw new Error(`missing parts: frag1=${!!frag1B64} iv=${!!ivB64} frag2=${!!frag2} token=${!!token}`);
  }
  console.log("token:", token, "frag2:", frag2, "video:", data.video_id, "title:", data.video_title);

  // token endpoint — same-session browser-like call (cookies + sec-fetch headers)
  const tok = (() => {
    const args = [
      "-sS", "-m", "30", "-A", UA,
      "-H", "accept: */*",
      "-H", "accept-language: en-US,en;q=0.9",
      "-H", `referer: ${ORIGIN}/e/${aid}?v=1&a=1`,
      "-H", `origin: ${ORIGIN}`,
      "-H", "sec-fetch-dest: empty",
      "-H", "sec-fetch-mode: cors",
      "-H", "sec-fetch-site: same-origin",
      "-b", "/tmp/flix-cookies.txt", "-c", "/tmp/flix-cookies.txt",
      "-w", "\n%{http_code}",
      `${ORIGIN}/api/m3u8/${token}`,
    ];
    const out = execFileSync("curl", args, { maxBuffer: 10 * 1024 * 1024 }).toString("utf8");
    const nl = out.lastIndexOf("\n");
    const code = parseInt(out.slice(nl + 1), 10);
    if (code !== 200) throw new Error(`token endpoint ${code}: ${out.slice(0, nl).slice(0, 120)}`);
    return JSON.parse(out.slice(0, nl));
  })();
  console.log("token response keys:", Object.keys(tok));

  const vidKey = sha256hex(token + "vid").slice(0, 10);
  const keyKey = sha256hex(token + "key").slice(0, 10);
  const encManifestB64 = tok[vidKey];
  const tokKeyB64 = tok[keyKey];
  if (!encManifestB64 || !tokKeyB64) throw new Error("token response incomplete");

  const seedInt = parseInt(seed.slice(0, 8), 16);
  const { mixed, pk } = wasmMix(data.w_payload, b64buf(frag1B64), b64buf(frag2), b64buf(tokKeyB64), seedInt);

  // PBKDF2(mixed, salt=seed, 1000, sha256, 256 bits)
  const pbk = crypto.pbkdf2Sync(mixed, Buffer.from(seed, "utf8"), 1000, 32, "sha256");
  const xored = Buffer.from(pbk);
  for (let i = 0; i < 32; i++) xored[i] ^= seed.charCodeAt(i % seed.length);
  const aesKey = crypto.createHash("sha256").update(xored).digest();

  const iv = b64buf(ivB64);
  const enc = b64buf(encManifestB64);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  const url = Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");

  // ---- probe the master manifest with every session key ----
  if (process.env.PROBE) {
    const manifest = await probeManifest(url, aesKey, iv, pk);
    if (manifest) {
      // walk variants (relative .. paths) with the same pk
      const masterUrl = url;
      const variantUrls = [...manifest.matchAll(/(?:URI=")?([^"\n]+\.m3u8)/g)]
        .map((m) => m[1])
        .filter((u) => !u.includes("master.m3u8"));
      const uniq = [...new Set(variantUrls)].slice(0, 4);
      for (const rel of uniq) {
        const abs = new URL(rel, masterUrl).toString();
        await probeManifest(abs, aesKey, iv, pk, true);
      }
    }
  }
  return { url, data, seed, aesKey, iv, pk };
}

const aid = process.argv[2] || "dmvdjvrznpif";
resolve(aid)
  .then(({ url, data }) => {
    console.log("\n=== M3U8 URL ===");
    console.log(url);
    console.log("\nvideo_title:", data.video_title);
    console.log("subtitles:", JSON.stringify(data.subtitles, null, 1));
    console.log("chapters:", JSON.stringify(data.chapters));
    console.log("intro:", JSON.stringify(data.intro_chapter), "outro:", JSON.stringify(data.outro_chapter));
  })
  .catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

// ---- fetch a playlist and XOR-decrypt with __pk ----
async function probeManifest(url, aesKey, iv, pk, quiet = false) {
  const raw = execFileSync("curl", ["-sS","-m","30","-L","-A",UA,"-H","accept: */*","-H","referer: https://flixcloud.cc/",url], {maxBuffer: 20*1024*1024}).toString("utf8");
  if (!quiet) console.log("master fetch:", raw.slice(0,72).replace(/\n/g," "));
  if (raw.trim().startsWith("#EXTM3U")) { if (!quiet) console.log("master is plaintext already"); return raw; }
  if (!pk) { console.log("no __pk available"); return null; }
  const bin = Buffer.from(raw.trim(), "base64");
  const txt = xorPk(bin, pk).toString("utf8");
  if (txt.includes("#EXTM3U")) {
    console.log(`*** PLAYLIST DECRYPTED with __pk (${pk.toString("hex")}) *** ${url.slice(0, 90)}`);
    if (!quiet) {
      console.log(txt.slice(0, 700));
    } else {
      const lines = txt.split("\n").filter(Boolean);
      const segs = lines.filter((l) => !l.startsWith("#"));
      console.log(`   lines=${lines.length} segments=${segs.length} first=${segs[0]?.slice(0,80)}`);
      // test one segment
      if (segs[0]) {
        const segUrl = new URL(segs[0], url).toString();
        const seg = execFileSync("curl", ["-sS","-m","30","-L","-A",UA,"-H","accept: */*","-H","referer: https://flixcloud.cc/",segUrl], {maxBuffer: 30*1024*1024});
        console.log(`   segment ${seg.length}B head=${seg.slice(0,4).toString("hex")} ${seg.slice(4,12).toString("latin1").replace(/[^\x20-\x7e]/g,".")}`);
      }
    }
    return txt;
  }
  console.log("__pk XOR failed for", url.slice(0, 90));
  return null;
}
