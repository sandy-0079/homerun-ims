// Plywood Network v2 — assembly (spec §5–6, §10).
// Returns the same result shape runEngine's network bypass consumes.

import { DS_LIST } from '../../constants.js';
import { buildUniverse, prepareDemand } from './demand.js';
import { allocate, allocateEmpirical, allocateTiered, allocateUnified, thicknessClass } from './allocator.js';
import { replay } from './replay.js';
import { sizeDCOrderBulk, trimDCComponents } from './dc.js';
import { collectBulkOrderQty } from './demand.js';
import { computeKeepScores } from './keepScore.js';

export const V2_DEFAULTS = {
  lookbackDays: 90,
  bulkOrderThreshold: 10,
  bulkDcServedShare: 1.0,
  allocMode: 'unified',          // 'unified' (two-branch, DEFAULT) | 'tiered' | 'empirical' | 'greedy'
  minLocalDayPercentile: 90,     // unified: percentile of local selling-day totals
  minNetOrderPercentile: 90,     // unified: percentile of network order sizes (Min floor)
  minDocCapDays: 45,             // unified: Min ≤ velocity × this (0 = off); floored at local order ABQ
  deadFloorMode: 'abq',          // unified: 'abq' | 'lean1' — floor for NZD=0 combos
  maxMode: 'worstDay',           // unified: 'worstDay' | 'minPlus1' — Max for active combos
  capacityFit: 'maxTrim',        // 'off' | 'maxTrim' — NZD-ordered Max→Min+1 trim at over-capacity racks
  dsKnobs: {},                   // per-DS knob overrides, e.g. { DS05: { minLocalDayPercentile: 80 } }
  tau: 99,                       // service quantile on rolling-window regular demand
  netOrderTailPct: 95,           // network order-size tail percentile for Max (empirical mode)
  rollingWindowDays: 2,          // replenishment exposure window (TO daily, arrives next noon)
  tierFrequentNZD: 10,           // tiered: local NZD (per 90d) ≥ this → frequent
  tierModerateNZD: 5,            // tiered: ≥ this → moderate
  tierSparseNZD: 2,              // tiered: ≥ this → sparse; below → dead (lean floor)
  minDepthStopPercentile: 99,    // greedy mode only
  dcReplPercentile: 98,
  dcBulkPercentile: 90,          // legacy rolling-window mode (kept for old sizeDC export)
  dcBulkOrderPct: 90,            // DC v2: percentile of per-SKU bulk-order sizes
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
    : c.allocMode === 'tiered' ? allocateTiered
    : allocateUnified;
  const { plan, nodeReport, floor, tclass } = allocFn(universe, demand, c);

  // DC: drain pass (infinite DC) → order-size bulk sizing → component-aware trim
  const drainPass = replay(plan, null, demand, { ...c, infiniteDC: true });
  const bulkOrderQty = collectBulkOrderQty(demand);
  const sized = sizeDCOrderBulk(drainPass.toDrain, bulkOrderQty, demand.windowDates, c);
  const { dcPlan, detail: dcDetail, trimReport } = trimDCComponents(
    sized.dcPlan, sized.detail, c.dcCapacity, (sku) => tclass[sku]);

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

/**
 * Keep Score / assortment analysis (recommend-only, network-level).
 * Grades every SKU on the REAL effective plan: holding value = Σ (Min+Max)/2 × PP
 * across 5 DS + DC; sales & NZD are TOTAL (regular + bulk). Adds the capacity-freed
 * consequence of cutting (sheets freed per node + which over-capacity nodes flip green).
 * Score itself is location-agnostic — capacity is shown, never a factor.
 */
export function keepScoreAnalysis(inv, skuM, priceData, cfg) {
  const c = { ...V2_DEFAULTS, ...(cfg || {}) };
  const res = computePlywoodNetworkV2Results(inv, skuM, { plywoodNetworkV2Config: c });
  const skus = Object.keys(res);
  if (skus.length === 0) return null;
  const universe = buildUniverse(skuM, c);
  const demand = prepareDemand(inv, universe, c);

  // plan / dcPlan from the effective results
  const plan = {}, dcPlan = {}, tclass = {};
  for (const sku of skus) {
    plan[sku] = {};
    for (const ds of DS_LIST) plan[sku][ds] = { min: res[sku].storeResults[ds].min, max: res[sku].storeResults[ds].max };
    dcPlan[sku] = { ...res[sku].dcResult };
    tclass[sku] = res[sku].storeResults[DS_LIST[0]].v2?.tclass || thicknessClass(skuM[sku]?.name, c.thickBoundaryMm);
  }

  // TOTAL sales qty + TOTAL network NZD (regular + bulk), from all order lines in window
  const windowQty = {}, nzdSet = {};
  for (const sku of skus) { windowQty[sku] = 0; nzdSet[sku] = new Set(); }
  for (const o of demand.orders) {
    for (const l of o.lines) {
      if (windowQty[l.sku] === undefined) continue;
      windowQty[l.sku] += l.qty;
      nzdSet[l.sku].add(o.date);
    }
  }
  const networkNZD = {};
  for (const sku of skus) networkNZD[sku] = nzdSet[sku].size;

  // score (NZD≥2 gate uses TOTAL network NZD per decision 1)
  const scored = computeKeepScores(
    { plan, dcPlan, priceData: priceData || {}, windowQty, networkNZD, regularNZD: networkNZD },
    c.keepScore || {});

  const rows = scored.map(s => ({
    ...s,
    name: skuM[s.sku]?.name || s.sku,
    brand: skuM[s.sku]?.brand || '',
    tclass: tclass[s.sku],
    windowQty: windowQty[s.sku] || 0,                 // Sold Qty (total, regular + bulk)
    networkNZD: networkNZD[s.sku] || 0,
    maxHoldQty: DS_LIST.reduce((a, ds) => a + plan[s.sku][ds].max, 0) + (dcPlan[s.sku]?.max || 0), // ΣMax = peak shelf footprint
    salesValue: (windowQty[s.sku] || 0) * (priceData?.[s.sku] || 0),  // Sales ₹ (cost basis)
  }));

  // capacity-freed consequence of the Cut set, per node × class (DS + DC)
  const cutSet = new Set(rows.filter(r => r.flag === 'Cut').map(r => r.sku));
  const nodes = [];
  const nodeSpecs = [...DS_LIST.map(ds => ({ node: ds, maxOf: sku => plan[sku][ds].max, cap: t => c.dsCapacities?.[ds]?.[t] })),
                     { node: 'DC', maxOf: sku => dcPlan[sku].max, cap: t => c.dcCapacity?.[t] }];
  for (const spec of nodeSpecs) {
    for (const t of ['thick', 'thin']) {
      let before = 0, after = 0;
      for (const sku of skus) {
        if (tclass[sku] !== t) continue;
        const m = spec.maxOf(sku);
        before += m;
        if (!cutSet.has(sku)) after += m;
      }
      const cap = spec.cap(t);
      nodes.push({ node: spec.node, tclass: t, cap: cap ?? null, before, after, freed: before - after,
        flips: cap != null && before > cap && after <= cap, stillOver: cap != null && after > cap });
    }
  }

  const cut = rows.filter(r => r.flag === 'Cut');
  const summary = {
    keep: rows.filter(r => r.flag === 'Keep').length,
    watch: rows.filter(r => r.flag === 'Watch').length,
    cut: cut.length,
    total: rows.length,
    salesAtRisk: cut.reduce((a, r) => a + r.salesValue, 0),
    totalSales: rows.reduce((a, r) => a + r.salesValue, 0),
    holdingFreed: cut.reduce((a, r) => a + r.holdingValue, 0),
    totalHolding: rows.reduce((a, r) => a + r.holdingValue, 0),
    flipsGreen: nodes.filter(n => n.flips).map(n => `${n.node} ${n.tclass}`),
  };
  return { rows, summary, nodes };
}

// Re-exports for tab / harness use
export { buildUniverse, prepareDemand, medianOrderQty, collectBulkOrderQty } from './demand.js';
export { allocate, allocateEmpirical, allocateTiered, allocateUnified, thicknessClass } from './allocator.js';
export { replay } from './replay.js';
export { sizeDC, trimDCToCapacity, sizeDCOrderBulk, trimDCComponents, rollingSums } from './dc.js';
export { dcEvaluate, dcSweep } from './evaluate.js';
export { computeKeepScores } from './keepScore.js';
export { evaluatePlan, autoTune, deriveNZDBuckets, bucketOf, planFootprint, fitPlan } from './evaluate.js';
