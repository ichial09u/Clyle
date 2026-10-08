import { NextResponse } from "next/server";

// TEMPORARY debug probe — fetches an ANN encyclopedia URL server-side and
// returns the raw body so param shapes can be inspected from production.
// Removed right after the reports.xml parameter question is settled.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get("u") ?? "";
  if (!u.startsWith("https://cdn.animenewsnetwork.com/")) {
    return NextResponse.json({ error: "bad url" }, { status: 400 });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": "ClyleApp/1.0 (anime tracker panel)", Accept: "application/xml, text/xml, */*" },
      signal: ac.signal,
      cache: "no-store",
    });
    const text = await res.text();
    return new NextResponse(text.slice(0, 4000), {
      status: res.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
