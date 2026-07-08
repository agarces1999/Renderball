/**
 * One-shot import: .data/briefs/*.json + .data/scripts/*.json → Postgres
 * (Project + ScriptDoc), for the store's file→pg backend flip (LAUNCH.md 3b).
 *
 * Idempotent — upserts by id, safe to re-run. Rules:
 *   - Briefs owned by DEV_OWNER_ID get the synthetic dev User row (upserted).
 *   - Briefs with NO owner_id are pre-auth dev artifacts → imported under
 *     DEV_OWNER_ID so they stay reachable in development.
 *   - Briefs whose real owner_id has no User row are SKIPPED with a report
 *     (a missing cuid means the DB was reset — importing would violate FK).
 *   - Scripts import unconditionally (ownership lives on Project).
 *
 * Run: npx tsx scripts/migrate-store-to-pg.ts
 */
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../lib/db";
import { DEV_OWNER_ID, type StoredBrief } from "../lib/store";
import type { Prisma } from "@prisma/client";

const DATA = path.join(process.cwd(), ".data");

const readJsonDir = async <T>(dir: string): Promise<[string, T][]> => {
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
    const out: [string, T][] = [];
    for (const f of files) {
      try {
        out.push([f, JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as T]);
      } catch {
        console.warn(`  ! skipping corrupt ${f}`);
      }
    }
    return out;
  } catch {
    return [];
  }
};

const run = async () => {
  await prisma.user.upsert({
    where: { id: DEV_OWNER_ID },
    update: {},
    create: { id: DEV_OWNER_ID, clerkId: DEV_OWNER_ID, email: "dev@renderball.local" },
  });

  const knownUsers = new Set(
    (await prisma.user.findMany({ select: { id: true } })).map((u) => u.id),
  );

  const briefs = await readJsonDir<StoredBrief>(path.join(DATA, "briefs"));
  let imported = 0, devClaimed = 0, skipped = 0;
  for (const [file, b] of briefs) {
    let ownerId = b.owner_id;
    if (!ownerId) {
      ownerId = DEV_OWNER_ID; // pre-auth artifact — keep reachable in dev
      devClaimed++;
    } else if (ownerId !== DEV_OWNER_ID && !knownUsers.has(ownerId)) {
      console.warn(`  ! ${file}: owner ${ownerId} has no User row — skipped`);
      skipped++;
      continue;
    }
    const brief = { ...b, owner_id: ownerId };
    const data = {
      ownerId,
      purpose: brief.purpose ?? "",
      status: brief.status ?? "script_generated",
      brief: brief as unknown as Prisma.InputJsonValue,
      brandExtract: (brief.brand_extract ?? undefined) as Prisma.InputJsonValue | undefined,
      scriptId: brief.script_id ?? null,
      error: brief.error ?? null,
    };
    await prisma.project.upsert({
      where: { id: brief.id },
      update: data,
      create: {
        id: brief.id,
        ...data,
        createdAt: brief.created_at ? new Date(brief.created_at) : new Date(),
      },
    });
    imported++;
  }

  const scripts = await readJsonDir<{ id: string }>(path.join(DATA, "scripts"));
  let scriptsImported = 0;
  for (const [, s] of scripts) {
    if (!s.id) continue;
    const json = s as unknown as Prisma.InputJsonValue;
    await prisma.scriptDoc.upsert({ where: { id: s.id }, update: { json }, create: { id: s.id, json } });
    scriptsImported++;
  }

  console.log(
    `briefs: ${imported} imported (${devClaimed} ownerless → dev-local), ${skipped} skipped; scripts: ${scriptsImported} imported`,
  );
  await prisma.$disconnect();
};

void run();
