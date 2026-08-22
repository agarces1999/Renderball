//
// One-time repair: reissue the <Img> shim into already-built decks.
//
// WHY. script.assets.images is an array of OBJECTS ({ id, src, width, height }).
// A shipped Linear deck reached into it with
//
//   images.find((u) => typeof u === "string" && u.includes("og_image")) || images[0]
//
// — a string predicate that can never match an object array — so it fell through to
// images[0] and handed the whole object to <Img src>. React stringified it to
// "[object Object]", the browser fetched a URL that cannot exist, and slide 4 showed
// an empty framed box with a caption badge floating on it. The correct og_image URL
// (https://linear.app/static/og/homepage.jpg) was in the manifest the entire time.
//
// The shim now coerces an asset object to its .src, so no upstream shape mistake can
// reach the DOM as a broken image. New builds get it from IMG_SHIM_SOURCE; decks
// already on disk need this pass, because their Img.tsx was written at build time.
//
// SAFETY. Only files whose bytes match a KNOWN previous shim are replaced. Anything
// else — notably five video-era decks that re-export Remotion's Img — is reported and
// left untouched. Recognise-then-replace, never blind-overwrite.
//
//   npx tsx scripts/migrate-img-shim.ts --check   # report only
//   npx tsx scripts/migrate-img-shim.ts           # apply
//
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";
import { IMG_SHIM_SOURCE } from "../lib/render/build-wrapper";

const ROOT = path.join(process.cwd(), "src", "generated");
const CHECK = process.argv.includes("--check");

/** sha1 of every shim this repo has emitted and may safely replace. */
const REPLACEABLE = new Set([
  "2a17dd0d3069abfc5692b77f79f71e2996b2fce6", // plain passthrough, pre-coercion
]);

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

const main = async (): Promise<void> => {
  const target = sha1(IMG_SHIM_SOURCE);
  let scanned = 0, already = 0, updated = 0;
  const skipped: string[] = [];

  for (const id of await fs.readdir(ROOT)) {
    const file = path.join(ROOT, id, "Img.tsx");
    let body: string;
    try {
      body = await fs.readFile(file, "utf8");
    } catch {
      continue; // deck has no wrapper (never built, or partially cleaned)
    }
    scanned++;
    const h = sha1(body);
    if (h === target) {
      already++;
    } else if (REPLACEABLE.has(h)) {
      if (!CHECK) await fs.writeFile(file, IMG_SHIM_SOURCE, "utf8");
      updated++;
    } else {
      skipped.push(`${id} (sha1 ${h.slice(0, 8)})`);
    }
  }

  console.log(`Img.tsx across ${scanned} deck(s)`);
  console.log(`  already current   ${already}`);
  console.log(`  ${CHECK ? "would update" : "updated     "}      ${updated}`);
  console.log(`  left alone        ${skipped.length}`);
  if (skipped.length) {
    console.log("\nUnrecognised — NOT touched (add the hash to REPLACEABLE only after reading one):");
    for (const s of skipped.slice(0, 10)) console.log(`  ${s}`);
    if (skipped.length > 10) console.log(`  … and ${skipped.length - 10} more`);
  }
};

void main();
