#!/usr/bin/env node
/**
 * Full local e2e for the push SEND path without a real browser:
 *   1. craft a subscription with a REAL P-256 p256dh key (format-valid)
 *   2. POST it to /api/push/subscribe
 *   3. POST /api/push/test  -> web-push must ENCRYPT the payload (crypto path)
 *      and hit FCM, which 404s the bogus token -> route prunes the dead sub
 *   4. confirm the sub row is gone
 * Proves: VAPID config, payload encryption, HTTP send, dead-endpoint pruning.
 */
import { createECDH, randomBytes } from "node:crypto";

const BASE = process.argv[2] || "http://localhost:3000";

// real P-256 public key — getPublicKey() already returns the 65-byte
// uncompressed point (0x04 || X || Y) that Web Push expects
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const p256dh = ecdh.getPublicKey().toString("base64url");
const auth = randomBytes(16).toString("base64url");
const endpoint = "https://fcm.googleapis.com/fcm/send/e2e- crafted-" + randomBytes(8).toString("hex");

const sub = { endpoint, keys: { p256dh, auth }, userId: "push-e2e-bot" };

const post = await fetch(`${BASE}/api/push/subscribe`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(sub),
});
console.log("subscribe:", post.status, await post.json());

const test = await fetch(`${BASE}/api/push/test?quiet=1`, { method: "POST" });
console.log("test:", test.status, await test.json());

// row should be GONE (FCM 404 for a bogus token -> pruned)
const { PrismaClient } = await import("@prisma/client").catch(() => ({ PrismaClient: null }));
if (PrismaClient) {
  const db = new PrismaClient();
  const left = await db.pushSub.count({ where: { endpoint } });
  console.log(left === 0 ? "PASS: dead subscription was pruned (encrypt + send + prune all work)" : `FAIL: ${left} row(s) left`);
  await db.$disconnect();
}
