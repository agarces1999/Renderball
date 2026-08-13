// One-time (idempotent) backfill of the per-user token meter from the
// transport-level spend ledger — run 2026-08-13 when the RB_METERING default
// flipped to "count" and the meter needed to stop reading 0 for users whose
// tokens were already in the ledger.
//
// Attribution: SpendRecord.scriptId → Project.scriptId → Project.ownerId.
// Rows without a scriptId (lab harnesses, unattributed) and rows owned by the
// dev partition are skipped — the meter is a USER-facing number and must not
// inherit ops noise. The write SETS totalTokens to the computed sum (upsert),
// so re-running converges instead of double-counting; live "count"-mode
// increments after the deploy simply continue from the true base.
//
//   node scripts/backfill-token-usage.mjs           # dry run (prints, no write)
//   node scripts/backfill-token-usage.mjs --write   # apply
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const write = process.argv.includes("--write");
const DEV_OWNER_ID = "dev-local";

const rows = await prisma.spendRecord.findMany({
  where: { scriptId: { not: null } },
  select: { scriptId: true, inputTokens: true, outputTokens: true },
});
const byScript = new Map();
for (const r of rows) {
  const t = (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
  byScript.set(r.scriptId, (byScript.get(r.scriptId) ?? 0) + t);
}

const projects = await prisma.project.findMany({
  where: { scriptId: { in: [...byScript.keys()] } },
  select: { scriptId: true, ownerId: true },
});
const byOwner = new Map();
let unattributed = 0;
const seen = new Set();
for (const p of projects) {
  seen.add(p.scriptId);
  if (!p.ownerId || p.ownerId === DEV_OWNER_ID) continue;
  byOwner.set(p.ownerId, (byOwner.get(p.ownerId) ?? 0) + byScript.get(p.scriptId));
}
for (const [sid, t] of byScript) if (!seen.has(sid)) unattributed += t;

console.log(`ledger rows with scriptId: ${rows.length}`);
console.log(`owners to backfill: ${byOwner.size}; unattributed tokens skipped: ${unattributed}`);
for (const [owner, tokens] of byOwner) {
  const user = await prisma.user.findUnique({ where: { id: owner }, select: { email: true } });
  console.log(`  ${user?.email ?? owner}: ${tokens.toLocaleString()} tokens`);
  if (write) {
    await prisma.tokenUsage.upsert({
      where: { ownerId: owner },
      create: { ownerId: owner, totalTokens: BigInt(tokens) },
      update: { totalTokens: BigInt(tokens) },
    });
  }
}
console.log(write ? "\napplied." : "\ndry run — pass --write to apply.");
await prisma.$disconnect();
