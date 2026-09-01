/**
 * Ask api.aniskip.com DIRECTLY for the probe set (bypassing our cache) to see
 * whether the live tier is missing data that actually exists up there.
 */
const malIds = [49233, 54000, 56735, 58929, 59193, 59741];

for (const malId of malIds) {
  for (const len of [24, 23]) {
    try {
      const res = await fetch(`https://api.aniskip.com/v2/skip-times/${malId}/1?types=op&types=ed&episodeLength=${len}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => null);
      const ops = (body?.results ?? []).filter((r) => r?.skipType === "op").map((r) => `${r.interval.startTime}->${r.interval.endTime}`);
      const eds = (body?.results ?? []).filter((r) => r?.skipType === "ed").map((r) => `${r.interval.startTime}->${r.interval.endTime}`);
      console.log(`${malId} len=${len} status=${res.status} found=${body?.found ?? "?"} op=[${ops.join(", ")}] ed=[${eds.join(", ")}]`);
    } catch (e) {
      console.log(`${malId} len=${len} ERROR ${String(e).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 1100)); // 1 req/s documented limit
  }
}
