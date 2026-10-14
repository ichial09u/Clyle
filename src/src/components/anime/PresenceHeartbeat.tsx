"use client";

import { useEffect } from "react";
import { ensurePresenceHeartbeat } from "@/lib/presence-client";

/**
 * Mounted once from the root layout (next to AccountSync): keeps the
 * app-wide presence heartbeat running on every screen — the homepage badge
 * is only one of its readers. Renders nothing.
 */
export default function PresenceHeartbeat() {
  useEffect(() => {
    ensurePresenceHeartbeat();
  }, []);
  return null;
}
