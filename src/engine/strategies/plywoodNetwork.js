// Plywood Network Design strategy
// Pre-computes Min/Max for all Network Design brand SKUs before the main engine loop.
// Only runs when categoryStrategies["Plywood, MDF & HDHMR"] === "network_design".
// Brands not in config (e.g. Merino) fall through to existing PCT strategy in runEngine.

import { percentile } from '../utils.js';
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
  const results = {};

  for (const [skuId, meta] of Object.entries(skuM)) {
    if (!isNetworkDesignSKU(meta, brands)) continue;
    const brandCfg = findBrandConfig(meta.brand, brands);
    const { nodes, dcMultMin, dcMultMax } = brandCfg;

    const storeResults = {};
    const nodeMinMax = {};

    // Compute Min/Max for each DS stocking node
    for (const [nodeId, nodeCfg] of Object.entries(nodes)) {
      if (nodeId === 'DC') continue;
      const { min: p95Min, nonZeroCount, belowMinNZD, p95Raw } =
        computeNodeMin(skuId, nodeCfg.covers, dailyDemand, minPercentile, spikeCapMultiplier, minNZD);

      let finalMin, finalMax, zone, abq = null, demandSignal = null;

      if (belowMinNZD) {
        // Rare: too few observations — do not stock
        zone = 'rare'; finalMin = 0; finalMax = 0;
      } else if (nonZeroCount < sparseNZD) {
        // Sparse: ABQ-based stocking — P95 unreliable with few data points
        zone = 'sparse';
        const allOrders = [];
        for (const ds of nodeCfg.covers) allOrders.push(...(orderQtys[skuId]?.[ds] || []));
        const totalQty = allOrders.reduce((a, b) => a + b, 0);
        abq = allOrders.length > 0 ? totalQty / allOrders.length : 0;
        demandSignal = abq;
        finalMin = Math.ceil(abq);
        finalMax = Math.min(Math.max(Math.ceil(abq * abqMultiplier), finalMin), maxCap);
      } else {
        // Frequent: P95-based stocking
        zone = 'frequent';
        demandSignal = p95Raw;
        const orderBuf = computeOrderBuffer(skuId, nodeCfg.covers, orderQtys, maxBufferPercentile);
        finalMax = Math.min(p95Min + orderBuf, maxCap);
        finalMin = Math.min(p95Min, Math.max(0, finalMax - 1));
      }

      nodeMinMax[nodeId] = { min: finalMin, max: finalMax };
      // Store covers so the tab can display "Covered DSes: DS01, DS05"
      storeResults[nodeId] = { min: finalMin, max: finalMax, nonZeroCount, covers: nodeCfg.covers, zone, abq, demandSignal };
    }

    // Non-stocking DSes → 0
    for (const ds of DS_LIST) {
      if (!storeResults[ds]) storeResults[ds] = { min: 0, max: 0, nonZeroCount: 0, covers: [] };
    }

    // DC: P95 direct-serving component (if DC node defined) + multiplier component
    let dcP95 = 0;
    if (nodes.DC) {
      const { min, belowMinNZD: dcBelow } = computeNodeMin(skuId, nodes.DC.covers, dailyDemand, minPercentile, spikeCapMultiplier, minNZD);
      dcP95 = dcBelow ? 0 : min;
    }

    // Σ DS_Min × mult: scales with demand velocity (Min ≈ P95 of daily demand).
    // Faster SKUs have higher Min → DC holds more, which is correct.
    // Σ(Max-Min) would collapse to near-zero for capped fast-movers, understocking DC.
    const sumMin = Object.values(nodeMinMax).reduce((acc, { min }) => acc + min, 0);
    const dcMin = dcP95 + Math.ceil(sumMin * dcMultMin);
    const dcMax = Math.max(dcP95 + Math.ceil(sumMin * dcMultMax), dcMin);

    results[skuId] = {
      brand: meta.brand,
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
