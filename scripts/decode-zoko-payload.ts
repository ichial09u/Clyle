/**
 * Decode zokoanime's player payload (__P) to understand the stream config:
 * payload = base64( xor( json ) ) with key "otaku-embed-v1".
 */
const OBF_KEY = "otaku-embed-v1";

function xor(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length));
  }
  return out;
}

function deobfuscate(blob) {
  return JSON.parse(decodeURIComponent(escape(xor(atob(blob)))));
}

const html = await Bun.stdin.text();
const m = html.match(/window\.__P="([^"]+)"/);
if (!m) {
  console.error("No __P payload found");
  process.exit(1);
}
const cfg = deobfuscate(m[1]);
console.log(JSON.stringify(cfg, null, 2));
