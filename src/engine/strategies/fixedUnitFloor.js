import { percentile } from "../utils.js";

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Fixed Unit Floor strategy: Min based on P90 of individual order line quantities.
 *
 * For categories where order timing is erratic but order size is predictable.
 * Returns null if no orders exist (signalling caller should fall back to Standard).
 *
 * Spike cap (winsorising): before the percentile, any single order that dwarfs this
 * SKU's own median order size (> median × spikeCapMult) is clipped to that cap, so one
 * contractor bulk-buy buried among normal orders can't inflate the floor. Only kicks in
 * with >= 3 orders (median is unstable below that); spikeCapMult <= 0 disables it.
 *
 * @param {Object} opts
 * @param {number[]} opts.orderQtys - array of individual order line quantities for this SKU x DS in the lookback window
 * @param {Object} opts.params - full params object
 * @returns {{ minQty: number, maxQty: number } | null} - null means "fall back to Standard"
 */
export function fixedUnitFloorStrategy(opts) {
  const { orderQtys, params: p } = opts;
  const config = p.fixedUnitFloor || {};
  const pctile = config.orderQtyPercentile ?? 90;
  const maxMult = config.maxMultiplier ?? 1.5;
  const maxAdd = config.maxAdditive ?? 1;
  const spikeCapMult = config.spikeCapMult ?? 5;

  if (!orderQtys || orderQtys.length === 0) {
    return null; // No orders — caller should fall back to Standard
  }

  let qtys = orderQtys;
  let winsor = { applied: false, spikeCapMult };
  if (spikeCapMult > 0 && orderQtys.length >= 3) {
    const med = median(orderQtys);
    const cap = med * spikeCapMult;
    if (med > 0 && orderQtys.some(q => q > cap)) {
      qtys = orderQtys.map(q => Math.min(q, cap));
      winsor = { applied: true, median: med, cap, spikeCapMult };
    }
  }

  const sorted = [...qtys].sort((a, b) => a - b);
  const pctQty = percentile(sorted, pctile);
  const minQty = Math.ceil(pctQty);
  const maxQty = Math.ceil(Math.max(minQty + maxAdd, minQty * maxMult));

  return {
    minQty,
    maxQty,
    details: {
      pctile,
      pctQty,
      orderCount: orderQtys.length,
      maxMult,
      maxAdd,
      winsor,
    },
  };
}
