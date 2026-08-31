"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, Download, Pencil, Trash2, Tv } from "lucide-react";
import type { ContinueItem } from "@/lib/types";
import { loadContinueItems, removeProgress, timeAgo, useProgressVersion } from "@/lib/client-store";
import { fileToAvatarDataUrl, useProfile, useSaveProfile } from "@/lib/profile-store";

/** Themed profile page: avatar from your own photos, nickname, watch stats. */
export default function ProfileView({
  onResume,
}: {
  onResume: (item: ContinueItem) => void;
}) {
  const { profile } = useProfile();
  const save = useSaveProfile();
  const progressVersion = useProgressVersion();

  const fileRef = useRef<HTMLInputElement>(null);
  const [nickname, setNickname] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [recent, setRecent] = useState<ContinueItem[]>([]);

  // hydrate fields once the local profile exists
  useEffect(() => {
    if (profile) setNickname(profile.nickname);
  }, [profile?.id]);

  // pull the freshest in-progress list (server merged with local) so the
  // section survives fresh storage; re-runs whenever progress changes
  const refreshRecent = async () => {
    setRecent(await loadContinueItems());
  };

  useEffect(() => {
    if (profile?.id) void refreshRecent();
  }, [profile?.id, progressVersion]);

  // watch stats across every anime (from the local detailed progress map)
  const stats = useMemo(() => {
    let episodes = 0;
    let minutes = 0;
    let animeCount = 0;
    try {
      const all = JSON.parse(window.localStorage.getItem("animetest123.epprogress") ?? "{}") as Record<
        string,
        Record<string, { pos: number; dur: number }>
      >;
      for (const eps of Object.values(all)) {
        if (!Object.keys(eps).length) continue;
        animeCount += 1;
        for (const e of Object.values(eps)) {
          episodes += 1;
          minutes += Math.round((e.pos || 0) / 60);
        }
      }
    } catch {
      /* ignore */
    }
    return { episodes, minutes, animeCount };
  }, [progressVersion]);

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      await save({ avatar: dataUrl });
    } catch (e) {
      setAvatarError(e instanceof Error ? e.message : "Could not use that photo");
    } finally {
      setAvatarBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveNickname() {
    if (saving) return;
    setSaving(true);
    try {
      await save({ nickname });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } finally {
      setSaving(false);
    }
  }

  const initial = (profile?.nickname ?? "O").trim().charAt(0).toUpperCase() || "O";

  return (
    <div className="pb-24 min-h-screen">
      <header className="px-4 pt-5 pb-2">
        <h1 className="font-slab text-[24px] font-bold">Profile</h1>
        <p className="text-[12px] text-gray-400">Your nickname, photo and watch history on this device</p>
      </header>

      {/* identity card */}
      <section className="mx-4 mt-3 rounded-xl bg-gradient-to-b from-[#1c1c1c] to-[#121212] border border-[#242424] p-5">
        <div className="flex items-center gap-4">
          <button
            onClick={() => fileRef.current?.click()}
            className="relative shrink-0 active:scale-95 transition"
            aria-label="Change profile picture"
          >
            {profile?.avatar ? (
              <img
                src={profile.avatar}
                alt={`${profile.nickname} avatar`}
                className="w-20 h-20 rounded-full object-cover border-2 border-[#d32f2f]"
              />
            ) : (
              <span className="w-20 h-20 rounded-full bg-[#2a2a2a] border-2 border-[#d32f2f] flex items-center justify-center font-slab text-[30px] font-extrabold text-white">
                {initial}
              </span>
            )}
            <span className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-[#d32f2f] flex items-center justify-center shadow-lg">
              <Camera className="w-3.5 h-3.5 text-white" />
            </span>
            {avatarBusy ? (
              <span className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
                <span className="w-6 h-6 border-2 border-[#d32f2f] border-t-transparent rounded-full animate-spin" />
              </span>
            ) : null}
          </button>

          <div className="flex-1 min-w-0">
            <label className="text-[10.5px] uppercase tracking-wide text-gray-400 font-bold">Nickname</label>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex items-center flex-1 bg-[#101010] border border-[#2c2c2c] rounded-md px-2.5">
                <Pencil className="w-3.5 h-3.5 text-gray-500 mr-2 shrink-0" />
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value.slice(0, 24))}
                  maxLength={24}
                  placeholder="Your nickname"
                  className="w-full bg-transparent py-2 text-[14px] outline-none"
                  aria-label="Nickname"
                />
              </div>
              <button
                onClick={saveNickname}
                disabled={saving || !nickname.trim()}
                className={`shrink-0 rounded-md px-3 py-2 text-[12px] font-bold transition active:scale-95 ${
                  savedFlash ? "bg-[#2e7d32] text-white" : "bg-[#d32f2f] hover:bg-[#b71c1c] text-white disabled:opacity-50"
                }`}
                aria-label="Save nickname"
              >
                {savedFlash ? <Check className="w-4 h-4" /> : saving ? "…" : "Save"}
              </button>
            </div>
            {avatarError ? <p className="mt-1.5 text-[11px] text-[#ff8a80]">{avatarError}</p> : null}
            <p className="mt-1.5 text-[10.5px] text-gray-500">Tap the avatar to use one of your own photos</p>
          </div>
        </div>

        {/* stats — same red/black theme */}
        <div className="grid grid-cols-3 gap-2 mt-5">
          <Stat label="Episodes" value={stats.episodes} />
          <Stat label="Anime" value={stats.animeCount} />
          <Stat label="Minutes" value={stats.minutes} />
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pickAvatar(e.target.files?.[0])}
          aria-hidden="true"
        />
      </section>

      {/* install to home screen (PWA) */}
      <InstallAppCard />

      {/* continue watching management */}
      <section className="mt-6">
        <h2 className="font-slab text-[19px] font-bold px-4 mb-2 flex items-center gap-2">
          <Tv className="w-[18px] h-[18px] text-[#ff5252]" /> Continue Watching
        </h2>
        {recent.length === 0 ? (
          <p className="px-4 text-[12.5px] text-gray-500">Nothing here yet — start an episode and it will show up.</p>
        ) : (
          <ul className="px-4 space-y-2">
            {recent.map((item) => (
              <li key={item.malId} className="flex items-center gap-3 bg-[#161616] rounded-lg p-2">
                <button
                  onClick={() => onResume(item)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left active:scale-[0.99] transition"
                >
                  {item.image ? (
                    <img src={item.image} alt="" className="w-[52px] h-[70px] object-cover rounded-md bg-[#222]" />
                  ) : (
                    <span className="w-[52px] h-[70px] rounded-md bg-[#222]" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-bold truncate">{item.title}</span>
                    <span className="block text-[11.5px] text-gray-400 mt-0.5">
                      EP {item.episode} · {item.percent}% · {timeAgo(item.updatedAt)}
                    </span>
                    <span className="block mt-1.5 h-[3px] rounded-full bg-white/10 overflow-hidden">
                      <span className="block h-full bg-[#d32f2f] rounded-full" style={{ width: `${item.percent}%` }} />
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    removeProgress(item.malId);
                    setRecent((r) => r.filter((x) => x.malId !== item.malId));
                  }}
                  className="p-2 text-gray-500 hover:text-[#ff5252] active:scale-95 transition"
                  aria-label={`Remove ${item.title} from Continue Watching`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="px-4 mt-8 text-[11px] text-gray-600 leading-relaxed">
        No account needed — your profile lives on this device and syncs your progress to the server so episodes pick
        up right where you left off.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-[#101010] border border-[#242424] py-3 text-center">
      <div className="font-slab text-[20px] font-extrabold text-[#ff5252] tabular-nums">{value}</div>
      <div className="text-[10.5px] text-gray-400 mt-0.5">{label}</div>
    </div>
  );
}

/**
 * "Install app" — turns the site into a home-screen app (standalone window,
 * its own icon, no browser bars). Android/Chrome get a real one-tap install
 * via beforeinstallprompt; iOS Safari has no programmatic install, so we show
 * the exact manual steps instead.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function InstallAppCard() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // window-only detection (SSR has no navigator/matchMedia) — setState in an
    // effect is intentional and safe here; it runs once after mount.
    /* eslint-disable react-hooks/set-state-in-effect */
    const ios = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    setIsIOS(ios);
    const standalone =
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (standalone) setInstalled(true);
    /* eslint-enable react-hooks/set-state-in-effect */

    const onPrompt = (e: Event) => {
      e.preventDefault(); // Chrome requires us to decide later
      setDeferred(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) {
    return (
      <section className="mx-4 mt-4 rounded-xl bg-[#121212] border border-[#1f3a1f] p-3.5 flex items-center gap-2.5">
        <Check className="w-[18px] h-[18px] text-[#4caf50] shrink-0" />
        <p className="text-[12.5px] text-gray-300">
          <span className="font-bold text-white">Installed</span> — you&apos;re running the home-screen app.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-4 mt-4 rounded-xl bg-[#121212] border border-[#242424] p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="w-9 h-9 rounded-lg bg-[#d32f2f]/15 border border-[#d32f2f]/40 flex items-center justify-center shrink-0">
          <Download className="w-[18px] h-[18px] text-[#ff5252]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-gray-100">Install AnimeTest123</p>
          <p className="text-[11.5px] text-gray-400 mt-0.5 leading-relaxed">
            Add it to your home screen — full-screen playback, its own icon, like a real app.
          </p>

          {deferred ? (
            <button
              onClick={async () => {
                try {
                  await deferred.prompt();
                  const choice = await deferred.userChoice;
                  if (choice.outcome === "accepted") setInstalled(true);
                  setDeferred(null);
                } catch {
                  /* user dismissed the native dialog */
                }
              }}
              className="mt-2.5 bg-[#d32f2f] hover:bg-[#b71c1c] text-white text-[12px] font-bold rounded-full px-4 py-2 transition active:scale-95"
            >
              Install now
            </button>
          ) : (
            <ol className="mt-2 text-[11px] text-gray-400 leading-relaxed list-decimal ml-4 space-y-0.5">
              {isIOS ? (
                <>
                  <li>
                    Tap the <span className="text-gray-200 font-bold">Share</span> button in Safari&apos;s toolbar
                  </li>
                  <li>
                    Choose <span className="text-gray-200 font-bold">&ldquo;Add to Home Screen&rdquo;</span>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    Open the browser menu <span className="text-gray-200 font-bold">(⋮)</span>
                  </li>
                  <li>
                    Choose <span className="text-gray-200 font-bold">&ldquo;Add to Home screen&rdquo;</span> / &ldquo;Install
                    app&rdquo;
                  </li>
                </>
              )}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------- helpers ---------- */
