"use client";

/* Last-resort boundary: if the root layout itself throws, this standalone
   document still renders with inlined styles (the global CSS may not have
   loaded) so the user never sees a raw white screen. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // production client stacks otherwise vanish beyond the digest line
  if (typeof console !== "undefined") console.error("[Clyle] global render error:", error);
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#000", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>Clyle hit a snag</h1>
          <p style={{ fontSize: 13.5, color: "#9ca3af", maxWidth: 340, margin: "0 0 20px" }}>
            The app failed to start. Reloading usually fixes it.
          </p>
          <button
            onClick={reset}
            style={{ background: "#fff", color: "#000", border: "none", borderRadius: 999, fontSize: 13.5, fontWeight: 600, padding: "10px 20px", cursor: "pointer" }}
          >
            Reload Clyle
          </button>
        </div>
      </body>
    </html>
  );
}
