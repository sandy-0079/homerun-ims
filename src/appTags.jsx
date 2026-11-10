// Tag pills, moved verbatim out of App.jsx so extracted tabs render the same pills.
import React from "react";
import { MOV_COLORS, TOPN_TAG_COLORS, TOPN_DISPLAY, TAG_STYLE } from "./appTagColors";

export const TagPill=React.memo(({value,colorMap})=>{
  const raw=colorMap[value]||{bg:"#F1F5F9",color:"#64748B",border:"#CBD5E1"};
  const displayVal=colorMap===TOPN_TAG_COLORS?(TOPN_DISPLAY[value]||value):value;
  return <span style={{...TAG_STYLE,background:raw.bg,color:raw.color,border:`1px solid ${raw.border}`}}>{displayVal||"—"}</span>;
});

export const MovTag=React.memo(({value})=>{
  const color=MOV_COLORS[value]||"#64748b",bg=color+"18";
  return <span style={{...TAG_STYLE,background:bg,color,border:`1px solid ${color}33`}}>{value||"—"}</span>;
});
