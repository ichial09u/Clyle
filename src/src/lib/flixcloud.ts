/**
 * FlixCloud (flixcloud.cc) embed resolver — the direct-play path for the
 * Ranma ½ (2024) Season 1 English DUB.
 *
 * AnimeFrenzy (animefrenzy.cc) hosts S1 on FlixCloud embeds that carry BOTH
 * audio tracks (Japanese + English) in one dual-audio HLS master; their SUB
 * pages use `?v=2`, their DUB pages `?v=1` — same embed id per episode. We
 * resolve the embed to the REAL master playlist server-side so OUR player
 * can stream it (no iframe, no ArtPlayer UI bleeding under ours).
 *
 * The embed page obfuscates the manifest URL in layers (all reverse-engineered
 * from the site's player bundle — field names, crypto and the mixing WASM all
 * ship inside the page itself):
 *
 *   1. GET /e/{aid}?v=1&a=1 — SvelteKit SSR payload carries
 *      `obfuscation_seed`, `obfuscated_crypto_data`, `w_payload` (a WASM
 *      blob) and one-time-token material, all under per-load obfuscated keys.
 *   2. Field names derive from the seed via a 3-round SHA-256 chain (plus 3
 *      more rounds for the keyFrag2 field).
 *   3. GET /api/m3u8/{token} (same-session cookies required) returns the
 *      encrypted manifest URL + key material under SHA-256-derived short keys.
 *   4. WASM `_s(seedInt)` + `_r(frag1, frag2, tokKey → out)` mixes the three
 *      key fragments; PBKDF2(salt=seed, 1000 iters) → XOR seed chars →
 *      SHA-256 = the AES-256-CBC key. Decrypting yields the master.m3u8 URL
 *      (JWT, 6h, client-IP-bound).
 *   5. WASM `_c()` after the mix exposes 32 bytes (`__pk`) — playlists are
 *      served base64(XOR(bytes, __pk)); our stream proxy peels that layer.
 *      Segments are standard HLS (AES-256-CTR via EXT-X-KEY) — hls.js handles
 *      them natively once the playlists are plaintext.
 *
 * The episode → embed map is scraped from animefrenzy's watch pages
 * (scripts/frenzy-scrape.mjs); ids also cross-check against the previously
 * deployed embed-only behavior.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** malId → episode → flixcloud embed id (animefrenzy.cc S1 DUB, 2026-10) */
const FLIX_EMBED_IDS: Record<number, Record<number, string>> = {
  59145: {
    1: "dmvdjvrznpif",
    2: "0fh5dcp590bu",
    3: "thfyg5cmf66c",
    4: "c5rljwyr2sb3",
    5: "6z1s0qsiqfz7",
    6: "ugxil8h1wrdh",
    7: "5bx4nznyhqw9",
    8: "nugi46pv0pqz",
    9: "lk3s6si86oxw",
    10: "z89kthenr82j",
    11: "6q7gti2zm84k",
    12: "2si4dhgms4qk",
  },
};

export const FLIX_REFERER = "https://flixcloud.cc/";
const ORIGIN = "https://flixcloud.cc";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Highest episode with a flix embed (null = title not mapped). */
export function flixDubThrough(malId: number): number | null {
  const map = FLIX_EMBED_IDS[malId];
  if (!map) return null;
  let thru = 0;
  while (map[thru + 1] != null) thru++;
  return thru > 0 ? thru : null;
}

export interface FlixStream {
  /** proxy URL fragment identifying the stored synthesized master (/api/stream/proxy?...) */
  src: string;
  /** raw master.m3u8 URL (JWT, ~6h, client-IP-bound) — last-resort fallback only */
  masterUrl: string;
  /** stable cache key for the synthesized master (sha1 of the embed id) */
  fkey: string;
  pk: string; // hex — playlist XOR key, static per video
  subtitles: Array<{ lang: string; label: string; src: string }>; // SRT (proxy converts to VTT)
  skip?: { intro?: { start: number; end: number }; outro?: { start: number; end: number } };
}

/* ---- resolved-result cache: the JWT lives 6h; refetching the embed page +
        burning a one-time token on every playback request would trip the
        token endpoint's rate limiting (it 410s aggressively) -------------- */
const TTL_MS = 5 * 60 * 60 * 1000;
const STALE_GRACE_MS = 30 * 60_000;
interface FlixCacheEntry {
  data: FlixStream;
  /** the DECRYPTED master playlist with absolute (JWT-less) variant URIs */
  masterText: string;
  expires: number;
}
const cache = new Map<string, FlixCacheEntry>();

/* ---- disk layer (same pattern as supaplay/anilist caches): survives cold
        starts on the same instance, so a redeploy doesn't re-burn tokens --- */
const DISK_CACHE_DIR =
  process.env.VERCEL === "1" ? join(tmpdir(), "flixcloud") : join(process.cwd(), "db", "flix-cache");

