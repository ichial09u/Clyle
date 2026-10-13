#!/usr/bin/env python3
"""Direct zoko payload probe for one (malId, ep, lang) — bypasses the app's
hasDub short-circuit to learn the UPSTREAM truth."""
import base64
import json
import re
import sys
import urllib.request

KEY = b"otaku-embed-v1"


def xor(data: bytes, key: bytes) -> bytes:
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def fetch(mal: int, ep: int, lang: str) -> dict | None:
    url = f"https://zokoanime.video/stream/mal/{mal}/{ep}/{lang}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"})
    try:
        html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    except Exception as e:
        return {"error": f"HTTP {e}"}
    m = re.search(r'window\.__P\s*=\s*"([^"]+)"', html)
    if not m:
        # page exists but no payload — look for markers
        has_404 = "not found" in html.lower()
        return {"error": "no __P payload", "page404": has_404, "len": len(html)}
    raw = base64.b64decode(m.group(1))
    dec = xor(raw, KEY).decode("utf-8", "replace")
    try:
        dec = urllib.parse.unquote(dec)
    except Exception:
        pass
    try:
        return json.loads(dec)
    except Exception:
        # escape-decode fallback (JS escape/unescape latin1)
        try:
            dec2 = dec.encode("latin1", "replace").decode("utf-8", "replace")
            return json.loads(dec2)
        except Exception:
            return {"error": "decode failed", "raw": dec[:200]}


if __name__ == "__main__":
    import urllib.parse
    mal, ep, lang = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    out = fetch(mal, ep, lang)
    if out and "error" not in out:
        keep = {k: out.get(k) for k in ("src", "subtitles", "skip", "audio", "lang", "quality")}
        if isinstance(keep.get("src"), str):
            keep["src"] = keep["src"][:80]
        print(json.dumps(keep, indent=1)[:800])
        subs = keep.get("subtitles") or []
        if isinstance(subs, list):
            print("SUB LANGS:", [s.get("label") or s.get("lang") for s in subs][:12])
    else:
        print(json.dumps(out, indent=1)[:400])
