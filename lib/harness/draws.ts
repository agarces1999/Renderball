/**
 * Best-of-N author draws, critic-ranked (RB_AUTHOR_DRAWS; 10x program,
 * 2026-09-04; default 1 = today's single draw).
 *
 * Why: the largest quality factor observed in the lab is the VARIANCE between
 * draws of byte-identical inputs — ab7 (2026-09-02) hash-proved two decks
 * built from the same pack, one of which the founder judged "a lot better",
 * differing only in the design the author happened to sample. Sampling twice
 * and letting the existing per-page critics rank the draws buys that upside
 * for one extra author call, with no new judgment machinery (the critic that
 * already gates revision is the ranker — doctrine: feed/free/check).
 *
 * How: every draw is rendered in its own scratch genDir (persist:false — same
 * isolation the stream-critics runner uses), every page critiqued in
 * parallel, and the draw with the fewest flagged pages wins (ties: fewer
 * truth violations, then the first draw). The winner's verdicts ride into
 * lookAndReviseOnce as `early` verdicts when the code that reaches the loop
 * is byte-identical to what was judged, so the critic stage is not paid
 * twice for the winner.
 */
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { writeGeneratedFiles } from "../render/build-wrapper";
import { measureScenes } from "../render/measure-scene";
import { critiquePageShot, sceneIntent, type EarlyVerdict } from "./stream-critics";

export const authorDraws = (): number => {
  const n = Number(process.env.RB_AUTHOR_DRAWS ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 3) : 1;
};

export interface DrawInput {
  code: string;
  /** Truth-validator hits on this draw (tiebreak — zero tokens). */
  violations: number;
}

export interface DrawRanking {
  winner: number;
  /** Per draw: flagged page count (null = render/critic failure → last). */
  flagged: (number | null)[];
  /** The winner's per-page verdicts, for reuse as `early` verdicts. */
  verdicts: Map<number, EarlyVerdict>;
}

export const rankDraws = async (args: {
  genDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  script: any;
  scenes: { label?: string; description?: string }[];
  n: number;
  draws: DrawInput[];
  critic?: typeof critiquePageShot;
  log?: (line: string) => void;
}): Promise<DrawRanking> => {
  const critic = args.critic ?? critiquePageShot;
  const judged = await Promise.all(
    args.draws.map(async (d, k) => {
      const dir = path.join(os.tmpdir(), "rb-draws", `${path.basename(args.genDir)}-${k}`);
      try {
        await writeGeneratedFiles(dir, { code: d.code, designCode: d.code, script: args.script }, { persist: false });
        const m = await measureScenes(dir, args.script, path.join(dir, "shots"), { screenshots: true });
        const verdicts = new Map<number, EarlyVerdict>();
        await Promise.all(
          Array.from({ length: args.n }, (_, i) => (async () => {
            const p = m[i]?.screenshotPath;
            if (!p) return;
            const shot = (await fsp.readFile(p)).toString("base64");
            const v = await critic(shot, sceneIntent(args.scenes[i], i));
            verdicts.set(i, { weakness: v.weakness });
          })().catch(() => {})),
        );
        const flagged = [...verdicts.values()].filter((v) => v.weakness).length;
        const judgedPages = verdicts.size;
        args.log?.(`harness:draws:draw ${k + 1}: ${flagged} flagged / ${judgedPages} judged, ${d.violations} violation(s)`);
        return { k, flagged: judgedPages ? flagged : null, verdicts };
      } catch (err) {
        args.log?.(`harness:draws:draw ${k + 1} failed to render (${String(err).slice(0, 80)})`);
        return { k, flagged: null, verdicts: new Map<number, EarlyVerdict>() };
      } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );
  const order = [...judged].sort((a, b) => {
    const fa = a.flagged ?? Number.POSITIVE_INFINITY;
    const fb = b.flagged ?? Number.POSITIVE_INFINITY;
    if (fa !== fb) return fa - fb;
    const va = args.draws[a.k].violations;
    const vb = args.draws[b.k].violations;
    if (va !== vb) return va - vb;
    return a.k - b.k;
  });
  const best = order[0];
  return { winner: best.k, flagged: judged.map((j) => j.flagged), verdicts: best.verdicts };
};
