import { percentile } from "../utils.js";

/**
 * Percentile Cover strategy: Min/Max based on the Xth percentile of non-zero daily qty.
 *
 * Percentile is selected by price tag (cheap = stock aggressively, expensive = lean).
 * Cover days are selected by movement tag.
 *
 * @param {Object} opts
 * @param {number[]} opts.q90 - daily qtys for full 90-day period (one entry per day, including zeros)
 * @param {string} opts.prTag - price tag (Premium/High/Medium/Low/Super Low/No Price)
 * @param {string} opts.mvTag90 - movement tag from 90-day period
 * @param {Object} opts.params - full params object
 * @returns {{ minQty: number, maxQty: number }}
 */
export function percentileCoverStrategy(opts) {
  const { q90, prTag, mvTag90, params: p } = opts;
  const config = p.percentileCover || {};
  const percentileByPrice = config.percentileByPrice || {
    "Low": 95, "Super Low": 95, "No Price": 95, "Medium": 90, "High": 85, "Premium": 85,
  };
  const coverDaysByMovement = config.coverDaysByMovement || {
    "Super Fast": 2, "Fast": 2, "Moderate": 3, "Slow": 2, "Super Slow": 1,
  };

  const pctValue = percentileByPrice[prTag] ?? 90;
  const coverDays = coverDaysByMovement[mvTag90] ?? 2;

  // Use only non-zero days for percentile calculation
  const nonZeroQtys = q90.filter(q => q > 0).sort((a, b) => a - b);

  if (nonZeroQtys.length === 0) {
    return { minQty: 0, maxQty: 0 };
  }

  const pctQty = percentile(nonZeroQtys, pctValue);
  const dailyAvg = q90.reduce((a, b) => a + b, 0) / q90.length;
  const buffer = p.maxDaysBuffer || 2;

  const minQty = Math.ceil(pctQty * coverDays);
  const maxQty = Math.ceil(minQty + dailyAvg * buffer);

  return { minQty, maxQty };
}
