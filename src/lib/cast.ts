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

/* DEV-only hook point (set by the NODE_ENV-guarded block at the bottom of
 * this file): lets the cast remote UI be exercised — and screenshotted —
 * without real cast hardware. Always null in production builds. */
let demoHook: {
  position(): number | null;
  duration(): number | null;
  isPlaying(): boolean;
  toggle(): boolean;
  seek(s: number): boolean;
  loadNext(): boolean;
} | null = null;

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

/**
 * Request a (possibly resumed) session. Rejects on user cancel; returns null
 * when the retry after a transient failure also failed.
 */
async function requestSession(context: any): Promise<any | null> {
  try {
    const session = await context.requestSession(); // rejects on cancel/failure
    return session ?? context.getCurrentSession();
  } catch (err) {
    const text = describeError(err).toLowerCase();
    // user closed the chooser — do not retry, just report
    if (text.includes("cancel")) throw err;
    // first connect attempts fail transiently on flaky mesh/2.4GHz links;
    // one quiet retry catches a good chunk of those
    noteTrail("retry");
    await sleep(1200);
    try {
      const session = await context.requestSession();
      return session ?? context.getCurrentSession();
    } catch {
      return null;
    }
  }
}

/**
 * The session wrapper the SDK handed us earlier can go STALE while the
 * module-level ref survives (phone locked, app backgrounded, Wi-Fi blip —
 * the receiver drops the socket, CAF tears the session down internally).
 * Calling loadMedia() on the stale wrapper then explodes deep inside the SDK
 * with e.g. "Cannot read properties of undefined (reading
 * 'addUpdateListener')". Re-hydrate from CastContext before every reuse:
 * it returns null/undefined once the session is really gone.
 */
function refreshLiveSession(context: any): boolean {
  if (!refs.session) return false;
  try {
    const live = context.getCurrentSession?.();
    if (live) {
      refs.session = live;
      return true;
    }
  } catch {
    /* fall through — treat as dead */
  }
  refs.session = null;
  refs.media = null;
  setState("idle");
  return false;
}

/** Ask the user to pick a device, then load the episode. Returns success. */
export async function castLoad(req: CastMediaRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const framework = cfw();
    const chromeCast = (window as any).chrome?.cast;
    if (!framework || !chromeCast) return { ok: false, error: "Cast is not available in this browser" };

    setState("connecting");
    const context = framework.CastContext.getInstance();

    if (refs.session) refreshLiveSession(context);
    if (!refs.session) {
      refs.session = await requestSession(context);
    }
    if (!refs.session) throw new Error("No Chromecast selected");

    const media = await loadMediaWithRecovery(context, chromeCast, req);
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

/**
 * loadMedia with one stale-session recovery: the SDK throws opaque TypeErrors
 * (addUpdateListener of undefined) when the cached CastSession wrapper outlived
 * its underlying connection. Discard the dead wrapper, re-ask for a session,
 * retry once — the user just sees the cast succeed.
 */
async function loadMediaWithRecovery(context: any, chromeCast: any, req: CastMediaRequest): Promise<any> {
  const build = () => {
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
    return request;
  };
  try {
    return await refs.session.loadMedia(build());
  } catch (err) {
    // no live session underneath — drop it and retry once with a fresh one
    noteTrail("stale-session");
    refs.session = null;
    refs.media = null;
    setState("idle");
    const fresh = await requestSession(context);
    if (!fresh) throw err;
    refs.session = fresh;
    return await refs.session.loadMedia(build());
  }
}

/** Load another episode into the live cast session (no re-prompt). */
export async function castLoadNext(req: CastMediaRequest): Promise<boolean> {
  if (demoHook) return demoHook.loadNext();
  try {
    const framework = cfw();
    const chromeCast = (window as any).chrome?.cast;
    if (!framework || !chromeCast) return false;
    const context = framework.CastContext.getInstance();
    // a session that died since the last episode (phone slept, Wi-Fi blip)
    // must not explode inside loadMedia — verify it is still alive first
    if (!refreshLiveSession(context) || !refs.session) return false;
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
    // the session died mid-series — drop it so the next Cast tap re-prompts
    refs.session = null;
    refs.media = null;
    setState("idle");
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
  if (demoHook) return demoHook.position();
  try {
    const t = refs.media?.getEstimatedTime?.();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function castDuration(): number | null {
  if (demoHook) return demoHook.duration();
  try {
    const d = refs.media?.duration;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/* ---- cast remote (phone controls the TV while casting) ---------------- */

/** True while the receiver reports active playback (BUFFERING counts — it's en route to PLAYING). */
export function castIsPlaying(): boolean {
  if (demoHook) return demoHook.isPlaying();
  try {
    const st = refs.media?.status?.playerState;
    return st === "PLAYING" || st === "BUFFERING";
  } catch {
    return false;
  }
}

/** Play/pause the TV; returns false when there is no live media to control. */
export async function castTogglePlay(): Promise<boolean> {
  if (demoHook) return demoHook.toggle();
  try {
    const chromeCast = (window as any).chrome?.cast;
    const media = refs.media;
    if (!chromeCast || !media) return false;
    if (castIsPlaying()) await media.pause?.(new chromeCast.media.PauseRequest());
    else await media.play?.(new chromeCast.media.PlayRequest());
    return true;
  } catch {
    return false;
  }
}

/** Jump the TV to an absolute second (remote progress bar + ±10s buttons). */
export async function castSeek(sec: number): Promise<boolean> {
  if (demoHook) return demoHook.seek(sec);
  try {
    const chromeCast = (window as any).chrome?.cast;
    const media = refs.media;
    if (!chromeCast || !media) return false;
    const req = new chromeCast.media.SeekRequest();
    req.currentTime = Math.max(0, sec);
    await media.seek?.(req);
    return true;
  } catch {
    return false;
  }
}

/* DEV-ONLY cast demo — strip-mined from production builds by the NODE_ENV
 * check. `window.__castDemo.start()` fakes a live session (ticking position,
 * toggle/seek/loadNext) so the remote UI can be verified without a TV. */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  let demo = false;
  let playing = true;
  let base = Date.now();
  let offset = 95; // fake position when the demo starts
  const pos = () => (playing ? offset + (Date.now() - base) / 1000 : offset);
  const api = {
    start() {
      demo = true;
      playing = true;
      base = Date.now();
      refs.session = { demo: true };
      setState("casting");
    },
    stop() {
      demo = false;
      refs.session = null;
      setState("idle");
    },
  };
  (window as any).__castDemo = api;
  demoHook = {
    position: () => (demo ? pos() : null),
    duration: () => (demo ? 1425 : null),
    isPlaying: () => demo && playing,
    toggle() {
      if (!demo) return false;
      if (playing) offset = pos();
      playing = !playing;
      base = Date.now();
      return true;
    },
    seek(s: number) {
      if (!demo) return false;
      offset = Math.max(0, s);
      base = Date.now();
      return true;
    },
    loadNext: () => demo,
  };
}
