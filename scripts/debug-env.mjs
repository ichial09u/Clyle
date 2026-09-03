/** Debug envelope profiles + matcher steps offline. */
import { readFileSync } from "node:fs";

const A = JSON.parse(readFileSync("/tmp/env21-1.json", "utf8"));
const B = JSON.parse(readFileSync("/tmp/env21-2.json", "utf8"));

const prof = (env, label, to = 320) => {
  console.log(`\n--- ${label} ---`);
  for (let i = 0; i < Math.min(to, env.length); i++) {
    if (i % 120 === 0) process.stdout.write(`\n${String(i * 0.5).padStart(5)}s `);
    const v = env[i];
    process.stdout.write(v < 0.05 ? " " : v < 0.14 ? "." : v < 0.3 ? "-" : v < 0.55 ? "=" : "#");
  }
  console.log();
};

prof(A.env, `A ep1 (zoko: ${JSON.stringify(A.skip?.intro)})`);
prof(B.env, `B ep2 (zoko: ${JSON.stringify(B.skip?.intro)})`);

// manual alignment: slide A's OP region (31-111s = windows 62-222) over B
const aS = 62, aE = 224;
let best = null;
for (let o = -aS; o + aE <= B.env.length; o++) {
  let sum = 0, n = 0;
  for (let i = aS; i < aE; i++) {
    const a = A.env[i];
    if (a < 0.12) continue;
    const b = B.env[i + o];
    if (b < 0.12) { sum += 1; n++; continue; }
    sum += Math.abs(a - b);
    n++;
  }
  if (n < (aE - aS) * 0.5) continue;
  const dist = sum / n;
  if (!best || dist < best.dist) best = { offset: o, dist };
}
console.log("\nbest offset:", best, "-> OP in B at", (aS + best.offset) * 0.5, "-", (aE + best.offset) * 0.5);
