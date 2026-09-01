"use client";

/**
 * Chromecast sender via Google's Cast Application Framework (CAF).
 *
 * We cast the SAME proxied HLS playlist our in-app player uses
 * (/api/stream/proxy rewrites Zoko's CDN URLs and serves them with
 * `Access-Control-Allow-Origin: *`), so the Default Media Receiver can play
 * it without any custom receiver app. The playlist's child URIs are
 * origin-relative, which the receiver resolves against the manifest URL —
 * the whole session stays inside our origin.
 *
 * The SDK only exists in Chrome/Chromium; everywhere else we simply hide the
 * Cast button.
 */


const CAST_SDK_SRC = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

export type CastState = "unavailable" | "idle" | "connecting" | "casting";

interface CastRefs {
  session: any | null;
  media: any | null;
}

const refs: CastRefs = { session: null, media: null };

let sdkLoading = false;
let sdkReady = false;
let currentState: CastState = "unavailable";
const listeners = new Set<(s: CastState) => void>();

function setState(s: CastState) {
  if (currentState === s) return;
  currentState = s;
  listeners.forEach((fn) => {
    try {
      fn(s);
    } catch {
      /* ignore listener errors */
    }
  });
}

export function getCastState(): CastState {
  return currentState;
}

export function onCastStateChange(fn: (s: CastState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function cfw(): any {
  return (window as any).cast?.framework;
}

/**
 * Inject the CAF sender SDK once and configure the cast context with the
 * Default Media Receiver. Safe to call from every player mount.
 */
export function ensureCastSdk(): void {
  if (typeof window === "undefined" || sdkReady || sdkLoading) return;

  // SDK already there (another component loaded it)
  if (cfw() && (window as any).chrome?.cast?.media) {
    configureContext();
    return;
  }

  sdkLoading = true;
  const done = (ok: boolean) => {
    sdkLoading = false;
    if (!ok) {
      setState("unavailable");
      return;
    }
    configureContext();
  };

  (window as any).__onGCastApiAvailable = (available: boolean) => done(available !== false);

  const existing = document.querySelector<HTMLScriptElement>(`script[src="${CAST_SDK_SRC}"]`);
  if (existing) return; // callback above will fire
  const script = document.createElement("script");
  script.src = CAST_SDK_SRC;
  script.async = true;
  script.onerror = () => done(false);
  document.head.appendChild(script);

  // belt & braces: some builds never call __onGCastApiAvailable
  window.setTimeout(() => {
    if (!sdkReady && cfw() && (window as any).chrome?.cast?.media) configureContext();
  }, 6000);
}

function configureContext() {
  try {
    const framework = cfw();
    if (!framework || !(window as any).chrome?.cast?.media) {
      setState("unavailable");
      return;
    }
    const context = framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: (window as any).chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: (window as any).chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    context.addEventListener(
      framework.CastContextEventType.SESSION_STATE_CHANGED,
      (e: any) => {
        const s = e?.sessionState;
        const S = framework.SessionState ?? {};
        if (s === S.SESSION_STARTED || s === S.SESSION_RESUMED) {
          refs.session = e.session ?? context.getCurrentSession();
          setState("casting");
        } else if (s === S.SESSION_START_FAILED) {
          refs.session = null;
          refs.media = null;
          setState("idle");
        } else if (s === S.SESSION_ENDED || s === S.SESSION_END_FAILED) {
          refs.session = null;
          refs.media = null;
          setState("idle");
        }
      },
    );
    // a previous page load may still hold a live session
    if (context.getCurrentSession()) {
      refs.session = context.getCurrentSession();
      setState("casting");
    } else {
      setState("idle");
    }
    sdkReady = true;
  } catch {
    setState("unavailable");
  }
}

export interface CastMediaRequest {
  /** Absolute HTTPS URL of the master m3u8 (our proxy). */
  src: string;
  title: string;
  subtitle?: string;
  imageUrl?: string | null;
  /** Resume point, seconds. */
  startTime?: number;
}

/** Ask the user to pick a device, then load the episode. Returns success. */
export async function castLoad(req: CastMediaRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const framework = cfw();
    const chromeCast = (window as any).chrome?.cast;
    if (!framework || !chromeCast) return { ok: false, error: "Cast is not available in this browser" };

    setState("connecting");
    const context = framework.CastContext.getInstance();

    if (!refs.session) {
      const session = await context.requestSession(); // rejects on cancel/failure
      refs.session = session ?? context.getCurrentSession();
    }
    if (!refs.session) throw new Error("No Chromecast selected");

    const mediaInfo = new chromeCast.media.MediaInfo(req.src, "application/x-mpegurl");
    const metadata = new chromeCast.media.GenericMediaMetadata();
    metadata.title = req.title;
    if (req.subtitle) metadata.subtitle = req.subtitle;
    if (req.imageUrl) metadata.images = [new chromeCast.Image(req.imageUrl)];
    mediaInfo.metadata = metadata;
    mediaInfo.streamType = chromeCast.media.StreamType.BUFFERED;

    const request = new chromeCast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = Math.max(0, req.startTime ?? 0);

    const media = await refs.session.loadMedia(request);
    refs.media = media;
    media.addUpdateListener?.(() => {
      // if playback finished / errored on the big screen, keep state honest
      const st = media.status?.playerState;
      if (st === "IDLE" && media.status?.idleReason === "FINISHED") {
        // keep the session alive — the user may pick the next episode
      }
    });
    setState("casting");
    return { ok: true };
  } catch (err: any) {
    // CAF errors arrive as message/description/code in mixed formats
    // ("session_error", "LOAD_MEDIA_FAILED", numeric codes...) — normalize
    // before matching so every failure maps to an actionable message.
    const rawParts = [err?.message, err?.description, typeof err?.code === "number" ? `code ${err.code}` : err?.code]
      .filter((p: unknown) => typeof p === "string" && p && p !== "undefined")
      .map((p: string) => String(p).replace(/_/g, " ").trim());
    const raw = rawParts[0] || "Cast failed";
    const flat = rawParts.join(" | ").toLowerCase();
    console.warn("[cast] session/media failure:", err, rawParts.join(" | "));
    let msg: string;
    if (flat.includes("cancel")) msg = "Cast cancelled";
    else if (flat.includes("no device") || flat.includes("not found") || flat.includes("no compatible")) {
      msg = "No cast device found — make sure your TV/Chromecast is on the same Wi-Fi, then try again";
    } else if (flat.includes("session error") || flat.includes("timeout") || flat.includes("status")) {
      msg = "Couldn't reach the cast device — check the Wi-Fi and try again";
    } else if (flat.includes("load") || flat.includes("media")) {
      msg = "The TV couldn't load this stream — try another server for this episode";
    } else {
      // unknown failure — show the actual code so it can be reported/fixed
      msg = `Cast failed (${rawParts.join(" · ")}) — tell me this text to fix it`;
    }
    if (!refs.session) setState("idle");
    return { ok: false, error: msg };
  }
}

/** Load another episode into the live cast session (no re-prompt). */
export async function castLoadNext(req: CastMediaRequest): Promise<boolean> {
  if (!refs.session) return false;
  try {
    const chromeCast = (window as any).chrome?.cast;
    const mediaInfo = new chromeCast.media.MediaInfo(req.src, "application/x-mpegurl");
    const metadata = new chromeCast.media.GenericMediaMetadata();
    metadata.title = req.title;
    if (req.imageUrl) metadata.images = [new chromeCast.Image(req.imageUrl)];
    mediaInfo.metadata = metadata;
    const request = new chromeCast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    request.currentTime = Math.max(0, req.startTime ?? 0);
    refs.media = await refs.session.loadMedia(request);
    return true;
  } catch {
    return false;
  }
}

/** Stop casting and give playback back to the device. */
export function castStop(): void {
  try {
    refs.media = null;
    refs.session?.endCurrentSession?.(true);
    cfw()?.CastContext.getInstance().endCurrentSession(true);
  } catch {
    /* ignore */
  }
  refs.session = null;
  setState("idle");
}

/** Best-effort current position inside the cast session (seconds). */
export function castPosition(): number | null {
  try {
    const t = refs.media?.getEstimatedTime?.();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function castDuration(): number | null {
  try {
    const d = refs.media?.duration;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}
