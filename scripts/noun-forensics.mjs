// Catch a REAL failing outline and read what the counter actually saw.
//
// The whitelist theory came from concepts I wrote myself, which is a proxy.
// This runs cells until it catches a genuine failure, then prints the model's
// own visual_concept beside the tokens the counter credited — so the gap
// between "what a person would call drawable" and "what scores" is visible
// rather than argued.
//
//   set -a && source .env.local && set +a && node scripts/noun-forensics.mjs
//
import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

const OUT = join(process.cwd(), ".data", "outline-matrix");
mkdirSync(OUT, { recursive: true });
const build = async (entry, out) => {
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, packages: "external", logLevel: "silent" });
  return import(pathToFileURL(out).href);
};
const { generateScript } = await build("lib/agents/script-generator.ts", join(OUT, "gen2.mjs"));
const sv = await build("lib/agents/schema-validator.ts", join(OUT, "sv2.mjs"));

// The two shapes that failed in the baseline matrix, at the page counts they
// failed on — the cheapest way back to a real failure.
const TRANSCRIPT = [
  "Good morning everyone, and thank you for joining us today. We started from a simple observation: finance teams spend enormous time moving numbers between systems never designed to talk to each other.",
  "Reconciliation is manual. Approvals sit in inboxes. Month end is a fire drill everyone dreads and nobody questions, because that is how it has always been done.",
  "So we built something narrower than a platform and deeper than a tool. It connects to the ledgers you already use and reconciles continuously rather than in a panic at the end of the month.",
  "Early customers close in four days rather than eleven. One redeployed two full time roles into analysis. Another said their auditors asked what had changed.",
].join(" ");
const ABSTRACT = [
  "Our thesis is that the category confused activity with progress. Teams adopt tools that measure themselves, and the measurement becomes the work.",
  "What matters is the interval between a question being asked and the answer being trusted. Everything else is theatre. The interval collapses when the underlying record is continuously correct rather than periodically corrected.",
  "That belief shapes every decision about scope, pricing and pace, and it is why we said no to several obvious features that would have sold well and taught us nothing.",
].join(" ");

const CELLS = [
  { name: "transcript", text: TRANSCRIPT, pages: 6 },
  { name: "abstract", text: ABSTRACT, pages: 6 },
  { name: "transcript", text: TRANSCRIPT, pages: 6 },
  { name: "abstract", text: ABSTRACT, pages: 6 },
  { name: "transcript", text: TRANSCRIPT, pages: 12 },
  { name: "abstract", text: ABSTRACT, pages: 12 },
];

const caught = [];
for (const [i, c] of CELLS.entries()) {
  process.stdout.write(`${i + 1}/${CELLS.length} ${c.name} x${c.pages}p … `);
  const r = await generateScript(
    {
      id: `forensic-${i}`, owner_id: "forensic", purpose: c.text.slice(0, 200),
      freeform_prompt: c.text, kind: "deck", distribution_format: "landscape",
      duration_seconds: c.pages * 5, moments: [], cta: "",
      created_at: new Date().toISOString(), status: "awaiting_agent_1",
      script_id: `forensic-script-${i}`, moment_count: c.pages,
    },
    `forensic-${i}`,
  );
  if (r.ok) { console.log("ok"); continue; }
  console.log("FAILED");
  // Print the WHOLE complaint. The first version of this probe printed only
  // the evidence and silently told me nothing when evidence was empty — which
  // is exactly the case worth seeing, because an empty evidence list means the
  // failure was NOT the drawable-noun floor.
  console.log(`  error: ${r.error}`);
  console.log(`  evidence entries: ${(r.evidence ?? []).length}`);
  for (const ev of r.evidence ?? []) {
    const vc = ev.visual_concept ?? "";
    // What the counter credited, and on which vocabulary.
    const plain = sv.countDrawableNouns(vc);
    const poster = sv.countDrawableNouns(vc, "quote");
    caught.push({ cell: `${c.name} x${c.pages}p`, ...ev, plain, poster });
    console.log(`\n  ── scene ${ev.scene} "${ev.label}" · ${vc.length} chars · counted ${plain} (poster vocab: ${poster})`);
    console.log(`  ${vc}\n`);
  }

}

writeFileSync(join(OUT, "forensics.json"), JSON.stringify(caught, null, 2));
console.log(caught.length ? `\ncaptured ${caught.length} failing scene(s) → .data/outline-matrix/forensics.json` : "\nno failure caught in this batch");
