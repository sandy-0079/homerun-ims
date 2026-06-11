// Plywood Network v2 — assembly (spec §5–6, §10).
// Returns the same result shape runEngine's network bypass consumes.

import { DS_LIST } from '../../constants.js';
import { buildUniverse, prepareDemand } from './demand.js';
import { allocate, allocateEmpirical, allocateTiered } from './allocator.js';
import { replay } from './replay.js';
import { sizeDC, trimDCToCapacity } from './dc.js';

export const V2_DEFAULTS = {
  lookbackDays: 90,
  bulkOrderThreshold: 10,
  bulkDcServedShare: 1.0,
  allocMode: 'tiered',           // 'tiered' (frequency-tiered τ-service) | 'empirical' (network tails everywhere) | 'greedy' (capacity-budgeted)
  tau: 99,                       // service quantile on rolling-window regular demand
  netOrderTailPct: 95,           // network order-size tail percentile for Max (empirical mode)
  rollingWindowDays: 2,          // replenishment exposure window (TO daily, arrives next noon)
  tierFrequentNZD: 10,           // tiered: local NZD (per 90d) ≥ this → frequent
  tierModerateNZD: 5,            // tiered: ≥ this → moderate
  tierSparseNZD: 2,              // tiered: ≥ this → sparse; below → dead (lean floor)
  deadFloorMode: 'netMedian',    // tiered: 'netMedian' | 'lean1' floor for locally-dead combos
  minDepthStopPercentile: 99,    // greedy mode only
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
  const allocFn = c.allocMode === 'greedy' ? allocate
    : c.allocMode === 'empirical' ? allocateEmpirical
    : allocateTiered;
  const { plan, nodeReport, floor, tclass } = allocFn(universe, demand, c);

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
        v2: { floor: p.floor, depth: p.min - p.floor, tclass: tclass[sku], tier: p.tier || null },
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
export { allocate, allocateEmpirical, allocateTiered, thicknessClass } from './allocator.js';
export { replay } from './replay.js';
export { sizeDC, trimDCToCapacity, rollingSums } from './dc.js';
export { computeKeepScores } from './keepScore.js';
