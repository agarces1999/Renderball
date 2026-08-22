import React from "react";
import { getRemotionEnvironment, delayRender, continueRender } from "remotion";
import { Lottie as RemotionLottie } from "@remotion/lottie";

export type LottieProps = { src: string; loop?: boolean; style?: React.CSSProperties; className?: string };

const RenderLottie: React.FC<LottieProps> = ({ src, loop, style, className }) => {
  const [data, setData] = React.useState(null);
  const [handle] = React.useState(() => delayRender("lottie"));
  React.useEffect(() => {
    let active = true;
    fetch(src)
      .then(function (r) { return r.json(); })
      .then(function (j) { if (active) { setData(j); continueRender(handle); } })
      .catch(function () { continueRender(handle); });
    return function () { active = false; };
  }, [src, handle]);
  if (!data) return null;
  return React.createElement(RemotionLottie, { animationData: data, loop: loop !== false, style: style, className: className });
};

export const Lottie: React.FC<LottieProps> = (props) => {
  let isRendering = false;
  try { isRendering = getRemotionEnvironment().isRendering; } catch (e) { isRendering = false; }
  if (isRendering) return React.createElement(RenderLottie, props);
  return React.createElement("div", {
    className: "rb-lottie " + (props.className || ""),
    "data-lottie-src": props.src,
    "data-lottie-loop": props.loop === false ? "0" : "1",
    style: props.style,
  });
};
