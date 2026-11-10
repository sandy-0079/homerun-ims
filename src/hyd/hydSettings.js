// Pure helpers behind the Hyderabad Logic Tweaker: the strategy dropdown options,
// which keys the generic editor leaves to dedicated controls, the Floors only ⇄
// Engine switch, and "Reset to Bangalore's current values".
import { HYD_HIDDEN_KEYS, buildHydParamsFromBangalore } from "./hydParams.js";

export const PLYWOOD_CATEGORY = "Plywood, MDF & HDHMR";

// The values Bangalore's Category → Strategy Map offers (App.jsx, inline <option>s;
// hydSettings.test.js fails if one of these disappears there). `network_design_v2`
// is deliberately absent: its tab is retired and its config row
// (plywoodNetworkV2Config) is hidden in Hyderabad, so it could not run here.
export const HYD_STRATEGY_OPTIONS = [
  { value: "standard", label: "Standard" },
  { value: "percentile_cover", label: "Percentile Cover" },
  { value: "fixed_unit_floor", label: "Fixed Unit Floor" },
  { value: "manual", label: "Manual" },
  { value: "network_design", label: "Network Design", plywoodOnly: true },
];

// Bangalore's "Non-network brands" dropdown under plywood offers these three.
export const HYD_NON_NETWORK_OPTIONS = HYD_STRATEGY_OPTIONS.filter(o =>
  ["standard", "percentile_cover", "fixed_unit_floor"].includes(o.value));

export const strategyOptionsFor = cat =>
  HYD_STRATEGY_OPTIONS.filter(o => !o.plywoodOnly || cat === PLYWOOD_CATEGORY);

/** As Bangalore does: "standard" removes the category's entry. */
export function setCategoryStrategy(hp, cat, value) {
  const next = { ...(hp?.categoryStrategies || {}) };
  if (value === "standard") delete next[cat];
  else next[cat] = value;
  return { ...hp, categoryStrategies: next };
}

export const HYD_EDITOR_EXCLUDED_KEYS = [
  ...HYD_HIDDEN_KEYS,
  "floorsOnly", "orderCycleDays", "brandLeadTimeDays", "categoryStrategies",
  "copiedFromBangaloreAt", "plywoodNonNetworkStrategy",
];

export function withFloorsOnly(hp, ds, on) {
  return { ...hp, floorsOnly: { ...(hp?.floorsOnly || {}), [ds]: on } };
}

/**
 * Bangalore's current values, re-copied. The two Hyderabad-only settings — the
 * per-store switch and the order cycle — are kept: they are not Bangalore values,
 * and silently flipping Pati back to floors-only would change its whole range.
 */
export function resetHydParamsToBangalore(current, blrParams, nowIso) {
  const fresh = buildHydParamsFromBangalore(blrParams, nowIso);
  return {
    ...fresh,
    floorsOnly: { ...fresh.floorsOnly, ...(current?.floorsOnly || {}) },
    orderCycleDays: current?.orderCycleDays ?? fresh.orderCycleDays,
  };
}
