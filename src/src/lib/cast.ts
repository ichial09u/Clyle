"use client";

import { saveProgressDetailed, recordWatchSeconds, readAppSettings } from "@/lib/client-store";

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

/* ---- cast progress ownership --------------------------------------------
 * While casting, the TV is the playback surface — the phone's <video> is a
 * paused bystander. WatchView used to own progress saving, but its heartbeat
 * died the moment the user navigated away from the watch page (very common:
 * cast, then browse), and the pagehide/unmount flush read the STALE local
 * position and REGRESSED the saved TV progress. Now cast.ts owns it: every
 * load carries a progress descriptor and a module-level tracker keeps
 * writing Continue Watching for as long as the session lives — page
 * navigation inside the SPA can't touch it.
 * ----------------------------------------------------------------------- */
export interface CastProgressDescriptor {
  malId: number;
  episode: number;
  lang: "sub" | "dub";
  server: string;
  title?: string;
  image?: string | null;
  total?: number;
  /** The exact title string we load with — used to verify the receiver is
   * still playing OUR episode before adopting progress tracking on a
   * resumed session (the TV might be on something else). */
  castTitle?: string;
}

let progressDesc: CastProgressDescriptor | null = null;
let progressTimer: number | null = null;
let trackerLastPos: number | null = null;
let trackerActiveAt = 0;
// resumed-session sync watchdog: when a live session has no receiver status
// for 12s straight, say so once instead of leaving silent dead controls
let noStatusSince: number | null = null;
let syncToastShown = false;
// fires once per loaded media — bumped on every castLoad/castLoadNext so a
// finished episode can't auto-advance twice
let autoNextEpoch = 0;
let autoNextFiredEpoch = -1;
let autoNextHandler: (() => void) | null = null;

/* ---- automatic stream failover (the "TV can't load this stream" fix) ----
 * When the receiver can't load/play the cast URL (CDN blocks the proxy's
 * datacenter IP, dead gateway), don't leave the viewer staring at dead
 * 0:00 controls with a "try Server 2" instruction — SWITCH servers for
 * them. WatchView registers the next-server chooser below; cast.ts just
 * fires it once per loaded media (epoch-guarded so a failing failover
 * can't loop inside cast.ts itself). */
let failoverHandler: ((reason: "stuck" | "media-error") => void) | null = null;
let failoverFiredEpoch = -1;
export function castSetFailoverHandler(fn: ((reason: "stuck" | "media-error") => void) | null): void {
  failoverHandler = fn;
}
function tryFailover(reason: "stuck" | "media-error"): boolean {
  if (currentState !== "casting" || !failoverHandler) return false;
  if (failoverFiredEpoch === autoNextEpoch) return false; // one auto-switch per loaded media
  failoverFiredEpoch = autoNextEpoch;
  try {
    failoverHandler(reason);
  } catch {
    /* navigation is best-effort */
  }
  return true;
}

/** Register the "roll into the next episode" hook (WatchView navigates; the
 * stream effect then side-loads the next episode into the live session). */
export function castSetAutoNextHandler(fn: (() => void) | null): void {
  autoNextHandler = fn;
}

function stopProgressTracker() {
  if (progressTimer != null) {
    window.clearInterval(progressTimer);
    progressTimer = null;
  }
}

/**
 * (Re)acquire the receiver's media client from a live session. THE fix for
 * the "remote controls dead while the TV plays" report: a page reload (or
 * PWA re-open) RESUMES the live cast session, but the media client was only
 * ever acquired inside the load paths — on a resumed session refs.media
 * stayed null, so position/duration never reached the remote and every
 * control (pause, ±10s, scrub) was a silent no-op while the TV played on.
 */
function wireMediaErrorListener(client: any) {
  client?.addUpdateListener?.(() => {
    const st = statusOf(client);
    if (st?.playerState === "IDLE" && st?.idleReason === "ERROR") {
      noteTrail("receiver-media-error");
      // auto-failover first — a server that dies MID-episode switches over
      // by itself; the manual advice only appears once the walk is exhausted
      if (!tryFailover("media-error")) {
        notifyMediaError("The TV couldn't play this stream — try another server or quality");
      }
    }
  });
}

