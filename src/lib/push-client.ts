"use client";

/**
 * Browser-side Web Push plumbing — pairs with src/lib/push.ts (server) and
 * public/sw.js (display). Everything here is deliberately defensive: push
 * support varies wildly (iOS only inside the installed PWA, desktop Chrome
 * fine in-tab) and every failure must degrade to "no notifications" instead
 * of breaking the app.
 *
 * Lifecycle:
 *   enable()  — ask permission -> subscribe with the server's VAPID key ->
 *               POST /api/push/subscribe. Returns a human-readable status.
 *   disable() — DELETE the server row + local unsubscribe.
 *   selfHeal()— on app open while enabled: re-POST the (possibly changed)
 *               subscription so a deploy that reset the server DB recovers
 *               silently on the next visit, without re-prompting.
 */

const ENABLED_KEY = "clyle.push.enabled";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushEnabledFlag(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function setEnabledFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* private mode — flag is best-effort */
  }
}

/** Current permission as a display string. */
export function pushPermission(): "granted" | "denied" | "default" | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission as "granted" | "denied" | "default";
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  // RegisterSW registers in production; ensurePushRegistration covers dev/tests
  let reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch {
      return null;
    }
  }
  // the push handler must be live before a subscription is useful
  await navigator.serviceWorker.ready.catch(() => undefined);
  return reg ?? null;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "sw-failed" | "subscribe-failed" | "server-rejected" | "no-key" };

/** Ask, subscribe, register server-side. Safe to call repeatedly. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, reason: "denied" };

  const reg = await swRegistration();
  if (!reg) return { ok: false, reason: "sw-failed" };

  let publicKey: string;
  try {
    const res = await fetch("/api/push/key");
    const data = (await res.json()) as { publicKey?: string };
    if (!res.ok || !data.publicKey) return { ok: false, reason: "no-key" };
    publicKey = data.publicKey;
  } catch {
    return { ok: false, reason: "no-key" };
  }

  let sub: PushSubscription;
  try {
    const existing = await reg.pushManager.getSubscription();
    sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));
  } catch {
    return { ok: false, reason: "subscribe-failed" };
  }

  const posted = await postSubscription(sub);
  if (!posted) return { ok: false, reason: "server-rejected" };

  setEnabledFlag(true);
  return { ok: true };
}

/** Unsubscribe everywhere (server row first, then the browser's). */
export async function disablePush(): Promise<void> {
  setEnabledFlag(false);
  try {
    const reg = await swRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
  } catch {
    /* disable is best-effort */
  }
}

async function postSubscription(sub: PushSubscription): Promise<boolean> {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const userId = (() => {
    try {
      // profile-store's key ("animetest123.user", JSON {id,…}) — read raw to
      // avoid a client-store import cycle for one field
      const raw = localStorage.getItem("animetest123.user");
      return raw ? ((JSON.parse(raw) as { id?: string }).id ?? undefined) : undefined;
    } catch {
      return undefined;
    }
  })();
  try {
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Called on every app open while notifications are enabled: if the browser
 * still holds a subscription, re-upsert it server-side (covers deploy DB
 * resets; costs one tiny POST). If the flag is set but the subscription is
 * gone (OS revoked it), try to re-subscribe quietly.
 */
export async function pushSelfHeal(): Promise<void> {
  if (!pushSupported() || !pushEnabledFlag()) return;
  try {
    if (Notification.permission !== "granted") {
      setEnabledFlag(false);
      return;
    }
    const reg = await swRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await postSubscription(sub);
    } else {
      await enablePush();
    }
  } catch {
    /* self-heal is silent by design */
  }
}
