//
// Repair generated code that searches the image manifest for STRINGS.
//
// `script.assets.images` is an array of objects — `{ id, src, width, height }`. A
// shipped Linear deck wrote, in its scene shell:
//
//   const images = Array.isArray(script.assets?.images) ? script.assets.images : [];
//   const ogImage = images.find((u: any) => typeof u === "string" && u.includes("og_image")) || images[0];
//
// `typeof u === "string"` can never hold for an object, so the find always returned
// undefined and the expression fell through to `images[0]` — the wrong asset, and an
// object rather than a URL. Slide 4 rendered an empty framed box; the correct
// og_image URL was in the manifest the whole time.
//
// The <Img> shim now coerces an asset object to its .src, so this can no longer
// produce a BROKEN image (lib/render/build-wrapper.ts). That is the safety net. This
// is the correctness fix: without it the slide loads the wrong picture — for the
// Linear deck, a 180x180 favicon stretched across an 800x130 strip — which is not
// what "fixed" means.
//
// Deliberately narrow. It rewrites exactly the shape above, with the asset id read
// out of the model's own `.includes("...")` argument, and only when that id is
// really in the deck's manifest. Anything it does not recognise is left alone and
// reported. New builds do not need it: the generation prompt now states the element
// shape (lib/agents/pipeline.ts).
//
import { readManifest, writeManifest } from "../agents/lego-store";
import { commitGenDir } from "./commit";

/**
 * `images.find((u: any) => typeof u === "string" && u.includes("ID")) || images[0]`
 *
 * Capture groups: 1 = the array identifier, 2 = the asset id, 3 = the fallback tail
 * exactly as written, so a deck without the `|| images[0]` half still matches.
 */
const STRING_PREDICATE =
  /(\w+)\s*\.find\(\s*\(\s*(\w+)\s*(?::\s*any\s*)?\)\s*=>\s*typeof\s+\2\s*===\s*["']string["']\s*&&\s*\2\s*\.includes\(\s*["']([^"']+)["']\s*\)\s*\)(\s*\|\|\s*\1\s*\[\s*0\s*\])?/g;

export interface AssetLookupRepair {
  /** The asset id the original code was reaching for. */
  assetId: string;
  before: string;
  after: string;
}

/**
 * Rewrite every string-predicate asset lookup in `source`.
 *
 * `knownIds` is the deck's actual manifest ids. A lookup for an id the deck does not
 * have is NOT rewritten — that is a different bug (a reference to a missing asset)
 * and silently repointing it would hide it.
 */
export const repairAssetLookups = (
  source: string,
  knownIds: ReadonlySet<string>,
): { source: string; repairs: AssetLookupRepair[] } => {
  const repairs: AssetLookupRepair[] = [];
  const out = source.replace(
    STRING_PREDICATE,
    (match, arr: string, _param: string, assetId: string, fallback: string | undefined) => {
      if (!knownIds.has(assetId)) return match;
      // `?? ` not `|| `: an empty-string src should still fall through, and both
      // halves now yield `string | undefined` rather than an object.
      const replacement =
        `${arr}.find((a: any) => a?.id === ${JSON.stringify(assetId)})?.src` +
        (fallback ? ` ?? ${arr}[0]?.src` : "");
      repairs.push({ assetId, before: match, after: replacement });
      return replacement;
    },
  );
  return { source: out, repairs };
};

/**
 * Apply the repair to one deck's stored scene templates, then reassemble.
 *
 * Templates, not piece bodies: the faulty `const ogImage = …` lives in the scene
 * shell, above the JSX, which is why regenerating the element would not have fixed
 * it. Returns the repairs made so the caller can report rather than guess.
 */
export const repairDeckAssetLookups = async (
  genDir: string,
  opts: { dryRun?: boolean } = {},
): Promise<AssetLookupRepair[]> => {
  const manifest = await readManifest(genDir);
  const knownIds = new Set<string>();
  // Ids come from the deck's own script, which the manifest does not carry — read it
  // from the gen dir so the check is against reality, not against a guess.
  try {
    const script = JSON.parse(
      await (await import("fs")).promises.readFile(`${genDir}/script.json`, "utf8"),
    ) as { assets?: { images?: { id?: string }[] } };
    for (const a of script.assets?.images ?? []) if (a?.id) knownIds.add(a.id);
  } catch {
    return []; // no script, no way to validate an id — do nothing
  }

  const all: AssetLookupRepair[] = [];
  let changed = false;
  for (const scene of manifest.scenes) {
    const template = (scene as { template?: string }).template;
    if (typeof template !== "string" || !template.includes(".find(")) continue;
    const { source, repairs } = repairAssetLookups(template, knownIds);
    if (!repairs.length) continue;
    all.push(...repairs);
    if (!opts.dryRun) {
      (scene as { template?: string }).template = source;
      changed = true;
    }
  }
  if (changed) {
    await writeManifest(genDir, manifest);
    // commitGenDir, NOT reassembleFromDisk: the latter RETURNS the composition and
    // writes nothing, so an earlier version of this repair edited the manifest and
    // left Composition.tsx — the file the preview and the renderer actually read —
    // untouched. Committing also type-checks the result and rolls back on failure,
    // which is what the editor's own edit paths do.
    const res = await commitGenDir(genDir, "asset lookup repair", { checkRender: true });
    if (!res.ok) throw new Error(`repair did not compile: ${res.error}`);
  }
  return all;
};
