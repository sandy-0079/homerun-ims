import { percentile } from "../utils.js";

/**
 * Fixed Unit Floor strategy: Min based on P90 of individual order line quantities.
 *
 * For categories where order timing is erratic but order size is predictable.
 * Returns null if no orders exist (signalling caller should fall back to Standard).
 *
 * @param {Object} opts
 * @param {number[]} opts.orderQtys - array of individual order line quantities for this SKU x DS in 90-day window
 * @param {Object} opts.params - full params object
 * @returns {{ minQty: number, maxQty: number } | null} - null means "fall back to Standard"
 */
export function fixedUnitFloorStrategy(opts) {
  const { orderQtys, params: p } = opts;
  const config = p.fixedUnitFloor || {};
  const pctile = config.orderQtyPercentile ?? 90;
  const maxMult = config.maxMultiplier ?? 1.5;
  const maxAdd = config.maxAdditive ?? 1;

  if (!orderQtys || orderQtys.length === 0) {
    return null; // No orders — caller should fall back to Standard
  }

  const sorted = [...orderQtys].sort((a, b) => a - b);
  const pctQty = percentile(sorted, pctile);
  const minQty = Math.ceil(pctQty);
  const maxQty = Math.ceil(Math.max(minQty + maxAdd, minQty * maxMult));

  return { minQty, maxQty };
}
