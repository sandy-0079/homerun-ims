// Plywood Network Design strategy
// Pre-computes Min/Max for all Network Design brand SKUs before the main engine loop.
// Only runs when categoryStrategies["Plywood, MDF & HDHMR"] === "network_design".
// Brands not in config (e.g. Merino) fall through to existing PCT strategy in runEngine.

import { percentile, inferThickness, thicknessCategory } from '../utils.js';
import { DS_LIST } from '../constants.js';

const PLYWOOD_CATEGORY = 'Plywood, MDF & HDHMR';

// Case-insensitive brand lookup — guards against "ArchidPly" vs "Archidply" mismatches
// between the config and what's actually stored in skuMaster.
function findBrandConfig(brand, brands) {
  if (!brand || !brands) return null;
  const key = Object.keys(brands).find(k => k.toLowerCase() === brand.toLowerCase());
  return key ? brands[key] : null;
}

function isNetworkDesignSKU(meta, brands) {
  return meta.category === PLYWOOD_CATEGORY && !!findBrandConfig(meta.brand, brands);
}

// Build daily-demand and order-qty maps for the plywood lookback window.
function buildMaps(inv, cutoffStr) {
  const dailyDemand = {};
  const orderQtys = {};
  for (const r of inv) {
    if (r.date < cutoffStr) continue;
    const { sku, ds, date } = r;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;
    if (!dailyDemand[sku]) dailyDemand[sku] = {};
    if (!dailyDemand[sku][ds]) dailyDemand[sku][ds] = {};
    dailyDemand[sku][ds][date] = (dailyDemand[sku][ds][date] || 0) + qty;
    if (!orderQtys[sku]) orderQtys[sku] = {};
    if (!orderQtys[sku][ds]) orderQtys[sku][ds] = [];
    orderQtys[sku][ds].push(qty);
  }
  return { dailyDemand, orderQtys };
}

// Aggregate daily totals across a list of DSes for one SKU.
function aggregateDailyTotals(sku, coveredDSes, dailyDemand) {
  const totals = {};
  for (const ds of coveredDSes) {
    for (const [date, qty] of Object.entries(dailyDemand[sku]?.[ds] || {})) {
      totals[date] = (totals[date] || 0) + qty;
    }
  }
  return totals;
}

