/**
 * Early critics over the authoring stream (RB_STREAM_CRITICS, 2026-09-01).
 *
 * The founder's Revolut autopsy: a 6-page build spent 113s of wall on
 * critics that each judge ONE page from ONE screenshot — work that could
 * have started the moment that page's section closed in the author stream,
 * minutes before the file finished. This runner does exactly that and
 * nothing else: same screenshots, same critic prompt, same verdicts —
 * earlier start times. The parallel-engine postmortem stays honored: the
 * WRITER is untouched, one mind, one stream.
 *
 * Safety is sig-based (see stream-sections.ts): the join reuses an early
 * verdict only when the page's final render inputs hash-match what was
 * critiqued. Everything else — author retries, surgical patches, render
 * quirks, runner bugs — degrades that page to the join-time critic path,
 * which is byte-for-byte today's behavior. Early renders happen in a
 * tmpdir scratch dir written with persist:false: nothing here can reach
 * the durable store customers hydrate from.
 */
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

import { measureScenes } from "../render/measure-scene";
import { writeGeneratedFiles } from "../render/build-wrapper";
import { callZaiVision, extractJsonFromReasoning } from "../render/zai-vision";
import { SectionWatcher, finalSigs, type CompletedSection } from "./stream-sections";
import { founderRubricEnabled, founderCriticPrompt } from "./rubric";
import type { AuthorStreamHooks } from "./author";

// DEFAULT ON since 2026-09-04 (founder decision on the fast lane): critics
// judge pages as they stream out of the author; sig-verified reuse, never
// harmful by construction. RB_STREAM_CRITICS=off restores the join-only path.
export const streamCriticsEnabled = (): boolean => (process.env.RB_STREAM_CRITICS ?? "on") === "on";

/** ONE definition of the page-intent line — VERBATIM the format build.ts has
 *  always sent (the unbound-copy postmortem is what happens when prompt
 *  fragments fork; build.ts now imports this instead of keeping its own). */
export const sceneIntent = (s: { label?: string; description?: string } | undefined, i: number): string =>
  `Page ${i + 1} — ${s?.label ?? "untitled"}: ${s?.description ?? ""}`;

/** ONE critic: a page screenshot judged against its outline intent. Exactly
 *  the call lookAndReviseOnce makes — build.ts imports THIS so the early
 *  path and the join path can never drift apart. Returns the decisive
 *  weakness, or null for a shippable page; parse failures never block. */
export const critiquePageShot = async (
  shotB64: string,
  intent: string,
): Promise<{ weakness: string | null }> => {
  const r = await callZaiVision(
    shotB64,
    // RB_CRITIC_RUBRIC=founder: the founder's own grading order (mistakes →
    // occupancy → device → brand → hierarchy), written from his verdicts.
    founderRubricEnabled()
      ? founderCriticPrompt(intent)
      : `This slide was authored for the intent: "${intent}". Judge it against that intent for an executive audience. Reply ONLY JSON: {"ship": true|false, "weakness": "<the ONE decisive weakness, or empty if ship>"}`,
    // 8192 = build.ts's CRITIC_TOKENS: judgment thinking ate 2048 in M5 — never lower.
    { timeoutMs: 120_000, maxTokens: 8192, stage: "harness-critic" },
  );
  const raw = (r.text ?? "").match(/\{[\s\S]*\}/)?.[0] ?? extractJsonFromReasoning(r.text ?? "");
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && v.ship === false && v.weakness) return { weakness: String(v.weakness).slice(0, 300) };
  } catch {
    /* an unparseable verdict never blocks — decks always ship */
  }
  return { weakness: null };
};

export interface EarlyVerdict {
  weakness: string | null;
}

export class EarlyCriticRunner {
  private watcher = new SectionWatcher();
  /** Serialized render chain — one scratch dir, one write+measure at a time. */
  private renderChain: Promise<void> = Promise.resolve();
  /** In-flight critic calls the join must wait for (they started EARLIER
   *  than the join path would have started them, so waiting is never worse). */
  private inflight: Promise<void>[] = [];
  private verdicts: { page: number; sig: string; weakness: string | null }[] = [];
  private closed = false;
  private readonly earlyDir: string;

