// Auto-generated wrapper. Do not edit.
// The agents' Composition.tsx is pure React + CSS. This file wraps each
// per-section component in a Remotion <Sequence> for the capture layer.
import React from "react";
import {
  Composition,
  registerRoot,
  Sequence,
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  getRemotionEnvironment,
} from "remotion";
import * as Sections from "./Composition";
import script from "./script.json";

// Resolve the section component by index, tolerating naming-style drift.
function pickSection(mod: any, i: number): React.FC<any> | undefined {
  const candidates = [
    `Section${i}`,
    `Scene${i}Slide`,
    `Scene${i}`,
    `Slide${i}`,
  ];
  for (const name of candidates) {
    if (typeof mod[name] === "function") return mod[name];
  }
  return undefined;
}

// ── Deterministic CSS-animation clock (render path only) ────────────────────
// The agents' sections animate with plain CSS (@keyframes + animation), which
// runs on the WALL clock. The renderer captures frames on the FRAME clock —
// Chromium's animation timeline does not advance in lockstep with captured
// frames, so animations with longer delays (empirically >= ~2.3s) never
// reached their active phase in the MP4 while the live preview played them:
// approved content silently vanished from the export.
//
// Fix: when (and ONLY when) Remotion is rendering, pin every Web Animations
// API animation in the section's subtree to the scene-relative Remotion time.
// WAAPI currentTime includes the delay phase, so setting it reproduces
// wall-clock playback exactly: delays elapse, fill-forwards holds, infinite
// loops cycle. getAnimations() re-runs every frame, so animations created
// after first paint (elements mounting mid-scene) are captured too; pause()
// also keeps finished non-fill animations alive in getAnimations(). In the
// preview / Studio (isRendering false) the effect is inert and native
// wall-clock playback is untouched.
const SectionClock: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // useCurrentFrame inside a <Sequence> is scene-relative — frame 0 is the
  // scene's first frame, matching when the section mounts and its CSS
  // animations start in wall-clock playback.
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { isRendering } = getRemotionEnvironment();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (!isRendering) return;
    const container = ref.current;
    if (!container || typeof container.getAnimations !== "function") return;
    const timeMs = (frame / fps) * 1000;
    for (const anim of container.getAnimations({ subtree: true })) {
      try {
        anim.pause();
        anim.currentTime = timeMs;
      } catch {
        // A detached or canceled animation can throw on seek — skip it.
      }
    }
  }, [frame, fps, isRendering]);
  // display:contents keeps the wrapper out of layout — absolutely-positioned
  // sections still resolve against the composition's AbsoluteFill.
  return (
    <div ref={ref} style={{ display: "contents" }}>
      {children}
    </div>
  );
};

// ── Deterministic scene transitions ──────────────────────────────────────────
// Scenes used to hard-cut. Each non-last scene's Sequence is extended by
// TRANSITION_FRAMES so it keeps playing (ambient loops breathing, plus a subtle
// cinematic push) while the NEXT scene — mounted on top by JSX order — fades in
// over the same window. The first scene fades up from the black composition
// base for a filmic open. Pure frame math; works identically in the Player
// preview and the frame-clocked render.
const TRANSITION_FRAMES = 12;
// The outgoing push scales toward the throughline motif's pinned anchor — the
// one object that survives every cut (its entrance only plays in scene 0) —
// so each cut reads as the camera pushing toward the surviving object while
// everything else exits and the next scene assembles around it.
const PUSH_ORIGIN = "1660px 20px";
const SceneTransition: React.FC<{
  scripted: number;
  isFirst: boolean;
  isLast: boolean;
  children: React.ReactNode;
}> = ({ scripted, isFirst, isLast, children }) => {
  const frame = useCurrentFrame(); // scene-relative inside the Sequence
  // data-rb-film gates the FILM-ONLY choreography (element exits): the
  // measurement harness and the per-scene editor iframe never mount this
  // wrapper, so they see the settled mid-scene frame; the composed Player
  // preview and the MP4 do, so elements leave the frame before each cut.
  const style: React.CSSProperties = { position: "absolute", inset: 0, transformOrigin: PUSH_ORIGIN };
  // Fade IN over the first window: crossfade over the extended predecessor
  // (or from black for the opening scene).
  const fadeIn = isFirst ? Math.round(TRANSITION_FRAMES * 1.5) : TRANSITION_FRAMES;
  if (frame < fadeIn) style.opacity = Math.max(0, Math.min(1, frame / fadeIn));
  // Outgoing push: past the scripted end (the overlap window), scale up gently
  // beneath the incoming scene for cut momentum, centered on the motif anchor.
  if (!isLast && frame > scripted) {
    const p = Math.min(1, (frame - scripted) / TRANSITION_FRAMES);
    style.transform = `scale(${1 + 0.02 * p})`;
  }
  return <div data-rb-film="" style={style}>{children}</div>;
};

const Composed: React.FC<{ script: typeof script }> = ({ script }) => (
  <AbsoluteFill style={{ backgroundColor: "#000" }}>
        {(() => {
          const C = pickSection(Sections, 0);
          return C ? (
            <Sequence from={0} durationInFrames={162} layout="none">
              <SceneTransition scripted={150} isFirst={true} isLast={false}>
                <SectionClock>
                  <C script={script} />
                </SectionClock>
              </SceneTransition>
            </Sequence>
          ) : null;
        })()}
        {(() => {
          const C = pickSection(Sections, 1);
          return C ? (
            <Sequence from={150} durationInFrames={162} layout="none">
              <SceneTransition scripted={150} isFirst={false} isLast={false}>
                <SectionClock>
                  <C script={script} />
                </SectionClock>
              </SceneTransition>
            </Sequence>
          ) : null;
        })()}
        {(() => {
          const C = pickSection(Sections, 2);
          return C ? (
            <Sequence from={300} durationInFrames={162} layout="none">
              <SceneTransition scripted={150} isFirst={false} isLast={false}>
                <SectionClock>
                  <C script={script} />
                </SectionClock>
              </SceneTransition>
            </Sequence>
          ) : null;
        })()}
        {(() => {
          const C = pickSection(Sections, 3);
          return C ? (
            <Sequence from={450} durationInFrames={162} layout="none">
              <SceneTransition scripted={150} isFirst={false} isLast={false}>
                <SectionClock>
                  <C script={script} />
                </SectionClock>
              </SceneTransition>
            </Sequence>
          ) : null;
        })()}
        {(() => {
          const C = pickSection(Sections, 4);
          return C ? (
            <Sequence from={600} durationInFrames={150} layout="none">
              <SceneTransition scripted={150} isFirst={false} isLast={true}>
                <SectionClock>
                  <C script={script} />
                </SectionClock>
              </SceneTransition>
            </Sequence>
          ) : null;
        })()}
  </AbsoluteFill>
);

const Root = () => (
  <Composition
    id="Generated"
    component={Composed as React.FC<{ script: typeof script }>}
    durationInFrames={750}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ script }}
  />
);

registerRoot(Root);
