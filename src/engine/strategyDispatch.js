// Strategy dispatch — pick a strategy for one demand series and return Min/Max.
//
// ⚠ ONE IMPLEMENTATION, TWO CALLERS. It was inline in `runEngine`'s per-DS loop
// until a DC-only SKU needed the SAME dispatch run against TOTAL SKU demand rather
// than one store's. An inline copy would have been two strategy engines drifting
// apart, surfacing as a DC target that disagrees with the DS logic beside it — the
// same shape of fix as src/toTargets.js, src/invValue.js and buildInvoiceCsv living
// beside parseInvoiceCsv.
//
// ⚠ EXTRACTED VERBATIM, no behaviour change. Proved inert against a frozen input
// snapshot: 0 of 18,046 cells differing across 2,578 SKUs. Do not "tidy" the branch
// order or the fallback tags while editing — every one of them is load-bearing:
//   • PCT below its NZD gate falls back to Standard and is RETAGGED "standard"
//   • Fixed Unit Floor below its order-days gate falls back to Standard, and is
//     floored at >= 1 because the caller only reaches here with demand present
//   • fixedUnitFloorStrategy returning null falls back to Standard as well
// CLAUDE.md records the reasoning for each; `strategyTag` is what audits see.
//
// ⚠ `getOrderQtys` IS A THUNK, NOT AN ARRAY, AND THAT IS DELIBERATE. The only
// caller that needs it is the Fixed-Unit-Floor-passed branch, and collecting the
// quantities is a FULL LINEAR SCAN of the sliced invoice rows (94,819 live). Passing
// it eagerly would run that scan for every SKU x DS — ~15,000 scans instead of a few
// hundred — turning a ~1.4s engine run into minutes.

import { standardStrategy } from "./strategies/standard.js";
import { percentileCoverStrategy } from "./strategies/percentileCover.js";
import { fixedUnitFloorStrategy } from "./strategies/fixedUnitFloor.js";

/**
 * @param strategy      resolved strategy key ("percentile_cover" | "fixed_unit_floor" | …)
 * @param s90           computeStats over the whole window for this series
 * @param q90           per-date quantities over the whole window
 * @param qLong/oLong   long-half quantities / order counts
 * @param qRecent/oRecent recent-half quantities / order counts
 * @param prTag         price tag ("Premium" | "High" | "Medium" | …)
 * @param mvTag90       movement tag for this series
 * @param params        engine params (`p`)
 * @param getOrderQtys  () => number[] — individual order-line quantities, lazy
 * @returns {{minQty:number, maxQty:number, strategyTag:string, strategyDetails:object}}
 */
export function dispatchStrategy({
  strategy, s90, q90, qLong, oLong, qRecent, oRecent, prTag, mvTag90, params, getOrderQtys,
}) {
  const p = params;
      let minQty, maxQty;
      let strategyTag = strategy;
      let strategyDetails = {};

      // Price-tag-aware NZD threshold:
      // Premium/High require pctMinNZD (default 2) — 1 observation insufficient for a reliable distribution
      // Medium/Low/Super Low/No Price use 1 — cheap items stocked aggressively even with sparse history
      const HIGH_PCT_TAGS = ["Premium", "High"];
      const LOW_PCT_TAGS = ["Medium", "Low", "Super Low", "No Price"];
      const nzdThreshold = HIGH_PCT_TAGS.includes(prTag) ? (p.pctMinNZD || 2) : 1;

      if (strategy === "percentile_cover" && s90.nonZeroDays >= nzdThreshold) {
        const r = percentileCoverStrategy({ q90, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        // DOC cap — Premium/High use pctDocCap; Medium/Low/Super Low/No Price use pctDocCapLow
        const isHighTag = HIGH_PCT_TAGS.includes(prTag);
        const capDays = isHighTag ? (p.pctDocCap ?? 30) : (p.pctDocCapLow ?? 60);
        const capApplies = isHighTag ? true : LOW_PCT_TAGS.includes(prTag);
        if (capDays > 0 && capApplies && s90.dailyAvg > 0) {
          const capMin = Math.ceil(s90.dailyAvg * capDays);
          if (minQty > capMin) {
            const uncappedMin = minQty, uncappedMax = maxQty;
            minQty = capMin;
            maxQty = Math.ceil(capMin + s90.dailyAvg * (p.maxDaysBuffer || 2));
            strategyDetails.docCap = { applied: true, capDays, priceTag: prTag, uncappedMin, uncappedMax, cappedMin: minQty, cappedMax: maxQty };
          } else {
            strategyDetails.docCap = { applied: false, capDays, priceTag: prTag };
          }
        }
      } else if (strategy === "percentile_cover" && s90.nonZeroDays < nzdThreshold) {
        // PCT assigned but NZD below threshold — fall back to standard
        const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        strategyDetails.pctFallback = { reason: "NZD", nzd: s90.nonZeroDays, threshold: nzdThreshold };
        strategyTag = "standard";
      } else if (strategy === "fixed_unit_floor") {
        // Order-days gate (mirrors PCT's NZD gate): Premium/High need >= fufMinNZD distinct
        // order-days before a single-order size percentile is trusted — one contractor
        // bulk-buy can't establish a size distribution. Below threshold → fall back to
        // Standard. Cheap tags keep threshold 1 (stock aggressively). fufMinNZD=1 = gate off.
        const fufMinNZD = HIGH_PCT_TAGS.includes(prTag) ? (p.fixedUnitFloor?.minNZD ?? 2) : 1;
        if (s90.nonZeroDays < fufMinNZD) {
          const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
          ({ minQty, maxQty } = r);
          minQty = Math.max(1, minQty); // demand-bearing SKU (HAS DATA path) → stock at least 1
          maxQty = Math.max(maxQty, minQty);
          strategyDetails = r.details || {};
          strategyDetails.fufFallback = { reason: "NZD", nzd: s90.nonZeroDays, threshold: fufMinNZD };
          strategyTag = "standard";
        } else {
          const result = fixedUnitFloorStrategy({ orderQtys: getOrderQtys(), params: p });
          if (result) {
            ({ minQty, maxQty } = result);
            strategyDetails = result.details || {};
          } else {
            // Null — fall back to standard
            const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
            ({ minQty, maxQty } = r);
            strategyDetails = r.details || {};
            strategyTag = "standard";
          }
        }
      } else {
        // "standard", "manual", or unknown — use standard blend
        const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        strategyTag = "standard";
      }

  return { minQty, maxQty, strategyTag, strategyDetails };
}