function attachRemoteMedia(session: any): boolean {
  try {
    const client = session?.getMediaSession?.();
    if (!client) return false;
    const isNew = refs.media !== client;
    refs.media = client;
    if (isNew) wireMediaErrorListener(client);
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-heal the remote from OUTSIDE a load: healthy sessions are untouched;
 * a casting session whose media client is missing/stale gets re-acquired
 * from CastContext. Called from the UI poll (fast) and the tracker (10s).
 */
export function castReattach(): boolean {
  if (currentState !== "casting") return false;
  if (refs.media && statusOf(refs.media)) return true; // healthy — nothing to do
  try {
    const live = cfw()?.CastContext.getInstance?.()?.getCurrentSession?.();
    if (live) refs.session = live;
    return attachRemoteMedia(refs.session);
  } catch {
    return false;
  }
}

/**
 * Continue-Watching adoption for RESUMED sessions: the TV is already playing
 * (loaded by the previous page life) and this fresh page has no descriptor.
 * Once the receiver reports a real status — and its title matches OUR open
 * episode — adopt the caller's descriptor so TV progress keeps saving.
 */
export function castEnsureTracking(desc: CastProgressDescriptor): void {
  if (currentState !== "casting" || progressDesc || !desc) return;
  try {
    const st = statusOf(refs.media);
    if (!st) return; // no confirmed receiver state — never guess
    const receiverTitle = st?.media?.metadata?.title;
    if (desc.castTitle && receiverTitle && receiverTitle !== desc.castTitle) return;
    progressDesc = desc;
    startProgressTracker();
  } catch {
    /* ignore */
  }
}

function startProgressTracker() {
  if (typeof window === "undefined" || demoHook) return;
  if (progressTimer != null) return; // already watching this session
  trackerLastPos = castPosition();
  trackerActiveAt = Date.now();
  progressTimer = window.setInterval(() => {
    if (currentState !== "casting") return;
    // ---- self-heal + sync watchdog (covers RESUMED sessions) ----
    // a page reload rejoins the live session with a null/stale media client;
    // re-acquire it, and if the receiver never reports a status, say so once
    if (!refs.media || !statusOf(refs.media)) {
      try {
        const live = cfw()?.CastContext.getInstance?.()?.getCurrentSession?.();
        if (live) {
          refs.session = live;
          attachRemoteMedia(live);
        }
      } catch {
        /* ignore */
      }
      if (noStatusSince == null) noStatusSince = Date.now();
      else if (!syncToastShown && Date.now() - noStatusSince > 12_000) {
        syncToastShown = true;
        noteTrail("no-status");
        notifyMediaError("Can't sync with the TV's playback — Stop casting, then cast this episode again");
      }
    } else {
      noStatusSince = null;
      syncToastShown = false;
    }
    if (!progressDesc) return; // resumed session not yet adopted — controls only
    // The TV moved on to something else (resumed-session adoption can land
    // before the receiver's metadata arrives) — the moment the receiver's
    // title exists and is NOT our episode, stop writing our row.
    if (progressDesc.castTitle) {
      const receiverTitle = statusOf(refs.media)?.media?.metadata?.title;
      if (receiverTitle && receiverTitle !== progressDesc.castTitle) {
        progressDesc = null;
        stopProgressTracker();
        return;
      }
    }
    const pos = castPosition();
    const now = Date.now();
    if (pos == null || pos === trackerLastPos) {
      // paused, buffering or unreachable — wall time between these ticks
      // must not accrue as watch time
      trackerLastPos = pos;
      trackerActiveAt = now;
    } else {
      const delta = Math.min(120, (now - trackerActiveAt) / 1000);
      trackerLastPos = pos;
      trackerActiveAt = now;
      if (delta >= 1) {
        recordWatchSeconds({ malId: progressDesc.malId, title: progressDesc.title ?? "", image: progressDesc.image ?? null, delta });
      }
      saveProgressDetailed({
        malId: progressDesc.malId,
        episode: progressDesc.episode,
        lang: progressDesc.lang,
        server: progressDesc.server,
        position: pos,
        duration: castDuration() || 0,
        title: progressDesc.title,
        image: progressDesc.image,
        total: progressDesc.total,
      });
    }
    // ---- auto next episode (mirrors the in-player ended handler) ----
    if (progressDesc && autoNextHandler) {
      const dur = castDuration() ?? 0;
      const st = statusOf(refs.media);
      const finished = st?.playerState === "IDLE" && st?.idleReason === "FINISHED";
      const atEnd = dur > 0 && pos != null && pos >= dur - 2;
      if ((finished || atEnd) && autoNextFiredEpoch !== autoNextEpoch) {
        if (readAppSettings().autoNext) {
          autoNextFiredEpoch = autoNextEpoch;
          try {
            autoNextHandler();
          } catch {
            /* navigation is best-effort */
          }
        }
      }
    }
  }, 10_000);
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

/* ---- stuck-load watchdog ------------------------------------------------
 * loadMedia() resolving only means the receiver ACCEPTED the request. If
 * the media URL can't actually be fetched by the TV (CDN blocks the
 * proxy's datacenter IP, dead gateway), the receiver sits on its loading
 * screen forever while the remote shows dead 0:00/0:00 controls — exactly
 * the owner's cast report (2026-10-09). Watch the status briefly after
 * each load: no duration and no position progress within 12s = the stream
 * never loaded — say so with an actionable message instead of leaving
 * silent dead controls. Disarms itself the moment the media is real.
 * ----------------------------------------------------------------------- */
let stuckWatchdog: number | null = null;
function disarmStuckWatchdog() {
  if (stuckWatchdog != null) {
    window.clearInterval(stuckWatchdog);
    stuckWatchdog = null;
  }
}
function armStuckLoadWatchdog() {
  if (typeof window === "undefined" || demoHook) return;
  disarmStuckWatchdog();
  const startedAt = Date.now();
  stuckWatchdog = window.setInterval(() => {
    if (currentState !== "casting") {
      disarmStuckWatchdog();
      return;
    }
    const dur = castDuration();
    const pos = castPosition();
    if ((dur != null && dur > 0) || (pos != null && pos > 0)) {
      disarmStuckWatchdog(); // media is real and moving — normal remote operation
      return;
    }
    if (Date.now() - startedAt > 12_000) {
      disarmStuckWatchdog();
      noteTrail("stuck-loading");
      // auto-failover: hand the walk to the next server instead of telling
      // the user to do it — the stream effect side-loads the new stream and
      // the TV is playing again without anyone touching the phone
      if (!tryFailover("stuck")) {
        notifyMediaError("The TV can't load this stream — try Server 2, or stop casting and cast again");
      }
    }
  }, 1_000);
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
          // RESUMED (page reload / PWA re-open while the TV plays): adopt the
          // receiver's CURRENT media client right here — waiting for a load
          // left the remote dead at 0:00/0:00 with no-op controls
          attachRemoteMedia(refs.session);
          startProgressTracker();
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
          progressDesc = null;
          captionsTrackId = null;
          captionsActive = false;
          noStatusSince = null;
          syncToastShown = false;
          stopProgressTracker();
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
  /** Captions active the moment the TV starts playing (default true). */
  captionsOn?: boolean;
  imageUrl?: string | null;
  /** Resume point, seconds. */
  startTime?: number;
  /** Continue-Watching ownership: who/where this TV playback is. */
  progress?: CastProgressDescriptor;
}

/* ---- captions state (toggleable from the phone while the TV plays) ------ */
let captionsTrackId: number | null = null;
let captionsActive = false;

/** Does the current cast session carry a side-loaded caption track? */
export function castCaptionsAvailable(): boolean {
  return captionsTrackId != null;
}

/** Are captions currently active on the TV? */
export function castCaptionsActive(): boolean {
  return captionsActive;
}

/**
 * Turn the TV's caption track on/off mid-session (EditTracksInfo replaces
 * the active-track set). Returns false when there is no live media or no
 * caption track was side-loaded for this episode.
 */
export async function castSetCaptions(on: boolean): Promise<boolean> {
  if (demoHook) return captionsTrackId != null;
  try {
    const chromeCast = (window as any).chrome?.cast;
    const media = refs.media;
    if (!chromeCast || !media || captionsTrackId == null) return false;
    const req = new chromeCast.media.EditTracksInfoRequest(on ? [captionsTrackId] : []);
    await mediaCommand(media, "editTracksInfo", req);
    captionsActive = on;
    return true;
  } catch {
    return false;
  }
}

/** The DMR resolves track contentIds against nothing useful — a RELATIVE
 * caption URL (our proxy-wrapped provider VTTs) silently never fetches and
 * the TV just plays with no subtitles. Absolutize every caption URL here,
 * the single choke point for both load paths. */
function absoluteUrl(u: string): string {
  try {
    return new URL(u, window.location.origin).toString();
  } catch {
    return u;
  }
}

/** Legible default for the big screen: white with a black outline. */
function tvTrackStyle(chromeCast: any): any | undefined {
  try {
    return new chromeCast.media.TextTrackStyle({
      foregroundColor: "#FFFFFF",
      backgroundColor: "#00000000",
      edgeColor: "#000000FF",
      edgeType: "OUTLINE",
      fontFamily: "Sans-Serif",
      fontScale: 1.0,
    });
  } catch {
    return undefined;
  }
}

/** Side-load a WebVTT caption track onto the Default Media Receiver. */
function attachCaptions(chromeCast: any, mediaInfo: any, request: any, captions?: { url: string; label?: string }, on = true) {
  captionsTrackId = null;
  captionsActive = false;
  if (!captions?.url || !chromeCast.media.Track) return;
  try {
    const track = new chromeCast.media.Track(0, chromeCast.media.TrackType.TEXT);
    track.subtype = chromeCast.media.TextTrackType?.SUBTITLES ?? "SUBTITLES";
    track.name = captions.label || "English";
    track.language = "en";
    // The receiver reads the URL from trackContentId / trackContentType —
    // chrome.cast.media.Track has NEVER had contentId/contentType fields, so
    // the track shipped with trackContentId null and the TV had nothing to
    // fetch: captions never rendered even though the absoluteUrl was right.
    track.trackContentId = absoluteUrl(captions.url);
    track.trackContentType = "text/vtt";
    // legacy alias — harmless extra JSON fields, helps older receiver builds
    track.contentId = track.trackContentId;
    track.contentType = track.trackContentType;
    mediaInfo.tracks = [track];
    mediaInfo.textTrackStyle = tvTrackStyle(chromeCast);
    request.activeTrackIds = on ? [0] : [];
    captionsTrackId = 0;
    captionsActive = on;
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

/**
 * CAF's CastSession.loadMedia() resolves VOID — the controllable object is
 * the RemoteMediaClient handed out by session.getMediaSession(). Treating
 * the resolution itself as the media object is what produced the owner's
 * "Cannot read properties of undefined (reading 'addUpdateListener')"
 * cast failure (the media HAD loaded on the TV; the sender then crashed on
 * undefined). Legacy v2 callers get the Media object back, so accept both
 * shapes: prefer the session's client, fall back to whatever loadMedia
 * returned.
 */
function resolveClient(session: any, loaded: any): any {
  try {
    const viaSession = session?.getMediaSession?.();
    if (viaSession) return viaSession;
  } catch {
    /* fall through to the loaded shape */
  }
  return loaded ?? null;
}

/**
 * MediaStatus accessor for BOTH API shapes the sender SDK ships:
 * - Desktop/CAF RemoteMediaClient: getMediaStatus() -> MediaStatus
 * - ANDROID (the owner's phone!): cast_sender.js ships the legacy v2 layer
 *   there, and CastSession.getMediaSession() returns a chrome.cast.media.Media
 *   object that IS the live status — playerState / currentTime / idleReason /
 *   media (MediaInfo w/ duration) are FLAT properties kept fresh by
 *   MEDIA_STATUS pushes. There is no .status wrapper and no getMediaStatus().
 *
 * Reading `.status` on the v2 object returned undefined, so statusOf() was
 * null on every Android device and silently killed everything status-derived:
 * pause tapped while playing sent PLAY (castIsPlaying() always false),
 * duration stayed 0:00 (progress bar unscrubbable, auto-next blind), the cast
 * auto-skip intro branch never fired (it gates on playing), and a bogus
 * "Can't sync with the TV" toast appeared 12s into every session.
 */
function statusOf(media: any): any {
  if (!media) return null;
  try {
    const st = media.getMediaStatus?.();
    if (st) return st;
  } catch {
    /* fall through */
  }
  return media ?? null;
}

/**
 * Fire one media command through BOTH call shapes the SDK ships: the v2
 * Media methods are callback-style and return void; the CAF RemoteMediaClient
 * methods are promise-style and ignore extra args. Whichever answers wins;
 * a silent (ACK-less) build resolves after a short grace so optimistic UI +
 * the poll keep things honest.
 */
function mediaCommand(media: any, method: string, req: any, graceMs = 4000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const bad = (e: unknown) => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e ?? "command failed")));
      }
    };
    const grace = window.setTimeout(ok, graceMs);
    const done = () => window.clearTimeout(grace);
    try {
      const fn = media?.[method];
      if (typeof fn !== "function") {
        done();
        bad(new Error(`${method} unavailable`));
        return;
      }
      const r = fn.call(media, req, ok, bad);
      if (r && typeof r.then === "function") r.then(() => { done(); ok(); }, (e: unknown) => { done(); bad(e); });
    } catch (e) {
      done();
      bad(e);
    }
  });
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

    progressDesc = req.progress ?? null;
    autoNextEpoch++;
    const loaded = await loadMediaWithRecovery(context, chromeCast, req);
    if (!attachRemoteMedia(refs.session)) {
      // loadMedia resolving only proves the REQUEST was accepted (CAF resolves
      // VOID) — the controllable client rides on the session
      refs.media = resolveClient(refs.session, loaded);
      wireMediaErrorListener(refs.media);
    }
    armStuckLoadWatchdog();
    startProgressTracker();
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
  const build = () => buildLoadRequest(chromeCast, req);
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

