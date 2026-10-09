/**
 * Logic harness for the Task 32 cast fixes — simulates the TWO media-client
 * shapes the CAF sender SDK actually ships (verified by disassembling
 * cast_framework.js + eureka/clank/<v>/cast_sender.js):
 *
 *  A) Android payload: CastSession.getMediaSession() returns the legacy v2
 *     chrome.cast.media.Media object — flat playerState/currentTime/media,
 *     NO getMediaStatus(), NO .status. Fields update from MEDIA_STATUS pushes.
 *  B) Desktop CAF: RemoteMediaClient — getMediaStatus() -> MediaStatus with
 *     .media.duration, promise-style commands.
 *
 * We re-implement statusOf/castDuration/castIsPlaying/castTogglePlay inline
 * (copied from src/lib/cast.ts semantics) and assert both shapes behave.
 */

function statusOf(media) {
  if (!media) return null;
  try {
    const st = media.getMediaStatus?.();
    if (st) return st;
  } catch { /* fall through */ }
  return media ?? null;
}

function castDuration(media) {
  try {
    const st = statusOf(media);
    const candidates = [
      st?.media?.duration,
      st?.duration,
      media?.duration,
      typeof media?.getStreamDuration === "function" ? media.getStreamDuration() : undefined,
    ];
    for (const d of candidates) {
      if (typeof d === "number" && Number.isFinite(d) && d > 0) return d;
    }
    return null;
  } catch { return null; }
}

function castIsPlaying(media) {
  try {
    const st = statusOf(media)?.playerState;
    return st === "PLAYING" || st === "BUFFERING";
  } catch { return false; }
}

function mediaCommand(media, method, req, graceMs = 4000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => { if (!settled) { settled = true; resolve(); } };
    const bad = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e ?? "command failed"))); } };
    const grace = setTimeout(ok, graceMs);
    const done = () => clearTimeout(grace);
    try {
      const fn = media?.[method];
      if (typeof fn !== "function") { done(); bad(new Error(`${method} unavailable`)); return; }
      const r = fn.call(media, req, ok, bad);
      if (r && typeof r.then === "function") r.then(() => { done(); ok(); }, (e) => { done(); bad(e); });
    } catch (e) { done(); bad(e); }
  });
}

// ---- shape A: the v2 chrome.cast.media.Media from the Android payload ----
function V2Media() {
  this.sessionId = 1; this.mediaSessionId = 1;
  this.media = null;              // MediaInfo set by MEDIA_STATUS
  this.playerState = "IDLE";
  this.currentTime = 0; this.idleReason = null;
  this.activeTrackIds = null;
  this.supportedMediaCommands = ["PLAY", "PAUSE", "SEEK", "EDIT_TRACKS_INFO"];
  this.commands = [];
  this.getEstimatedTime = function () { return this.currentTime; };
  this.play = function (req, ok, err) { this.commands.push("PLAY"); if (ok) ok(); };
  this.pause = function (req, ok, err) { this.commands.push("PAUSE"); if (ok) ok(); };
  this.seek = function (req, ok, err) { this.commands.push("SEEK"); if (ok) ok(); };
  this.editTracksInfo = function (req, ok, err) { this.commands.push("EDIT_TRACKS_INFO"); if (ok) ok(); };
  // no getMediaStatus — the Android payload doesn't define one
}
function simulateStatus(v2, playerState, duration) {
  // mirrors the SDK's MEDIA_STATUS merge: flat fields updated in place
  v2.playerState = playerState;
  v2.media = { contentId: "https://x/ep.mp4", duration, metadata: { title: "South Park — Episode 2: The Coon" } };
}

// ---- shape B: desktop RemoteMediaClient ----
function RemoteClient() {
  this.st = null;
  this.commands = [];
  this.getMediaStatus = function () { return this.st; };
  this.getEstimatedTime = function () { return this.st ? this.st.currentTime : 0; };
  this.getStreamDuration = function () { return this.st?.media?.duration ?? 0; };
  this.play = function (req) { this.commands.push("PLAY"); return Promise.resolve(); };
  this.pause = function (req) { this.commands.push("PAUSE"); return Promise.resolve(); };
  this.seek = function (req) { this.commands.push("SEEK"); return Promise.resolve(); };
  this.editTracksInfo = function (req) { this.commands.push("EDIT_TRACKS_INFO"); return Promise.resolve(); };
}

let failed = 0;
function assert(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed++;
}

(async () => {
  // ---------- shape A (the owner's phone) ----------
  const v2 = new V2Media();
  assert("A: no status yet -> statusOf non-null (v2 object IS the status)", statusOf(v2) === v2);
  assert("A: pre-status duration -> null (not 0-locked)", castDuration(v2) === null);
  assert("A: pre-status playing -> false", castIsPlaying(v2) === false);
  simulateStatus(v2, "PLAYING", 1425);
  assert("A: duration from media.duration", castDuration(v2) === 1425);
  assert("A: playing detected", castIsPlaying(v2) === true);
  // the owner's bug: tapping pause while playing must send PAUSE
  const chromeCast = { media: { PauseRequest: function () {}, PlayRequest: function () {}, SeekRequest: function () {} } };
  await mediaCommand(v2, castIsPlaying(v2) ? "pause" : "play", new chromeCast.media.PauseRequest());
  assert("A: pause tap sends PAUSE (was PLAY before the fix)", v2.commands.at(-1) === "PAUSE");
  simulateStatus(v2, "PAUSED", 1425);
  assert("A: paused -> not playing", castIsPlaying(v2) === false);
  await mediaCommand(v2, castIsPlaying(v2) ? "pause" : "play", new chromeCast.media.PlayRequest());
  assert("A: play tap sends PLAY", v2.commands.at(-1) === "PLAY");
  await mediaCommand(v2, "seek", new chromeCast.media.SeekRequest());
  assert("A: seek still works (skips regression)", v2.commands.at(-1) === "SEEK");
  await mediaCommand(v2, "editTracksInfo", {});
  assert("A: editTracksInfo routes", v2.commands.at(-1) === "EDIT_TRACKS_INFO");
  // tracker title guard
  const st = statusOf(v2);
  assert("A: receiver title readable for tracker guard", st.media.metadata.title === "South Park — Episode 2: The Coon");

  // ---------- shape B (desktop) ----------
  const rc = new RemoteClient();
  assert("B: no status -> duration null", castDuration(rc) === null);
  rc.st = { playerState: "PLAYING", currentTime: 754, media: { duration: 1425 } };
  assert("B: duration via status.media.duration", castDuration(rc) === 1425);
  assert("B: playing via getMediaStatus", castIsPlaying(rc) === true);
  await mediaCommand(rc, castIsPlaying(rc) ? "pause" : "play", {});
  assert("B: pause tap sends PAUSE (promise style)", rc.commands.at(-1) === "PAUSE");

  // ---------- error paths ----------
  const dead = { pause: () => { throw new Error("stale"); } };
  let threw = false;
  try { await mediaCommand(dead, "pause", {}); } catch { threw = true; }
  assert("A: sync command throw surfaces as rejection", threw);
  const noFn = {};
  threw = false;
  try { await mediaCommand(noFn, "seek", {}); } catch { threw = true; }
  assert("A: missing method rejects fast (no 4s hang)", threw);

  console.log(failed === 0 ? "\nALL GREEN" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
