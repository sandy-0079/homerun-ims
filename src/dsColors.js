// Per-store colour identity — ONE definition, shared by every surface that paints a
// store. `App.jsx` (Overview, SKU Detail, Manual Overrides) and `tabs/StockHealthTab`
// both used to carry their own copy.
//
// ⚠⚠ THAT DUPLICATION IS NOT A TIDINESS PROBLEM — IT WHITE-PAGES THE APP.
// Both copies are indexed BY POSITION IN `DS_LIST`, so each one silently has to be at
// least as long as it. On 2026-09-18 DS_LIST went 6 → 8 for DS07/DS08; App.jsx's copy
// was extended and guarded, StockHealthTab's was missed. `DS_COLORS[6].header` on an
// array of 6 throws inside render, React unmounts, and the whole tab goes blank — the
// same blast radius as the 2026-07-29 malformed-date incident, from a missing hex
// string. The engine recomputes client-side on every page load, so there is no stale
// cache to hide behind either.
//
// Two defences, and BOTH are needed:
//   1. one array, so a new store cannot be added to some surfaces and not others;
//   2. `DS_COLOR()` clamps instead of indexing, so even a list that has outgrown the
//      palette renders in a borrowed colour rather than taking the page down.
// Colour is cosmetic; a blank page is not. Degrade, never throw.
//
// ⚠ The TO tool keeps its own `DS_ACCENT` (separate repo, separate deploy) and must
// be updated alongside this. Its headers are deliberately the same hexes.

export const DS_COLORS = [
  { bg:"#FFFBEA", header:"#B8860B", text:"#7A5800" },   // DS01 Sarjapur
  { bg:"#EDFFF3", header:"#1D6B30", text:"#0F4020" },   // DS02 Bileshivale
  { bg:"#FFF4EC", header:"#C05A00", text:"#7A3800" },   // DS03 Kengeri
  { bg:"#F5EEFF", header:"#7A3DBF", text:"#4A1A8A" },   // DS04 Chikkabanavara
  { bg:"#FFF0F6", header:"#B5006A", text:"#7A0040" },   // DS05 Basavanapura
  { bg:"#E8FFFA", header:"#0F766E", text:"#0A4A44" },   // DS06 Kogilu
  { bg:"#FFF1F1", header:"#A4161A", text:"#6E0E11" },   // DS07 HAL
  { bg:"#F7F2EC", header:"#7A5230", text:"#4A3220" },   // DS08 Rajajinagar
];

export const DC_COLOR = { bg:"#EAF9FF", header:"#0077A8", text:"#004D70" };

/** Colour for a store by its index in DS_LIST. Never throws, whatever the index —
 *  a negative index (an unknown store) falls back to the DC colour. */
export const DS_COLOR = (i) =>
  i < 0 ? DC_COLOR : (DS_COLORS[i] ?? DS_COLORS[DS_COLORS.length - 1]);
