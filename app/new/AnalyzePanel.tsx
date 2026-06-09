"use client";

import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";

/**
 * Progress panel shown while the setup agent runs.
 *
 * Two parallel timelines:
 *   • Visual step animation (timer-based, fixed pace per step)
 *   • Real agent work (the setup-action promise)
 *
 * The component holds the last step in "in progress" until the agent
 * resolves. This way:
 *   - If the agent is fast, the user still sees the full ceremony.
 *   - If the agent is slow, the last step keeps a spinner instead of
 *     freezing.
 *
 * When BOTH the animation has reached the last step AND the agent has
 * finished, `onDone` fires. The parent then transitions to review.
 */

export type AnalyzeStep = {
  id: string;
  label: string;
};

type Status = "pending" | "active" | "done";

const STEP_DURATION_MS = 1500;

export function AnalyzePanel({
  steps,
  isAgentDone,
  agentError,
  onDone,
}: {
  steps: AnalyzeStep[];
  isAgentDone: boolean;
  agentError: string | null;
  onDone: () => void;
}) {
  // currentStep is the index of the step that is currently "active".
  // Steps before it are "done". Steps after it are "pending".
  const [currentStep, setCurrentStep] = useState(0);

  const isLastStep = currentStep === steps.length - 1;
  const finished = currentStep >= steps.length;

  // Advance the visual animation. The last step waits for agent.
  useEffect(() => {
    if (finished) return;
    if (isLastStep && !isAgentDone) return; // Hold spinner on last step.

    const t = setTimeout(() => {
      setCurrentStep((s) => s + 1);
    }, STEP_DURATION_MS);
    return () => clearTimeout(t);
  }, [currentStep, finished, isLastStep, isAgentDone]);

  // When everything is done, fire onDone exactly once.
  useEffect(() => {
    if (finished && isAgentDone && !agentError) {
      onDone();
    }
  }, [finished, isAgentDone, agentError, onDone]);

  if (agentError) {
    return (
      <div className="py-10">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-2 w-2 rounded-full bg-red-500" />
          <span className="text-xs uppercase tracking-widest text-red-500">
            something went wrong
          </span>
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-ink mb-2">
          The setup agent hit an error
        </h2>
        <pre className="mt-4 p-4 rounded-lg bg-red-500/5 ring-1 ring-red-500/30 text-sm font-mono text-red-500 whitespace-pre-wrap break-words">
          {agentError}
        </pre>
        <div className="mt-4 text-xs text-muted">
          You can scroll up to edit your prompt and try again.
        </div>
      </div>
    );
  }

  const completedCount = currentStep + (finished ? 0 : 0);
  const pct = Math.min(
    100,
    ((completedCount + (isLastStep && !isAgentDone ? 0.5 : 0)) / steps.length) *
      100,
  );

  return (
    <div className="py-6">
      <div className="flex items-center gap-3 mb-5">
        <Spinner small />
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-ink">
            Drafting your script
          </h2>
          <p className="text-sm text-ink-soft mt-0.5">
            We're reading your inputs and shaping the first draft.
          </p>
        </div>
      </div>

      <div className="h-1 rounded-full bg-surface-3 overflow-hidden mb-6">
        <div
          className="h-full bg-accent transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="space-y-2">
        {steps.map((step, i) => {
          const status: Status = finished
            ? "done"
            : i < currentStep
              ? "done"
              : i === currentStep
                ? "active"
                : "pending";
          return <StepRow key={step.id} label={step.label} status={status} />;
        })}
      </ul>
    </div>
  );
}

function StepRow({ label, status }: { label: string; status: Status }) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 px-4 py-2.5 rounded-lg ring-1 transition-colors",
        status === "done" && "bg-accent-soft ring-accent-line",
        status === "active" && "bg-surface-2 ring-[var(--hairline)]",
        status === "pending" && "bg-surface-2 ring-[var(--hairline)] opacity-60",
      )}
    >
      <StatusDot status={status} />
      <span
        className={cn(
          "text-sm",
          status === "done" ? "text-ink" : "text-ink-soft",
          status === "active" && "font-medium",
        )}
      >
        {label}
        {status === "active" && <span className="text-muted">…</span>}
      </span>
    </li>
  );
}

function StatusDot({ status }: { status: Status }) {
  if (status === "done") {
    return (
      <div className="h-6 w-6 rounded-full bg-accent flex items-center justify-center shrink-0">
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M2.5 6.5L5 9L9.5 3.5"
            stroke="var(--accent-ink)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }
  if (status === "active") {
    return (
      <div className="h-6 w-6 rounded-full ring-2 ring-accent/30 flex items-center justify-center shrink-0">
        <Spinner small />
      </div>
    );
  }
  return <div className="h-6 w-6 rounded-full bg-surface-3 shrink-0" />;
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? "h-4 w-4" : "h-6 w-6";
  return (
    <svg
      className={cn(size, "animate-spin text-accent")}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

/**
 * Build the list of steps shown to the user based on what they
 * provided. Order: read prompt → read website → review files →
 * draft script. The LAST step is always "Drafting your script" so
 * the spinner stays on it while the agent runs.
 */
export function computeAnalyzeSteps({
  hasWebsite,
  fileCount,
}: {
  hasWebsite: boolean;
  fileCount: number;
}): AnalyzeStep[] {
  const steps: AnalyzeStep[] = [
    { id: "read_inputs", label: "Reading your description" },
  ];
  if (hasWebsite) {
    steps.push({ id: "read_site", label: "Reading your website" });
    steps.push({ id: "find_brand", label: "Finding your brand voice" });
  }
  if (fileCount > 0) {
    steps.push({
      id: "review_files",
      label: `Reviewing your ${fileCount === 1 ? "brand file" : `${fileCount} brand files`}`,
    });
  }
  steps.push({ id: "draft", label: "Drafting your script" });
  return steps;
}
