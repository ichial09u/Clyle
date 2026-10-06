/*
 * Clyle offline engine.
 *
 * The old SW was a pure network pass-through (its only job was making the
 * site installable). This one makes the app actually USABLE with no internet:
 *
 *   - app shell (navigations)      network-first, cached copy offline
 *   - build assets /_next/static   cache-first (content-hashed, immutable)
 *   - catalog GET APIs             network-first, cached copy offline
 *   - stream proxy playlists       network-first, cached copy offline
 *   - stream proxy SEGMENTS        cache-first — everything that played while
 *                                  online is on the device, so rewatches and
 *                                  continue-watching play offline in the same
 *                                  quality (up to full HD) they were watched
 *   - poster / art images          cache-first with caps
 *
 * Caps keep storage bounded: segments are FIFO-capped (oldest-tokened URLs
 * evict first — each re-resolve mints fresh tokened URLs, so old segments
 * are naturally dead weight). Every cache write is quota-safe (try/catch).
 *
 * Writes/POSTs are NEVER intercepted here — progress, watchtime, my list
 * etc. queue in the page (client-store outbox) and replay when the
 * connection returns, so nothing in this file can swallow a save.
 *
 * The push / notificationclick handlers at the bottom are untouched.
 */

const VERSION = "v1";
const SHELL = `clyle-shell-${VERSION}`;
const STATIC = `clyle-static-${VERSION}`;
const API = `clyle-api-${VERSION}`;
const MEDIA = `clyle-media-${VERSION}`;
const IMG = `clyle-img-${VERSION}`;
const OWNED = [SHELL, STATIC, API, MEDIA, IMG];

// segment entries (~0.7-1.4 MB each) and poster entries we keep at most.
// ~1200 segments ≈ 1-1.5 GB — several full episodes at 1080p.
const CAPS = { [MEDIA]: 1200, [IMG]: 600 };
let trimTick = 0;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !OWNED.includes(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* ---------------- helpers ---------------- */

/** FIFO-trim a capped cache — checked every 25 writes (and on demand). */
async function fifoTrim(name, force = false) {
  const max = CAPS[name];
  if (!max) return;
  if (!force && (trimTick = (trimTick + 1) % 25) !== 0) return;
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const over = keys.length - max;
    for (let i = 0; i < over; i++) await cache.delete(keys[i]);
  } catch {
    /* quota/lookup issues are never worth crashing the handler over */
  }
}

/** Cache a successful GET response, ignoring any storage failure. */
async function stash(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    fifoTrim(cacheName);
  } catch {
    /* storage full / private mode — playback itself still works */
  }
}

/** fetch() with a hard timeout so a hanging portal doesn't freeze offline fallback. */
function fetchTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function isImageRequest(url, request) {
  if (request.destination === "image") return true;
  return /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(url.pathname);
}

/* ---------------- strategies ---------------- */

// pages: fresh when online, cached snapshot offline, bundled shell as last resort
async function handleNavigation(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) stash(SHELL, request, res.clone());
    return res;
  } catch {
    const cache = await caches.open(SHELL);
    return (
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match("/")) ||
      offlinePage()
    );
  }
}

// build assets: immutable — cache first, network only on a miss
async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && (res.ok || res.type === "opaque")) stash(cacheName, request, res.clone());
  return res;
}

// catalog APIs: fresh first (8s cap), cached answer when the network is gone
async function handleApi(request) {
  const url = new URL(request.url);
  // bot/cron endpoints are machine-only — no cache value, no staleness risk
  if (url.pathname.startsWith("/api/cron") || url.pathname.startsWith("/api/bots")) {
    return fetch(request).catch(() => Response.error());
  }
  try {
    const res = await fetchTimeout(request, 8_000);
    if (res && res.ok) stash(API, request, res.clone());
    return res;
  } catch {
    const cache = await caches.open(API);
    const hit = await cache.match(request, { ignoreSearch: false });
    if (hit) return hit;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}

// posters/art (same-origin + opaque cross-origin CDN images): cache first
async function handleImage(request) {
  try {
    return await cacheFirst(IMG, request);
  } catch {
    return Response.error();
  }
}

// stream proxy: the heart of offline playback
//
//  - playlists (m3u8 / fkey master) + subtitles: network-first, cached offline
//  - segments + keys: cache-first. A segment URL is minted per resolve and is
//    immutable at that URL (the proxy already marks it immutable), so a cache
//    hit is always byte-identical to the network answer.
//  - Range requests (native progressive mp4 fallback): served from cache with
//    a hand-built 206; never cached themselves.
async function handleMedia(request, url) {
  const sp = url.searchParams;
  const type = sp.get("type");
  const upstream = sp.get("u") || "";
  const isPlaylist = type === "m3u8" || sp.has("fkey") || /\.m3u8($|\?)/i.test(upstream);
  const isVtt = type === "vtt";

  if (isPlaylist || isVtt) {
    try {
      const res = await fetchTimeout(request, 8_000);
      if (res && res.ok) stash(MEDIA, request, res.clone());
      return res;
    } catch {
      const hit = await (await caches.open(MEDIA)).match(request);
      return hit || Response.error();
    }
  }

  // segment / key / misc binary
  const cache = await caches.open(MEDIA);
  const hit = await cache.match(request);
  if (hit) {
    if (request.headers.has("range")) return slice206(hit, request);
    return hit;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok && res.status === 200 && !request.headers.has("range")) {
      stash(MEDIA, request, res.clone());
    }
    return res;
  } catch {
    return Response.error();
  }
}

