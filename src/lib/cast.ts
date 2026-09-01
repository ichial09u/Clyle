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

/* ---- failure forensics ------------------------------------------------
 * CAF's requestSession() rejection is often an EMPTY object (no code, no
 * message) — the real reason rides on the CastContext events instead
 * (SESSION_START_FAILED / CAST_STATE_CHANGED carry e.errorCode). We keep
 * both the last event errorCode and a short trail so a failed cast can be
 * diagnosed from the toast alone, without a debugger.
 * -------------------------------------------------------------------- */
let lastEventError = "";
const castTrail: string[] = [];
function noteTrail(s: string, code?: unknown) {
  const c = typeof code === "string" && code ? code : "";
  if (c) lastEventError = c;
  castTrail.push(c ? `${s}(${c})` : s);
  if (castTrail.length > 12) castTrail.shift();
}

/* receiver-side playback failure (HLS the TV couldn't load etc.) */
const mediaErrorListeners = new Set<(msg: string) => void>();
export function onCastMediaError(fn: (msg: string) => void): () => void {
  mediaErrorListeners.add(fn);
  return () => mediaErrorListeners.delete(fn);
}
function notifyMediaError(msg: string) {
  mediaErrorListeners.forEach((fn) => {
    try {
      fn(msg);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Squeeze every byte of meaning out of a cast failure. CAF rejections come
 * in many shapes: undefined, empty object, {errorCode}, {code, description},
 * DOMException, Error... Serialize whichever fields actually exist.
 */
function describeError(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err.trim();
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "description", "errorCode", "code", "detail", "reason", "name"]) {
    const v = e[key];
    if (typeof v === "string" && v.trim()) parts.push(`${key}:${v.trim().replace(/_/g, " ")}`);
    else if (typeof v === "number") parts.push(`${key}:${v}`);
  }
  // last resort: every own property, JSON-shaped (truncated)
  if (parts.length === 0) {
    try {
      const keys = Object.getOwnPropertyNames(e);
      const snap = JSON.stringify(e, keys as never);
      if (snap && snap !== "{}" && snap !== '""') parts.push(snap.slice(0, 140));
      else if (keys.length > 0) parts.push(keys.join(","));
    } catch {
      /* ignore */
    }
  }
  return parts.join(" · ").slice(0, 180);
}

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
          noteTrail("session-started");
          refs.session = e.session ?? context.getCurrentSession();
          setState("casting");
        } else if (s === S.SESSION_START_FAILED) {
          // THIS is where the real reason hides when requestSession rejects empty
          noteTrail("session-failed", e?.errorCode);
          refs.session = null;
          refs.media = null;
          setState("idle");
        } else if (s === S.SESSION_ENDED || s === S.SESSION_END_FAILED) {
          noteTrail("session-ended", s === S.SESSION_END_FAILED ? e?.errorCode : undefined);
          refs.session = null;
          refs.media = null;
          setState("idle");
        }
      },
    );
    context.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, (e: any) => {
      noteTrail(`cast:${e?.castState ?? "?"}`, e?.errorCode);
    });
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
  /** Deprecated text (metadata subtitle line), not a caption track. */
  subtitle?: string;
  /** Side-loaded caption track the receiver fetches directly (absolute URL). */
  captions?: { url: string; label?: string };
  imageUrl?: string | null;
  /** Resume point, seconds. */
  startTime?: number;
}

/** Side-load a WebVTT caption track onto the Default Media Receiver. */
function attachCaptions(chromeCast: any, mediaInfo: any, request: any, captions?: { url: string; label?: string }) {
  if (!captions?.url || !chromeCast.media.Track) return;
  try {
    const track = new chromeCast.media.Track(0, chromeCast.media.TrackType.TEXT);
    track.subtype = chromeCast.media.TextTrackType?.SUBTITLES ?? "SUBTITLES";
    track.name = captions.label || "English";
    track.language = "en";
    track.contentId = captions.url;
    track.contentType = "text/vtt";
    mediaInfo.tracks = [track];
    request.activeTrackIds = [0];
  } catch {
    /* captions are best-effort — video still casts without them */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the user to pick a device, then load the episode. Returns success. */
export async function castLoad(req: CastMediaRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const framework = cfw();
    const chromeCast = (window as any).chrome?.cast;
    if (!framework || !chromeCast) return { ok: false, error: "Cast is not available in this browser" };

    setState("connecting");
    const context = framework.CastContext.getInstance();

    if (!refs.session) {
      const ask = async () => {
        const session = await context.requestSession(); // rejects on cancel/failure
        return session ?? context.getCurrentSession();
      };
      try {
        refs.session = await ask();
      } catch (err) {
        const text = describeError(err).toLowerCase();
        // user closed the chooser — do not retry, just report
        if (text.includes("cancel")) throw err;
        // first connect attempts fail transiently on flaky mesh/2.4GHz links;
        // one quiet retry catches a good chunk of those
        noteTrail("retry");
        await sleep(1200);
        refs.session = await ask();
      }
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
    attachCaptions(chromeCast, mediaInfo, request, req.captions);

    const media = await refs.session.loadMedia(request);
    refs.media = media;
    media.addUpdateListener?.(() => {
      // if playback finished / errored on the big screen, keep state honest
      const st = media.status?.playerState;
      if (st === "IDLE" && media.status?.idleReason === "ERROR") {
        noteTrail("receiver-media-error");
        notifyMediaError("The TV couldn't play this stream — try another server or quality");
      }
    });
    setState("casting");
    return { ok: true };
  } catch (err: unknown) {
    // CAF errors arrive in mixed shapes (often EMPTY) — describeError pulls
    // whatever exists, and lastEventError holds the reason the context events
    // saw (the promise rejection alone is frequently {} on session failures).
    const detail = [describeError(err), lastEventError ? `event:${lastEventError}` : ""]
      .filter(Boolean)
      .join(" · ");
    const flat = detail.toLowerCase();
    console.warn("[cast] session/media failure:", err, "| eventError:", lastEventError, "| trail:", castTrail.join(" > "));
    let msg: string;
    if (flat.includes("cancel")) msg = "Cast cancelled";
    else if (flat.includes("no device") || flat.includes("not found") || flat.includes("no compatible")) {
      msg = "No cast device found — make sure your TV/Chromecast is on the same Wi-Fi, then try again";
    } else if (flat.includes("session error") || flat.includes("timeout") || flat.includes("unreachable")) {
      msg = `Couldn't reach the TV (${detail}) — your phone finds the TV but can't open a connection. Router AP/client isolation or a guest network usually causes this`;
    } else if (flat.includes("load") || flat.includes("media") || flat.includes("invalid")) {
      msg = "The TV couldn't load this stream — try another server for this episode";
    } else {
      // unknown failure — show everything we captured so it can be reported
      msg = `Cast failed (${detail || "no details"}) — tell me this text to fix it`;
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
    attachCaptions(chromeCast, mediaInfo, request, req.captions);
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
