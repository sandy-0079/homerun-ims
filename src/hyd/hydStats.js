// Aggregations for the Hyderabad screens (report counts, the Floors only → Engine
// impact preview). Pure: no React, no Supabase.
import { computeInvValue } from "../invValue.js";
import { HYD_DS_LIST } from "../city.js";

const STORE = "HYDS01";
const FLAGS = ["Purchase=OFF", "Supplier", "Dead Stock"];

const storeOf = r => r?.stores?.[STORE];
const hasTarget = r => (storeOf(r)?.max || 0) > 0;

/** report.overrides carries one entry per flag; screens count SKUs. */
export function uniqueOverrideSkus(overrides) {
  const by = new Map();
  for (const { sku, reason } of overrides || []) {
    if (!by.has(sku)) by.set(sku, []);
    by.get(sku).push(reason);
  }
  return [...by].map(([sku, reasons]) => ({ sku, reasons }));
}

/** SKUs zeroed by each Bangalore-origin flag (engine mode). Each SKU is counted
 *  once, under the flag its logicTag names — the first that applied.
 *  `demandOnly` (default) counts only SKUs the engine would otherwise have stocked
 *  (engineMax > 0): runHydEngine tags the flag before looking at demand, so most
 *  carriers of a flag have no Pati sales and would be 0/0 anyway. */
export function zeroedByFlag(results, { demandOnly = true } = {}) {
  const out = Object.fromEntries(FLAGS.map(f => [f, 0]));
  for (const r of Object.values(results || {})) {
    const s = storeOf(r);
    const tag = s?.logicTag || "";
    if (!tag.startsWith("Flag: ")) continue;
    if (demandOnly && !((s.engineMax || 0) > 0)) continue;
    const flag = tag.slice(6);
    if (flag in out) out[flag]++;
  }
  return out;
}

/** What switching Pati to Engine would do, from a dry run. */
export function engineFlipImpact(beforeRun, afterRun, priceData) {
  const side = run => ({
    withTargets: Object.values(run?.results || {}).filter(hasTarget).length,
    invMax: computeInvValue(run?.results || {}, priceData || {}, HYD_DS_LIST).max,
  });
  return {
    before: side(beforeRun),
    after: side(afterRun),
    blockedByFlag: zeroedByFlag(afterRun?.results),
    flaggedByFlag: zeroedByFlag(afterRun?.results, { demandOnly: false }),
  };
}
