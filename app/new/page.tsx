import { BriefForm } from "./BriefForm";
import { AppHeader } from "../../components/AppHeader";
import { getCurrentUser } from "../../lib/auth";
import { listBrandKitSummaries, type BrandKitSummary } from "../../lib/brand-kits";

/**
 * /new — the front door (fluid v1).
 *
 * The BriefForm renders a self-contained, centered front door (orb +
 * "Design your business story" + one prompt) floating on an emerald mesh
 * field. The old "step 1 / step 2" indicator is gone — story-first means
 * no upfront wizard framing.
 */
export default async function NewBriefPage({
  searchParams,
}: {
  searchParams: { prompt?: string; url?: string };
}) {
  // Saved brand kits for the picker (canvas pivot: kit reuse across
  // documents). Best-effort — the kit rail must never break the front door
  // (signed-out or a cold DB just means no picker).
  let savedKits: BrandKitSummary[] = [];
  try {
    const user = await getCurrentUser();
    if (user) savedKits = await listBrandKitSummaries(user.id);
  } catch {
    savedKits = [];
  }
  return (
    // Emerald mesh field (see globals.css → .brand-field) lives on <main>
    // so it paints over body's grey canvas. A deliberate, approved deviation
    // from DESIGN.md's quiet-chrome rule, scoped to the front door; the rest
    // of the app keeps the greyscale chrome.
    <main className="brand-field relative min-h-screen">
      <AppHeader tone="light" />
      <BriefForm
        initialPrompt={searchParams.prompt ?? ""}
        initialUrl={searchParams.url ?? ""}
        savedKits={savedKits}
      />
    </main>
  );
}
