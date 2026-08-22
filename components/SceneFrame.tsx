"use client";

//
// The slide iframe, and the one place that decides how big it is.
//
// Four surfaces embed a scene document — the production editor, the dev editor, the
// preview surface and the share viewer — and each wrote its own `position:absolute;
// inset:0; width:100%; height:100%`. That was fine while the DOCUMENT scaled itself.
// It stops being fine the moment the host owns the scale, because then the same
// twenty lines of measure-and-transform would land in four files and drift.
//
// So the frame lives here, both modes behind one prop-free flag:
//
//   RB_HOST_SCALE off (default)  the iframe fills its container and the scene
//                                document's own fit() scales the canvas inside it.
//                                Byte-for-byte the behaviour that ships today.
//   RB_HOST_SCALE on             the iframe is sized to the canvas EXACTLY and this
//                                component scales the whole element. The document
//                                inside is always 1:1.
//
// Why that matters is in lib/edit/frame-scale.ts: with the scale inside the document,
// the editor could only discover it by measuring a foreign DOM — falling back to 1
// when it could not, which halved every drawn box — and the morph path's ancestor sync
// could erase it, snapping the slide to 1:1 ("everything expanded again"). A scale the
// host SETS cannot be unmeasurable and cannot be synced away.
//
// The editor does not need this component to tell it the scale: it derives the same
// number from the same container with the same pure `fitFrame`, so there is no prop to
// thread and nothing to fall out of step.
//
import React, { useCallback, useEffect, useRef, useState } from "react";
import { fitFrame, type FrameFit } from "../lib/edit/frame-scale";

export interface SceneFrameProps {
  src: string;
  title: string;
  /** Intrinsic slide size in canvas px. */
  canvas: { w: number; h: number };
  /**
   * Host-scaling mode. Defaults to the flag, so a host embeds the frame without
   * threading anything. Only pass it to force a mode (tests, a single surface being
   * migrated ahead of the rest).
   */
  hostScale?: boolean;
  /** The iframe element, for the editor's overlay and DOM surgery. */
  iframeRef?: React.Ref<HTMLIFrameElement>;
  /** Painted behind the slide — the host owns the letterbox colour, never the doc. */
  background?: string;
  className?: string;
  /**
   * Anything else the host needs on the <iframe> itself — `onLoad`, a data attribute,
   * an opacity transition. One escape hatch beats four special-cased props, and every
   * embedding site needed something different.
   *
   * `style` here is MERGED UNDER ours: a host may tint or fade the frame, but the
   * geometry (size, transform, visibility) belongs to this component. A host that
   * could override `transform` would silently reintroduce the double-scaling this
   * whole change exists to remove.
   */
  iframeProps?: Omit<React.IframeHTMLAttributes<HTMLIFrameElement>, "src" | "title" | "ref"> &
    // data-* attributes are how the build surface finds its own frames
    // (`[data-rb-build-iframe]`); React allows them on an element but the typed
    // attribute map does not enumerate them.
    Record<`data-${string}`, string | number | boolean | undefined>;
}

/**
 * The flag, read the way Next.js requires in a client bundle.
 *
 * `process.env.NEXT_PUBLIC_*` is inlined at build time ONLY as a literal member
 * access — handing `process.env` to a helper does not work in the browser, because the
 * object itself is not shipped. So the literal lives here and the shared predicate is
 * given just the value it needs.
 */
const FLAG_ON = ["on", "1", "true", "yes"].includes(
  String(process.env.NEXT_PUBLIC_RB_HOST_SCALE ?? "").trim().toLowerCase(),
);

export const SceneFrame: React.FC<SceneFrameProps> = ({
  src,
  title,
  canvas,
  hostScale = FLAG_ON,
  iframeRef,
  background,
  className,
  iframeProps,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<FrameFit | null>(null);

  const remeasure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFit(fitFrame({ w: r.width, h: r.height }, canvas));
  }, [canvas]);

  useEffect(() => {
    if (!hostScale) return;
    remeasure();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      // No observer (older engine, or not mounted): a window listener still catches
      // the common case. Better a coarser trigger than a frame frozen at first paint.
      window.addEventListener("resize", remeasure);
      return () => window.removeEventListener("resize", remeasure);
    }
    const ro = new ResizeObserver(remeasure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hostScale, remeasure]);

  // LEGACY: unchanged from what every host wrote by hand.
  if (!hostScale) {
    return (
      <div ref={containerRef} className={className} style={{ position: "absolute", inset: 0, background }}>
        <iframe
          {...iframeProps}
          ref={iframeRef}
          src={src}
          title={title}
          style={{
            ...iframeProps?.style,
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
          }}
        />
      </div>
    );
  }

  // HOST-SCALED: the frame is canvas-sized and transformed as a whole. Until the first
  // measurement lands the frame is hidden rather than shown at 1:1 — a 1920px slide
  // flashing at full size in a 1000px pane is the exact "everything expanded" artefact
  // this change exists to remove.
  return (
    <div
      ref={containerRef}
      className={className}
      // absolute + inset-0, which is what all seven hand-written frames used. The
      // percentage alternative looks more portable and is not: `height: 100%` needs a
      // parent with a DEFINITE height, and the editor shell sizes its canvas area by
      // positioning rather than by height — so the wrapper measured 0x0, fitFrame
      // correctly returned null, and the slide stayed hidden. Measured, not reasoned.
      // Every embedding parent is positioned; the one that was not now says so.
      style={{ position: "absolute", inset: 0, overflow: "hidden", background }}
    >
      <iframe
        {...iframeProps}
        ref={iframeRef}
        src={src}
        title={title}
        style={{
          ...iframeProps?.style,
          position: "absolute",
          left: 0,
          top: 0,
          width: canvas.w,
          height: canvas.h,
          border: 0,
          transformOrigin: "top left",
          transform: fit ? `translate(${fit.left}px, ${fit.top}px) scale(${fit.scale})` : undefined,
          visibility: fit ? "visible" : "hidden",
        }}
      />
    </div>
  );
};
