"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * /signin — the Google sign-in page.
 *
 * Opt-in by design: anonymous viewers keep their device-local progress, so
 * this page only ever explains WHAT signing in adds (progress follows you to
 * any device) and never blocks watching. When the OAuth client isn't
 * configured yet the page says so honestly instead of a dead button.
 *
 * ?error=... lands here from the OAuth callback (access denied, state
 * mismatch, exchange failure) — rendered as a friendly line, never a stack.
 */
const ERROR_TEXT: Record<string, string> = {
  denied: "Sign-in was cancelled — no worries, you can keep watching anonymously.",
  missing_code: "The sign-in round trip came back incomplete. Please try again.",
  bad_state: "That sign-in link expired (it's only valid for 10 minutes). Please try again.",
  exchange_failed: "Google didn't complete the handshake. Please try again in a moment.",
  not_configured: "Google sign-in isn't set up on the server yet.",
  access_denied: "Sign-in was cancelled — no worries, you can keep watching anonymously.",
};

export default function SignInPage() {
  const [configured, setConfigured] = useState<boolean | null>(null); // null = checking
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(new URLSearchParams(window.location.search).get("error"));
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { configured?: boolean }) => setConfigured(!!d.configured))
      .catch(() => setConfigured(false));
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-black px-6 text-white">
      <div className="w-full max-w-sm">
        <h1 className="font-slab text-4xl font-extrabold tracking-tight">
          Clyle<span className="text-rose-500">.</span>
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-gray-400">
          Sign in with Google to keep your Continue Watching on every device you use.
        </p>
        <ul className="mt-4 space-y-1.5 text-[13px] text-gray-500">
          <li>• Your progress syncs automatically while you watch</li>
          <li>• What you watched on this device comes with you</li>
          <li>• No password here — Google handles the sign-in</li>
        </ul>

        {error && (
          <p className="mt-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-300">
            {ERROR_TEXT[error] ?? "Something went wrong with sign-in. Please try again."}
          </p>
        )}

        {configured === false && (
          <p className="mt-5 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-[13px] text-gray-400">
            Google sign-in isn&apos;t configured on the server yet — the owner still needs to add
            the OAuth client credentials. Your progress keeps tracking on this device in the
            meantime.
          </p>
        )}

        <a
          href="/api/auth/google"
          aria-disabled={configured === false}
          className={`mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-white font-medium text-gray-900 transition active:scale-[0.98] ${
            configured === false ? "pointer-events-none opacity-50" : "hover:bg-gray-100"
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
            <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.07.72-2.44 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
            <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28v-3.1H1.29a12 12 0 0 0 0 10.76l3.98-3.1Z" />
            <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.6 4.58 1.8l3.44-3.44A11.98 11.98 0 0 0 12 0 12 12 0 0 0 1.29 6.62l3.98 3.1C6.22 6.87 8.87 4.76 12 4.76Z" />
          </svg>
          Continue with Google
        </a>

        <Link href="/" className="mt-4 block text-center text-[13px] text-gray-500 transition hover:text-gray-300">
          Not now — keep watching
        </Link>
      </div>
    </main>
  );
}
