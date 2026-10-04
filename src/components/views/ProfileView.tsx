"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, Pencil, Settings as SettingsIcon } from "lucide-react";
import { fileToAvatarDataUrl, useProfile, useSaveProfile } from "@/lib/profile-store";

/**
 * The Profile page — deliberately minimal (user ask): only the identity
 * itself, i.e. your avatar and a way to change your name. No watch stats,
 * no Continue-Watching list below — progress lives on the home rail and its
 * management lives in Settings → Storage; install lives in Settings → App.
 */
export default function ProfileView({ onSettings }: { onSettings: () => void }) {
  const { profile } = useProfile();
  const save = useSaveProfile();

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
    </div>
  );
}
