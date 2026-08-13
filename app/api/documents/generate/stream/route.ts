import { getCurrentUser } from "../../../../../lib/auth";
import { loadBriefByScriptId } from "../../../../../lib/store";
import { subscribeOutlineStream } from "../../../../../lib/render/outline-stream";

/**
 * SSE relay for the outline ceremony (2026-08-14): the text of the outline as
 * the model writes it, so the panel types it live. Sibling of the poll in
 * ../route.ts — the poll owns truth (done / failed / review URL), this owns
 * theater. A client that never connects here, or gets cut off, loses nothing
 * but the show.
 *
 * GET /api/documents/generate/stream?scriptId=…&from=N
 *   data: {"i":0,"kind":"note","data":"thinking"}
 *   data: {"i":1,"kind":"delta","data":"{\"scenes\":[{\"label\":\"The"}
 *   …
 *   data: {"i":N,"kind":"note","data":"done"}        ← then the stream ends
 *
 * `from` replays from that event index (a reload reattaches without a gap).
 * 404 = no live stream in this process (restart, other container, or the job
 * predates the feature) — the panel falls back to its paced steps.
 *
 * Heartbeats every 15s: GLM thinks silently for its first ~half-minute, and
 * both Cloudflare and the browser will kill a connection that looks dead
 * exactly when the ceremony needs it to survive.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const url = new URL(request.url);
  const scriptId = url.searchParams.get("scriptId");
  if (!scriptId) return new Response("scriptId required", { status: 400 });
  const from = Math.max(0, Number(url.searchParams.get("from")) || 0);

  const owned = await loadBriefByScriptId(scriptId, user.id);
  if (!owned) return new Response("not found", { status: 404 });

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const shutdown = () => {
        if (!open) return;
        open = false;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (payload: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The client went away mid-write; stop relaying.
          shutdown();
        }
      };

      const relay = (ev: Parameters<Parameters<typeof subscribeOutlineStream>[2]>[0]) => {
        send(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.kind === "note" && ev.data === "done") shutdown();
      };
      let unsubscribe = subscribeOutlineStream(scriptId, from, relay);
      if (!unsubscribe) {
        // Not here YET is the common case, not the error case: the panel's
        // EventSource beats the job's preamble (auth, gates, a Neon read can
        // take seconds) to this route. Wait out the race before declaring
        // the stream unavailable — a client told "unavailable" latches into
        // the paced fallback and never sees the typing.
        const GRACE_MS = 12_000;
        const tWait = Date.now();
        const poll = setInterval(() => {
          if (!open) {
            clearInterval(poll);
            return;
          }
          unsubscribe = subscribeOutlineStream(scriptId, from, relay);
          if (unsubscribe) {
            clearInterval(poll);
            heartbeat = setInterval(() => send(": hb\n\n"), 15_000);
            return;
          }
          if (Date.now() - tWait > GRACE_MS) {
            clearInterval(poll);
            send(`data: ${JSON.stringify({ i: -1, kind: "note", data: "unavailable" })}\n\n`);
            shutdown();
          }
        }, 400);
        cleanup = () => {
          clearInterval(poll);
          shutdown();
        };
        return;
      }
      heartbeat = setInterval(() => send(": hb\n\n"), 15_000);
      cleanup = shutdown;
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Any buffering hop between here and the browser turns typing into one
      // big paste. Local dev proved the relay; this header asks nginx-shaped
      // proxies to leave the stream alone, and the client's paced-steps
      // fallback covers whatever refuses.
      "X-Accel-Buffering": "no",
    },
  });
}
