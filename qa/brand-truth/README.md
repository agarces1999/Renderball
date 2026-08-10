# Brand truth set

Read `docs/BRAND_ACCURACY.md` first — it holds the numbers, the method, and the
detector ideas already killed by data. This file is just how to run the rig.

```bash
cd qa/brand-truth
node score.mjs --half tune          # the 38 sites fixes were developed against
node score.mjs --half holdout       # the 14 they never saw (aggregate only)
node score.mjs --only stripe.com    # one site, verbose
node score.mjs --json out.json      # machine-readable snapshot
```

`RB_TRUTH_OFFLINE=1` forbids live fetches, so a run can only replay the
recorded bytes in `cache/` and cannot silently re-measure against whatever the
CDN is serving today. Use it whenever you are comparing two versions of the
picker. `--refetch` does the opposite: ignores the cache and re-records.

`cache/` is ~18MB, gitignored, and rebuilt on demand — any probe re-fetches and
re-records what it cannot find. A missing cache costs one slow run, not a
wrong number.

The `probe-*.mjs` scripts are the evidence behind the doc. Three of them read
measurement-only fields that are deliberately NOT in the shipped code:

```bash
git apply qa/brand-truth/instrumentation.patch   # then probe-ink / -achromatic / -unconfirmed
```

Revert it when you are done (`git checkout -- app/new/schema.ts
lib/crawl/extract-brand.ts lib/documents/site-brand.ts`). Nothing in the
product reads those fields, and dead code that looks load-bearing is worse than
no code.

## Adding sites

`split.mjs` assigns halves by hostname hash, so a host lands in the same half
every time and the split cannot be nudged. **The holdout seal is broken** — its
rows were read on 2026-08-09 — so a future round needs fresh hosts, not a
reshuffle of these.

Truth values come from the brand's own served bytes (`probe-evidence.mjs`,
`probe-frequency.mjs`, `probe-builder-theme.mjs`), never from the favicon and
never from `readSiteBrand` itself — either would make the truth agree with the
fix by construction. When two answers are both defensible and more than a band
apart, the row goes in `truth-excluded.json`. A wrong truth value is worse than
a missing one.