// P{pct} of winsorized non-zero aggregated daily demand → node Min.
// Guards:
//   1. minNZD — fewer observations than threshold → Min = 0 (no stocking, on-demand only)
//   2. spikeCapMult — caps outlier days at median × mult before P95 computation
function computeNodeMin(sku, coveredDSes, dailyDemand, minPct, spikeCapMult, minNZD) {
  const totals = aggregateDailyTotals(sku, coveredDSes, dailyDemand);
  const nonZero = Object.values(totals).filter(q => q > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return { min: 0, nonZeroCount: 0, belowMinNZD: true, p95Raw: 0 };

  // Guard 1: insufficient demand history → do not stock (Rare zone)
  if (nonZero.length < (minNZD || 2)) return { min: 0, nonZeroCount: nonZero.length, belowMinNZD: true, p95Raw: 0 };

  // Guard 2: winsorize — cap values above median × spikeCapMult
  const mid = Math.floor(nonZero.length / 2);
  const med = nonZero.length % 2 === 0
    ? (nonZero[mid - 1] + nonZero[mid]) / 2
    : nonZero[mid];
  const cap = med * (spikeCapMult || 3);
  const winsorized = nonZero.map(v => Math.min(v, cap));

  const p95Raw = percentile(winsorized, minPct);
  return { min: Math.ceil(p95Raw), nonZeroCount: nonZero.length, p95Raw };
}

// P{pct} of individual order quantities across covered DSes → Max buffer.
function computeOrderBuffer(sku, coveredDSes, orderQtys, maxBufPct) {
  const all = [];
  for (const ds of coveredDSes) all.push(...(orderQtys[sku]?.[ds] || []));
  if (all.length === 0) return 0;
  all.sort((a, b) => a - b);
  return Math.ceil(percentile(all, maxBufPct));
}

// Spread ratio = max(orders) / P25(orders) — measures order quantity erraticity.
// High ratio (e.g. [6,13] → 1.93) means demand is lumpy; low (e.g. [6,7] → 1.12) means consistent.
function spreadRatio(orderQtys) {
  if (!orderQtys || orderQtys.length < 2) return 1;
  const sorted = [...orderQtys].sort((a, b) => a - b);
  const p25 = percentile(sorted, 25);
  return p25 > 0 ? sorted[sorted.length - 1] / p25 : Infinity;
}

/**
 * Capacity-aware trim — runs after all node Min/Max computed, before DC.
 * Per stocking node, per thickness (thick/thin independently).
 * 4 passes, one SKU at a time sorted by spread ratio desc, stops when within tolerance.
 * Pass 1: Sparse Erratic   — Min=P25(orders), Max=Min+1
 * Pass 2: Frequent Erratic — Max=Min+ceil(P25(orders)), Min unchanged
 * Pass 3: Sparse Conservative — same as Pass 1 for remaining Sparse
 * Pass 4: Min of Frequent Erratic — reduce Min to P85 then P75 of daily demand
 */
function applyCapacityTrim(rawResults, skuM, cfg, dsCapacities, dailyDemand, orderQtys) {
  if (!dsCapacities) return;
  const thickBoundary  = cfg.thickBoundaryMm        || 9;
  const tolerancePct   = (cfg.capacityTolerancePct  || 2) / 100;
  const erraticTh      = cfg.sparseErraticThreshold  || 1.5;
  const spikeCapMult   = cfg.spikeCapMultiplier      || 3;
  const minNZD         = cfg.minNZD                  || 2;

  // Collect per-node data: { nodeId → { skuIds, capacity:{thick,thin} } }
  const nodes = {};
  for (const [skuId, data] of Object.entries(rawResults)) {
    for (const [nodeId, sr] of Object.entries(data.storeResults)) {
      if (!sr.covers || sr.covers.length === 0) continue; // non-stocking node
      if (!nodes[nodeId]) nodes[nodeId] = { skuIds: [], cap: dsCapacities[nodeId] };
      nodes[nodeId].skuIds.push(skuId);
    }
  }

  for (const [nodeId, { skuIds, cap }] of Object.entries(nodes)) {
    if (!cap) continue;

    for (const [thicknessKey, capacity] of [['thick', cap.thick], ['thin', cap.thin]]) {
      if (!capacity || capacity <= 0) continue;

      const inGroup = skuIds.filter(id => {
        const mm = inferThickness(skuM[id]?.name);
        if (mm === null || mm <= 1) return false;
        return thicknessKey === 'thick' ? mm > thickBoundary : mm <= thickBoundary;
      });

      const sumMax = inGroup.reduce((s, id) => s + (rawResults[id].storeResults[nodeId]?.max || 0), 0);
      const target = Math.ceil(capacity * (1 + tolerancePct));
      if (sumMax <= target) continue;

      let deficit = sumMax - target;

      // Precompute per-SKU data for this node
      const skuData = {};
      for (const skuId of inGroup) {
        const sr = rawResults[skuId].storeResults[nodeId];
        const allOrders = [];
        for (const ds of sr.covers) allOrders.push(...(orderQtys[skuId]?.[ds] || []));
        const sorted = [...allOrders].sort((a, b) => a - b);
        skuData[skuId] = {
          zone: sr.zone,
          sortedOrders: sorted,
          ratio: spreadRatio(allOrders),
          isErratic: spreadRatio(allOrders) > erraticTh,
        };
      }

      const byRatioDesc = (a, b) => skuData[b].ratio - skuData[a].ratio;
      const untrimmed = id => !rawResults[id].storeResults[nodeId].trimTag;

      const trim = (skuId, newMin, newMax) => {
        const sr = rawResults[skuId].storeResults[nodeId];
        deficit -= (sr.max - newMax);
        rawResults[skuId].storeResults[nodeId] = {
          ...sr, min: newMin, max: newMax,
          originalMin: sr.originalMin ?? sr.min,
          originalMax: sr.originalMax ?? sr.max,
          trimTag: 'Cap Trim',
        };
        rawResults[skuId].nodeMinMax[nodeId] = { min: newMin, max: newMax };
      };

      // Pass 1: Sparse Erratic
      for (const id of inGroup.filter(id => skuData[id].zone === 'sparse' && skuData[id].isErratic && untrimmed(id)).sort(byRatioDesc)) {
        if (deficit <= 0) break;
        const newMin = Math.max(1, Math.ceil(percentile(skuData[id].sortedOrders, 25)));
        const newMax = newMin + 1;
        if (newMax >= rawResults[id].storeResults[nodeId].max) continue;
        trim(id, newMin, newMax);
      }
      if (deficit <= 0) continue;

      // Pass 2: Frequent Erratic — trim Max buffer only
      for (const id of inGroup.filter(id => skuData[id].zone === 'frequent' && skuData[id].isErratic && untrimmed(id)).sort(byRatioDesc)) {
        if (deficit <= 0) break;
        const sr = rawResults[id].storeResults[nodeId];
        const p25buf = Math.ceil(percentile(skuData[id].sortedOrders, 25));
        const newMax = Math.max(sr.min + 1, sr.min + p25buf);
        if (newMax >= sr.max) continue;
        trim(id, sr.min, newMax);
      }
      if (deficit <= 0) continue;

      // Pass 3: Sparse Conservative — all remaining Sparse
      for (const id of inGroup.filter(id => skuData[id].zone === 'sparse' && untrimmed(id)).sort(byRatioDesc)) {
        if (deficit <= 0) break;
        const newMin = Math.max(1, Math.ceil(percentile(skuData[id].sortedOrders, 25)));
        const newMax = newMin + 1;
        if (newMax >= rawResults[id].storeResults[nodeId].max) continue;
        trim(id, newMin, newMax);
      }
      if (deficit <= 0) continue;

      // Pass 4: Min of Frequent Erratic — reduce Min at P85 then P75
      const freqErratic = inGroup.filter(id => skuData[id].zone === 'frequent' && skuData[id].isErratic).sort(byRatioDesc);
      for (const pct of [85, 75]) {
        for (const id of freqErratic) {
          if (deficit <= 0) break;
          const sr = rawResults[id].storeResults[nodeId];
          const covers = sr.covers;
          const { min: newMinRaw, belowMinNZD } = computeNodeMin(id, covers, dailyDemand, pct, spikeCapMult, minNZD);
          if (belowMinNZD || newMinRaw >= sr.min) continue;
          const newMin = Math.max(1, newMinRaw);
          const p25buf = Math.ceil(percentile(skuData[id].sortedOrders, 25));
          const newMax = Math.max(newMin + 1, newMin + p25buf);
          trim(id, newMin, newMax);
        }
        if (deficit <= 0) break;
      }
    }
  }
}

/**
 * Pre-compute Network Design stocking results for all covered brand SKUs.
 * Called once before the main allSKUs.forEach loop in runEngine, only when
 * categoryStrategies["Plywood, MDF & HDHMR"] === "network_design".
 *
 * Returns:
 *   { [skuId]: { brand, storeResults: { [dsId]: {min,max,nonZeroCount,covers} }, dcResult: {min,max} } }
 *
 * SKUs absent from result → runEngine falls through to existing PCT strategy.
 */
export function computePlywoodNetworkResults(inv, skuM, params) {
  const cfg = params?.plywoodNetworkConfig;
  if (!cfg?.brands) return {};

  const {
    lookbackDays = 90,
    minPercentile = 95,
    maxBufferPercentile = 75,
    maxCap = 20,
    spikeCapMultiplier = 3,
    minNZD = 2,
    sparseNZD = 5,
    abqMultiplier = 1.5,
    brands,
  } = cfg;

  // Cutoff date: lookbackDays before the latest invoice date
  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return {};
  const latest = new Date(allDates[allDates.length - 1]);
  latest.setDate(latest.getDate() - lookbackDays);
  const cutoffStr = latest.toISOString().slice(0, 10);

  const { dailyDemand, orderQtys } = buildMaps(inv, cutoffStr);

  // ── Phase 1: compute raw node Min/Max for every SKU ──────────────────────
  const rawResults = {}; // { [skuId]: { brand, storeResults, nodeMinMax, nodes, dcMultMin, dcMultMax } }

  for (const [skuId, meta] of Object.entries(skuM)) {
    if (!isNetworkDesignSKU(meta, brands)) continue;
    if ((meta.status || 'Active').toLowerCase() !== 'active') continue;
    const brandCfg = findBrandConfig(meta.brand, brands);
    const { nodes, dcMultMin, dcMultMax } = brandCfg;

    const storeResults = {};
    const nodeMinMax = {};

    for (const [nodeId, nodeCfg] of Object.entries(nodes)) {
      if (nodeId === 'DC') continue;
      const { min: p95Min, nonZeroCount, belowMinNZD, p95Raw } =
        computeNodeMin(skuId, nodeCfg.covers, dailyDemand, minPercentile, spikeCapMultiplier, minNZD);

      let finalMin, finalMax, zone, abq = null, demandSignal = null;

      if (belowMinNZD) {
        zone = 'rare'; finalMin = 0; finalMax = 0;
      } else if (nonZeroCount < sparseNZD) {
        zone = 'sparse';
        const allOrders = [];
        for (const ds of nodeCfg.covers) allOrders.push(...(orderQtys[skuId]?.[ds] || []));
        const totalQty = allOrders.reduce((a, b) => a + b, 0);
        abq = allOrders.length > 0 ? totalQty / allOrders.length : 0;
        demandSignal = abq;
        finalMin = Math.ceil(abq);
        finalMax = Math.min(Math.max(Math.ceil(finalMin * abqMultiplier), finalMin + 1), maxCap);
      } else {
        zone = 'frequent';
        demandSignal = p95Raw;
        const orderBuf = computeOrderBuffer(skuId, nodeCfg.covers, orderQtys, maxBufferPercentile);
        finalMax = Math.min(p95Min + orderBuf, maxCap);
        finalMin = Math.min(p95Min, Math.max(0, finalMax - 1));
      }

      nodeMinMax[nodeId] = { min: finalMin, max: finalMax };
      storeResults[nodeId] = { min: finalMin, max: finalMax, nonZeroCount, covers: nodeCfg.covers, zone, abq, demandSignal };
    }

    // Non-stocking DSes → 0
    for (const ds of DS_LIST) {
      if (!storeResults[ds]) storeResults[ds] = { min: 0, max: 0, nonZeroCount: 0, covers: [] };
    }

    rawResults[skuId] = { brand: meta.brand, storeResults, nodeMinMax, nodes, dcMultMin, dcMultMax };
  }

  // ── Phase 2: capacity trim (before DC so trimmed DS_Min feeds DC formula) ─
  if (params.dsCapacities) {
    applyCapacityTrim(rawResults, skuM, cfg, params.dsCapacities, dailyDemand, orderQtys);
  }

  // ── Phase 3: compute DC for each SKU using (trimmed) nodeMinMax ──────────
  const results = {};

  for (const [skuId, data] of Object.entries(rawResults)) {
    const { brand, storeResults, nodeMinMax, nodes, dcMultMin, dcMultMax } = data;

    let dcP95 = 0;
    if (nodes.DC) {
      const { min, belowMinNZD: dcBelow } = computeNodeMin(skuId, nodes.DC.covers, dailyDemand, minPercentile, spikeCapMultiplier, minNZD);
      dcP95 = dcBelow ? 0 : min;
    }

    const sumMin = Object.values(nodeMinMax).reduce((acc, { min }) => acc + min, 0);
    const dcMin = dcP95 + Math.ceil(sumMin * dcMultMin);
    const dcMax = Math.max(dcP95 + Math.ceil(sumMin * dcMultMax), dcMin);

    results[skuId] = {
      brand,
      storeResults,
      dcResult: { min: dcMin, max: dcMax },
    };
  }

  return results;
}

/**
 * Compute aggregated SKU stats for the Plywood tab display.
 * For a given stocking node (dsId) and its covered DSes, returns per-SKU demand data.
 * Used by the tab independently of runEngine for visualization.
 */
export function computeNetworkNodeStats(inv, skuMaster, brand, coveredDSes, lookbackDays = 90) {
  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return [];
  const latest = new Date(allDates[allDates.length - 1]);
  latest.setDate(latest.getDate() - lookbackDays);
  const cutoffStr = latest.toISOString().slice(0, 10);

  const { dailyDemand, orderQtys } = buildMaps(inv, cutoffStr);

  const brandLower = brand.toLowerCase();
  const brandSKUs = Object.values(skuMaster).filter(
    m => m.brand?.toLowerCase() === brandLower && m.category === PLYWOOD_CATEGORY && (m.status || 'Active').toLowerCase() === 'active'
  );

  return brandSKUs.map(meta => {
    const sku = meta.sku;
    const totals = aggregateDailyTotals(sku, coveredDSes, dailyDemand);
    const nonZeroTotals = Object.values(totals).filter(q => q > 0).sort((a, b) => a - b);
    const allOrders = [];
    for (const ds of coveredDSes) allOrders.push(...(orderQtys[sku]?.[ds] || []));

    // Daily totals map for histogram/timeline in modal
    const dailyMap = totals;

    return {
      sku,
      name: meta.name,
      nzd: nonZeroTotals.length,
      dailyTotals: nonZeroTotals,
      dailyMap,
      orderQtys: allOrders.sort((a, b) => a - b),
    };
  }); // all active SKUs returned — zero-demand ones show NZD=0, Min=Max=0 in the table
}
