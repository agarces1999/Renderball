//
// The quality-notes panel, shared by BOTH editor surfaces.
//
// It lived inside PreviewClient, so /preview showed a document's unresolved
// findings and /dev/edit — the surface the entire QA suite drives — showed
// nothing at all. That is not a cosmetic difference: it meant no QA flow could
// ever have caught a build recording a defect that reached no human, which is
// exactly the failure that shipped a visible page-2 collision as "checks
// passed" on 2026-08-21. A harness that cannot see the channel cannot test it.
//
// One definition, imported by both, so the two surfaces cannot drift again.
//
"use client";

export function StructuralPanel({ issues }: { issues: string[] }) {
  return (
    <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/5 p-4">
      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-red-500">
        Unresolved structural issues ({issues.length})
      </div>
      <div className="mb-2.5 text-[12px] text-ink-soft">
        These failed the build&apos;s structural quality gates and survived
        every automatic retry — the design shipped with them. Regenerate the
        affected page or scene, or rebuild, to clear them.
      </div>
      <ul className="space-y-1">
        {issues.slice(0, 10).map((issue, i) => {
          const sep = issue.indexOf(":");
          const gate = sep > 0 ? issue.slice(0, sep) : null;
          const detail = sep > 0 ? issue.slice(sep + 1).trim() : issue;
          return (
            <li key={i} className="flex items-baseline gap-2 text-[12px]">
              <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full bg-red-500" />
              {gate && (
                <span className="shrink-0 font-mono text-[11px] text-red-500">
                  {gate}
                </span>
              )}
              <span className="text-ink-soft">{detail}</span>
            </li>
          );
        })}
        {issues.length > 10 && (
          <li className="font-mono text-[11px] text-muted">
            +{issues.length - 10} more in warnings.json
          </li>
        )}
      </ul>
    </div>
  );
}
