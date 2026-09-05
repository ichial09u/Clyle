import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Bug-patrol fleet API — the server half of the 24/7 patrol bots that crawl
 * the site like a real user and file every breakage they find as one deduped
 * BugReport row per (kind, targetKey):
 *
 *   - re-observing an open finding bumps `count` + `lastSeen` (no spam)
 *   - re-observing a FIXED finding flips it back to open = REGRESSION ALARM
 *     (the fix stopped working)
 *
 *   GET  ?token=T                       -> triage list (open findings first,
 *                                          then recently-fixed for regression
 *                                          watch), plus rolling counters
 *   POST ?token=T  { findings: [...] }  -> ingest observations:
 *        { kind, targetKey, severity?, detail? }
 *   POST ?token=T  { resolve: targetKey, kind, note? }
 *                                      -> mark a finding fixed (with note)
 */
const TOKEN = process.env.SCOUT_TOKEN ?? "clyle-scout-v1";

const KINDS = new Set([
  "api-error",
  "api-slow",
  "api-shape",
  "page-broken",
  "stream-broken",
  "dub-claim-mismatch",
  "data-consistency",
  "art-broken",
]);

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (token !== TOKEN) return NextResponse.json({ error: "bad token" }, { status: 401 });

  const [open, fixed] = await Promise.all([
    db.bugReport.findMany({
      where: { status: "open" },
      orderBy: [{ severity: "asc" }, { lastSeen: "desc" }],
      take: 100,
    }),
    db.bugReport.findMany({
      where: { status: "fixed" },
      orderBy: { lastSeen: "desc" },
      take: 50,
    }),
  ]);

  const byKind: Record<string, number> = {};
  for (const b of open) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;

  return NextResponse.json(
    {
      open,
      fixed,
      summary: { openCount: open.length, byKind },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "bad token" }, { status: 401 });
  }

  let body: {
    findings?: Array<{ kind: string; targetKey: string; severity?: number; detail?: string }>;
    resolve?: { kind: string; targetKey: string; note?: string };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  // ---- resolve (mark fixed, with an explanatory note) ----
  if (body.resolve) {
    const { kind, targetKey, note } = body.resolve;
    if (!kind || !targetKey) return NextResponse.json({ error: "kind+targetKey required" }, { status: 400 });
    const existing = await db.bugReport.findUnique({ where: { kind_targetKey: { kind, targetKey } } });
    if (!existing) return NextResponse.json({ ok: true, note: "nothing to resolve" });
    await db.bugReport.update({
      where: { id: existing.id },
      data: { status: "fixed", detail: (note ? `fixed: ${note}` : existing.detail ?? "fixed").slice(0, 500) },
    });
    return NextResponse.json({ ok: true });
  }

  // ---- ingest observations ----
  const findings = Array.isArray(body.findings) ? body.findings.slice(0, 200) : [];
  let ingested = 0;
  let reopened = 0;

  for (const f of findings) {
    if (!f?.kind || !f?.targetKey || !KINDS.has(f.kind)) continue;
    const existing = await db.bugReport.findUnique({
      where: { kind_targetKey: { kind: f.kind, targetKey: f.targetKey } },
    });

    if (!existing) {
      await db.bugReport.create({
        data: {
          kind: f.kind,
          targetKey: f.targetKey.slice(0, 300),
          severity: Number.isFinite(f.severity) ? Math.min(3, Math.max(1, f.severity as number)) : 2,
          detail: f.detail?.slice(0, 500),
          status: "open",
          count: 1,
        },
      });
      ingested++;
      continue;
    }

    if (existing.status === "fixed") {
      // REGRESSION: a finding we already fixed came back — reopen loudly
      await db.bugReport.update({
        where: { id: existing.id },
        data: {
          status: "open",
          count: existing.count + 1,
          lastSeen: new Date(),
          detail: `REOPENED: ${f.detail?.slice(0, 400) ?? existing.detail ?? "re-observed after fix"}`,
        },
      });
      reopened++;
      continue;
    }

    if (existing.status === "ignored") continue;

    await db.bugReport.update({
      where: { id: existing.id },
      data: {
        count: existing.count + 1,
        lastSeen: new Date(),
        detail: f.detail?.slice(0, 500) ?? existing.detail,
      },
    });
    ingested++;
  }

  return NextResponse.json({ ok: true, ingested, reopened });
}
