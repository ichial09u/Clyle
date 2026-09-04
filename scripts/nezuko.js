        (function () {
            "use strict";

            jwplayer.key =
                "uoW6qHjBL3KNudxKVnwa3rt5LlTakbko9e6aQ6VUyKQ=";

            const API_BASE = window.location.origin;

            // VAST pre-roll configuration.
            // This ad is requested by JW Player when playback begins.
            
           const VAST_AD_TAG = "https://supaplay.fun/vast";
     
           
           const MAGSERV_ADS = [
    "https://supaplay.fun/super_vast",
    "https://supaplay.fun/super_vast",
    "https://supaplay.fun/super_vast",
];

function getRandomMagServAd() {
    return MAGSERV_ADS[Math.floor(Math.random() * MAGSERV_ADS.length)];
}


const shuffledMagsrvAds = [...MAGSERV_ADS].sort(() => Math.random() - 0.5);

           
          const VAST_SCHEDULE_ID = Math.random().toString(36).substring(2, 14);
function getBackupSources(episodeId, type) {
    return [
        `https://megaplay.buzz/stream/s-2/${episodeId}/${type}`,
        `https://megaplay.buzz/stream/s-5/${episodeId}/${type}`,
        `https://vidwish.live/stream/s-2/${episodeId}/${type}`
    ];
}
            const errorDiv = document.getElementById("error-message");
    
    const loader =
    document.getElementById("loadingScreen");

const MIN_LOADER_TIME = 5000;

let loaderShownAt = Date.now();
let loaderHideTimer = null;
let loaderReadyToHide = false;
            const introSound = document.getElementById("intro-sound");
            var backdropImage ;
            let player = null;

            let intro = {
                start: 0,
                end: 0
            };

            let outro = {
                start: 0,
                end: 0
            };

            let subtitles = [];

            let skipTarget = null;
            let skipLayer = null;
            let segmentLabel = null;
            let watermark = null;

            let introHighlight = null;
            let outroHighlight = null;

            let introAdOverlay = null;
            let introAdPlayed = false;
            let introAdRunning = false;
            let introAdTimerStarted = false;

            let lastPostTime = 0;
// ====================== PRIMARY -> 50s STALL -> DECRYPT -> BACKUP ======================
const DECRYPTION_STALL_TIMEOUT_MS = 250000;
const DECRYPTION_RECOVERY_TIMEOUT_MS = 20000;

let currentMasterUrl = "";
let decryptionRecoveryStarted = false;
let backupStarted = false;
let playbackWatchdogTimer = null;
let recoveryTimeoutTimer = null;
let lastPlaybackPosition = 0;
let lastPlaybackAdvanceAt = Date.now();
let recoveryGeneration = 0;

const MegaDecrypt = (function () {
    const SECRET = "megaPlayClientKey2025";
    let aesKey = null;
    let interceptorEnabled = false;
    const cache = new Map();
    const originalFetch = window.fetch.bind(window);

    async function getKey() {
        if (aesKey) return aesKey;

        const enc = new TextEncoder();
        const keyData = enc.encode(SECRET).slice(0, 32);

        aesKey = await crypto.subtle.importKey(
            "raw",
            keyData,
            { name: "AES-CTR" },
            false,
            ["decrypt"]
        );

        return aesKey;
    }

    function getSegmentId(url) {
        const value = String(url || "");

        // Direct segment URL.
        let match = value.match(/\/segment\/([A-Za-z0-9_-]+)/);
        if (match) return match[1];

        // SupaPlay proxy URL: ?url=<real-segment-url>
        try {
            const query = value.includes("?")
                ? value.slice(value.indexOf("?") + 1)
                : "";

            const proxied = new URLSearchParams(query).get("url");

            if (proxied) {
                match = proxied.match(/\/segment\/([A-Za-z0-9_-]+)/);
                if (match) return match[1];
            }
        } catch (error) {
            console.warn("[Decrypt] Could not inspect segment URL:", error);
        }

        return null;
    }

    async function decrypt(data, segmentId) {
        if (!segmentId) {
            throw new Error("Missing segment ID");
        }

        if (cache.has(segmentId)) {
            return cache.get(segmentId);
        }

        const key = await getKey();
        const counter = new Uint8Array(16);

        const decrypted = await crypto.subtle.decrypt(
            {
                name: "AES-CTR",
                counter,
                length: 128
            },
            key,
            data
        );

        cache.set(segmentId, decrypted);

        console.log(
            `✅ [Decrypt] Decrypted segment: ${segmentId.slice(0, 25)}...`
        );

        return decrypted;
    }

    function resetCache() {
        cache.clear();
        console.log("🧹 [Decrypt] Segment cache cleared");
    }

    function enable() {
        if (interceptorEnabled) {
            resetCache();
            return;
        }

        interceptorEnabled = true;

        window.fetch = async function (input, init) {
            const url =
                typeof input === "string"
                    ? input
                    : input && input.url
                        ? input.url
                        : "";

            const segmentId = getSegmentId(url);

            // Only intercept HLS segments. All other requests remain normal.
            if (!segmentId) {
                return originalFetch(input, init);
            }

            console.log(
                `🔓 [Decrypt] Intercepting segment: ${segmentId.slice(0, 25)}...`
            );

            const response = await originalFetch(input, init);

            if (!response.ok) {
                console.warn(
                    "[Decrypt] Segment request failed:",
                    response.status,
                    url
                );
                return response;
            }

            const encryptedBuffer = await response.arrayBuffer();

            try {
                const plainBuffer = await decrypt(
                    encryptedBuffer,
                    segmentId
                );

                const headers = new Headers(response.headers);
                headers.set("Content-Type", "video/MP2T");
                headers.set(
                    "Content-Length",
                    String(plainBuffer.byteLength)
                );

                return new Response(plainBuffer, {
                    status: response.status,
                    statusText: response.statusText,
                    headers
                });
            } catch (error) {
                console.error(
                    "❌ [Decrypt] Segment decryption failed:",
                    segmentId,
                    error
                );

                // Do not silently pretend encrypted data is playable.
                // Let the recovery controller decide whether to move to backup.
                throw error;
            }
        };

        console.log("🔐 [Decrypt] Interceptor ENABLED");
    }

    return {
        enable,
        resetCache,
        isEnabled: function () {
            return interceptorEnabled;
        }
    };
})();
// ====================== END PRIMARY -> DECRYPT -> BACKUP ======================

            /*
             * Playback resume support.
             *
             * Supported URL formats:
             *   ?resume=120
             *   ?start=120
             *
             * The parent watch page can also send:
             *   { action: "seek", seconds: 120 }
             *   { event: "resume", time: 120 }
             */
            const playerQuery =
                new URLSearchParams(window.location.search);

            /*
             * Automatic intro/outro skipping.
             *
             * Enabled URL examples:
             *   ?autoskip=true
             *   ?autoskip=1
             *   ?autoskip=on
             *
             * When disabled or missing, the normal manual Skip Intro/Outro
             * button remains available.
             */
            function queryBoolean(value) {
                return ["1", "true", "yes", "on"].includes(
                    String(value || "").trim().toLowerCase()
                );
            }

            let autoSkipEnabled = queryBoolean(
                playerQuery.get("autoskip")
            );

            let introAutoSkipped = false;
            let outroAutoSkipped = false;
            let lastAutoSkipTime = 0;

            let resumeTarget = Math.max(
                0,
                Number(
                    playerQuery.get("resume") ||
                    playerQuery.get("start") ||
                    0
                ) || 0
            );

            let resumeApplied = resumeTarget < 5;
            let resumeAttemptTimer = 0;
            let resumeAttempts = 0;
            let adBreakActive = false;

            function clearResumeTimer() {
                if (resumeAttemptTimer) {
                    window.clearTimeout(resumeAttemptTimer);
                }

                resumeAttemptTimer = 0;
            }

            function finishResume(seconds) {
                resumeApplied = true;
                resumeAttempts = 0;
                clearResumeTimer();

                postToParent({
                    event: "resume-applied",
                    type: "resume-applied",
                    time: Math.floor(seconds)
                });
            }

            function tryApplyResume() {
                if (
                    resumeApplied ||
                    resumeTarget < 5 ||
                    adBreakActive ||
                    !player ||
                    typeof player.seek !== "function"
                ) {
                    return;
                }

                const duration = Number(
                    typeof player.getDuration === "function"
                        ? player.getDuration() || 0
                        : 0
                );

                /*
                 * Wait until JW Player has loaded the actual content metadata.
                 * This also prevents seeking inside the VAST pre-roll.
                 */
                if (
                    !Number.isFinite(duration) ||
                    duration <= 1
                ) {
                    return;
                }

                const target = Math.min(
                    resumeTarget,
                    Math.max(0, duration - 1)
                );

                if (target < 5) {
                    finishResume(0);
                    return;
                }

                const current = Number(
                    typeof player.getPosition === "function"
                        ? player.getPosition() || 0
                        : 0
                );

                if (
                    Number.isFinite(current) &&
                    Math.abs(current - target) < 4
                ) {
                    finishResume(target);
                    return;
                }

                resumeAttempts += 1;

                try {
                    player.seek(target);
                } catch (error) {
                    console.warn(
                        "Resume seek failed:",
                        error
                    );
                }

                clearResumeTimer();

                resumeAttemptTimer =
                    window.setTimeout(function () {
                        if (
                            resumeApplied ||
                            !player
                        ) {
                            return;
                        }

                        const position = Number(
                            typeof player.getPosition === "function"
                                ? player.getPosition() || 0
                                : 0
                        );

                        if (
                            Number.isFinite(position) &&
                            (
                                Math.abs(position - target) < 4 ||
                                position >= target
                            )
                        ) {
                            finishResume(target);
                            return;
                        }

                        /*
                         * Retry while the stream is still becoming seekable.
                         * Stop after roughly 12 seconds.
                         */
                        if (resumeAttempts < 30) {
                            tryApplyResume();
                        } else {
                            clearResumeTimer();
                            resumeApplied = true;

                            console.warn(
                                "Saved playback position could not be restored."
                            );
                        }
                    }, 400);
            }

            function scheduleResume(seconds) {
                const nextTarget = Math.max(
                    0,
                    Number(seconds) || 0
                );

                resumeTarget = nextTarget;
                resumeApplied = nextTarget < 5;
                resumeAttempts = 0;
                clearResumeTimer();

                if (resumeApplied) {
                    return;
                }

                window.setTimeout(
                    tryApplyResume,
                    120
                );
            }

            function parseParentMessage(value) {
                if (typeof value !== "string") {
                    return value;
                }

                try {
                    return JSON.parse(value);
                } catch (error) {
                    return null;
                }
            }

            window.addEventListener(
                "message",
                function (event) {
                    /*
                     * Only accept playback commands from the page that
                     * embedded this player.
                     */
                    if (
                        window.parent !== window &&
                        event.source !== window.parent
                    ) {
                        return;
                    }

                    let data =
                        parseParentMessage(event.data);

                    if (
                        data &&
                        typeof data === "object" &&
                        data.payload &&
                        typeof data.payload === "object"
                    ) {
                        data = data.payload;
                    }

                    if (
                        !data ||
                        typeof data !== "object"
                    ) {
                        return;
                    }

                    const messageName = String(
                        data.action ||
                        data.event ||
                        data.type ||
                        ""
                    ).toLowerCase();


 if (


    messageName === "fullscreen" ||
    messageName === "full-screen"
) {
    const enabled =
        data.enabled ??
        data.value ??
        data.active ??
        true;

    if (enabled) {
        try {
            const element =
                document.getElementById("player") ||
                document.documentElement;

            if (element.requestFullscreen) {
                element.requestFullscreen();
            } else if (element.webkitRequestFullscreen) {
                element.webkitRequestFullscreen();
            }
        } catch (error) {
            console.warn("Fullscreen request failed:", error);
        }
    } else {
        try {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } catch (error) {
            console.warn("Exit fullscreen failed:", error);
        }
    }

    return;
}

                    if (
                        messageName === "autoskip" ||
                        messageName === "auto-skip"
                    ) {
                        const requestedAutoSkip =
                            data.enabled ??
                            data.value ??
                            data.active;

                        autoSkipEnabled =
                            typeof requestedAutoSkip === "boolean"
                                ? requestedAutoSkip
                                : queryBoolean(requestedAutoSkip);

                        if (!autoSkipEnabled) {
                            introAutoSkipped = false;
                            outroAutoSkipped = false;
                        }

                        postToParent({
                            event: "autoskip-changed",
                            type: "autoskip-changed",
                            enabled: autoSkipEnabled
                        });

                        return;
                    }

                    if (
                        messageName !== "seek" &&
                        messageName !== "resume"
                    ) {
                        return;
                    }

                    scheduleResume(
                        data.seconds ??
                        data.time ??
                        data.currentTime ??
                        0
                    );
                }
            );



async function loadEpisodeData(episodeEmbedId) {
    try {
        const response = await fetch(
            `/api/episode/${encodeURIComponent(episodeEmbedId)}`, //imade it wrong so limits on supaplay will be less
            {
                method: "GET",
                cache: "no-store",
                headers: {
                    Accept: "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new Error(
                result.error || "Failed to load episode"
            );
        }

        return result;
    } catch (error) {
        return null;
    }
}

function showBackupLoadingScreen() {
    const background = document.getElementById("loadingBackground");
    const poster = document.getElementById("loadingPoster");
    const animeTitle = document.getElementById("loadingAnimeTitle");
    const episode = document.getElementById("loadingEpisode");
    const episodeTitle = document.getElementById("loadingEpisodeTitle");
    const message = document.getElementById("loadingMessage");

    if (background) {
        background.style.backgroundImage =
            "linear-gradient(135deg, #050505, #111827, #020617)";
        background.style.backgroundSize = "cover";
        background.style.backgroundPosition = "center";
    }

    if (poster) {
        poster.removeAttribute("src");
        poster.style.display = "none";
    }

    if (animeTitle) {
        animeTitle.textContent = "You are a free user ";
    }

    if (episode) {
        episode.textContent = "Loading witdh";
    }

    if (episodeTitle) {
        episodeTitle.textContent = "Open account and escape ads";
    }

    if (message) {
        message.textContent = "Get an account and share your reference on your profile to more  extra 3 days ad-free!.";
    }
}

async function setupLoadingScreen(episodeEmbedId) {
    const data = await loadEpisodeData(episodeEmbedId);

    if (!data) {
        showBackupLoadingScreen();
        return;
    }

    const episode = data.episode || {};
    const anime = data.anime || {};

    const background = document.getElementById("loadingBackground");

    if (background) {
        if (anime.background_image) {
            background.style.backgroundImage =
                `url("${anime.background_image}")`;
        } else if (anime.poster) {
            background.style.backgroundImage =
                `url("${anime.poster}")`;
        } else {
            background.style.backgroundImage =
                "linear-gradient(135deg, #050505, #111827, #020617)";
        }

        background.style.backgroundSize = "cover";
        background.style.backgroundPosition = "center";
    }

    const poster = document.getElementById("loadingPoster");

    if (poster) {
        if (anime.poster) {
            poster.src = anime.poster;
            poster.alt = anime.title || "Anime";
            poster.style.display = "";
        } else {
            poster.removeAttribute("src");
            poster.style.display = "none";
        }
    }

    const animeTitle = document.getElementById("loadingAnimeTitle");

    if (animeTitle) {
        animeTitle.textContent = anime.title || "Anime";
    }

    const episodeElement = document.getElementById("loadingEpisode");

    if (episodeElement) {
        episodeElement.textContent =
            episode.episode_number != null
                ? `Episode ${episode.episode_number}`
                : "Loading";
    }

    const episodeTitle = document.getElementById("loadingEpisodeTitle");

    if (episodeTitle) {
        episodeTitle.textContent =
            episode.title ||
            (
                episode.episode_number != null
                    ? `Episode ${episode.episode_number}`
                    : "Preparing your episode..."
            );
    }

    const loadingMessage = document.getElementById("loadingMessage");

    if (loadingMessage) {
        loadingMessage.textContent =
            "Preparing your episode... 🎬";
    }
}
const loadingMessages = [
    "🎁 Join AnimapoTV and enjoy 7 days completely ad-free! Visit animapotv.fun",
    "✨ Create your free AnimapoTV account and watch without ads for 7 days!",
    "🍿 Welcome to AnimapoTV — sign up today and get 7 days of ad-free watching!",
    "🚀 Get your AnimapoTV account and unlock 7 days without ads!",
    "💙 Love anime? Join AnimapoTV and enjoy 7 days of ad-free streaming!",
    "🎬 Watch your favorite shows without ads for 7 days with an AnimapoTV account!",
    "🔥 Create an account on AnimapoTV and enjoy your first 7 days ad-free!",
    "✨ Less ads, more anime! Join AnimapoTV for 7 days of ad-free watching.",
    "🎁 Your AnimapoTV account comes with 7 days of ad-free entertainment!",
    "😎 Tired of ads? Sign up at animapotv.fun and enjoy 7 days ad-free!",
    "🍿 More anime, fewer ads! Create your AnimapoTV account and get 7 days ad-free.",
    "💫 Join AnimapoTV today and unlock your 7-day ad-free trial!",
    "🎉 Your 7-day ad-free experience is waiting! Create your account at animapotv.fun",
    "❤️ Anime without interruptions? Join AnimapoTV and enjoy 7 days without ads!",
    "🚀 Account holders get 7 days of ad-free watching. Join AnimapoTV today!",
    "🎬 Get your AnimapoTV account and enjoy 7 days of uninterrupted anime!",
    "✨ Make your anime experience better — join AnimapoTV and go ad-free for 7 days!",
    "🔥 AnimapoTV + your account = 7 days without ads. Join now!",
    "😌 Sit back, relax, and enjoy 7 days of ad-free anime on AnimapoTV.",
    "🎁 Don't want ads? Create your AnimapoTV account and enjoy 7 days ad-free!",
    "💙 Sign up at animapotv.fun and unlock your 7-day ad-free experience!",
    "🌟 7 days without ads are waiting for you on AnimapoTV!",
    "🍿 More watching, fewer interruptions — join AnimapoTV for 7 days ad-free!",
    "🎉 Join AnimapoTV today and enjoy your next 7 days without ads!",
    "🚀 Ready for ad-free anime? Create your AnimapoTV account today!",
    "💫 Create your account at animapotv.fun and unlock 7 days without ads!",
    "🎬 Join AnimapoTV, start your 7-day free ad-free trial, and enjoy the show!",
    "😎 Make the ads disappear for 7 days — join AnimapoTV today!",
    "❤️ Join AnimapoTV and enjoy 7 days ad-free. Visit animapotv.fun!",
    "✨ Almost ready! Create your AnimapoTV account and enjoy 7 days of ad-free watching!"
];
let messageIndex = 0;

function startLoadingMessages() {

    const message =
        document.getElementById("loadingMessage");

    setInterval(() => {

        messageIndex =
            (messageIndex + 1) %
            loadingMessages.length;

        message.style.opacity = "0";

        setTimeout(() => {

            message.textContent =
                loadingMessages[messageIndex];

            message.style.opacity = "1";

        }, 250);

    }, 3000);
}


startLoadingMessages();
            function escapeHtml(text) {
                return String(text)
                    .replaceAll("&", "&amp;")
                    .replaceAll("<", "&lt;")
                    .replaceAll(">", "&gt;")
                    .replaceAll('"', "&quot;")
                    .replaceAll("'", "&#039;");
            }

            function showError(message) {
                console.error("[Player Error]", message);

                hideLoader();

                if (!errorDiv) {
                    return;
                }

                errorDiv.innerHTML = `
                    <strong>Player Error</strong><br>
                    ${escapeHtml(message)}
                `;

                errorDiv.style.display = "block";
            }

            function hideError() {
                if (!errorDiv) {
                    return;
                }

                errorDiv.style.display = "none";
                errorDiv.textContent = "";
            }

            function postToParent(payload) {
                try {
                    window.parent.postMessage(payload, "*");
                } catch (error) {
                    console.error("postMessage failed:", error);
                }
            }

            function stopPlaybackWatchdog() {
                if (playbackWatchdogTimer) {
                    window.clearInterval(playbackWatchdogTimer);
                    playbackWatchdogTimer = null;
                }
            }

            function stopRecoveryTimeout() {
                if (recoveryTimeoutTimer) {
                    window.clearTimeout(recoveryTimeoutTimer);
                    recoveryTimeoutTimer = null;
                }
            }

            function resetPlaybackWatchdog(reason) {
                lastPlaybackPosition = Number(
                    player && typeof player.getPosition === "function"
                        ? player.getPosition() || 0
                        : 0
                );

                lastPlaybackAdvanceAt = Date.now();

                console.log(
                    "⏱️ Playback watchdog reset:",
                    reason || "unknown"
                );
            }

            function startPlaybackWatchdog() {
                stopPlaybackWatchdog();
                resetPlaybackWatchdog("watchdog started");

                playbackWatchdogTimer = window.setInterval(function () {
                    if (backupStarted || decryptionRecoveryStarted || !player) {
                        return;
                    }

                    // Never count the advertising break as failed content playback.
                    if (adBreakActive) {
                        lastPlaybackAdvanceAt = Date.now();
                        return;
                    }

                    let state = "";
                    try {
                        state = String(
                            typeof player.getState === "function"
                                ? player.getState() || ""
                                : ""
                        ).toLowerCase();
                    } catch (error) {}

                    let position = lastPlaybackPosition;
                    try {
                        if (typeof player.getPosition === "function") {
                            position = Number(player.getPosition() || 0);
                        }
                    } catch (error) {}

                    if (
                        Number.isFinite(position) &&
                        position > lastPlaybackPosition + 0.05
                    ) {
                        lastPlaybackPosition = position;
                        lastPlaybackAdvanceAt = Date.now();
                        return;
                    }

                    // If the player is paused by the viewer, this is not a stream failure.
                    if (state === "paused") {
                        lastPlaybackAdvanceAt = Date.now();
                        return;
                    }

                    const stalledFor =
                        Date.now() - lastPlaybackAdvanceAt;

                    if (stalledFor >= DECRYPTION_STALL_TIMEOUT_MS) {
                        console.warn(
                            "⏳ No playback progress for 50 seconds. Activating decryption recovery."
                        );

                        activateDecryptionRecovery(
                            "50-second playback stall"
                        );
                    }
                }, 1000);
            }

            async function activateDecryptionRecovery(reason) {
                if (
                    backupStarted ||
                    decryptionRecoveryStarted ||
                    !currentMasterUrl
                ) {
                    return;
                }

                decryptionRecoveryStarted = true;
                recoveryGeneration += 1;
                const generation = recoveryGeneration;

                stopPlaybackWatchdog();
                stopRecoveryTimeout();

                console.warn(
                    "🔐 Starting decryption recovery:",
                    reason
                );

                postToParent({
                    type: "decrypt-recovery-start",
                    reason: reason
                });

                hideError();
                showLoader();

                try {
                    // Turn decryption on only now. Normal startup stays untouched.
                    MegaDecrypt.enable();
                    MegaDecrypt.resetCache();

                    // Remove the failed normal player before rebuilding it.
                    try {
                        if (player) {
                            player.remove();
                        }
                    } catch (error) {
                        console.warn(
                            "[Decrypt] Failed removing old JW instance:",
                            error
                        );
                    }

                    player = null;
                    watermark = null;
                    skipLayer = null;
                    segmentLabel = null;
                    introHighlight = null;
                    outroHighlight = null;

                    // Recreate the SAME primary stream, now with segment decryption active.
                    setupPlayer(currentMasterUrl, true);

                    recoveryTimeoutTimer = window.setTimeout(function () {
                        if (
                            generation !== recoveryGeneration ||
                            backupStarted
                        ) {
                            return;
                        }

                        console.error(
                            "❌ Decrypted playback did not recover within 20 seconds."
                        );

                        failDecryptionRecovery(
                            "Decrypted stream did not start playback"
                        );
                    }, DECRYPTION_RECOVERY_TIMEOUT_MS);
                } catch (error) {
                    console.error(
                        "❌ Decryption recovery setup failed:",
                        error
                    );

                    failDecryptionRecovery(
                        error && error.message
                            ? error.message
                            : "Decryption recovery setup failed"
                    );
                }
            }

            function decryptionPlaybackSucceeded() {
                if (!decryptionRecoveryStarted || backupStarted) {
                    return;
                }

                stopRecoveryTimeout();
                decryptionRecoveryStarted = false;
                resetPlaybackWatchdog("decrypted playback recovered");
                startPlaybackWatchdog();

                console.log(
                    "✅ Decrypted playback is working. Staying on primary stream."
                );

                postToParent({
                    type: "decrypt-recovery-success"
                });
            }

            function failDecryptionRecovery(reason) {
                if (backupStarted) {
                    return;
                }

                stopRecoveryTimeout();
                stopPlaybackWatchdog();
                decryptionRecoveryStarted = false;

                console.error(
                    "💀 Decryption recovery failed. Moving to backups:",
                    reason
                );

                postToParent({
                    type: "decrypt-recovery-failed",
                    message: reason
                });

                startBackupPlayer();
            }


function showLoader() {
    const loadingScreen =
        document.getElementById("loadingScreen");

    if (!loadingScreen) {
        return;
    }

    // Start a new 5-second minimum display period
    loaderShownAt = Date.now();
    loaderReadyToHide = false;

    if (loaderHideTimer) {
        clearTimeout(loaderHideTimer);
        loaderHideTimer = null;
    }

    loadingScreen.classList.remove("hide");

    loadingScreen.style.display = "flex";
    loadingScreen.style.opacity = "1";
    loadingScreen.style.visibility = "visible";
    loadingScreen.style.pointerEvents = "auto";
    loadingScreen.style.zIndex = "9999";

    if (backdropImage) {
        loadingScreen.style.backgroundImage =
            `url("${backdropImage}")`;

        loadingScreen.style.backgroundSize = "cover";
        loadingScreen.style.backgroundPosition = "center";
        loadingScreen.style.backgroundRepeat = "no-repeat";
    }
}


function hideLoader() {
    const loadingScreen =
        document.getElementById("loadingScreen");

    if (!loadingScreen) {
        console.error("❌ #loadingScreen does not exist");
        return;
    }

    loaderReadyToHide = true;

    const elapsed =
        Date.now() - loaderShownAt;

    const remaining =
        Math.max(0, MIN_LOADER_TIME - elapsed);

    console.log(
        `⏳ Loader will hide in ${remaining}ms`
    );

    if (loaderHideTimer) {
        clearTimeout(loaderHideTimer);
    }

    loaderHideTimer = setTimeout(function () {

        if (!loaderReadyToHide) {
            return;
        }

        console.log("✅ 5-second loader period completed");

        loadingScreen.classList.add("hide");

        loadingScreen.style.display = "none";
        loadingScreen.style.opacity = "0";
        loadingScreen.style.visibility = "hidden";
        loadingScreen.style.pointerEvents = "none";
        loadingScreen.style.zIndex = "-1";

        loaderHideTimer = null;

    }, remaining);
}
function getRouteParams() {

    const parts = window.location.pathname
        .split("/")
        .map(function (part) {
            return part.trim();
        })
        .filter(Boolean);

    /*
     * Supports:
     *
     * /ani/21/1/sub
     * /mal/21/1/sub
     * /stream/ani/21/1/sub
     * /stream/mal/21/1/sub
     * /supstream/ani/21/1/sub
     * /supstream/mal/21/1/sub
     *
     * Result:
     *
     * source   = ani / mal
     * animeId  = 21
     * episode  = 1
     * type     = sub
     */

    let sourceIndex = -1;
    let source = null;

    // Find either "ani" or "mal"
    const aniIndex = parts.indexOf("ani");
    const malIndex = parts.indexOf("mal");

    if (aniIndex !== -1) {
        sourceIndex = aniIndex;
        source = "ani";
    } else if (malIndex !== -1) {
        sourceIndex = malIndex;
        source = "mal";
    }

    if (sourceIndex !== -1) {

        const animeIdRaw =
            parts[sourceIndex + 1] || "";

        const episodeRaw =
            parts[sourceIndex + 2] || "";

        const typeRaw =
            parts[sourceIndex + 3] || "sub";

        const animeId =
            parseInt(animeIdRaw, 10) || 0;

        const episodeId =
            parseInt(episodeRaw, 10) || 0;

        const normalizedType =
            String(typeRaw).toLowerCase() === "dub"
                ? "dub"
                : "sub";

        if (!animeId || !episodeId) {

            console.error(
                "[Player] Invalid " + source.toUpperCase() + " route:",
                window.location.pathname
            );

            return {
                source: source,
                animeId: 0,
                episodeId: 0,
                type: normalizedType
            };
        }

        /*
         * Loading screen still uses the episode ID.
         */
        setupLoadingScreen(episodeId);

        return {
            source: source,
            animeId: animeId,
            episodeId: episodeId,
            type: normalizedType
        };
    }


    /*
     * ----------------------------------------------------------
     * OLD ROUTE SUPPORT
     * ----------------------------------------------------------
     *
     * Keeps your existing:
     *
     * /s-2/1234/sub
     * /stream/s-2/1234/sub
     */

    const typeRaw =
        parts[parts.length - 1] || "sub";

    const episodeRaw =
        parts[parts.length - 2] || "1279";

    const normalizedType =
        String(typeRaw).toLowerCase() === "dub"
            ? "dub"
            : "sub";

    const episodeId =
        parseInt(episodeRaw, 10) || 1279;

    setupLoadingScreen(episodeId);

    return {
        source: "s-2",
        animeId: null,
        episodeId: episodeId,
        type: normalizedType
    };
}
async function fetchStreamData(episodeId, type) {

    const route = getRouteParams();


    /*
    ============================================================
    ANI ROUTE
    /stream/ani/:animeId/:episode/:type
    ============================================================
    */

    if (
        route.source === "ani" &&
        route.animeId &&
        route.episodeId
    ) {

        try {

            const apiUrl =
                API_BASE +
                "/api/z-6/" +
                encodeURIComponent(route.animeId) +
                "/" +
                encodeURIComponent(route.episodeId) +
                "/" +
                encodeURIComponent(route.type);


            console.log(
                "[Player] ANI route detected"
            );

            console.log(
                "[Player] Calling z-6:",
                apiUrl
            );


            const response =
                await fetch(
                    apiUrl,
                    {
                        method: "GET",
                        cache: "no-store",
                        credentials: "same-origin",
                        headers: {
                            Accept: "application/json"
                        }
                    }
                );


            const text =
                await response.text();


            let json;

            try {

                json =
                    JSON.parse(text);

            } catch (error) {

                throw new Error(
                    "z-6 API returned invalid JSON"
                );
            }


            if (!response.ok) {

                throw new Error(
                    "z-6 API request failed with HTTP " +
                    response.status
                );
            }


            const data =
                json.results ||
                json.data ||
                json;


            if (!data) {

                throw new Error(
                    "z-6 response missing data"
                );
            }


            if (!data.m3u8) {

                throw new Error(
                    "z-6 response missing m3u8"
                );
            }


            return {

                ...data,

                m3u8:
                    data.m3u8,

                rawM3u8:
                    data.rawM3u8 ||
                    data.originalRawM3u8 ||
                    null,

                originalRawM3u8:
                    data.originalRawM3u8 ||
                    null,

                subtitles:
                    Array.isArray(data.subtitles)
                        ? data.subtitles
                        : [],

                intro: {
                    start: Number(
                        data.intro?.start || 0
                    ),

                    end: Number(
                        data.intro?.end || 0
                    )
                },

                outro: {
                    start: Number(
                        data.outro?.start || 0
                    ),

                    end: Number(
                        data.outro?.end || 0
                    )
                }
            };

        } catch (error) {

            console.error(
                "[Player] z-6 failed:",
                error
            );

            /*
             * Throw so your existing backup/recovery
             * logic can handle the failure.
             */
            throw error;
        }
    }

   if (
        route.source === "mal" &&
        route.animeId &&
        route.episodeId
    ) {

        try {

            const apiUrl =
                API_BASE +
                "/api/z-7/" +
                encodeURIComponent(route.animeId) +
                "/" +
                encodeURIComponent(route.episodeId) +
                "/" +
                encodeURIComponent(route.type);


            console.log(
                "[Player] ANI route detected"
            );

            console.log(
                "[Player] Calling z-6:",
                apiUrl
            );


            const response =
                await fetch(
                    apiUrl,
                    {
                        method: "GET",
                        cache: "no-store",
                        credentials: "same-origin",
                        headers: {
                            Accept: "application/json"
                        }
                    }
                );


            const text =
                await response.text();


            let json;

            try {

                json =
                    JSON.parse(text);

            } catch (error) {

                throw new Error(
                    "z-6 API returned invalid JSON"
                );
            }


            if (!response.ok) {

                throw new Error(
                    "z-6 API request failed with HTTP " +
                    response.status
                );
            }


            const data =
                json.results ||
                json.data ||
                json;


            if (!data) {

                throw new Error(
                    "z-6 response missing data"
                );
            }


            if (!data.m3u8) {

                throw new Error(
                    "z-6 response missing m3u8"
                );
            }


            return {

                ...data,

                m3u8:
                    data.m3u8,

                rawM3u8:
                    data.rawM3u8 ||
                    data.originalRawM3u8 ||
                    null,

                originalRawM3u8:
                    data.originalRawM3u8 ||
                    null,

                subtitles:
                    Array.isArray(data.subtitles)
                        ? data.subtitles
                        : [],

                intro: {
                    start: Number(
                        data.intro?.start || 0
                    ),

                    end: Number(
                        data.intro?.end || 0
                    )
                },

                outro: {
                    start: Number(
                        data.outro?.start || 0
                    ),

                    end: Number(
                        data.outro?.end || 0
                    )
                }
            };

        } catch (error) {

            console.error(
                "[Player] z-6 failed:",
                error
            );

            /*
             * Throw so your existing backup/recovery
             * logic can handle the failure.
             */
            throw error;
        }
    }
    /*
    ============================================================
    OLD ROUTE
    /api/episode-cache/:episodeId/:type
    ============================================================
    */

    try {

        const apiUrl =
            API_BASE +
            "/api/episode-cache/" +
            encodeURIComponent(episodeId) +
            "/" +
            encodeURIComponent(type);


        const response =
            await fetch(
                apiUrl,
                {
                    method: "GET",
                    cache: "no-store",
                    credentials: "same-origin",
                    headers: {
                        Accept: "application/json"
                    }
                }
            );


        const text =
            await response.text();


        let json;

        try {

            json =
                JSON.parse(text);

        } catch (error) {

            throw new Error(
                "Primary API returned invalid JSON"
            );
        }


        if (!response.ok) {

            throw new Error(
                "Primary API request failed with HTTP " +
                response.status
            );
        }


        if (!json.success) {

            throw new Error(
                json.message ||
                "Primary API success is false"
            );
        }


        const data =
            json.results ||
            json.data;


        if (!data) {

            throw new Error(
                "Primary API response missing data/results object"
            );
        }


        if (!data.m3u8) {

            throw new Error(
                "Primary API response missing m3u8"
            );
        }


        return {

            ...data,

            m3u8:
                data.m3u8,

            rawM3u8:
                data.rawM3u8 ||
                data.originalRawM3u8 ||
                null,

            originalRawM3u8:
                data.originalRawM3u8 ||
                null,

            subtitles:
                Array.isArray(data.subtitles)
                    ? data.subtitles
                    : [],

            intro: {
                start: Number(
                    data.intro?.start || 0
                ),

                end: Number(
                    data.intro?.end || 0
                )
            },

            outro: {
                start: Number(
                    data.outro?.start || 0
                ),

                end: Number(
                    data.outro?.end || 0
                )
            }
        };


    } catch (primaryError) {

        console.warn(
            "[Player] Primary API failed:",
            primaryError.message
        );
    }


    /*
    ============================================================
    FALLBACK API
    ============================================================
    */

    try {

        const apiUrl =
            API_BASE +
            "/episode/" +
            encodeURIComponent(episodeId) +
            "/" +
            encodeURIComponent(type);


        const response =
            await fetch(
                apiUrl,
                {
                    method: "GET",
                    cache: "no-store",
                    credentials: "same-origin",
                    headers: {
                        Accept: "application/json"
                    }
                }
            );


        const text =
            await response.text();


        let json;

        try {

            json =
                JSON.parse(text);

        } catch (error) {

            throw new Error(
                "Fallback API returned invalid JSON"
            );
        }


        if (!response.ok) {

            throw new Error(
                "Fallback API request failed with HTTP " +
                response.status
            );
        }


        if (!json.success) {

            throw new Error(
                json.message ||
                "Fallback API success is false"
            );
        }


        const m3u8 =
            json.sp_1 ||
            json.sp_2 ||
            json.sp_3 ||
            json.sp_4 ||
            json.original_raw_m3u8 ||
            null;


        if (!m3u8) {

            throw new Error(
                "Fallback API response missing m3u8"
            );
        }


        return {

            m3u8: m3u8,

            rawM3u8:
                json.original_raw_m3u8 ||
                null,

            originalRawM3u8:
                json.original_raw_m3u8 ||
                null,

            subtitles:
                Array.isArray(json.subtitles)
                    ? json.subtitles
                    : [],

            intro: {
                start: Number(
                    json.intro_start || 0
                ),

                end: Number(
                    json.intro_end || 0
                )
            },

            outro: {
                start: Number(
                    json.outro_start || 0
                ),

                end: Number(
                    json.outro_end || 0
                )
            },

            anime:
                json.anime ||
                null,

            episode:
                json.episode ||
                null,

            metadata: {
                animeId:
                    json.anime?.id ??
                    null,

                malId:
                    json.anime?.mal_id ??
                    null,

                aniId:
                    json.anime?.ani_id ??
                    null,

                episodeNumber:
                    json.episode_number ??
                    null,

                title:
                    json.episode?.title ||
                    `Episode ${
                        json.episode_number ?? ""
                    }`.trim(),

                jpTitle:
                    json.episode?.jp_title ||
                    "",

                description:
                    json.episode?.description ||
                    "",

                backdropImage:
                    json.episode?.backdrop_image ||
                    json.episode?.backdrop_img ||
                    "",

                duration:
                    Number(
                        json.episode?.duration ||
                        0
                    ),

                airDate:
                    json.episode?.air_date ||
                    "",

                filler:
                    Boolean(
                        json.episode?.filler
                    )
            }
        };


    } catch (fallbackError) {

        console.error(
            "[Player] Fallback API failed:",
            fallbackError
        );

        throw new Error(
            "Unable to load stream from primary or fallback API"
        );
    }
}
    /*
    ============================================================
    PRIMARY API
    /api/episode-cache/:episodeId/:type
    ============================================================
    */

       function absolutizeUrl(url) {
                if (!url) {
                    return "";
                }

                try {
                    return new URL(
                        url,
                        window.location.href
                    ).href;
                } catch (error) {
                    return String(url);
                }
            }

            function proxySubtitleUrl(url) {
                if (!url) {
                    return "";
                }

                const absoluteUrl = absolutizeUrl(url);

                if (
                    absoluteUrl.includes(
                        "/api/subtitle-proxy"
                    )
                ) {
                    return absoluteUrl;
                }

                return (
                    API_BASE +
                    "/api/subtitle-proxy?url=" +
                    encodeURIComponent(absoluteUrl)
                );
            }

function buildSubtitleTracks(list) {
    if (!Array.isArray(list)) {
        return [];
    }

    return list
        .filter(track => track && track.file)
        .map((track, index) => ({
            file: proxySubtitleUrl(track.file),
            kind: track.kind || "captions",
            label:
                track.label ||
                track.language ||
                track.lang ||
                `Subtitle ${index + 1}`,
            default: Boolean(
                track.default ?? track.is_default
            )
        }));
}
            function normalizeSegment(segment) {
                const source =
                    segment &&
                    typeof segment === "object"
                        ? segment
                        : {};

                const start = Number(
                    source.start || 0
                );

                const end = Number(
                    source.end || 0
                );

                return {
                    start:
                        Number.isFinite(start)
                            ? Math.max(0, start)
                            : 0,
                    end:
                        Number.isFinite(end)
                            ? Math.max(0, end)
                            : 0
                };
            }
function randomUniquePercents(count, min = 10, max = 100) {
    const values = [];

    while (values.length < count) {
        const value =
            Math.floor(Math.random() * (max - min + 1)) + min;

        if (!values.includes(value)) {
            values.push(value);
        }
    }

    return values;
}

       const [ad1Offset, ad2Offset] = randomUniquePercents(2, 10, 100);


            function setupPlayer(masterUrl, isDecryptionRecovery) {
                currentMasterUrl = masterUrl;
                hideError();
                showLoader();

                player = jwplayer("player").setup({
                    file: masterUrl,

                    width: "100%",
                    height: "100%",
                    image: backdropImage || "",

                    autostart: true,
                    controls: true,
                    mute: false,
                    hlsjsdefault: true,
                    preload: "auto",
                    stretching: "uniform",

                    primary: "html5",

                    // Native JW Player VAST pre-roll.
                    // Do not combine advertising.tag with advertising.schedule.
                    advertising: {
                        client: "vast",
                        schedule: [
                 {
            offset: "0%",
            tag: VAST_AD_TAG
        },
        
                       
        {
      
            
        offset: `${ad1Offset}%`,
        tag: shuffledMagsrvAds[1]
        },


        {

        offset: `${ad2Offset}%`,
        tag: shuffledMagsrvAds[1]
        }
        
                        ],
                        requestTimeout: 35000,
                        withCredentials: false
                    },

                    hlsjsConfig: {
                        capLevelToPlayerSize: false,
                        startLevel: -1
                    },

                    tracks: buildSubtitleTracks(
                        subtitles
                    )
                });

                bindPlayerEvents();
            }
const iframe = document.createElement("iframe");

iframe.allow = "autoplay; fullscreen";
iframe.allowFullscreen = true;

iframe.style.cssText = `
    width:100%;
    height:100%;
    border:0;
    display:none;
`;

document.getElementById("player").appendChild(iframe);

            function startBackupPlayer() {
    if (backupStarted) {
        return;
    }

    backupStarted = true;
    stopPlaybackWatchdog();
    stopRecoveryTimeout();
    decryptionRecoveryStarted = false;

    const route = getRouteParams();
    const sources = getBackupSources(
        route.episodeId,
        route.type
    );

    // Hide JW Player
    try {
        if (player) {
            player.remove();
        }
    } catch (e) {}

    // Show iframe
    iframe.style.display = "block";

    let index = 0;

    function tryNext() {
        if (index >= sources.length) {
            showError("All backup players failed.");
            return;
        }

        iframe.src = sources[index++];
    }

    iframe.onload = function () {
        hideError();
        hideLoader();
    };

    iframe.onerror = function () {
        tryNext();
    };

    // If iframe never loads (403, timeout, etc.)
    let timeout;

    iframe.addEventListener("load", function () {
        clearTimeout(timeout);
    });

    function loadSource() {
        clearTimeout(timeout);

        iframe.src = sources[index];

        timeout = setTimeout(function () {
            index++;
            tryNext();
        }, 10000); // 10 seconds
    }

    index = 0;
    loadSource();
}
            function setCustomPlayerOverlaysVisible(visible) {
                const display = visible ? "" : "none";

                if (watermark) {
                    watermark.style.display = display;
                }

                if (!visible) {
                    if (skipLayer) {
                        skipLayer.style.display = "none";
                    }

                    if (segmentLabel) {
                        segmentLabel.style.display = "none";
                    }
                }
            }
/* ============================================================
   SUPER VAST UI
============================================================ */

let superVastCurrentAd = null;
let superVastIsActive = false;
let superVastMetadataLoading = false;


/* ============================================================
   CHECK WHETHER THIS IS OUR SUPER VAST
============================================================ */

function isSuperVastTag(tag) {

    if (!tag) {
        return false;
    }

    try {

        const url = new URL(
            String(tag),
            window.location.href
        );

        return (
            url.pathname === "/super_vast" ||
            url.pathname.endsWith("/super_vast")
        );

    } catch {

        return String(tag).includes("/super_vast");
    }
}


/* ============================================================
   LOAD THE EXACT AD METADATA
============================================================ */

async function loadSuperVastMetadata(adId) {

    if (!adId) {
        return null;
    }

    if (superVastMetadataLoading) {
        return null;
    }

    superVastMetadataLoading = true;

    try {

        console.info(
            "[SUPER VAST] Loading metadata for:",
            adId
        );


        const response = await fetch(
            `/super_vast/meta/${encodeURIComponent(adId)}`,
            {
                method: "GET",

                cache: "no-store",

                credentials: "same-origin"
            }
        );


        if (!response.ok) {

            throw new Error(
                `Metadata request failed: ${response.status}`
            );
        }


        const ad = await response.json();


        if (!ad || !ad.id) {

            throw new Error(
                "Invalid Super VAST metadata"
            );
        }


        superVastCurrentAd = ad;


        console.info(
            "[SUPER VAST] Metadata loaded:",
            ad
        );


        return ad;

    } catch (error) {

        console.error(
            "[SUPER VAST] Metadata error:",
            error
        );

        return null;

    } finally {

        superVastMetadataLoading = false;
    }
}


/* ============================================================
   CREATE OVERLAY
============================================================ */

/* ============================================================
   REMOVE OVERLAY
============================================================ */
function createSuperVastOverlay(ad) {

    removeSuperVastOverlay();

    if (!ad) {
        return;
    }

    const playerContainer =
        document.querySelector(".jwplayer");

    if (!playerContainer) {
        console.warn(
            "[SUPER VAST] JW player container not found"
        );
        return;
    }

    /*
     * ==========================================
     * OVERLAY
     * ==========================================
     */

    const overlay =
        document.createElement("div");

    overlay.className =
        "super-vast-overlay";


    /*
     * ==========================================
     * TOP BAR
     * TITLE LEFT
     * LOGO RIGHT
     * ==========================================
     */

    const advertiser =
        document.createElement("div");

    advertiser.className =
        "super-vast-advertiser";


    /*
     * ==========================================
     * TITLE
     * ==========================================
     */

    if (ad.title) {

        /*
         * IMAGE TITLE
         */

        if (ad.title_type === "image") {

            const titleImage =
                document.createElement("img");

            titleImage.className =
                "super-vast-title-image";

            titleImage.src =
                ad.title;

            titleImage.alt =
                "Advertisement";

            titleImage.draggable =
                false;

            advertiser.appendChild(
                titleImage
            );

        }

        /*
         * TEXT TITLE
         */

        else {

            const title =
                document.createElement("div");

            title.className =
                "super-vast-title";

            title.textContent =
                String(ad.title).trim();

            advertiser.appendChild(
                title
            );
        }
    }


    /*
     * ==========================================
     * LOGO
     * LOCKED TO RIGHT
     * ==========================================
     */

    if (ad.logo_url) {

        const logoWrapper =
            document.createElement("div");

        logoWrapper.className =
            "super-vast-logo-wrapper";


        const logo =
            document.createElement("img");

        logo.className =
            "super-vast-logo";

        logo.src =
            ad.logo_url;

        logo.alt =
            ad.title_type === "text"
                ? ad.title || "Advertisement"
                : "Advertisement";

        logo.draggable =
            false;


        logoWrapper.appendChild(
            logo
        );

        advertiser.appendChild(
            logoWrapper
        );
    }


    /*
     * ==========================================
     * ADD TOP BAR
     * ==========================================
     */

    overlay.appendChild(
        advertiser
    );


    /*
     * ==========================================
     * CTA BUTTON
     * ==========================================
     */

    if (ad.target_url) {

        const button =
            document.createElement("a");

        button.className =
            "super-vast-cta";

        button.href =
            ad.target_url;

        button.target =
            "_blank";

        button.rel =
            "noopener noreferrer";

        button.textContent =
            ad.button_text ||
            "WATCH FOR FREE NOW";


        overlay.appendChild(
            button
        );
    }


    /*
     * ==========================================
     * ADD TO PLAYER
     * ==========================================
     */

    playerContainer.appendChild(
        overlay
    );


    console.info(
        "[SUPER VAST] Overlay displayed:",
        ad
    );
}
function removeSuperVastOverlay() {

    document
        .querySelectorAll(
            ".super-vast-overlay"
        )
        .forEach(function (element) {

            element.remove();
        });


    superVastCurrentAd = null;

    superVastIsActive = false;

    superVastMetadataLoading = false;
}

            function bindPlayerEvents() {
                player.on("ready", function () {
                    hideLoader();
                    createWatermarkInsideJW();
                    createSkipLayerInsideJW();
                    createSegmentLabelInsideJW();
                  //  createIntroAdInsideJW();
                    addJWButtons();

                    postToParent({
                        event: "player-ready",
                        type: "player-ready",
                        autoskip: autoSkipEnabled
                    });

                    window.setTimeout(function () {
                        updateTimelineHighlights();
                        tryApplyResume();
                    }, 700);
                });

/* ============================================================
   VAST REQUEST
============================================================ */

player.on("adRequest", function (event) {

    adBreakActive = true;

    hideLoader();


    console.info(
        "[VAST] adRequest",
        event
    );


    /*
     * Determine whether this is our Super VAST.
     */

    if (
        event &&
        event.tag &&
        isSuperVastTag(event.tag)
    ) {

        superVastIsActive = true;

        console.info(
            "[SUPER VAST] Our VAST requested:",
            event.tag
        );

    } else {

        /*
         * Another VAST.
         *
         * Do not show Super VAST UI.
         */

        superVastIsActive = false;

        removeSuperVastOverlay();
    }


    /*
     * IMPORTANT:
     *
     * Do not send the complete JW event through
     * postMessage because it can contain XMLHttpRequest.
     */

    postToParent({
        type: "vast-ad-request",

        event: {
            client: event?.client || null,
            placement: event?.placement || null,
            adBreakId: event?.adBreakId || null,
            adPlayId: event?.adPlayId || null,
            offset: event?.offset || null,
            tag: event?.tag || null
        }
    });
});


/* ============================================================
   VAST LOADED
============================================================ */

player.on("adLoaded", function (event) {

    hideLoader();

    console.info(
        "[VAST] adLoaded",
        event
    );
});


/* ============================================================
   AD IMPRESSION
============================================================ */

player.on("adImpression", async function (event) {

    console.info(
        "[VAST] adImpression",
        event
    );


    /*
     * This event from your console contains:
     *
     * adId: "ad-2"
     *
     * Perfect.
     */

    if (
        !superVastIsActive ||
        !event ||
        !event.adId
    ) {
        return;
    }


    const ad =
        await loadSuperVastMetadata(
            event.adId
        );


    if (ad) {

        /*
         * If JW has already started playing,
         * show it immediately.
         */

        if (superVastIsActive) {

            createSuperVastOverlay(ad);
        }
    }
});


/* ============================================================
   AD STARTED
============================================================ */

player.on("adStarted", async function (event) {

    console.info(
        "[VAST] adStarted",
        event
    );


    if (!superVastIsActive) {
        return;
    }


    /*
     * JW's event should contain adId.
     */

    const adId =
        event?.adId ||
        event?.id ||
        null;


    if (!adId) {

        console.warn(
            "[SUPER VAST] adStarted has no adId"
        );

        return;
    }


    /*
     * If metadata wasn't already loaded,
     * load it now.
     */

    let ad =
        superVastCurrentAd;


    if (
        !ad ||
        String(ad.id) !== String(adId)
    ) {

        ad =
            await loadSuperVastMetadata(
                adId
            );
    }


    if (!ad) {
        return;
    }


    createSuperVastOverlay(ad);
});


/* ============================================================
   AD BREAK START
============================================================ */

player.on("adBreakStart", function (event) {

    adBreakActive = true;

    hideLoader();

    setCustomPlayerOverlaysVisible(false);


    console.info(
        "[VAST] adBreakStart",
        event
    );
});


/* ============================================================
   AD PLAY
============================================================ */

player.on("adPlay", function (event) {

    hideLoader();

    setCustomPlayerOverlaysVisible(false);


    console.info(
        "[VAST] adPlay",
        event
    );


    if (
        superVastIsActive &&
        superVastCurrentAd
    ) {

        createSuperVastOverlay(
            superVastCurrentAd
        );
    }


    /*
     * Send only safe values to parent.
     *
     * Do NOT send the complete event.
     */

    postToParent({

        type: "vast-ad-play",

        event: {

            client:
                event?.client || null,

            placement:
                event?.placement || null,

            adBreakId:
                event?.adBreakId || null,

            adPlayId:
                event?.adPlayId || null,

            offset:
                event?.offset || null
        }
    });
});


/* ============================================================
   AD COMPLETE
============================================================ */

player.on("adComplete", function (event) {

    console.info(
        "[VAST] adComplete",
        event
    );


    removeSuperVastOverlay();


    postToParent({

        type: "vast-ad-complete",

        event: {

            client:
                event?.client || null,

            placement:
                event?.placement || null,

            adBreakId:
                event?.adBreakId || null,

            adPlayId:
                event?.adPlayId || null
        }
    });
});


/* ============================================================
   AD SKIPPED
============================================================ */

player.on("adSkipped", function (event) {

    console.info(
        "[VAST] adSkipped",
        event
    );


    removeSuperVastOverlay();
});


/* ============================================================
   AD ERROR
============================================================ */

player.on("adError", function (event) {

    adBreakActive = false;


    console.warn(
        "[VAST] adError",
        event
    );


    removeSuperVastOverlay();


    hideLoader();

    setCustomPlayerOverlaysVisible(true);


    postToParent({

        type: "vast-ad-error",

        message:
            event?.message ||
            "VAST ad failed",

        code:
            event?.code ||
            null
    });
});


/* ============================================================
   AD BREAK END
============================================================ */

player.on("adBreakEnd", function (event) {

    adBreakActive = false;


    removeSuperVastOverlay();


    setCustomPlayerOverlaysVisible(true);


    window.setTimeout(
        tryApplyResume,
        150
    );


    console.info(
        "[VAST] adBreakEnd",
        event
    );
});


/* ============================================================
   AD BLOCK
============================================================ */

player.on("adBlock", function (event) {

    console.warn(
        "[VAST] Ad blocker detected",
        event
    );


    postToParent({

        type: "vast-ad-block",

        event: {

            client:
                event?.client || null,

            placement:
                event?.placement || null
        }
    });
});
                player.on("time", function (event) {
                    const time = Number(
                        event.position || 0
                    );

                    const duration = Number(
                        player.getDuration() ||
                        event.duration ||
                        0
                    );

                    // Actual playback progress is the signal used by the 50-second watchdog.
                    if (!adBreakActive && Number.isFinite(time)) {
                        if (time > lastPlaybackPosition + 0.05) {
                            lastPlaybackPosition = time;
                            lastPlaybackAdvanceAt = Date.now();

                            if (decryptionRecoveryStarted) {
                                decryptionPlaybackSucceeded();
                            }
                        }
                    }

                    const percent =
                        duration > 0
                            ? Math.min(
                                100,
                                Math.max(
                                    0,
                                    (time / duration) * 100
                                )
                            )
                            : 0;

                    if (handleAutoSkip(time)) {
                        return;
                    }

                    handleSkipLayer(time);
                    handleSegmentLabel(time);
                    updateTimelineHighlights();

                    /*
                     * Do not send an incorrect zero position to the parent
                     * while the saved position is still being restored.
                     */
                    if (!resumeApplied) {
                        tryApplyResume();
                        return;
                    }

                    sendWatchingLog(time);

                    postToParent({
                        channel: "megacloud",
                        event: "time",
                        time: Math.floor(time),
                        duration: Math.floor(duration),
                        percent: Number(
                            percent.toFixed(2)
                        )
                    });
                });

                player.on("firstFrame", function () {
                    hideLoader();

                    if (decryptionRecoveryStarted) {
                        // firstFrame proves media reached the renderer; the time event will
                        // confirm actual forward playback as well.
                        console.log("🎬 [Decrypt] First frame received");
                    }
                    updateTimelineHighlights();

                    window.setTimeout(
                        tryApplyResume,
                        180
                    );

                    // VAST is handled by JW Player's pre-roll schedule.
                });

                player.on("setupError", function (event) {
                    const message =
                        event && event.message
                            ? event.message
                            : "JW Player setup error";

                    console.error("[JW] Setup error:", message);

                    postToParent({
                        type: "error",
                        message: message
                    });

                    // Normal startup has not reached the 50-second recovery point.
                    // Do not jump directly to backups here.
                    if (decryptionRecoveryStarted) {
                        failDecryptionRecovery(message);
                    }
                });

                player.on("error", function (event) {
                    const message =
                        event && event.message
                            ? event.message
                            : "JW Player playback error";

                    console.error("[JW] Playback error:", message);

                    postToParent({
                        type: "error",
                        message: message
                    });

                    // If the decrypted attempt itself errors, backups are now allowed.
                    if (decryptionRecoveryStarted) {
                        failDecryptionRecovery(message);
                    }
                });

                player.on(
                    "levels",
                    updateTimelineHighlights
                );

                player.on(
                    "resize",
                    updateTimelineHighlights
                );

                player.on("play", function () {
                    hideLoader();
                    hideError();
                    updateTimelineHighlights();

                    resetPlaybackWatchdog("play event");

                    if (decryptionRecoveryStarted) {
                        console.log("▶️ [Decrypt] Playback resumed after decryption");
                    }

                    if (!resumeApplied) {
                        window.setTimeout(
                            tryApplyResume,
                            120
                        );
                    }

                    // VAST is handled by JW Player's pre-roll schedule.

                });

                player.on("pause", function () {
                    postToParent({
                        channel: "megacloud",
                        event: "pause",
                        time: Math.floor(
                            Number(
                                player.getPosition() || 0
                            )
                        )
                    });
                });

                player.on("buffer", function () {
                    postToParent({
                        channel: "megacloud",
                        event: "buffer"
                    });
                });

                player.on("complete", function () {
                    const params = getRouteParams();


                    postToParent({
                        channel: "megacloud",
                        event: "complete",
                        type: "complete",
                        episodeId: params.episodeId
                    });
                });
            }

            function addJWButtons() {
                if (
                    !player ||
                    typeof player.addButton !== "function"
                ) {
                    return;
                }

                try {
                    player.addButton(
                        "https://supaplay.fun/public/assets/images/skip-10-next.svg?v=0.8",
                        "Forward 10 seconds",
                        function () {
                            const current = Number(
                                player.getPosition() || 0
                            );

                            const duration = Number(
                                player.getDuration() || 0
                            );

                            const target =
                                duration > 0
                                    ? Math.min(
                                        current + 10,
                                        Math.max(
                                            duration - 1,
                                            0
                                        )
                                    )
                                    : current + 10;

                            player.seek(target);
                        },
                        "forward-10-button"
                    );
                } catch (error) {
                    console.warn(
                        "Forward 10 button failed:",
                        error
                    );
                }

                try {
                    player.addButton(
                        "https://supaplay.fun/public/assets/images/skip-10-prev.svg?v=0.8",
                        "Back 10 seconds",
                        function () {
                            const current = Number(
                                player.getPosition() || 0
                            );

                            const target = Math.max(
                                current - 10,
                                0
                            );

                            player.seek(target);
                        },
                        "back-10-button"
                    );
                } catch (error) {
                    console.warn(
                        "Back 10 button failed:",
                        error
                    );
                }
            }

     function createWatermarkInsideJW() {
    if (!player || watermark) {
        return;
    }

    const container = player.getContainer();

    if (!container) {
        return;
    }

    watermark = document.createElement("a");

    watermark.href = "home";
    watermark.setAttribute("data-link", "");
    watermark.setAttribute("aria-label", "SupaPlay home");

    watermark.innerHTML = `
        <span class="brand-word">FREE</span>
    `;

    watermark.className = "jw-reset supaplay-watermark";

    container.appendChild(watermark);
}
            function createSkipLayerInsideJW() {
                if (!player || skipLayer) {
                    return;
                }

                const container =
                    player.getContainer();

                if (!container) {
                    return;
                }

                skipLayer =
                    document.createElement("button");

                skipLayer.type = "button";
                skipLayer.textContent = "Skip";

                skipLayer.className =
                    "jw-reset animapo-skip-layer";

                skipLayer.setAttribute(
                    "aria-label",
                    "Skip segment"
                );

                skipLayer.addEventListener(
                    "click",
                    function (event) {
                        event.preventDefault();
                        event.stopPropagation();

                        if (
                            !player ||
                            skipTarget === null
                        ) {
                            return;
                        }

                        player.seek(skipTarget);

                        skipLayer.style.display =
                            "none";

                        skipTarget = null;
                    }
                );

                container.appendChild(skipLayer);
            }

            function createSegmentLabelInsideJW() {
                if (!player || segmentLabel) {
                    return;
                }

                const container =
                    player.getContainer();

                if (!container) {
                    return;
                }

                segmentLabel =
                    document.createElement("div");

                segmentLabel.className =
                    "jw-reset animapo-segment-label";

                segmentLabel.textContent = "";

                container.appendChild(segmentLabel);
            }

            function createIntroAdInsideJW() {
                if (!player || introAdOverlay) {
                    return;
                }

                const container =
                    player.getContainer();

                if (!container) {
                    return;
                }

                introAdOverlay =
                    document.createElement("div");

                introAdOverlay.className =
                    "jw-reset animapo-jw-intro-overlay";

                introAdOverlay.innerHTML = `
                    <div class="animapo-jw-intro-logo">
                        ANIMAPO
                    </div>

                    <div class="animapo-jw-intro-text">
                        Now Streaming
                    </div>
                `;

                container.appendChild(introAdOverlay);
            }

            function handleAutoSkip(position) {
                if (
                    !autoSkipEnabled ||
                    !resumeApplied ||
                    adBreakActive ||
                    introAdRunning ||
                    !player ||
                    typeof player.seek !== "function"
                ) {
                    return false;
                }

                const time = Number(position || 0);

                if (!Number.isFinite(time)) {
                    return false;
                }

                /*
                 * Avoid firing multiple seek commands from closely spaced
                 * JW Player time events.
                 */
                if (Date.now() - lastAutoSkipTime < 900) {
                    return false;
                }

                if (
                    intro.end > intro.start &&
                    time >= intro.start &&
                    time < intro.end &&
                    !introAutoSkipped
                ) {
                    introAutoSkipped = true;
                    lastAutoSkipTime = Date.now();

                    if (skipLayer) {
                        skipLayer.style.display = "none";
                    }

                    skipTarget = null;
                    player.seek(intro.end);

                    postToParent({
                        event: "autoskip",
                        type: "autoskip",
                        segment: "intro",
                        from: Math.floor(time),
                        to: Math.floor(intro.end)
                    });

                    return true;
                }

                if (
                    outro.end > outro.start &&
                    time >= outro.start &&
                    time < outro.end &&
                    !outroAutoSkipped
                ) {
                    outroAutoSkipped = true;
                    lastAutoSkipTime = Date.now();

                    if (skipLayer) {
                        skipLayer.style.display = "none";
                    }

                    skipTarget = null;
                    player.seek(outro.end);

                    postToParent({
                        event: "autoskip",
                        type: "autoskip",
                        segment: "outro",
                        from: Math.floor(time),
                        to: Math.floor(outro.end)
                    });

                    return true;
                }

                return false;
            }

            function handleSkipLayer(position) {
                if (!skipLayer) {
                    return;
                }

                const time = Number(position || 0);

                if (
                    intro.end > intro.start &&
                    time >= intro.start &&
                    time < intro.end
                ) {
                    skipLayer.style.color =
                        "#ffffff";

                    skipLayer.textContent =
                        "Skip Intro";

                    skipLayer.style.display =
                        "flex";

                    skipTarget = intro.end;

                    return;
                }

                if (
                    outro.end > outro.start &&
                    time >= outro.start &&
                    time < outro.end
                ) {
                    skipLayer.style.color =
                        "#ffffff";

                    skipLayer.textContent =
                        "Skip Outro";

                    skipLayer.style.display =
                        "flex";

                    skipTarget = outro.end;

                    return;
                }

                skipLayer.style.display = "none";
                skipTarget = null;
            }

            function handleSegmentLabel(position) {
                if (!segmentLabel) {
                    return;
                }

                const time = Number(position || 0);

                if (
                    intro.end > intro.start &&
                    time >= intro.start &&
                    time < intro.end
                ) {
                    segmentLabel.textContent =
                        "Opening";

                    segmentLabel.style.display =
                        "block";

                    return;
                }

                if (
                    outro.end > outro.start &&
                    time >= outro.start &&
                    time < outro.end
                ) {
                    segmentLabel.textContent =
                        "Ending";

                    segmentLabel.style.display =
                        "block";

                    return;
                }

                segmentLabel.style.display = "none";
                segmentLabel.textContent = "";
            }

            function updateTimelineHighlights() {
                if (!player) {
                    return;
                }

                const duration = Number(
                    player.getDuration() || 0
                );

                if (
                    !Number.isFinite(duration) ||
                    duration <= 0
                ) {
                    return;
                }

                const container =
                    player.getContainer();

                if (!container) {
                    return;
                }

                const rail =
                    container.querySelector(
                        ".jw-slider-time .jw-rail"
                    ) ||
                    container.querySelector(
                        ".jw-slider-time"
                    );

                if (!rail) {
                    return;
                }

                if (
                    window.getComputedStyle(rail)
                        .position === "static"
                ) {
                    rail.style.position = "relative";
                }

                if (!introHighlight) {
                    introHighlight =
                        document.createElement("div");

                    introHighlight.className =
                        "animapo-progress-highlight animapo-intro-highlight";

                    rail.appendChild(introHighlight);
                }

                if (!outroHighlight) {
                    outroHighlight =
                        document.createElement("div");

                    outroHighlight.className =
                        "animapo-progress-highlight animapo-outro-highlight";

                    rail.appendChild(outroHighlight);
                }

                applyHighlight(
                    introHighlight,
                    intro,
                    duration
                );

                applyHighlight(
                    outroHighlight,
                    outro,
                    duration
                );
            }

            function applyHighlight(
                element,
                segment,
                duration
            ) {
                if (
                    !element ||
                    !segment ||
                    !duration
                ) {
                    return;
                }

                const start = Number(
                    segment.start || 0
                );

                const end = Number(
                    segment.end || 0
                );

                if (
                    end <= start ||
                    start < 0
                ) {
                    element.style.display = "none";
                    return;
                }

                const left = Math.max(
                    0,
                    Math.min(
                        100,
                        (start / duration) * 100
                    )
                );

                const width = Math.max(
                    0,
                    Math.min(
                        100 - left,
                        ((end - start) / duration) * 100
                    )
                );

                element.style.left =
                    String(left) + "%";

                element.style.width =
                    String(width) + "%";

                element.style.display = "block";
            }

     
            function sendWatchingLog(position) {
                const now = Date.now();

                if (
                    now - lastPostTime < 5000
                ) {
                    return;
                }

                lastPostTime = now;

                postToParent({
                    type: "watching-log",
                    currentTime: Math.floor(
                        position || 0
                    ),
                    duration: Math.floor(
                        player
                            ? player.getDuration() || 0
                            : 0
                    )
                });
            }
async function initPlayer() {
    try {

        const params = getRouteParams();


        if (!window.jwplayer) {

            startBackupPlayer();

            return;
        }

  
        const data = await fetchStreamData(
            params.episodeId,
            params.type
        );

        /*
         * Get M3U8
         */
        const masterUrl = data.m3u8;

        if (!masterUrl) {
            throw new Error(
                "Stream data does not contain an m3u8 URL"
            );
        }

   
        intro = normalizeSegment(
            data.intro
        );

        backdropImage =
            data.metadata?.backdropImage ||
            data.episode?.backdrop_image ||
            data.episode?.backdrop_img ||
            "";

        /*
         * Outro
         */
        outro = normalizeSegment(
            data.outro
        );

        subtitles =
            Array.isArray(data.subtitles)
                ? data.subtitles
                : [];


        setupPlayer(masterUrl);

    } catch (error) {

        const message =
            error &&
            error.message
                ? error.message
                : String(error);

        startBackupPlayer();

      
        postToParent({
            type: "error",
            message: message
        });
    }
}
            function initializePage() {
                initPlayer();
                
            }

            if (
                document.readyState === "loading"
            ) {
                document.addEventListener(
                    "DOMContentLoaded",
                    initializePage,
                    {
                        once: true
                    }
                );
            } else {
                initializePage();
            }
        })();
