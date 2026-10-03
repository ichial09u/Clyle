import { NextResponse } from "next/server";
import { pushPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * GET /api/push/key — the VAPID public key the browser must supply when it
 * creates its push subscription (pushManager.subscribe's applicationServerKey).
 */
export async function GET() {
  return NextResponse.json(
    { publicKey: pushPublicKey() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
