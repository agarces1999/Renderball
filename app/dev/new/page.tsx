import { notFound } from "next/navigation";
import { BriefForm } from "../../new/BriefForm";

/**
 * Dev-only front-door harness (NODE_ENV-gated, mirrors /dev/edit). Renders
 * the /new BriefForm with no Clerk session so the front door — including the
 * "continue what you started" banner seeded by the landing-canvas sandbox —
 * can be exercised headlessly (Playwright) without auth.
 * GET /dev/new
 */
export default function DevNewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="brand-field relative min-h-screen">
      <BriefForm />
    </main>
  );
}
