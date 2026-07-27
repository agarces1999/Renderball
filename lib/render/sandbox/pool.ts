/**
 * The render sandbox — a long-lived child process that executes composition
 * code, and the only thing in this codebase allowed to run it.
 *
 * WHY A CHILD PROCESS AND NOT A WORKER THREAD. A worker thread shares the OS
 * process, so it can still reach the filesystem and process internals; the
 * boundary that actually holds is a separate process whose ENVIRONMENT IS
 * EMPTY. On Railway secrets arrive as environment variables rather than a
 * file, so scrubbing the env genuinely removes them from the child's reach.
 *
 * WHY POOLED AND NOT SPAWNED PER RENDER. Measured on this codebase: the eval
 * itself is 0.1ms and a whole compile+eval+render is 4.2ms, while spawning a
 * process costs ~52ms. Fork-per-render would have been ~500x the work it
 * protects. One long-lived child costs a 14ms startup, paid once, and ~0.03ms
 * per request thereafter — under 1% overhead.
 *
 * WHY A TIMEOUT IS THE POINT. `new Function(...)()` is synchronous and cannot
 * be interrupted from the thread running it. In-process, a composition with an
 * infinite loop froze the whole server for every user with no recovery. Here
 * the parent simply kills the child and restarts it, and only that one render
 * fails. This is the failure mode most likely to actually occur — a model
 * emitting accidental runaway code is far commoner than a successful attack.
 *
 * HONEST LIMIT. This removes the secrets, not every capability: a determined
 * payload inside the child could still reach the filesystem through Node
 * internals and read application source or other documents on that disk. What
 * it cannot do is read DATABASE_URL, CLERK_SECRET_KEY, STRIPE_SECRET_KEY or
 * RB_FIREWORKS_KEY, because they are not in this process. Closing the
 * remaining surface needs OS-level sandboxing (a locked-down container), which
 * is a deployment change rather than a code change.
 */
import { fork, type ChildProcess } from "child_process";
import path from "path";

export type SceneRenderResult =
  | { ok: true; html: string }
  | { ok: false; status: number; message: string };

interface Pending {
  resolve: (r: SceneRenderResult) => void;
  timer: NodeJS.Timeout;
  /**
   * Which child this request belongs to.
   *
   * Without it, a dying child's `exit` event failed EVERY in-flight request —
   * including ones already re-sent to its freshly spawned replacement. The
   * observed effect was that one timed-out render permanently broke all
   * subsequent renders: "render sandbox was killed (SIGKILL)" forever.
   */
  owner: ChildProcess;
}

/**
 * How long one scene may take before the child is considered hung.
 *
 * Generous against the measured 4.2ms of real work — a slow cold compile of a
 * large composition is legitimate; a composition still running after this is
 * not. Env-tunable so a pathological-but-genuine document can be accommodated
 * without a deploy.
 */
const renderTimeoutMs = (): number => {
  const v = Number(process.env.RB_RENDER_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 20_000;
};

const WORKER = path.join(process.cwd(), "lib", "render", "sandbox", "render-worker.cjs");

/**
 * How many sandbox children to keep.
 *
 * A child is single-threaded, so it renders requests SERIALLY — with only one,
 * a request that hangs blocks every request queued behind it, and both time
 * out together. Measured: a good render running concurrently with a hung one
 * failed too. More than one child gives real concurrency AND bounds the blast
 * radius of a hang to the slot it happened on.
 *
 * Two by default, matching RB_MAX_CONCURRENT_BUILDS. Each is ~14ms to start
 * and idles at nearly no cost.
 */
const POOL_SIZE = (() => {
  const v = Number(process.env.RB_RENDER_POOL);
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 8) : 2;
})();

interface Slot {
  child: ChildProcess | null;
  /** requests currently out at this slot — used to pick the least busy */
  load: number;
}

const slots: Slot[] = Array.from({ length: POOL_SIZE }, () => ({ child: null, load: 0 }));
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * The child's entire environment. Deliberately NOT `process.env` — that is the
 * whole mechanism. PATH is kept so node can find its own toolchain; NODE_ENV
 * so React picks its production build.
 */
const childEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  NODE_ENV: process.env.NODE_ENV,
  // Explicitly nothing else. Adding a secret here defeats the isolation.
});

/**
 * Marks a failure caused by the SANDBOX dying rather than by the composition
 * being bad. The distinction matters: one hung document kills the shared
 * child, which collaterally fails whatever else was mid-render. Those victims
 * are retried once on a fresh child, so a neighbour's broken deck degrades
 * into a few extra milliseconds instead of a visible error.
 */
