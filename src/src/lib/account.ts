"use client";

/**
 * The progress-tracking account file.
 *
 * Anonymous viewers already get full progress tracking under a device UUID
 * (profile-store). Signing in with Google flips the ACTIVE profile record to
 * "google:<sub>" — but that would orphan everything the device had watched.
 * So the sign-in moment does a one-time merge:
 *
 *   1. back up the anonymous profile (sign-out restores it — the device's
 *      anonymous identity survives the visit)
 *   2. copy every WatchProgress row from the anonymous id onto the Google id
 *      (GET /api/progress/all?userId=<anon> -> POST /api/progress per row)
 *   3. flip the active profile record — every getUserId() consumer (heart-
 *      beats, continue-watching, comments) follows automatically
 *   4. reload once so every mounted view refetches under the new identity
 *
 * Signing out hands the device back to the anonymous identity: the Google
 * account keeps its progress in the cloud; the next sign-in on ANY device
 * re-copies that device's anonymous rows on top.
 */
import { readProfile, replaceProfile, type Profile } from "@/lib/profile-store";

const BACKUP_KEY = "animetest123.backupProfile";
const SYNCED_FLAG = "animetest123.syncedFor";

function backupAnonProfile(): void {
  const p = readProfile();
  if (!p || p.id.startsWith("google:")) return; // nothing anonymous to keep
  try {
    window.localStorage.setItem(BACKUP_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked */
  }
}

function restoreAnonProfile(): void {
  try {
    const raw = window.localStorage.getItem(BACKUP_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Profile;
      if (p?.id && !p.id.startsWith("google:")) {
        replaceProfile(p);
        return;
      }
    }
  } catch {
    /* fall through */
  }
  replaceProfile(null); // no backup — mint a fresh anonymous identity
}

/** Copy the anonymous device rows onto the signed-in identity. */
async function copyProgressRows(fromId: string, toId: string): Promise<number> {
  let copied = 0;
  try {
    const res = await fetch(`/api/progress/all?userId=${encodeURIComponent(fromId)}`, { cache: "no-store" });
    const data = (await res.json()) as {
      rows?: Array<{ malId: number; episode: number; lang: string; server: string; position: number; duration: number; completed: boolean; title?: string | null; image?: string | null }>;
    };
    for (const row of data.rows ?? []) {
      const r = await fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...row, userId: toId }),
      }).catch(() => null);
      if (r && r.ok) copied++;
    }
  } catch {
    /* network hiccup — the rows stay under the anon id and will re-merge on
       the next sign-in on this device */
  }
  return copied;
}

/**
 * Called by AccountSync when the session says "signed in" but the active
 * local profile is still anonymous (or a DIFFERENT Google account). Idempotent
 * per session: the SYNCED_FLAG records which google id already merged, so a
 * reload storm can't copy rows twice.
 */
export async function syncAccountOnSignIn(user: { id: string; nickname: string; avatar: string | null }): Promise<void> {
  let alreadySynced = false;
  try {
    alreadySynced = window.localStorage.getItem(SYNCED_FLAG) === user.id;
  } catch {
    /* storage blocked — treat as not synced */
  }
  const active = readProfile();
  const activeIsThisAccount = active?.id === user.id;
  const activeIsOtherGoogle = !!active?.id.startsWith("google:") && active.id !== user.id;
  if (alreadySynced && activeIsThisAccount) return;

  // Back up the device's anonymous identity once (never overwrite a backup
  // with another google profile).
  backupAnonProfile();

  // The anonymous id whose rows should merge: the profile we were BEFORE the
  // flip. If the device is currently riding another google identity, its
  // backup is the real anonymous source.
  let anonId: string | null = null;
  if (!active) {
    anonId = null; // fresh device — nothing to merge
  } else if (activeIsOtherGoogle) {
    try {
      const raw = window.localStorage.getItem(BACKUP_KEY);
      anonId = raw ? ((JSON.parse(raw) as Profile).id ?? null) : null;
    } catch {
      anonId = null;
    }
  } else {
    anonId = active.id;
  }

  if (anonId && anonId !== user.id && !alreadySynced) {
    await copyProgressRows(anonId, user.id);
  }

  // Flip the active record + remember the merge for this account.
  replaceProfile({
    id: user.id,
    nickname: user.nickname || active?.nickname || "Username",
    avatar: user.avatar ?? active?.avatar ?? null,
  });
  try {
    window.localStorage.setItem(SYNCED_FLAG, user.id);
  } catch {
    /* storage blocked */
  }

  // One reload so every mounted view refetches under the cloud identity.
  if (!alreadySynced) window.location.reload();
}

/** Called on sign-out: hand the device back to its anonymous identity. */
export function restoreAccountOnSignOut(): void {
  try {
    window.localStorage.removeItem(SYNCED_FLAG);
  } catch {
    /* storage blocked */
  }
  restoreAnonProfile();
}
