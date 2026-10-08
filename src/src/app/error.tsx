"use client";

/* Global error boundary — a render crash anywhere in the SPA used to mean a
   permanent white screen. This catches it, explains it, and offers a way
   back that doesn't lose the tab. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // production client stacks otherwise vanish beyond the digest line
  if (typeof console !== "undefined") console.error("[Clyle] render error:", error);
  return (
    <main className="min-h-dvh bg-black text-white flex flex-col items-center justify-center px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-[#141414] border border-white/10 flex items-center justify-center mb-4">
        <svg viewBox="0 0 24 24" className="w-7 h-7 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="font-slab text-[22px] font-bold mb-1.5">Something broke</h1>
      <p className="text-[13px] text-gray-400 max-w-[340px] mb-5">
        An unexpected error interrupted the app. Retrying usually fixes it — your watch progress and list are safe.
      </p>
      <div className="flex items-center gap-3">
        <button
          onClick={reset}
          className="rounded-full bg-white text-black text-[13.5px] font-semibold px-5 py-2.5 hover:opacity-90 active:scale-95 transition"
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          className="rounded-full border border-white/15 bg-white/5 text-[13.5px] font-medium px-5 py-2.5 hover:bg-white/10 active:scale-95 transition"
        >
          Reload Clyle
        </button>
      </div>
      {error.digest ? (
        <p className="mt-6 text-[10.5px] text-gray-600 select-all">ref: {error.digest}</p>
      ) : null}
    </main>
  );
}
