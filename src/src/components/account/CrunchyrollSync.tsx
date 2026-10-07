"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, RefreshCw } from "lucide-react";
import { getUserId } from "@/lib/profile-store";
import { extractEtpRt, looksLikeEmail } from "@/lib/etprt";

/**
 * Crunchyroll sync card on the Profile screen.
 *
 * Crunchyroll has no public API and (since 2024) no password login for
 * outside apps either — their OAuth endpoint rejects every password grant
 * for every public client pair. The one reliable door is the session cookie
 * their own site sets (etp_rt). The viewer grabs that value once from their
 * logged-in browser and pastes it here; the paste can be the bare value, an
 * "etp_rt=…" fragment, or the whole Cookie header — we extract what we need.
 * The cookie is used once and never stored.
 */
export default function CrunchyrollSync() {
  const [open, setOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailHint, setEmailHint] = useState(false);

  async function sync() {
    if (busy) return;
    setError(null);
    setResult(null);
    setEmailHint(false);

    const etpRt = extractEtpRt(paste);
    if (!etpRt) {
      if (looksLikeEmail(paste)) {
        setEmailHint(true);
        setError(null);
      } else {
        setError("That doesn't look like the etp_rt cookie — follow the steps above and paste the value (or the whole cookie line).");
      }
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/crunchyroll/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ etpRt, userId: getUserId() }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        imported?: number;
        message?: string;
        error?: string;
        unmatched?: Array<{ seriesTitle: string }>;
      };
      if (!res.ok) {
        setError(data.error ?? "Sync failed — try again in a moment.");
      } else if ((data.imported ?? 0) > 0) {
        setResult(`Imported ${data.imported} episode${data.imported === 1 ? "" : "s"} from Crunchyroll — Continue Watching is up to date.`);
      } else {
        setResult(data.message ?? "Nothing new to import.");
      }
      if (data.unmatched?.length) {
        const names = [...new Set(data.unmatched.map((u) => u.seriesTitle))].slice(0, 4).join(", ");
        if (names) setResult((r) => `${r ?? ""} Not in Clyle yet: ${names}${data.unmatched!.length > 4 ? "…" : ""}`);
      }
      if (res.ok) setPaste("");
    } catch {
      setError("Sync failed — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-4 mt-3 rounded-xl bg-gradient-to-b from-[#1c1c1c] to-[#121212] border border-[#242424] overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <span className="flex-1">
          <span className="block text-[13px] font-bold uppercase tracking-wide text-gray-300">Crunchyroll</span>
          <span className="mt-0.5 block text-[12px] text-gray-500">Bring your Continue Watching from Crunchyroll</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-5 pb-5">
          {/* why there is no password box — the question everyone asks first */}
          <p className="rounded-lg bg-[#f47521]/10 border border-[#f47521]/20 px-3 py-2 text-[11.5px] leading-relaxed text-[#ffcf9e]">
            Crunchyroll doesn&apos;t let other sites log in with your email &amp; password — they block it for
            safety. This one-time cookie paste is the official-safe workaround: it reads your watch history
            <span className="text-[#f47521] font-semibold"> only</span>, once, and is never stored.
          </p>

          <ol className="mt-3 text-[12px] leading-relaxed text-gray-400 space-y-1">
            <li>
              1.{" "}
              <a
                href="https://www.crunchyroll.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-[#f47521] hover:underline"
              >
                Log in to crunchyroll.com <ExternalLink className="w-3 h-3" />
              </a>{" "}
              (in another tab)
            </li>
            <li>
              2. Press <span className="text-gray-200">F12</span> → <span className="text-gray-200">Application</span> →{" "}
              <span className="text-gray-200">Cookies</span> → crunchyroll.com
            </li>
            <li>
              3. Copy the row named <span className="text-gray-200 font-mono">etp_rt</span> and paste it below — the bare
              value, or even the whole cookie line, both work
            </li>
          </ol>

          <div className="mt-3 flex items-start gap-2">
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={2}
              placeholder={"etp_rt cookie value — or paste the whole Cookie:\netp_rt=abc123…; session=…"}
              className="flex-1 bg-[#101010] border border-[#2c2c2c] rounded-md px-2.5 py-2 text-[12px] outline-none font-mono resize-y min-h-[52px]"
              aria-label="Crunchyroll etp_rt cookie"
            />
            <button
              onClick={sync}
              disabled={busy || !paste.trim()}
              className="shrink-0 flex items-center gap-1.5 rounded-md bg-[#f47521] hover:bg-[#d96418] px-3 py-2 text-[12px] font-bold text-black transition active:scale-95 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
              {busy ? "Syncing…" : "Sync"}
            </button>
          </div>

          {emailHint && (
            <p className="mt-2 rounded-lg bg-[#fdd835]/10 border border-[#fdd835]/25 px-3 py-2 text-[12px] text-[#ffe082]">
              That&apos;s an email address — Crunchyroll blocks password sign-ins from outside sites, so there&apos;s
              nothing to type it into. Use the <span className="font-semibold">etp_rt cookie</span> from the steps above
              instead: it proves you&apos;re logged in without sharing your password.
            </p>
          )}
          <p className="mt-2 text-[10.5px] text-gray-600">
            The cookie is used once to read your watch history and is never stored.
          </p>
          {result && <p className="mt-2 rounded-lg bg-[#2e7d32]/15 px-3 py-2 text-[12px] text-[#8ef2a0]">{result}</p>}
          {error && <p className="mt-2 rounded-lg bg-[#d32f2f]/15 px-3 py-2 text-[12px] text-[#ff8a80]">{error}</p>}
        </div>
      )}
    </section>
  );
}
