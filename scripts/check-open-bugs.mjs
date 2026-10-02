import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const bugs = await db.bugReport.findMany({ where: { status: "open" }, orderBy: { severity: "asc" }, take: 40 });
console.log(JSON.stringify(bugs.map(b => ({ id: b.id, kind: b.kind, key: b.targetKey, sev: b.severity, count: b.count, detail: (b.detail || "").slice(0, 220), lastSeen: b.lastSeen })), null, 1));
console.log("total open:", bugs.length);
await db.$disconnect();
