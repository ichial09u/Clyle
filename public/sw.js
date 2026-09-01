/*
 * Clyle service worker — deliberately minimal.
 *
 * Why it exists: Android Chrome only treats the site as an installable PWA
 * (fires `beforeinstallprompt`, shows "Install app") when a service worker
 * with a fetch handler is registered. It must NOT get in the way of
 * playback, so the strategy is pure network pass-through:
 *
 *   - only same-origin GETs are handled; POSTs (progress/watchtime/import)
 *     and cross-origin requests (CDN posters, cast SDK) are untouched
 *   - responses are NEVER cached — every request goes to the network exactly
 *     like before, so HLS segments/range requests keep working unchanged
 *   - the only added value: if the network is gone while opening the app,
 *     navigations get a tiny offline notice instead of a browser error
 */

self.addEventListener("install", () => {
  // nothing to precache — install instantly
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch API writes
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // posters, cast SDK, Zoko CDN

  event.respondWith(
    fetch(req).catch(() => {
      if (req.mode === "navigate") {
        return new Response(
          '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clyle</title><style>body{background:#000;color:#bbb;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:24px;text-align:center}p{font-size:14px;line-height:1.6}</style></head><body><p>You&rsquo;re offline.<br>Reopen <b>Clyle</b> when you have a connection.</p></body></html>',
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
        );
      }
      return Response.error(); // non-navigation offline failure: behave like before
    }),
  );
});
