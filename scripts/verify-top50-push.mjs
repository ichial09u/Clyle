#!/usr/bin/env node
/** Verify the Top-50 widening + push endpoints against a base URL. */
const BASE = process.argv[2] || "http://localhost:3000";

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};

// 1) Top 10/50 snapshot
const t = await j("/api/top10");
const items = t.body?.items ?? [];
console.log(`[top10] items=${items.length} (want 50)`);
for (const i of [0, 9, 10, 25, items.length - 1]) {
  const it = items[i];
  if (it) console.log(`  #${it.rank} ${String(it.title).slice(0, 34)} (prev=${it.prevRank})`);
}
console.log(items.length >= 40 ? "[top10] PASS (>=40 rows)" : "[top10] FAIL — snapshot not widened");

// 2) push key
const k = await j("/api/push/key");
console.log(`[push/key] status=${k.status} pubKeyLen=${k.body?.publicKey?.length ?? 0}`);
console.log(k.body?.publicKey?.startsWith("B") ? "[push/key] PASS" : "[push/key] FAIL");

// 3) subscribe round-trip (fake endpoint, then delete it)
const fake = { endpoint: "https://fcm.googleapis.com/fcm/send/smoke-test-endpoint", keys: { p256dh: "B-smoke-p256dh", auth: "smoke-auth" }, userId: "smoke-bot" };
const s = await j("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fake) });
console.log(`[push/subscribe POST] status=${s.status} ok=${s.body?.ok}`);
const d = await j("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: fake.endpoint }) });
console.log(`[push/subscribe DELETE] status=${d.status} ok=${d.body?.ok}`);
console.log(s.body?.ok && d.body?.ok ? "[push/subscribe] PASS" : "[push/subscribe] FAIL");

// 4) events feed shape
const e = await j("/api/top10-events");
console.log(`[top10-events] status=${e.status} count=${e.body?.events?.length ?? 0}`);
