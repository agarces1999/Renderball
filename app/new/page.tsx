import { BriefForm } from "./BriefForm";
import { AppHeader } from "../../components/AppHeader";

/**
 * /new — the front door (fluid v1).
 *
 * The BriefForm renders a self-contained, centered front door (orb +
 * "Design your business story" + one prompt) floating on an emerald mesh
 * field. The old "step 1 / step 2" indicator is gone — story-first means
 * no upfront wizard framing.
 */
export default function NewBriefPage({
  searchParams,
}: {
  searchParams: { prompt?: string; url?: string };
}) {
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
      />
    </main>
  );
}
