"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The visual for a gallery card. Leads with the work and stays light:
 *   - thumbUrl present → the document's cached page-1 PNG (deck cards); if the
 *                        image fails to load, falls back to the orb alone —
 *                        thumbUrl only exists for built documents, so the
 *                        "Not built yet" caption would state the opposite of
 *                        the truth.
 *   - mp4Url present  → the rendered video, muted + looping, autoplays while
 *                       it's in view (paused when it scrolls away) so the grid
 *                       shows the actual output playing.
 *   - previewUrl only → a branded placeholder; on hover it mounts the live
 *                       composition preview (server-compiled scene), so the
 *                       heavier previews only load when you point at a card.
 *   - none            → branded placeholder (not built yet).
 *
 * Sized to the project's true aspect so portrait/square/landscape read at a
 * glance. Dark frame so the work is the loudest thing on the card.
 */
export function ProjectThumb({
  aspect,
  mp4Url,
  previewUrl,
  thumbUrl = null,
}: {
  aspect: string; // "9:16" | "1:1" | "16:9"
  mp4Url: string | null;
  previewUrl: string | null;
  thumbUrl?: string | null;
}) {
  const ar = (aspect || "16:9").replace(":", " / ");
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  // Autoplay the rendered video while it's on screen; pause when it leaves.
  // Keeps motion to what the viewer is actually looking at.
  useEffect(() => {
    if (!mp4Url) return;
    const el = wrapRef.current;
    const v = videoRef.current;
    if (!el || !v) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void v.play().catch(() => {});
          else v.pause();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mp4Url]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden bg-[#0b0d12]"
      style={{ aspectRatio: ar }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {thumbUrl && !thumbFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setThumbFailed(true)}
          // Fade in over the dark placeholder instead of popping — the load
          // itself is now usually instant (R2-persisted, immutable-cached),
          // and the fade makes the residual cold case read as intentional.
          style={{ animation: "rb-thumb-in 0.35s ease" }}
          className="h-full w-full object-cover"
        />
      ) : mp4Url ? (
        <video
          ref={videoRef}
          src={`${mp4Url}#t=0.1`}
          muted
          loop
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
      ) : previewUrl && hover ? (
        <iframe
          src={previewUrl}
          title="preview"
          className="h-full w-full border-0"
          style={{ background: "#0b0d12" }}
        />
      ) : (
        // A thumbUrl that failed to load still means the document is built —
        // no caption is honest; "Not built yet" would be a lie.
        <Placeholder hint={thumbUrl ? null : previewUrl ? "Hover to preview" : "Not built yet"} />
      )}
    </div>
  );
}

function Placeholder({ hint }: { hint: string | null }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
      <span className="orb h-10 w-10" aria-hidden />
      {hint && (
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
          {hint}
        </span>
      )}
    </div>
  );
}