function diskPath(key: string): string {
  return join(DISK_CACHE_DIR, `${key}.json`);
}

async function diskRead(key: string): Promise<FlixCacheEntry | null> {
  try {
    return JSON.parse(await readFile(diskPath(key), "utf8")) as FlixCacheEntry;
  } catch {
    return null;
  }
}

async function diskWrite(key: string, entry: FlixCacheEntry): Promise<void> {
  try {
    await mkdir(DISK_CACHE_DIR, { recursive: true });
    await writeFile(diskPath(key), JSON.stringify(entry), "utf8");
  } catch {
    /* best-effort */
  }
}

/* ---- transport: curl first (Cloudflare 403s undici's fingerprint and the
        token endpoint wants the embed page's session cookies), fetch as a
        best-effort fallback — same pattern as supaplay.ts / jikan.ts ------- */
const COOKIE_JAR = "/tmp/flixcloud-cookies.txt";

function curlGet(url: string, timeoutMs: number, extraHeaders: string[] = []): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "curl",
      [
        "-sS",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-L",
        "-A",
        UA,
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-b",
        COOKIE_JAR,
        "-c",
        COOKIE_JAR,
        ...extraHeaders,
        "-w",
        "\n__STATUS__%{http_code}",
        url,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs + 5_000 },
      (err, stdout, stderr) => {
        const m = stdout.match(/__STATUS__(\d+)\s*$/);
        if (!m) return reject(new Error(stderr || err?.message || "curl failed"));
        resolve({ status: parseInt(m[1], 10), body: stdout.replace(/__STATUS__\d+\s*$/, "") });
      },
    );
  });
}

/* ---- field-name derivation (3-round SHA-256 chain over the seed) -------- */
const sha256hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

interface FlixFields {
  containerName: string;
  arrayName: string;
  objectName: string;
  keyField: string;
  ivField: string;
  tokenField: string;
  keyFrag2Field: string;
}

function deriveFields(seed: string): FlixFields {
  let e = seed;
  for (let s = 0; s < 3; s++) e = sha256hex(e + s.toString());
  let a = e;
  for (let s = 0; s < 3; s++) a = sha256hex(a + s.toString());
  return {
    keyField: `kf_${e.slice(8, 16)}`,
    ivField: `ivf_${e.slice(16, 24)}`,
    containerName: `cd_${e.slice(24, 32)}`,
    arrayName: `ad_${e.slice(32, 40)}`,
    objectName: `od_${e.slice(40, 48)}`,
    tokenField: `${e.slice(48, 64)}_${e.slice(56, 64)}`,
    keyFrag2Field: `${a.slice(0, 16)}_${a.slice(16, 24)}`,
  };
}

/** Pull the SvelteKit SSR data object out of the embed page. */
function extractData(html: string): Record<string, unknown> {
  const marker = '{type:"data",data:{';
  const k = html.indexOf(marker);
  if (k < 0) throw new Error("no kit payload");
  const start = k + marker.length - 1; // at the '{' of the data object
  let depth = 0;
  let inStr = false;
  let esc = false;
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
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // SvelteKit emits a JS object literal (unquoted keys), not strict JSON
        const literal = html.slice(start, p + 1);
        // eslint-disable-next-line no-new-func
        return new Function(`return (${literal})`)() as Record<string, unknown>;
      }
    }
  }
  throw new Error("unterminated kit payload");
}

/** WASM _s(seedInt) + _r(frag1, frag2, tokKey → out) mix; also reads _c() = __pk. */
function wasmMix(wPayloadB64: string, frag1: Buffer, frag2: Buffer, tokKey: Buffer, seedInt: number): { mixed: Buffer; pk: Buffer } {
  const bytes = Buffer.from(wPayloadB64, "base64");
  const inst = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), {});
  const b = inst.exports as WebAssembly.Exports & { memory: WebAssembly.Memory; _s: (n: number) => void; _r: (...a: number[]) => void; _c?: () => number };
  const mem = b.memory;
  if (mem.buffer.byteLength === 0) mem.grow(1);
  let w = new Uint8Array(mem.buffer);
  const T = frag1.length;
  const BASE = 1000;
  const E = BASE + T;
  const Y = E + T;
  const B = Y + T;
  w.set(frag1, BASE);
  w.set(frag2, E);
  w.set(tokKey, Y);
  b._s(seedInt);
  b._r(BASE, E, Y, B, T);
  w = new Uint8Array(mem.buffer);
  let pk = Buffer.alloc(0);
  try {
    if (b._c) {
      const p = b._c();
      pk = Buffer.from(w.slice(p, p + 32));
    }
  } catch {
    /* _c missing — playlists will come plaintext or fail loudly */
  }
  return { mixed: Buffer.from(w.slice(B, B + T)), pk };
}

