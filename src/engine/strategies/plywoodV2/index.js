// Plywood Network v2 — assembly (spec §5–6, §10).
// Returns the same result shape runEngine's network bypass consumes.

import { DS_LIST } from '../../constants.js';
import { buildUniverse, prepareDemand } from './demand.js';
import { allocate } from './allocator.js';
import { replay } from './replay.js';
import { sizeDC, trimDCToCapacity } from './dc.js';

export const V2_DEFAULTS = {
  lookbackDays: 90,
  bulkOrderThreshold: 10,
  bulkDcServedShare: 1.0,
  minDepthStopPercentile: 99,
  dcReplPercentile: 98,
  dcBulkPercentile: 90,
  dcCoverDays: 2,
  thickBoundaryMm: 9,
  excludedBrands: ['Merino'],
  leadDays: 3,
  dsCapacities: {
    DS01: { thick: 360, thin: 150 }, DS02: { thick: 360, thin: 150 },
    DS03: { thick: 360, thin: 150 }, DS04: { thick: 225, thin: 150 },
    DS05: { thick: 200, thin: 150 },
  },
  dcCapacity: { thick: 1000, thin: 500 },
  keepScore: { grossMarginPct: 0.06, carryRateQuarterly: 0.05, opsBuffer: 1.5, serviceNZDThreshold: 5 },
};

export function computePlywoodNetworkV2Results(inv, skuM, params) {
  const cfg = params?.plywoodNetworkV2Config;
  if (!cfg) return {};
  const c = { ...V2_DEFAULTS, ...cfg };

  const universe = buildUniverse(skuM, c);
  if (Object.keys(universe).length === 0) return {};
  const demand = prepareDemand(inv, universe, c);
  if (!demand) return {};

  // DS plans
  const { plan, nodeReport, floor, tclass } = allocate(universe, demand, c);

  // DC: drain pass (infinite DC) → size → capacity trim
  const drainPass = replay(plan, null, demand, { ...c, infiniteDC: true });
  const sized = sizeDC(drainPass.toDrain, demand.bulkDaily, demand.windowDates, c);
  const { dcPlan, detail: dcDetail, trimReport } = trimDCToCapacity(
    sized.dcPlan, sized.detail, drainPass.toDrain, demand.bulkDaily,
    demand.windowDates, c, c.dcCapacity, (sku) => tclass[sku]);

  // Assemble runEngine-compatible results
  const results = {};
  for (const [sku, meta] of Object.entries(universe)) {
    const storeResults = {};
    for (const ds of DS_LIST) {
      const p = plan[sku][ds];
      const nzd = Object.keys(demand.regularDaily[sku]?.[ds] || {}).length;
      storeResults[ds] = {
        min: p.min, max: p.max, nonZeroCount: nzd, covers: [ds],
        v2: { floor: p.floor, depth: p.min - p.floor, tclass: tclass[sku] },
      };
    }
    const dc = dcPlan[sku] || { min: 0, max: 0 };
    results[sku] = {
      brand: meta.brand,
      storeResults,
      dcResult: { min: dc.min, max: dc.max },
      v2: { nodeReport, dcDetail: dcDetail[sku] || null, dcTrimReport: trimReport, floor: floor[sku] },
    };
  }
  return results;
}

// Re-exports for tab / harness use
export { buildUniverse, prepareDemand, medianOrderQty } from './demand.js';
export { allocate, thicknessClass } from './allocator.js';
export { replay } from './replay.js';
export { sizeDC, trimDCToCapacity, rollingSums } from './dc.js';
export { computeKeepScores } from './keepScore.js';
