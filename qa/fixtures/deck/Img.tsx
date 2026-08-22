import React from "react";

export type ImgProps = React.ImgHTMLAttributes<HTMLImageElement>;

export const Img: React.FC<ImgProps> = (props) =>
  React.createElement("img", props);
