import { notFound } from "next/navigation";
import { LandingEditor } from "../../../components/LandingEditor";

/**
 * Dev-only preview of the editor-shell landing (docs/PIVOT.md landing work).
 *
 * Lets the new landing be built and reviewed side by side with the live one
 * at `/` before anything is swapped — the production landing keeps serving
 * the version that's already approved until this earns the swap.
 */
export const dynamic = "force-dynamic";

export default function DevLandingPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="min-h-screen bg-canvas">
      <LandingEditor />
    </div>
  );
}
