"use client";

import { useState } from "react";

/**
 * Shown on /preview/[id] when no Composition.tsx exists yet. Lets the
 * user kick off the Design + Choreography pass (no MP4 capture) and
 * reloads the page when it lands — at which point the real
 * PreviewClient takes over.
 *
 * Iteration cost: ~30-60s for the agents only, much cheaper than the
 * full MP4 path. The user iterates on the design here, then commits
 * to MP4 capture via the "Render to MP4 →" link inside PreviewClient.
 */
export function BuildPreviewClient({ scriptId }: { scriptId: string }) {
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBuild = async () => {
    setBuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/preview/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scriptId }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`build failed (${res.status}): ${txt}`);
      }
      // Hard reload — webpack picks up the newly-written Composition.tsx
      // and the server component re-evaluates the file-exists guard.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBuilding(false);
    }
  };

  return (
    <div className="rounded-xl bg-yellow-50 ring-1 ring-yellow-200 p-6">
      <div className="text-sm font-semibold text-yellow-900 mb-2">
        No composition built yet for this script.
      </div>
      <p className="text-sm text-yellow-900 leading-relaxed mb-4">
        Click below to run the Design + Choreography passes. Typically
        60–120s (one shot, no retries). Output is written to{" "}
        <code className="font-mono text-xs bg-yellow-100 px-1 py-0.5 rounded">
          src/generated/{scriptId}/Composition.tsx
        </code>{" "}
        and the preview becomes available.
      </p>

      <button
        type="button"
        onClick={handleBuild}
        disabled={building}
        className="px-4 py-2 rounded-md bg-yellow-600 text-white text-sm font-medium hover:bg-yellow-700 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {building ? "Building… (60–120s)" : "Build preview"}
      </button>

      {building && (
        <p className="mt-3 text-xs text-yellow-800">
          Running Pass 1 (Design Agent) then Pass 2 (Choreography Agent). The
          page will reload automatically when ready.
        </p>
      )}

      {error && (
        <div className="mt-4 p-3 rounded-md bg-red-50 ring-1 ring-red-200 text-xs font-mono text-red-900 whitespace-pre-wrap">
          {error}
        </div>
      )}
    </div>
  );
}