async function resolveEmbed(aid: string, malId: number, ep: number): Promise<{ stream: FlixStream; masterText: string }> {
  // 1. embed page (fresh cookies — the token endpoint is session-bound)
  const page = await curlGet(`${ORIGIN}/e/${aid}?v=1&a=1`, 20_000).catch(() => null);
  if (!page || page.status !== 200 || !page.body.includes("node_ids:")) {
    throw new Error(`embed page ${page?.status ?? "unreachable"}`);
  }
  const data = extractData(page.body);
  const seed = String(data.obfuscation_seed ?? "");
  const fields = deriveFields(seed);

  // 2. peel the obfuscated crypto container
  const cryptoData = data.obfuscated_crypto_data as Record<string, Record<string, Array<Record<string, Record<string, string>>>>> | undefined;
  const obj = cryptoData?.[fields.containerName]?.[fields.arrayName]?.[0]?.[fields.objectName];
  const frag1B64 = obj?.[fields.keyField];
  const ivB64 = obj?.[fields.ivField];
  const frag2 = data[fields.keyFrag2Field] as string | undefined;
  const token = data[fields.tokenField] as string | undefined;
  const wPayload = data.w_payload as string | undefined;
  if (!frag1B64 || !ivB64 || !frag2 || !token || !wPayload) {
    throw new Error("embed crypto payload incomplete");
  }

  // 3. one-time playback token (same session — the cookie jar matters)
  const tok = await curlGet(`${ORIGIN}/api/m3u8/${token}`, 15_000, [
    "-H",
    `Referer: ${ORIGIN}/e/${aid}?v=1&a=1`,
    "-H",
    `Origin: ${ORIGIN}`,
    "-H",
    "Sec-Fetch-Dest: empty",
    "-H",
    "Sec-Fetch-Mode: cors",
    "-H",
    "Sec-Fetch-Site: same-origin",
    "-H",
    "Accept: */*",
  ]).catch(() => null);
  if (!tok || tok.status !== 200) {
    throw new Error(`playback token ${tok?.status ?? "unreachable"}`);
  }
  const tokJson = JSON.parse(tok.body) as Record<string, string>;
  const vidKey = sha256hex(token + "vid").slice(0, 10);
  const keyKey = sha256hex(token + "key").slice(0, 10);
  const encManifestB64 = tokJson[vidKey];
  const tokKeyB64 = tokJson[keyKey];
  if (!encManifestB64 || !tokKeyB64) throw new Error("token response incomplete");

  // 4. derive the AES key exactly as the player does, decrypt the manifest URL
  const seedInt = parseInt(seed.slice(0, 8), 16);
  const { mixed, pk } = wasmMix(wPayload, Buffer.from(frag1B64, "base64"), Buffer.from(frag2, "base64"), Buffer.from(tokKeyB64, "base64"), seedInt);
  const pbk = crypto.pbkdf2Sync(mixed, Buffer.from(seed, "utf8"), 1000, 32, "sha256");
  const xored = Buffer.from(pbk);
  for (let i = 0; i < 32; i++) xored[i] ^= seed.charCodeAt(i % seed.length);
  const aesKey = crypto.createHash("sha256").update(xored).digest();
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, Buffer.from(ivB64, "base64"));
  const masterUrl = Buffer.concat([decipher.update(Buffer.from(encManifestB64, "base64")), decipher.final()]).toString("utf8");
  if (!masterUrl.startsWith("http")) throw new Error("decrypt produced no URL");

  // 4b. fetch the master HERE, in the same invocation that called the token
  // endpoint: its JWT is client-IP-bound, and only the master itself needs it
  // (child playlists/segments are JWT-less) — fetching it now guarantees the
  // requesting IP matches, no matter which lambda later serves the children
  const master = await curlGet(masterUrl, 20_000, ["-H", `Referer: ${FLIX_REFERER}`, "-H", "Accept: */*"]).catch(() => null);
  if (!master || master.status !== 200) throw new Error(`master fetch ${master?.status ?? "unreachable"}`);
  const rawMaster = master.body.trim();
  let masterText: string;
  if (rawMaster.startsWith("#EXTM3U")) {
    masterText = rawMaster;
  } else {
    // XOR with __pk, exactly what their patched hls.js loader does
    const bin = Buffer.from(rawMaster, "base64");
    const pkBuf = Buffer.from(pk);
    const dec = Buffer.from(bin);
    for (let i = 0; i < dec.length; i++) dec[i] ^= pkBuf[i % pkBuf.length];
    masterText = dec.toString("utf8");
    if (!masterText.startsWith("#EXTM3U")) throw new Error("master decrypt failed");
  }
  // absolutize the URIs and DROP the master's token query from children —
  // the variant/audio playlists authenticate by path, not by JWT
  const base = new URL(masterUrl);
  base.search = "";
  masterText = masterText
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return "";
      if (t.startsWith("#")) {
        return t.replace(/URI="([^"]+)"/g, (_m, uri: string) => {
          try {
            const abs = new URL(uri, base);
            abs.search = "";
            return `URI="${abs.toString()}"`;
          } catch {
            return _m;
          }
        });
      }
      try {
        const abs = new URL(t, base);
        abs.search = "";
        return abs.toString();
      } catch {
        return t;
      }
    })
    .join("\n");

  // 5. per-episode skip data + English subtitles come straight from the payload
  const chapters = data.chapters as Array<{ start: number; end: number; title: string }> | undefined;
  const intro = data.intro_chapter as { start: number; end: number } | undefined;
  const outro = data.outro_chapter as { start: number; end: number } | undefined;
  const skip: FlixStream["skip"] = {};
  if (intro && Number.isFinite(intro.start) && intro.end > intro.start) skip.intro = { start: intro.start, end: intro.end };
  else if (chapters?.length) {
    const op = chapters.find((c) => /op|opening/i.test(c.title));
    if (op) skip.intro = { start: op.start, end: op.end };
  }
  if (outro && Number.isFinite(outro.start) && outro.end > outro.start) skip.outro = { start: outro.start, end: outro.end };
  else if (chapters?.length) {
    const ed = chapters.find((c) => /ed|ending/i.test(c.title));
    if (ed) skip.outro = { start: ed.start, end: ed.end };
  }

  const subtitles = Array.isArray(data.subtitles)
    ? (data.subtitles as Array<{ url: string; language: string; default?: boolean }>)
        .filter((s) => s?.url && /\.srt($|\?)/i.test(s.url))
        .map((s) => ({
          lang: "en",
          label: /sdh/i.test(s.language) ? "English (SDH)" : /dubtitle/i.test(s.language) ? "English (Dubtitle)" : "English",
          src: s.url,
        }))
    : [];

  const pkHex = pk.toString("hex");
  const fkey = crypto.createHash("sha1").update(aid).digest("hex").slice(0, 24);
  const stream: FlixStream = {
    // the proxy serves the stored synthesized master by fkey; malId/ep let a
    // cache-miss instance re-resolve; u is the JWT master (last-resort only)
    src: `/api/stream/proxy?type=m3u8&fkey=${fkey}&malId=${malId}&ep=${ep}&pk=${encodeURIComponent(pkHex)}&rf=${encodeURIComponent(FLIX_REFERER)}&u=${encodeURIComponent(masterUrl)}`,
    masterUrl,
    fkey,
    pk: pkHex,
    subtitles,
    skip: skip.intro || skip.outro ? skip : undefined,
  };
  return { stream, masterText };
}