/** Build a 206 partial response from a cached full response. */
async function slice206(full, request) {
  const range = request.headers.get("range") || "";
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const buf = await full.clone().arrayBuffer();
  if (!m) return full;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? Math.min(parseInt(m[2], 10), buf.byteLength - 1) : buf.byteLength - 1;
  if (start >= buf.byteLength || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${buf.byteLength}` },
    });
  }
  const body = buf.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": full.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
      "Content-Length": String(body.byteLength),
      "Accept-Ranges": "bytes",
    },
  });
}

function offlinePage() {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clyle</title><style>
      body{background:#000;color:#eee;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px}
      .card{text-align:center;max-width:340px}
      .dot{width:10px;height:10px;border-radius:50%;background:#d32f2f;display:inline-block;margin-bottom:14px;box-shadow:0 0 14px #d32f2f88}
      h1{font-size:17px;margin:0 0 8px}
      p{font-size:13px;line-height:1.65;color:#9a9aa2;margin:0}
      button{margin-top:18px;background:#fff;color:#000;border:0;border-radius:12px;padding:10px 22px;font-weight:600;font-size:13px}
    </style></head><body><div class="card"><span class="dot"></span><h1>You&rsquo;re offline</h1><p>Clyle couldn&rsquo;t reach the internet on this launch. Reopen the app from your home screen to browse and watch everything saved on this device.</p><button onclick="location.reload()">Retry</button></div></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/* ---------------- router ---------------- */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // writes belong to the page-level outbox
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  const same = url.origin === self.location.origin;

  // 1) our playback proxy — everything HLS rides through here
  if (same && url.pathname.startsWith("/api/stream/proxy")) {
    event.respondWith(handleMedia(req, url));
    return;
  }

  // 2) poster / art images (same-origin endpoints + cross-origin CDNs)
  if (isImageRequest(url, req)) {
    if (same || req.mode === "no-cors" || req.mode === "cors") {
      event.respondWith(handleImage(req));
      return;
    }
    return;
  }

  if (!same) return; // cast SDK, fonts, anything else cross-origin: untouched

  // 3) navigations (the SPA shell)
  if (req.mode === "navigate") {
    event.respondWith(handleNavigation(req));
    return;
  }

  // 4) build assets + manifest: immutable, cache-first
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(css|js|mjs|woff2?|ttf|webmanifest)$/i.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(STATIC, req));
    return;
  }

  // 5) catalog APIs (stream proxy already handled above)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(handleApi(req));
    return;
  }

  // anything else (service files, one-offs): plain pass-through
});

/* ------------------------------------------------------------------ *
 * Web Push — "actual notifications that pop up when you're not in the app".
 *
 * The server signs payloads with VAPID and fires them at the browser's push
 * service when a new anime lands in the catalog, a new episode drops, the
 * Top 10 moves (one summary/day), or an episode is about to air. This
 * handler is what the OS wakes to display them — it runs with the app fully
 * closed, which is the entire point.
 *
 * Payload shape (src/lib/push.ts): { t: title, b: body, tag?, url?, img? }.
 * Text-only fallback if a payload ever fails to parse (a showNotification()
 * is mandatory on push — Chrome kills the SW otherwise).
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { t: event.data ? event.data.text() : "Clyle", b: "" };
  }
  const title = (data.t || "Clyle").slice(0, 120);
  const options = {
    body: (data.b || "").slice(0, 200) || undefined,
    tag: data.tag || "clyle", // same tag replaces — no notification pileups
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    image: data.img || undefined, // poster (large picture where supported)
    data: { url: data.url || "/" },
    // keep Android from stacking duplicates between wakeups
    renotify: !!data.tag,
    requireInteraction: false,
    silent: false,
  };
  event.waitUntil(
    self.registration.showNotification(title, options).catch(() => undefined),
  );
});

/*
 * Tapping a notification opens (or focuses) the app at the payload URL —
 * /?open={malId} lands straight on that anime's details.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  const abs = new URL(target, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // already open? focus it and navigate in place
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          try {
            if ("navigate" in client) await client.navigate(abs);
          } catch {
            /* older browsers: focusing the open app is enough */
          }
          return;
        }
      }
      // nothing open — launch fresh
      await self.clients.openWindow(abs);
    })(),
  );
});