function buildLoadRequest(chromeCast: any, req: CastMediaRequest): any {
  // the Default Media Receiver sniffs better with the honest type: our SP
  // sources are progressive MP4s, everything else is an HLS master
  const type = /\.m3u8($|\?)/i.test(req.src) ? "application/x-mpegurl" : "video/mp4";
  const mediaInfo = new chromeCast.media.MediaInfo(req.src, type);
  const metadata = new chromeCast.media.GenericMediaMetadata();
  metadata.title = req.title;
  if (req.subtitle) metadata.subtitle = req.subtitle;
  if (req.imageUrl) metadata.images = [new chromeCast.Image(req.imageUrl)];
  mediaInfo.metadata = metadata;
  mediaInfo.streamType = chromeCast.media.StreamType.BUFFERED;
  const request = new chromeCast.media.LoadRequest(mediaInfo);
  request.autoplay = true;
  request.currentTime = Math.max(0, req.startTime ?? 0);
  attachCaptions(chromeCast, mediaInfo, request, req.captions, req.captionsOn ?? true);
  return request;
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
    progressDesc = req.progress ?? progressDesc; // keep the old descriptor when none is given
    autoNextEpoch++;
    // loadMedia resolves VOID in CAF — prefer the session's client
    const loadedNext = await refs.session.loadMedia(buildLoadRequest(chromeCast, req));
    if (!attachRemoteMedia(refs.session)) {
      refs.media = resolveClient(refs.session, loadedNext);
      wireMediaErrorListener(refs.media);
    }
    armStuckLoadWatchdog();
    startProgressTracker();
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
  disarmStuckWatchdog();
  // final Continue-Watching write at the exact second the TV was at — the
  // tracker dies with the session, this flush must not be skipped
  if (progressDesc && !demoHook) {
    const pos = castPosition();
    if (pos != null) {
      saveProgressDetailed({
        malId: progressDesc.malId,
        episode: progressDesc.episode,
        lang: progressDesc.lang,
        server: progressDesc.server,
        position: pos,
        duration: castDuration() || 0,
        title: progressDesc.title,
        image: progressDesc.image,
        total: progressDesc.total,
      });
    }
  }
  progressDesc = null;
  captionsTrackId = null;
  captionsActive = false;
  noStatusSince = null;
  syncToastShown = false;
  stopProgressTracker();
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
    if (typeof t === "number" && Number.isFinite(t)) return t;
    // v2 Media shape: .currentTime property
    const legacy = refs.media?.currentTime;
    return typeof legacy === "number" && Number.isFinite(legacy) ? legacy : null;
  } catch {
    return null;
  }
}

