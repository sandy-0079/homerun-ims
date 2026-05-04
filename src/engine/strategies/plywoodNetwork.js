// Plywood Network Design strategy
// Pre-computes Min/Max for all Network Design brand SKUs before the main engine loop.
// Only runs when categoryStrategies["Plywood, MDF & HDHMR"] === "network_design".
// Brands not in config (e.g. Merino) fall through to existing PCT strategy in runEngine.
//
// Bulk/Regular split:
//   cross-DS ABQ determines a per-SKU bulk threshold (N × ABQ).
//   Zone classification uses total NZD (all orders).
//   Min/Max computation uses regular orders only (≤ threshold).
//   If all orders at a node are bulk → Min=Max=0 (don't stock, free space).

import { percentile, inferThickness, thicknessCategory } from '../utils.js';
import { DS_LIST } from '../constants.js';

const PLYWOOD_CATEGORY = 'Plywood, MDF & HDHMR';

function findBrandConfig(brand, brands) {
  if (!brand || !brands) return null;
  const key = Object.keys(brands).find(k => k.toLowerCase() === brand.toLowerCase());
  return key ? brands[key] : null;
}

function isNetworkDesignSKU(meta, brands) {
  return meta.category === PLYWOOD_CATEGORY && !!findBrandConfig(meta.brand, brands);
}