  constructor(
    private readonly args: {
      genDir: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      script: any;
      scenes: { label?: string; description?: string }[];
      n: number;
      log?: (line: string) => void;
      /** Test seam: the offline smoke drives real writes+renders with a fake
       *  critic so proving the plumbing costs zero model spend. */
      critic?: typeof critiquePageShot;
    },
  ) {
    this.earlyDir = path.join(os.tmpdir(), "rb-stream-critics", path.basename(args.genDir));
  }

  /** Hooks for authorDeck({stream}) — reset on every attempt so a failed
   *  try's half-file can never masquerade as the winner's pages. (Verdicts
   *  from stale attempts stay in the list; the sig match at finish() is what
   *  disqualifies them, so no attempt bookkeeping can ever be wrong.) */
  authorHooks(): AuthorStreamHooks {
    return {
      onAttemptStart: () => this.watcher.reset(),
      onText: (acc) => {
        if (this.closed) return;
        for (const s of this.watcher.feed(acc)) this.enqueue(s);
      },
    };
  }

  private enqueue(s: CompletedSection): void {
    if (s.index >= this.args.n) return;
    this.renderChain = this.renderChain.then(async () => {
      if (this.closed) return; // dropped: the join's own measure covers it
      try {
        const shot = await this.renderEarly(s);
        if (!shot) return;
        this.args.log?.(`harness:stream-critic:page ${s.index + 1} shot early`);
        const critic = this.args.critic ?? critiquePageShot;
        const job = critic(shot, sceneIntent(this.args.scenes[s.index], s.index))
          .then((v) => {
            this.verdicts.push({ page: s.index, sig: s.sig, weakness: v.weakness });
            this.args.log?.(`harness:stream-critic:page ${s.index + 1} ${v.weakness ? "flagged" : "ship"}`);
          })
          .catch(() => {});
        this.inflight.push(job);
      } catch (err) {
        // Any early failure = that page falls back to the join path. Named in
        // the timeline so a systematically-failing early pass is visible
        // instead of silently degrading every build to the old schedule.
        this.args.log?.(`harness:stream-critic:page ${s.index + 1} early render failed (${String(err).slice(0, 100)})`);
      }
    });
  }

  /** Write the prefix as a scratch genDir and screenshot JUST this scene. */
  private async renderEarly(s: CompletedSection): Promise<string | null> {
    await writeGeneratedFiles(
      this.earlyDir,
      { code: s.prefixCode, designCode: s.prefixCode, script: this.args.script },
      { persist: false },
    );
    const m = await measureScenes(this.earlyDir, this.args.script, path.join(this.earlyDir, "shots"), {
      screenshots: true,
      onlyScenes: [s.index],
    });
    const shotPath = m[s.index]?.screenshotPath;
    if (!shotPath) return null;
    try {
      return (await fsp.readFile(shotPath)).toString("base64");
    } catch {
      return null;
    }
  }

  /** Resolves when everything enqueued SO FAR has run (renders + critics).
   *  Prod never calls this — the author stream paces work naturally; the
   *  offline smoke feeds instantaneously and needs a quiescence point. */
  async idle(): Promise<void> {
    await this.renderChain.catch(() => {});
    await Promise.all(this.inflight);
  }

  /**
   * The join. Stops new work, drops anything not yet started, awaits critics
   * already in flight, then keeps only verdicts whose sig matches the FINAL
   * code — the guarantee that a reused verdict judged exactly the pixels the
   * deck ships with.
   */
  async finish(finalCode: string): Promise<Map<number, EarlyVerdict>> {
    this.closed = true;
    await this.renderChain.catch(() => {});
    await Promise.all(this.inflight);
    const sigs = finalSigs(finalCode, this.args.n);
    const out = new Map<number, EarlyVerdict>();
    for (const v of this.verdicts) {
      if (sigs[v.page] && v.sig === sigs[v.page]) out.set(v.page, { weakness: v.weakness });
    }
    return out;
  }

  /** Remove the scratch dir. Best-effort; a leftover tmpdir is harmless. */
  async cleanup(): Promise<void> {
    await fsp.rm(this.earlyDir, { recursive: true, force: true }).catch(() => {});
  }
}
