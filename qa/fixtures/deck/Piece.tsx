import React from "react";

export const Piece: React.FC<{
  id?: string;
  kind?: string;
  throughline?: string;
  children?: React.ReactNode;
}> = ({ id, kind, throughline, children }) =>
  React.createElement(
    "div",
    { "data-piece": id, "data-kind": kind, "data-throughline": throughline, style: { display: "contents" } },
    children,
  );