export function castDuration(): number | null {
  if (demoHook) return demoHook.duration();
  try {
    // v2 Media: .media is the MediaInfo (duration lives there) ·
    // RemoteMediaClient: status.media.duration or getStreamDuration()
    const st = statusOf(refs.media);
    const candidates = [
      st?.media?.duration,
      st?.duration,
      refs.media?.duration,
      typeof refs.media?.getStreamDuration === "function" ? refs.media.getStreamDuration() : undefined,
    ];
    for (const d of candidates) {
      if (typeof d === "number" && Number.isFinite(d) && d > 0) return d;
    }
    return null;
  } catch {
    return null;
  }
}

/* ---- cast remote (phone controls the TV while casting) ---------------- */

/** True while the receiver reports active playback (BUFFERING counts — it's en route to PLAYING). */
export function castIsPlaying(): boolean {
  if (demoHook) return demoHook.isPlaying();
  try {
    const st = statusOf(refs.media)?.playerState;
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
    // castIsPlaying() reads the LIVE receiver state (v2 Media on Android,
    // MediaStatus via getMediaStatus() elsewhere) — pause when it says
    // playing, play when it says paused/idle
    if (castIsPlaying()) await mediaCommand(media, "pause", new chromeCast.media.PauseRequest());
    else await mediaCommand(media, "play", new chromeCast.media.PlayRequest());
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
    await mediaCommand(media, "seek", req);
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
