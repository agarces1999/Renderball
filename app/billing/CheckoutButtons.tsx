"use client";

import { useState } from "react";

/** POST to a billing endpoint and follow the returned hosted-checkout URL. */
function useRedirectAction(path: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? "Something went wrong.");
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return { go, busy, error };
}

export function SubscribeButton() {
  const { go, busy, error } = useRedirectAction("/api/billing/checkout");
  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-block rounded-full bg-accent px-4 py-2 text-[13.5px] font-semibold text-accent-ink transition-all hover:brightness-110 disabled:opacity-60"
      >
        {busy ? "Opening checkout…" : "Subscribe →"}
      </button>
      {error && <p className="mt-2 text-[12.5px] text-red-500">{error}</p>}
    </div>
  );
}

export function ManageBillingButton() {
  const { go, busy, error } = useRedirectAction("/api/billing/portal");
  return (
    <div>
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className="inline-block rounded-md border border-hairline bg-surface px-4 py-2 text-[13.5px] font-semibold text-ink transition-all hover:bg-surface-2 disabled:opacity-60"
      >
        {busy ? "Opening portal…" : "Manage subscription"}
      </button>
      {error && <p className="mt-2 text-[12.5px] text-red-500">{error}</p>}
    </div>
  );
}
