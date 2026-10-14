"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, LogOut, MoveRight, Pencil, Settings as SettingsIcon } from "lucide-react";
import { fileToAvatarDataUrl, useProfile, useSaveProfile, getUserId } from "@/lib/profile-store";
import { getMyListMalIds } from "@/lib/client-store";
import { restoreAccountOnSignOut } from "@/lib/account";
import { fetchSession } from "@/components/account/AccountSync";
import { buildTransferUrl, isTransferTarget } from "@/lib/transfer";

/**
 * The Profile page — deliberately minimal (user ask): only the identity
 * itself, i.e. your avatar and a way to change your name. No watch stats,
 * no Continue-Watching list below — progress lives on the home rail and its
 * management lives in Settings → Storage; install lives in Settings → App.
 */
export default function ProfileView({ onSettings }: { onSettings: () => void }) {
  const { profile } = useProfile();
  const save = useSaveProfile();

  // Google session (account card)
  const [session, setSession] = useState<Awaited<ReturnType<typeof fetchSession>> | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchSession().then((s) => alive && setSession(s));
    return () => {
      alive = false;
    };
  }, [profile?.id]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/signout", { method: "POST" });
      restoreAccountOnSignOut();
      setSession({ configured: session?.configured ?? true, user: null });
    } finally {
      setSigningOut(false);
    }
  }

  const fileRef = useRef<HTMLInputElement>(null);
  const [nickname, setNickname] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // hydrate fields once the local profile exists
  useEffect(() => {
    if (profile) setNickname(profile.nickname);
  }, [profile?.id]);

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
    <div className="pb-24 min-h-screen lg:max-w-[860px] lg:mx-auto">
      <header className="px-4 pt-5 pb-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-slab text-[24px] font-bold">Profile</h1>
          <p className="text-[12px] text-gray-400">Your name and photo on this device</p>
        </div>
        <button
          onClick={onSettings}
          aria-label="Open settings"
          className="shrink-0 flex items-center gap-1.5 rounded-full bg-[#1d1d1d] border border-white/10 pl-3 pr-3.5 py-2 text-[12.5px] font-semibold text-gray-200 hover:bg-[#282828] active:scale-95 transition"
        >
          <SettingsIcon className="w-4 h-4" />
          Settings
        </button>
      </header>

      {/* identity card — the whole page */}
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

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => pickAvatar(e.target.files?.[0])}
          aria-hidden="true"
        />
      </section>

      {/* cross-site transfer — only on mirror deployments, only while anonymous
          (signed-in viewers are already portable through their account) */}
      {session !== null && !session.user && !isTransferTarget() ? (
        <section className="mx-4 mt-3 rounded-xl bg-gradient-to-b from-[#1c1c1c] to-[#121212] border border-[#242424] p-5">
          <span className="text-[13px] font-bold uppercase tracking-wide text-gray-300">Move to the main site</span>
          <p className="mt-3 text-[12.5px] leading-relaxed text-gray-400">
            You&apos;re on a mirror site. One tap moves your Continue Watching and My List to the
            main Clyle site — no account needed, nothing is deleted here.
          </p>
          <button
            onClick={() => {
              window.location.href = buildTransferUrl(getUserId(), getMyListMalIds());
            }}
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-[#d32f2f] px-4 text-[13px] font-semibold text-white transition hover:bg-[#b71c1c] active:scale-[0.98]"
          >
            <MoveRight className="w-4 h-4" />
            Move my progress
          </button>
        </section>
      ) : null}

      {/* Google account card — sign in to track progress in the cloud */}
      <section className="mx-4 mt-3 rounded-xl bg-gradient-to-b from-[#1c1c1c] to-[#121212] border border-[#242424] p-5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-bold uppercase tracking-wide text-gray-300">Account</span>
          {session?.user ? (
            <span className="rounded-full bg-[#2e7d32]/20 px-2 py-0.5 text-[10.5px] font-bold text-[#8ef2a0]">Progress syncing</span>
          ) : (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10.5px] font-bold text-gray-400">On this device only</span>
          )}
        </div>
        {session?.user ? (
          <div className="mt-3 flex items-center gap-3">
            {session.user.avatar ? (
              <img src={session.user.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
            ) : (
              <span className="w-10 h-10 rounded-full bg-[#2a2a2a] flex items-center justify-center text-[15px] font-bold">
                {(session.user.nickname || "G").charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold">{session.user.nickname}</p>
              <p className="truncate text-[11.5px] text-gray-500">{session.user.email ?? "Signed in with Google"}</p>
            </div>
            <button
              onClick={signOut}
              disabled={signingOut}
              className="shrink-0 flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#191919] px-3 py-2 text-[12px] font-semibold text-gray-300 transition hover:bg-[#242424] active:scale-95 disabled:opacity-50"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-[12.5px] leading-relaxed text-gray-400">
              Sign in with Google and your Continue Watching syncs to your account — same shows,
              same episode, same second, on every device you sign in on.
            </p>
            <a
              href="/signin"
              className="mt-3 inline-flex h-10 items-center gap-2.5 rounded-lg bg-white px-4 text-[13px] font-semibold text-gray-900 transition hover:bg-gray-100 active:scale-[0.98]"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
                <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
                <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
                <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1Z" />
                <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.6 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76Z" />
              </svg>
              Continue with Google
            </a>
            {!session?.configured && session !== null ? (
              <p className="mt-2 text-[11px] text-gray-600">Server isn&apos;t set up for Google sign-in yet.</p>
            ) : null}
          </div>
        )}
      </section>

    </div>
  );
}
