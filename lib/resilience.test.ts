/**
 * What happens when a dependency is down.
 *
 * Every route in this product depends on four things it does not control — a
 * database that scales to zero, object storage, a model provider, and a billing
 * meter. None of those failures had a test, and two of them bit during
 * development: Neon answered `P1001 can't reach database server` twice in one
 * night, and a missing DATABASE_URL silently turned a restore into a no-op.
 *
 * The property throughout is the same: DEGRADE, don't collapse. A dependency
 * being unavailable should produce a refusal the user can read and nothing
 * billed — never a 500, never lost work, never a charge for work not done.
 *
 * These use injected failures rather than genuinely unplugging things, so they
 * run in milliseconds and in CI.
 */
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { withDbRetry } from "./db";
import { persistGenDir, hydrateGenDir } from "./render/gen-store";
import { isStorageConfigured } from "./storage/r2";
import { takeRegenSlot } from "./edit/op-cap";
import {
  assertZaiAvailable,
  isBalanceError,
  noteZaiError,
  noteZaiSuccess,
  resetZaiBreakerForTests,
  zaiBreakerState,
  ZaiUnavailableError,
} from "./zai-breaker";
import { commitGenDir } from "./edit/commit";
import { decomposeGenDir } from "./agents/lego-store";
import { ulid } from "./ulid";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`); }
};
const assert = (c: boolean, m: string) => { if (!c) throw new Error(m); };

const run = async () => {
  console.log("resilience: every dependency failing");

  // ── the database ──────────────────────────────────────────────────────────

  await check("a COLD database is retried, not surfaced as an error", async () => {
    // Neon scales to zero; the first query after a sleep fails and the second
    // succeeds. Without the retry, the very first page load of the day 500s.
    let attempts = 0;
    const result = await withDbRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          const e = new Error("Can't reach database server at ep-x.neon.tech:5432");
          (e as Error & { code?: string }).code = "P1001";
          throw e;
        }
        return "woke up";
      },
      10,
    );
    assert(result === "woke up", "the retry should return the second attempt's value");
    assert(attempts === 2, `expected exactly 2 attempts, saw ${attempts}`);
  });

  await check("a database error that is NOT transient is raised immediately", async () => {
    // A constraint violation must not be retried — retrying hides the bug and
    // doubles the work.
    let attempts = 0;
    let threw = false;
    try {
      await withDbRetry(async () => {
        attempts++;
        const e = new Error("Unique constraint failed on the fields: (`email`)");
        (e as Error & { code?: string }).code = "P2002";
        throw e;
      }, 10);
    } catch {
      threw = true;
    }
    assert(threw, "a non-transient error must reach the caller");
    assert(attempts <= 2, `a constraint error should not be retried repeatedly (saw ${attempts})`);
  });

  await check("a database that never comes back still gives up rather than hanging", async () => {
    let threw = false;
    try {
      await withDbRetry(async () => {
        const e = new Error("Can't reach database server");
        (e as Error & { code?: string }).code = "P1001";
        throw e;
      }, 10);
    } catch {
      threw = true;
    }
    assert(threw, "a permanently unreachable database must eventually raise");
  });

  // ── object storage ────────────────────────────────────────────────────────

  await check("storage being UNCONFIGURED does not throw, it reports false", async () => {
    // A document must still be editable with no R2 at all — it just isn't
    // redeploy-safe, which is a different (and logged) problem.
    const saved = {
      endpoint: process.env.STORAGE_ENDPOINT,
      key: process.env.STORAGE_ACCESS_KEY_ID,
      secret: process.env.STORAGE_SECRET_ACCESS_KEY,
      bucket: process.env.STORAGE_BUCKET,
    };
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_ACCESS_KEY_ID;
    delete process.env.STORAGE_SECRET_ACCESS_KEY;
    delete process.env.STORAGE_BUCKET;
    try {
      // isStorageConfigured reads module-level values captured at import, so this
      // asserts the CONTRACT rather than re-reading env: whatever it reports,
      // neither call may throw and neither may claim success it did not achieve.
      const persisted = await persistGenDir(`NOSUCHDOC${ulid()}`);
      assert(persisted === false, "persisting a nonexistent document must report false, not throw");
      const hydrated = await hydrateGenDir(`NOSUCHDOC${ulid()}`);
      assert(hydrated === false, "hydrating a document that is not in storage must report false");
    } finally {
      for (const [k, v] of [
        ["STORAGE_ENDPOINT", saved.endpoint],
        ["STORAGE_ACCESS_KEY_ID", saved.key],
        ["STORAGE_SECRET_ACCESS_KEY", saved.secret],
        ["STORAGE_BUCKET", saved.bucket],
      ] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  await check("hydrating an unknown document reports false rather than inventing one", async () => {
    const hydrated = await hydrateGenDir(`DEFINITELYMISSING${ulid()}`);
    assert(hydrated === false, "an unknown document must not appear to hydrate");
    assert(typeof isStorageConfigured() === "boolean", "storage configuration must be answerable");
  });

  // ── the model provider ────────────────────────────────────────────────────

  await check("an exhausted-balance error trips the breaker", () => {
    resetZaiBreakerForTests();
    const tripped = noteZaiError(new Error("402 Insufficient balance for account"));
    assert(tripped, "a balance error should trip the breaker");
    assert(zaiBreakerState().open, "the breaker should be open");
    let friendly = "";
    try {
      assertZaiAvailable();
    } catch (e) {
      friendly = e instanceof ZaiUnavailableError ? e.friendly : "not the right error type";
    }
    assert(friendly.length > 0, "an open breaker must offer a user-facing message");
    assert(!/402|insufficient balance/i.test(friendly), `the message should not leak provider detail: ${friendly}`);
    resetZaiBreakerForTests();
  });

  await check("a RATE LIMIT does not trip the breaker", () => {
    // Regression: the breaker used to treat 429 bodies as an exhausted account
    // and shut down all generation for everyone during a traffic spike.
    resetZaiBreakerForTests();
    for (const msg of [
      "429 Too Many Requests",
      "rate limit exceeded, please retry",
      "concurrency limit reached",
    ]) {
      const tripped = noteZaiError(new Error(msg));
      assert(!tripped, `"${msg}" must not be read as an exhausted balance`);
    }
    assert(!zaiBreakerState().open, "a rate limit must leave generation available");
    resetZaiBreakerForTests();
  });

  await check("ordinary failures do not trip the breaker", () => {
    resetZaiBreakerForTests();
    for (const e of [
      new Error("socket hang up"),
      new Error("500 internal server error"),
      new Error("model produced invalid JSON"),
      undefined,
      null,
      "a string",
    ]) {
      assert(!isBalanceError(e), `${String(e)} must not be read as a balance problem`);
    }
    assert(!zaiBreakerState().open, "the breaker should still be closed");
  });

  await check("a success closes an open breaker", () => {
    resetZaiBreakerForTests();
    noteZaiError(new Error("402 Insufficient balance"));
    assert(zaiBreakerState().open, "precondition: the breaker is open");
    noteZaiSuccess();
    assert(!zaiBreakerState().open, "a successful probe must resume generation");
    assertZaiAvailable(); // must not throw
    resetZaiBreakerForTests();
  });

  // ── spend limits ──────────────────────────────────────────────────────────

  await check("the per-owner cap eventually refuses, and says when to retry", () => {
    const owner = `capuser_${ulid()}`;
    let allowed = 0;
    let refusal: { allowed: boolean; retryAfterMin?: number } | null = null;
    // Take slots until refused. The cap is per hour, so this cannot run away.
    for (let i = 0; i < 500; i++) {
      const r = takeRegenSlot(owner);
      if (r.allowed) { allowed++; continue; }
      refusal = r;
      break;
    }
    assert(allowed > 0, "the first request must be allowed");
    assert(refusal !== null, `the cap never engaged after ${allowed} requests`);
    assert(
      typeof refusal!.retryAfterMin === "number" && refusal!.retryAfterMin! > 0,
      "a refusal must tell the user when they can try again",
    );
  });

  await check("one owner's cap does not affect another", () => {
    const a = `capA_${ulid()}`;
    const b = `capB_${ulid()}`;
    for (let i = 0; i < 500; i++) if (!takeRegenSlot(a).allowed) break;
    assert(takeRegenSlot(b).allowed, "exhausting one account must not lock out everyone else");
  });

  // ── the write barrier ─────────────────────────────────────────────────────

  await check("code that does not compile is REFUSED and the render is untouched", async () => {
    const dir = path.join(os.tmpdir(), `rb-resilience-${ulid()}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      const good = `import React from "react";
import { Piece } from "./Piece";
export const Section0: React.FC<{ script: any }> = () => (
  <div style={{ position: "absolute", inset: 0 }}>
    <Piece id="s0.a" kind="text"><div style={{ position: "absolute", left: 10, top: 10, width: 100, height: 50 }}>Hi</div></Piece>
  </div>
);
export const Generated: React.FC<{ script: any }> = ({ script }) => (<Section0 script={script} />);
`;
      await fs.writeFile(path.join(dir, "Composition.tsx"), good, "utf8");
      await decomposeGenDir(dir);
      const before = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");

      // Corrupt a piece body so reassembly cannot compile.
      const pieces = path.join(dir, "lego", "pieces");
      const names = await fs.readdir(pieces);
      await fs.writeFile(path.join(pieces, names[0]), "<div style={{ BROKEN", "utf8");

      const res = await commitGenDir(dir, "resilience test");
      assert(!res.ok, "a commit that does not compile must be refused");
      const after = await fs.readFile(path.join(dir, "Composition.tsx"), "utf8");
      assert(
        after === before,
        "a refused commit must leave the previous render EXACTLY as it was — this is the only thing standing between a bad edit and a broken document",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

await run();
