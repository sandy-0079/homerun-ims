// Labels for the Hyderabad Plywood panel's "Global Settings" (network parameters).
// Pure: no React, no Supabase.
//
// HYD_PLYWOOD_PARAM_LABELS is COPIED from Bangalore's Network Design Configuration →
// Global Settings list in src/tabs/PlywoodNetworkTab.jsx (the array mapped at ~line
// 1585, "History Window" … "Bulk Hard Floor (sheets)"); same order, labels, ranges and
// hints. Copied, not imported: that file is Bangalore's and must not change. Only the
// bulk-multiplier hint is reworded — Bangalore's says bulk is "fulfilled from DC", and
// Pati has no DC.
import { flattenParamRows } from "./hydParamRows.js";

/** Top-level plywood config keys that only size the DC. Pati has no DC, so they are
 *  not rendered — but they stay in the stored object (nothing deletes them).
 *  `dcCapacity` ({thick, thin}) is read only by Bangalore's DC capacity row
 *  (PlywoodNetworkTab.jsx) and the dormant v2 engine; plywoodNetwork.js never reads it.
 *  The per-brand DC multipliers (dcMultMin/dcMultMax) live under `brands`, which is
 *  never a param row here. Every other global key feeds the store-level Min/Max or the
 *  store capacity trim (plywoodNetwork.js computePlywoodNetworkResults / applyCapacityTrim). */
export const HYD_PLYWOOD_HIDDEN_PARAMS = ["dcCapacity"];

/** Edited elsewhere on the panel (brand checkboxes), never a param row. */
const NOT_PARAMS = ["brands"];

export const isHiddenPlywoodParam = path =>
  HYD_PLYWOOD_HIDDEN_PARAMS.some(k => path === k || path.startsWith(k + "."));

export const HYD_PLYWOOD_GROUP_TITLE = "Global Settings";

export const HYD_PLYWOOD_PARAM_LABELS = [
  { label: "History Window", key: "lookbackDays", min: 30, max: 365, step: 1, hint: "Days of sales history used to compute Min & Max" },
  { label: "Min Qty Percentile", key: "minPercentile", min: 50, max: 99, step: 1, hint: "P95 = stock enough for 95% of peak demand days" },
  { label: "Rare Zone Threshold (NZD)", key: "minNZD", min: 1, max: 20, step: 1, hint: "Below this NZD → Rare zone (not stocked at all)" },
  { label: "Sparse Zone Threshold (NZD)", key: "sparseNZD", min: 2, max: 20, step: 1, hint: "Below this NZD → Sparse (ABQ-based). Above → Frequent (P95-based)" },
  { label: "Outlier Cap (× median)", key: "spikeCapMultiplier", min: 1, max: 20, step: 0.5, hint: "Winsorise spike days at N × median before P95" },
  { label: "Max Sheets per Location", key: "maxCap", min: 1, max: 100, step: 1, hint: "Hard ceiling on Max per SKU per location" },
  { label: "Thick Boundary (mm)", key: "thickBoundaryMm", min: 1, max: 30, step: 1, hint: "SKUs above this mm are Thick, below are Thin — affects capacity trim and display" },
  { label: "Capacity Tolerance (%)", key: "capacityTolerancePct", min: 0, max: 20, step: 0.5, hint: "% over capacity before trim kicks in (e.g. 2 = trim when >102% full)" },
  { label: "Erratic Order Threshold", key: "sparseErraticThreshold", min: 1, max: 5, step: 0.1, hint: "max/P25 of orders — above this = erratic demand, trimmed first" },
  { label: "Bulk Multiplier (N×ABQ)", key: "bulkThresholdMultiplier", min: 1, max: 10, step: 0.1, hint: "Orders above N × ABQ are bulk — excluded from Pati's stocking" },
  { label: "Min Orders for Bulk Filter", key: "minOrdersForBulkFilter", min: 1, max: 20, step: 1, hint: "Min total orders across all DSes to reliably identify bulk — below this only the hard floor applies" },
  { label: "Bulk Hard Floor (sheets)", key: "bulkMaxThreshold", min: 2, max: 50, step: 1, hint: "Orders ≥ this are always bulk regardless of ABQ — universal ceiling on the bulk threshold" },
];

const BY_KEY = Object.fromEntries(HYD_PLYWOOD_PARAM_LABELS.map((l, i) => [l.key, { ...l, order: i }]));

// "bulkThresholdMultiplier" → "bulk threshold multiplier"; keeps acronyms ("minNZD" → "min NZD").
const words = key => String(key)
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .replace(/[_.-]+/g, " ")
  .split(" ").filter(Boolean)
  .map(w => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase()))
  .join(" ");
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Readable label for a param Bangalore does not label: segments joined by " — ". */
export function humaniseParamPath(path) {
  return String(path).split(".").map((seg, i) => (i === 0 ? cap(words(seg)) : words(seg))).join(" — ");
}

/**
 * The parameter rows the Hyderabad panel shows: flattenParamRows output minus `brands`
 * and the hidden DC-only keys, each with a label (+ hint/range when Bangalore has one).
 * Bangalore-labelled rows first in Bangalore's order, then the rest by path.
 */
export function hydPlywoodParamRows(cfg) {
  const rows = flattenParamRows(cfg || {}, NOT_PARAMS).filter(r => !isHiddenPlywoodParam(r.path));
  const out = rows.map(r => {
    const known = BY_KEY[r.path];
    return known
      ? { ...r, label: known.label, hint: known.hint, min: known.min, max: known.max, step: known.step, order: known.order }
      : { ...r, label: humaniseParamPath(r.keys.join(".")), hint: null, order: Infinity };
  });
  return out.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path)).map(({ order, ...r }) => r);
}
