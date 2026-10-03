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

/*
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
