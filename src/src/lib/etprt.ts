/**
 * etp_rt extraction — shared by the Crunchyroll sync UI and the sync API.
 *
 * Viewers rarely paste JUST the cookie value: they copy the whole Cookie
 * header, a devtools request blob, or a "etp_rt=…" fragment. Accept all of
 * it — pull the token out of whatever lands in the box so the sync "just
 * works" on the first paste.
 */
export function extractEtpRt(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  // etp_rt=… / etp_rt: … inside a cookie header, cURL command, or headers blob
  const m = s.match(/etp_rt\s*[=:]\s*"?([A-Za-z0-9_\-~.%]{16,})"?/i);
  if (m) return m[1];
  // a bare token (the etp_rt value's charset — long opaque string)
  if (/^[A-Za-z0-9_\-~.%]{16,}$/.test(s)) return s;
  return null;
}

/** Did the viewer paste an email? (They tried to "sign in" — see the UI explainer.) */
export function looksLikeEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((input || "").trim());
}
