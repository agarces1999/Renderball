import React from "react";
import { OffthreadVideo, getRemotionEnvironment } from "remotion";

export type VideoProps = React.VideoHTMLAttributes<HTMLVideoElement> & { src: string };

export const Video: React.FC<VideoProps> = (props) => {
  let isRendering = false;
  try { isRendering = getRemotionEnvironment().isRendering; } catch (e) { isRendering = false; }
  if (isRendering) {
    return React.createElement(OffthreadVideo, Object.assign({ muted: true, loop: true }, props));
  }
  return React.createElement(
    "video",
    Object.assign({ autoPlay: true, loop: true, muted: true, playsInline: true }, props),
  );
};
