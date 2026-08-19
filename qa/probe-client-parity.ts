/**
 * CLIENT PREVIEW Phase 1 parity probe (docs/CLIENT_PREVIEW_SPIKE.md).
 *
 * For each stored deck the dev lane can load: open every scene with
 * ?hydrate=1 and read window.__rbParity — the in-document canonical-DOM
 * comparison between the SSR markup and a client render of the SAME
 * compiled bundle. This is the corpus parity gate that decides the
 * RB_CLIENT_PREVIEW flip: any mismatch class must be understood (and
 * either fixed or added to the documented divergence classes) first.
 *
 * Usage:
 *   npx tsx qa/probe-client-parity.ts                  # fixture + 20-deck sample
 *   RB_PARITY_DECKS=all npx tsx qa/probe-client-parity.ts   # whole corpus
 *   RB_PARITY_DECKS=01K... npx tsx qa/probe-client-parity.ts # one deck
 */
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { chromium } from "playwright";
import { harness } from "./kit";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const FIXTURE = "01KZXQDA10N4EWYDPRTQSXDKSZ"; // the QA fixture deck
const MAX_SCENES = 14;

interface Parity {
  ok: boolean;
  match?: boolean;
  phase?: string;
  error?: string;
  ssrLen?: number;
  clientLen?: number;
  firstDiff?: number;
  ssrCtx?: string;
  clientCtx?: string;
}

const pickDecks = (): string[] => {
  const sel = process.env.RB_PARITY_DECKS ?? "";
  const genDir = join(process.cwd(), "src", "generated");
  const all = readdirSync(genDir).filter((d) =>
    existsSync(join(genDir, d, "Composition.tsx")),
  );
  if (sel === "all") return all;
  if (sel && sel !== "sample") return sel.split(",");
  // Deterministic sample: fixture first, then every 9th deck (~20).
  const sample = all.filter((_, i) => i % 9 === 0).slice(0, 20);
  return [FIXTURE, ...sample.filter((d) => d !== FIXTURE)];
};

const main = async () => {
  const h = harness();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const decks = pickDecks();
  console.log(`client-parity: ${decks.length} deck(s) against ${BASE}\n`);

  let scenesChecked = 0;
  let matched = 0;
  // scene 500s with or without hydrate — pre-existing deck breakage (e.g.
  // video-era useVideoConfig relics), not a parity signal
  let ssrBroken = 0;
  // designed fail-open: compile refused (422), SSR-only preview kept
  let bundleRejected = 0;
  const mismatches: { deck: string; scene: number; p: Parity }[] = [];
  const errors: { deck: string; scene: number; p: Parity }[] = [];
  let decksSkipped = 0;

  for (const deck of decks) {
    for (let scene = 0; scene < MAX_SCENES; scene++) {
      const url = `${BASE}/api/dev/${deck}/iframe?scene=${scene}&hydrate=1`;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
      if (!resp) { errors.push({ deck, scene, p: { ok: false, error: "nav timeout" } }); continue; }
      if (resp.status() === 404 && scene === 0) { decksSkipped++; break; } // not loadable under dev owner
      if (resp.status() === 400) break; // out of range — deck done
      if (resp.status() === 500) { ssrBroken++; continue; } // SSR itself fails — hydrate never entered
      if (!resp.ok()) { errors.push({ deck, scene, p: { ok: false, error: `HTTP ${resp.status()}` } }); continue; }

      const p = (await page
        .waitForFunction(
          () => {
            const w = window as unknown as { __rbParity?: { ok: boolean; error?: string } };
            return w.__rbParity && (w.__rbParity.ok || w.__rbParity.error) ? w.__rbParity : null;
          },
          { timeout: 20_000 },
        )
        .then((jh) => jh.jsonValue())
        .catch(() => null)) as Parity | null;

      scenesChecked++;
      if (!p) {
        errors.push({ deck, scene, p: { ok: false, error: "no __rbParity (bundle failed to load?)" } });
      } else if (!p.ok && /bundle did not attach/.test(p.error ?? "")) {
        // Distinguish the DESIGNED fail-open (bundle route refused the
        // compile — e.g. legacy decks importing lucide icons that no longer
        // exist; SSR keeps working) from a real attach bug (route served JS
        // that didn't run).
        // Fetched from the probe process (NOT page.evaluate) — the scene
        // doc's CSP blocks in-page connect, which read as a fake HTTP 0.
        const bundleStatus = await fetch(`${BASE}/api/dev/${deck}/scene-bundle`)
          .then((r) => r.status)
          .catch(() => 0);
        if (bundleStatus === 422) bundleRejected++;
        else errors.push({ deck, scene, p: { ...p, error: `${p.error} (bundle HTTP ${bundleStatus})` } });
      } else if (!p.ok) {
        errors.push({ deck, scene, p });
      } else if (p.match) {
        matched++;
      } else {
        mismatches.push({ deck, scene, p });
      }
    }
  }

  await browser.close();

  console.log(`scenes checked: ${scenesChecked}  matched: ${matched}  mismatched: ${mismatches.length}  errors: ${errors.length}  ssr-broken (pre-existing): ${ssrBroken}  bundle-rejected (fail-open): ${bundleRejected}  decks skipped (not dev-loadable): ${decksSkipped}`);
  for (const m of mismatches.slice(0, 10)) {
    console.log(`\n— MISMATCH ${m.deck} scene ${m.scene} (ssr ${m.p.ssrLen} vs client ${m.p.clientLen}, diff @${m.p.firstDiff})`);
    console.log(`  ssr:    …${m.p.ssrCtx}…`);
    console.log(`  client: …${m.p.clientCtx}…`);
  }
  for (const e of errors.slice(0, 10)) {
    console.log(`— ERROR ${e.deck} scene ${e.scene}: [${e.p.phase ?? "?"}] ${e.p.error}`);
  }

  // Durable verdict — the full mismatch/error detail survives any tail'd
  // console (a 30-line tail once ate the first mismatches of a 25-min run).
  const verdictPath = join(process.cwd(), ".data", "parity-verdict.json");
  mkdirSync(join(process.cwd(), ".data"), { recursive: true });
  writeFileSync(
    verdictPath,
    JSON.stringify(
      { decksProbed: decks.length, scenesChecked, matched, ssrBroken, bundleRejected, decksSkipped, mismatches, errors },
      null,
      1,
    ),
  );
  console.log(`verdict written: ${verdictPath}`);

  h.expect(scenesChecked > 0, `probed real scenes (${scenesChecked})`);
  h.expect(errors.length === 0, `zero probe errors (${errors.length})`);
  h.expect(mismatches.length === 0, `zero parity mismatches (${mismatches.length})`);
  process.exit(h.finish("client-parity"));
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
