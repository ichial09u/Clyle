"use client";

/**
 * Viewer profile — no accounts, no passwords.
 *
 * The first visit generates a UUID that lives in localStorage; nickname and
 * avatar (a small 160x160 JPEG data-URL the client builds from the user's own
 * photo) are mirrored to the server so comments show who you are.
 */

import { useCallback, useSyncExternalStore } from "react";

const USER_KEY = "animetest123.user";

export interface Profile {
  id: string;
  nickname: string;
  avatar: string | null;
}

export function readProfile(): Profile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

function writeProfile(p: Profile) {
  try {
    window.localStorage.setItem(USER_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked — profile stays in memory only */
  }
  window.dispatchEvent(new CustomEvent("profile-changed"));
}

/** Get (or lazily create) the local identity + default nickname. */
export function getUserId(): string {
  let p = readProfile();
  if (!p) {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `u-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    p = { id, nickname: "Username", avatar: null };
    writeProfile(p);
    // register on the server in the background (best effort)
    fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: id, nickname: p.nickname }),
    }).catch(() => undefined);
  }
  return p.id;
}

const sub = (cb: () => void) => {
  window.addEventListener("profile-changed", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("profile-changed", cb);
    window.removeEventListener("storage", cb);
  };
};
const snapshot = () => window.localStorage.getItem(USER_KEY) ?? "null";
const serverSnapshot = () => "null";

/** Reactive profile; null until mounted on the client. */
export function useProfile(): { profile: Profile | null; ready: boolean } {
  const raw = useSyncExternalStore(sub, snapshot, serverSnapshot);
  let profile: Profile | null = null;
  try {
    profile = raw && raw !== "null" ? (JSON.parse(raw) as Profile) : null;
  } catch {
    profile = null;
  }
  return { profile, ready: true };
}

/** Replace the entire active profile record (used by the Google sign-in
 * sync: the active id flips to "google:<sub>" and every getUserId()
 * consumer follows). null clears the record; the next getUserId() mints a
 * fresh anonymous one. */
export function replaceProfile(p: Profile | null) {
  try {
    if (p) window.localStorage.setItem(USER_KEY, JSON.stringify(p));
    else window.localStorage.removeItem(USER_KEY);
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new CustomEvent("profile-changed"));
}

/** Save nickname/avatar locally + push to the server (avatar null clears it). */
export function useSaveProfile() {
  return useCallback(async (patch: { nickname?: string; avatar?: string | null }) => {
    const current = readProfile();
    const id = getUserId();
    const next: Profile = {
      id,
      nickname: (patch.nickname ?? current?.nickname ?? "Username").replace(/\s+/g, " ").trim().slice(0, 24) || "Username",
      avatar: patch.avatar !== undefined ? patch.avatar : current?.avatar ?? null,
    };
    writeProfile(next);
    try {
      await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: id, nickname: next.nickname, avatar: next.avatar }),
      });
    } catch {
      /* offline — local copy already updated, server sync retries next save */
    }
    return next;
  }, []);
}

/**
 * Turn a user-chosen photo into a small square avatar data-URL
 * (160x160 center-crop JPEG, ~15-40 KB) entirely on the client.
 */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Not an image");
  if (file.size > 12_000_000) throw new Error("Image too large (max ~12 MB)");

  const bmp = await loadBitmap(file);
  const S = 160;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  // center-crop cover
  const side = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - side) / 2;
  const sy = (bmp.height - side) / 2;
  ctx.drawImage(bmp as CanvasImageSource, sx, sy, side, side, 0, 0, S, S);
  if ("close" in bmp && typeof bmp.close === "function") bmp.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Could not read image"));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }
}
