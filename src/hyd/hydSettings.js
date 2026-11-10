// Pure helpers behind the Hyderabad Logic Tweaker's top section (HydLogicTop): the
// Floors only ⇄ Engine switch and "Reset to Bangalore's current values".
import { buildHydParamsFromBangalore } from "./hydParams.js";

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