const SANDBOX_DIED = "__sandbox_died__";

/** Fail only the requests that belong to `owner` — see Pending.owner. */
const failPendingFor = (owner: ChildProcess, message: string): void => {
  for (const [id, p] of pending) {
    if (p.owner !== owner) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve({ ok: false, status: 500, message, [SANDBOX_DIED]: true } as SceneRenderResult);
  }
};

const spawnChild = (slot: Slot): ChildProcess => {
  const c = fork(WORKER, [], {
    env: childEnv(),
    // Inherit stderr so a crash is visible in logs; the child never writes to
    // stdout in normal operation.
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  c.on("message", (raw: unknown) => {
    const m = raw as { id?: number; ready?: boolean } & SceneRenderResult;
    if (!m || typeof m.id !== "number") return; // the ready handshake
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve(
      m.ok
        ? { ok: true, html: (m as { html: string }).html }
        : { ok: false, status: m.status ?? 500, message: m.message ?? "render failed" },
    );
  });

  const onGone = (why: string) => {
    if (slot.child === c) {
      slot.child = null;
      slot.load = 0;
    }
    failPendingFor(c, `render sandbox ${why}`);
  };
  c.on("exit", (code, signal) =>
    onGone(signal ? `was killed (${signal})` : `exited (code ${code})`),
  );
  c.on("error", (err) => onGone(`failed: ${err.message}`));

  return c;
};

/** The least-busy slot, spawning its child on first use. */
const acquireSlot = (): Slot => {
  const slot = slots.reduce((a, b) => (b.load < a.load ? b : a));
  if (!slot.child || !slot.child.connected) slot.child = spawnChild(slot);
  return slot;
};

/**
 * Render one scene of a composition to HTML, in the sandbox.
 *
 * Never throws: a hang, a crash, or a hostile composition all come back as a
 * normal `{ ok: false }` so the caller renders an error state rather than
 * taking the request down.
 */
export const renderSceneSandboxed = async (
  compPath: string,
  sceneIndex: number,
  script: unknown,
): Promise<SceneRenderResult> => {
  const first = await attemptRender(compPath, sceneIndex, script);
  // Retry ONCE, and only when the sandbox itself died — never when the
  // composition failed on its own merits, and never for a timeout (retrying a
  // hang just hangs again).
  if (!first.ok && (first as Record<string, unknown>)[SANDBOX_DIED]) {
    return attemptRender(compPath, sceneIndex, script);
  }
  return first;
};

const attemptRender = (
  compPath: string,
  sceneIndex: number,
  script: unknown,
): Promise<SceneRenderResult> =>
  new Promise((resolve) => {
    let slot: Slot;
    let c: ChildProcess;
    try {
      slot = acquireSlot();
      c = slot.child as ChildProcess;
      slot.load++;
    } catch (err) {
      resolve({
        ok: false,
        status: 500,
        message: `could not start render sandbox: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const id = nextId++;
    const timeoutMs = renderTimeoutMs();
    const release = () => {
      slot.load = Math.max(0, slot.load - 1);
    };

    const timer = setTimeout(() => {
      pending.delete(id);
      release();
      // The child is wedged inside synchronous composition code and will not
      // respond to anything gentler. Kill it; the next request spawns a fresh
      // one. This is the recovery that was impossible in-process.
      try {
        c.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (slot.child === c) {
        slot.child = null;
        slot.load = 0;
      }
      resolve({
        ok: false,
        status: 500,
        message: `This page took too long to render and was stopped after ${Math.round(
          timeoutMs / 1000,
        )}s. It may contain an element that never finishes drawing.`,
      });
    }, timeoutMs);

    pending.set(id, {
      resolve: (r) => {
        release();
        resolve(r);
      },
      timer,
      owner: c,
    });

    try {
      c.send({ id, compPath, sceneIndex, script });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      release();
      resolve({
        ok: false,
        status: 500,
        message: `render sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

/** Test/shutdown seam. */
export const stopRenderSandbox = (): void => {
  for (const slot of slots) {
    if (!slot.child) continue;
    failPendingFor(slot.child, "render sandbox stopped");
    try {
      slot.child.kill();
    } catch {
      /* already gone */
    }
    slot.child = null;
    slot.load = 0;
  }
};

/** Introspection for tests. */
export const sandboxState = (): { running: number; inFlight: number; size: number } => ({
  running: slots.filter((s) => s.child && s.child.connected).length,
  inFlight: pending.size,
  size: POOL_SIZE,
});