// Build daily-demand and order-lines maps for the plywood lookback window.
// orderLines keeps individual dated order quantities for bulk/regular split.
function buildMaps(inv, cutoffStr) {
  const dailyDemand = {};
  const orderLines = {}; // { sku: { ds: [{qty, date}] } }
  for (const r of inv) {
    if (r.date < cutoffStr) continue;
    const { sku, ds, date } = r;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;
    if (!dailyDemand[sku]) dailyDemand[sku] = {};
    if (!dailyDemand[sku][ds]) dailyDemand[sku][ds] = {};
    dailyDemand[sku][ds][date] = (dailyDemand[sku][ds][date] || 0) + qty;
    if (!orderLines[sku]) orderLines[sku] = {};
    if (!orderLines[sku][ds]) orderLines[sku][ds] = [];
    orderLines[sku][ds].push({ qty, date });
  }
  return { dailyDemand, orderLines };
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

// Count total NZD (all orders, including bulk) for zone classification.
function countTotalNZD(sku, coveredDSes, dailyDemand) {
  const totals = aggregateDailyTotals(sku, coveredDSes, dailyDemand);
  return Object.values(totals).filter(q => q > 0).length;
}

// P{pct} of winsorised regular daily demand → node Min (no minNZD gate — zone already handled).
function computeRegularNodeMin(sku, coveredDSes, regularDailyDemand, minPct, spikeCapMult) {
  const totals = aggregateDailyTotals(sku, coveredDSes, regularDailyDemand);
  const nonZero = Object.values(totals).filter(q => q > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return { min: 0, regularNZD: 0, p95Raw: 0 };
  const mid = Math.floor(nonZero.length / 2);
  const med = nonZero.length % 2 === 0 ? (nonZero[mid - 1] + nonZero[mid]) / 2 : nonZero[mid];
  const cap = med * (spikeCapMult || 3);
  const winsorized = nonZero.map(v => Math.min(v, cap));
  const p95Raw = percentile(winsorized, minPct);
  const winsorisedMax = winsorized[winsorized.length - 1]; // max of winsorised regular daily demand
  return { min: Math.ceil(p95Raw), regularNZD: nonZero.length, p95Raw, winsorisedMax };
}

// P{pct} of individual order quantities across covered DSes → Max buffer.
// orderQtyMap: { skuId: { ds: [qty] } }
function computeOrderBuffer(sku, coveredDSes, orderQtyMap, maxBufPct) {
  const all = [];
  for (const ds of coveredDSes) all.push(...(orderQtyMap[sku]?.[ds] || []));
  if (all.length === 0) return 0;
  all.sort((a, b) => a - b);
  return Math.ceil(percentile(all, maxBufPct));
}

// Legacy P95 computeNodeMin — still used by applyCapacityTrim Pass 4 and DC direct-serving.
function computeNodeMin(sku, coveredDSes, dailyDemand, minPct, spikeCapMult, minNZD) {
  const totals = aggregateDailyTotals(sku, coveredDSes, dailyDemand);
  const nonZero = Object.values(totals).filter(q => q > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return { min: 0, nonZeroCount: 0, belowMinNZD: true, p95Raw: 0 };
  if (nonZero.length < (minNZD || 2)) return { min: 0, nonZeroCount: nonZero.length, belowMinNZD: true, p95Raw: 0 };
  const mid = Math.floor(nonZero.length / 2);
  const med = nonZero.length % 2 === 0 ? (nonZero[mid - 1] + nonZero[mid]) / 2 : nonZero[mid];
  const cap = med * (spikeCapMult || 3);
  const winsorized = nonZero.map(v => Math.min(v, cap));
  const p95Raw = percentile(winsorized, minPct);
  return { min: Math.ceil(p95Raw), nonZeroCount: nonZero.length, p95Raw };
}

// Spread ratio = max(orders) / P25(orders) — measures order quantity erraticity.
function spreadRatio(orderQtys) {
  if (!orderQtys || orderQtys.length < 2) return 1;
  const sorted = [...orderQtys].sort((a, b) => a - b);
  const p25 = percentile(sorted, 25);
  return p25 > 0 ? sorted[sorted.length - 1] / p25 : Infinity;
}

/**
 * Capacity-aware trim — runs after all node Min/Max computed, before DC.
 * Uses regular orders for trim passes to stay consistent with Min/Max computation.
 */
function applyCapacityTrim(rawResults, skuM, cfg, dsCapacities, regularDailyDemand, regularOrderQtys) {
  if (!dsCapacities) return;
  const thickBoundary  = cfg.thickBoundaryMm        || 9;
  const tolerancePct   = (cfg.capacityTolerancePct  || 2) / 100;
  const erraticTh      = cfg.sparseErraticThreshold  || 1.5;
  const spikeCapMult   = cfg.spikeCapMultiplier      || 3;
  const minNZD         = cfg.minNZD                  || 2;

  const nodes = {};
  for (const [skuId, data] of Object.entries(rawResults)) {
    for (const [nodeId, sr] of Object.entries(data.storeResults)) {
      if (!sr.covers || sr.covers.length === 0) continue;
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

      const skuData = {};
      for (const skuId of inGroup) {
        const sr = rawResults[skuId].storeResults[nodeId];
        const regOrders = [];
        for (const ds of sr.covers) regOrders.push(...(regularOrderQtys[skuId]?.[ds] || []));
        const sorted = [...regOrders].sort((a, b) => a - b);
        skuData[skuId] = {
          zone: sr.zone,
          sortedOrders: sorted,
          ratio: spreadRatio(regOrders),
          isErratic: spreadRatio(regOrders) > erraticTh,
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

      for (const id of inGroup.filter(id => skuData[id].zone === 'sparse' && skuData[id].isErratic && untrimmed(id)).sort(byRatioDesc)) {
        if (deficit <= 0) break;
        const newMin = Math.max(1, Math.ceil(percentile(skuData[id].sortedOrders, 25)));
        const newMax = newMin + 1;
        if (newMax >= rawResults[id].storeResults[nodeId].max) continue;
        trim(id, newMin, newMax);
      }
      if (deficit <= 0) continue;

      for (const id of inGroup.filter(id => skuData[id].zone === 'frequent' && skuData[id].isErratic && untrimmed(id)).sort(byRatioDesc)) {
        if (deficit <= 0) break;
        const sr = rawResults[id].storeResults[nodeId];
        const p25buf = Math.ceil(percentile(skuData[id].sortedOrders, 25));
        const newMax = Math.max(sr.min + 1, sr.min + p25buf);
        if (newMax >= sr.max) continue;
        trim(id, sr.min, newMax);
      }
      if (deficit <= 0) continue;

      for (const id of inGroup.filter(id => skuData[id].zone === 'sparse' && untrimmed(id)).sort(byRatioDesc)) {
        if (deficit <= 0) break;
        const newMin = Math.max(1, Math.ceil(percentile(skuData[id].sortedOrders, 25)));
        const newMax = newMin + 1;
        if (newMax >= rawResults[id].storeResults[nodeId].max) continue;
        trim(id, newMin, newMax);
      }
      if (deficit <= 0) continue;

      const freqErratic = inGroup.filter(id => skuData[id].zone === 'frequent' && skuData[id].isErratic).sort(byRatioDesc);
      for (const pct of [85, 75]) {
        for (const id of freqErratic) {
          if (deficit <= 0) break;
          const sr = rawResults[id].storeResults[nodeId];
          const covers = sr.covers;
          const { min: newMinRaw, regularNZD } = computeRegularNodeMin(id, covers, regularDailyDemand, pct, spikeCapMult);
          if (regularNZD === 0 || newMinRaw >= sr.min) continue;
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
 * Zone classification from total NZD; Min/Max from regular orders (≤ N×cross_DS_ABQ).
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
    bulkThresholdMultiplier = 2.0,
    minOrdersForBulkFilter = 5,
    bulkMaxThreshold = 10,
    brands,
  } = cfg;

  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return {};
  const latest = new Date(allDates[allDates.length - 1]);
  latest.setDate(latest.getDate() - lookbackDays);
  const cutoffStr = latest.toISOString().slice(0, 10);

  const { dailyDemand, orderLines } = buildMaps(inv, cutoffStr);

  // ── Phase 0: compute cross-DS bulk thresholds and build regular demand maps ─
  const regularDailyDemand = {}; // same structure as dailyDemand, regular orders only
  const regularOrderQtys   = {}; // { skuId: { ds: [qty] } }
  const bulkOrderQtys      = {}; // { skuId: { ds: [qty] } } — for modal display
  const bulkThresholds     = {}; // { skuId: number | null }
  const crossDSAbqs        = {}; // { skuId: number } — for modal display

  for (const [skuId, meta] of Object.entries(skuM)) {
    if (!isNetworkDesignSKU(meta, brands)) continue;
    if ((meta.status || 'Active').toLowerCase() !== 'active') continue;

    // Per-DS ABQ: compute threshold for each DS independently, take the max.
    // Low-activity DSes benefit from the most generous signal across all active DSes.
    const perDSThresholds = [];
    let maxDSAbq = 0;
    for (const ds of DS_LIST) {
      const dsOrders = (orderLines[skuId]?.[ds] || []).map(l => l.qty);
      if (dsOrders.length >= minOrdersForBulkFilter) {
        const dsAbq = dsOrders.reduce((a, b) => a + b, 0) / dsOrders.length;
        maxDSAbq = Math.max(maxDSAbq, dsAbq);
        perDSThresholds.push(Math.ceil(bulkThresholdMultiplier * dsAbq));
      }
    }
    const abqThreshold = perDSThresholds.length > 0 ? Math.max(...perDSThresholds) : null;
    // Universal floor: orders >= bulkMaxThreshold always bulk; cap ABQ threshold at floor
    const threshold = abqThreshold !== null
      ? Math.min(abqThreshold, bulkMaxThreshold - 1)
      : (bulkMaxThreshold - 1);
    const crossAbq = maxDSAbq; // for display — ABQ of the DS that drove the threshold
    bulkThresholds[skuId] = threshold;
    crossDSAbqs[skuId] = crossAbq;

    // Build regular/bulk demand maps per DS
    regularDailyDemand[skuId] = {};
    regularOrderQtys[skuId] = {};
    bulkOrderQtys[skuId] = {};

    for (const ds of DS_LIST) {
      regularDailyDemand[skuId][ds] = {};
      regularOrderQtys[skuId][ds] = [];
      bulkOrderQtys[skuId][ds] = [];

      for (const { qty, date } of (orderLines[skuId]?.[ds] || [])) {
        if (threshold === null || qty <= threshold) {
          regularDailyDemand[skuId][ds][date] = (regularDailyDemand[skuId][ds][date] || 0) + qty;
          regularOrderQtys[skuId][ds].push(qty);
        } else {
          bulkOrderQtys[skuId][ds].push(qty);
        }
      }
    }
  }

  // ── Phase 1: compute raw node Min/Max for every SKU ──────────────────────
  const rawResults = {};

  for (const [skuId, meta] of Object.entries(skuM)) {
    if (!isNetworkDesignSKU(meta, brands)) continue;
    if ((meta.status || 'Active').toLowerCase() !== 'active') continue;
    const brandCfg = findBrandConfig(meta.brand, brands);
    const { nodes, dcMultMin, dcMultMax } = brandCfg;

    const storeResults = {};
    const nodeMinMax = {};

    const threshold  = bulkThresholds[skuId];
    const crossAbq   = crossDSAbqs[skuId];
    const bulkFilterApplied = threshold !== null;

    for (const [nodeId, nodeCfg] of Object.entries(nodes)) {
      if (nodeId === 'DC') continue;

      // Zone from TOTAL NZD (all orders including bulk)
      const totalNZD = countTotalNZD(skuId, nodeCfg.covers, dailyDemand);

      // winsorisedMax shared by both Sparse and Frequent for Max computation
      const { min: regP95Min, regularNZD, p95Raw, winsorisedMax } =
        computeRegularNodeMin(skuId, nodeCfg.covers, regularDailyDemand, minPercentile, spikeCapMultiplier);

      let finalMin, finalMax, zone, abq = null, demandSignal = null;

      if (totalNZD < minNZD) {
        zone = 'rare'; finalMin = 0; finalMax = 0;
      } else if (totalNZD < sparseNZD) {
        // Sparse: ABQ from regular orders, Max = max regular day ≥ Min+1
        zone = 'sparse';
        const regOrders = [];
        for (const ds of nodeCfg.covers) regOrders.push(...(regularOrderQtys[skuId]?.[ds] || []));
        if (regOrders.length === 0) {
          finalMin = 0; finalMax = 0;
        } else {
          abq = regOrders.reduce((a, b) => a + b, 0) / regOrders.length;
          demandSignal = abq;
          finalMin = Math.ceil(abq);
          finalMax = Math.min(Math.max(winsorisedMax, finalMin + 1), maxCap);
        }
      } else {
        // Frequent: P95 of regular daily demand, Max = max regular day ≥ Min+1
        zone = 'frequent';
        if (regularNZD === 0) {
          finalMin = 0; finalMax = 0;
        } else {
          demandSignal = p95Raw;
          // Max = max of winsorised regular daily demand, at least Min+1
          finalMax = Math.min(Math.max(winsorisedMax, regP95Min + 1), maxCap);
          finalMin = Math.min(regP95Min, Math.max(0, finalMax - 1));
        }
      }

      nodeMinMax[nodeId] = { min: finalMin, max: finalMax };
      storeResults[nodeId] = {
        min: finalMin, max: finalMax, nonZeroCount: totalNZD,
        covers: nodeCfg.covers, zone, abq, demandSignal,
        bulkThreshold: threshold, crossDSAbq: crossAbq, bulkFilterApplied,
      };
    }

    // Non-stocking DSes → 0
    for (const ds of DS_LIST) {
      if (!storeResults[ds]) storeResults[ds] = { min: 0, max: 0, nonZeroCount: 0, covers: [] };
    }

    rawResults[skuId] = { brand: meta.brand, storeResults, nodeMinMax, nodes, dcMultMin, dcMultMax };
  }

  // ── Phase 2: capacity trim ────────────────────────────────────────────────
  if (params.dsCapacities) {
    applyCapacityTrim(rawResults, skuM, cfg, params.dsCapacities, regularDailyDemand, regularOrderQtys);
  }

  // ── Phase 3: compute DC for each SKU using (trimmed) nodeMinMax ──────────
  const results = {};

  for (const [skuId, data] of Object.entries(rawResults)) {
    const { brand, storeResults, nodeMinMax, nodes, dcMultMin, dcMultMax } = data;

    let dcP95 = 0;
    if (nodes.DC) {
      // DC direct-serving uses regular demand (bulk excluded)
      const { min, belowMinNZD: dcBelow } = computeNodeMin(
        skuId, nodes.DC.covers, regularDailyDemand, minPercentile, spikeCapMultiplier, minNZD
      );
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
 * Optionally accepts a bulkThreshold to split regular/bulk demand for modal charts.
 */
export function computeNetworkNodeStats(inv, skuMaster, brand, coveredDSes, lookbackDays = 90, bulkThresholdsBySku = null) {
  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return [];
  const latest = new Date(allDates[allDates.length - 1]);
  latest.setDate(latest.getDate() - lookbackDays);
  const cutoffStr = latest.toISOString().slice(0, 10);

  const { dailyDemand, orderLines } = buildMaps(inv, cutoffStr);

  const brandLower = brand.toLowerCase();
  const brandSKUs = Object.values(skuMaster).filter(
    m => m.brand?.toLowerCase() === brandLower && m.category === PLYWOOD_CATEGORY && (m.status || 'Active').toLowerCase() === 'active'
  );

  return brandSKUs.map(meta => {
    const sku = meta.sku;

    // Total demand (for NZD and timeline)
    const totals = aggregateDailyTotals(sku, coveredDSes, dailyDemand);
    const nonZeroTotals = Object.values(totals).filter(q => q > 0).sort((a, b) => a - b);
    const dailyMap = totals;

    // Split regular / bulk
    const allOrderLines = [];
    for (const ds of coveredDSes) allOrderLines.push(...(orderLines[sku]?.[ds] || []));

    const bulkThreshold = bulkThresholdsBySku ? (bulkThresholdsBySku[sku] ?? null) : null;
    const regularLines = bulkThreshold !== null ? allOrderLines.filter(l => l.qty <= bulkThreshold) : allOrderLines;
    const bulkLines    = bulkThreshold !== null ? allOrderLines.filter(l => l.qty >  bulkThreshold) : [];

    // Regular daily map (for formula computation and chart)
    const regularDailyMap = {};
    for (const { qty, date } of regularLines) {
      regularDailyMap[date] = (regularDailyMap[date] || 0) + qty;
    }

    // Bulk daily map (for chart overlay)
    const bulkDailyMap = {};
    for (const { qty, date } of bulkLines) {
      bulkDailyMap[date] = (bulkDailyMap[date] || 0) + qty;
    }

    const regularOrderQtys = regularLines.map(l => l.qty).sort((a, b) => a - b);
    const bulkOrderQtys    = bulkLines.map(l => l.qty).sort((a, b) => a - b);

    const regularNonZeroTotals = Object.values(regularDailyMap).filter(q => q > 0).sort((a, b) => a - b);

    return {
      sku,
      name: meta.name,
      nzd: nonZeroTotals.length,          // total NZD for zone classification
      dailyTotals: regularNonZeroTotals,  // regular demand for formula (P95/ABQ)
      dailyMap,                            // total for timeline chart
      regularDailyMap,
      bulkDailyMap,
      orderQtys: regularOrderQtys,        // regular orders for Max buffer
      bulkOrderQtys,
      bulkThreshold,
    };
  });
}