/**
 * Resolve the FlixCloud dual-audio stream for one episode.
 * Returns null when the title/episode isn't mapped or the upstream fails —
 * the caller falls through to its own 404 handling.
 */
export async function flixDubStream(malId: number, ep: number): Promise<FlixStream | null> {
  const entry = await flixResolveCached(malId, ep);
  return entry?.data ?? null;
}

/**
 * The proxy serves the stored synthesized master by `fkey`. Memory first,
 * then the disk layer, then a full re-resolve (which re-fetches the master
 * from the same lambda that called the token endpoint, keeping IPs aligned).
 */
export async function flixStoredMaster(malId: number, ep: number): Promise<string | null> {
  const entry = await flixResolveCached(malId, ep);
  return entry?.masterText ?? null;
}

async function flixResolveCached(malId: number, ep: number): Promise<FlixCacheEntry | null> {
  const aid = FLIX_EMBED_IDS[malId]?.[ep];
  if (!aid) return null;
  const key = crypto.createHash("sha1").update(aid).digest("hex").slice(0, 24);
  const mem = cache.get(key);
  if (mem && mem.expires > Date.now()) return mem;
  const disk = await diskRead(key);
  if (disk && disk.expires > Date.now() && disk.masterText.startsWith("#EXTM3U")) {
    cache.set(key, disk);
    return disk;
  }
  try {
    const { stream, masterText } = await resolveEmbed(aid, malId, ep);
    const entry: FlixCacheEntry = { data: stream, masterText, expires: Date.now() + TTL_MS };
    cache.set(key, entry);
    void diskWrite(key, entry);
    return entry;
  } catch (err) {
    console.error("[flixcloud]", aid, err instanceof Error ? err.message : err);
    // keep a stale-but-valid entry alive rather than spamming the token
    // endpoint while it is rate-limiting us
    const stale = mem ?? (await diskRead(key));
    if (stale && stale.expires + STALE_GRACE_MS > Date.now() && stale.masterText.startsWith("#EXTM3U")) {
      return stale;
    }
    return null;
  }
}
