// Allocation logic for Plywood v2. Two modes:
//  - allocateEmpirical (default): τ-service formula, capacity-unconstrained.
//      Min = max(local ABQ, network ABQ, P[tau] of rolling 2-day regular demand)
//      Max = max(local max order, P[netOrderTailPct] of NETWORK order sizes, Min+1)
//    Order sizes are a network-level property of the SKU — network tails rescue
//    combos whose local sample is too thin to estimate its own tail.
//  - allocate (greedy): capacity-budgeted; floors → Min depth by marginal coverage
//    → Max buffer. Kept as an A/B alternative (cfg.allocMode = 'greedy').

import { DS_LIST } from '../../constants.js';
import { inferThickness, percentile } from '../../utils.js';
import { medianOrderQty } from './demand.js';

export function thicknessClass(name, boundaryMm = 9) {
  const mm = inferThickness(name);
  return mm !== null && mm > boundaryMm ? 'thick' : 'thin';
}

// Unified two-branch allocator (DEFAULT — user-confirmed 2026-06-11).
//   NZD ≥ 1: Min = max( P[localDayPct] of local selling-day totals,
//                        P[netOrderPct] of network order sizes )
//            Max = max( largest local selling day, Min + 1 )
//   NZD = 0: Min = network ABQ (qty ÷ orders; 1 if no network history), Max = Min + 1
// Validated: in-sample 99.15%, out-of-sample 92.6% (DS04 95.0 / DS05 95.4).
// Capacity reported, not enforced.
export function allocateUnified(universe, demand, cfg) {
  const { regularDaily, regOrderQtys, windowDates } = demand;
  const localDayPct = cfg.minLocalDayPercentile ?? 90;
  const netOrdPct = cfg.minNetOrderPercentile ?? 90;
  const docCapDays = cfg.minDocCapDays ?? 45;   // 0 = off; caps Min at velocity×days (floored at local order ABQ)
  const span = windowDates?.length || 90;
  const boundary = cfg.thickBoundaryMm ?? 9;
  const caps = cfg.dsCapacities || null;

  const skus = Object.keys(universe).sort();
  const tclass = {};
  for (const sku of skus) tclass[sku] = thicknessClass(universe[sku].name, boundary);

  const plan = {};
  const floor = {};
  for (const sku of skus) {
    plan[sku] = {};
    const no = [...(regOrderQtys[sku] || [])].sort((a, b) => a - b);
    const netAbq = no.length ? Math.ceil(no.reduce((a, b) => a + b, 0) / no.length) : 1;
    const netPx = netOrdPct > 0 && no.length ? Math.ceil(percentile(no, netOrdPct)) : 1;  // 0 = floor off
    floor[sku] = netAbq;

    for (const ds of DS_LIST) {
      const dd = regularDaily[sku]?.[ds] || {};
      const days = Object.values(dd).sort((a, b) => a - b);
      let min, max, tier;
      if (days.length === 0) {
        tier = 'dead';
        min = netAbq;
        max = min + 1;
      } else {
        tier = 'active';
        min = Math.max(Math.ceil(percentile(days, localDayPct)), netPx);
        if (docCapDays > 0) {
          // velocity cap: never hold more Min than local rate justifies,
          // floored at the local per-day ABQ so one typical order stays coverable
          const qty = days.reduce((a, b) => a + b, 0);
          const localOrdAbq = Math.ceil(qty / days.length);
          const doc = Math.ceil((qty / span) * docCapDays);
          min = Math.min(min, Math.max(doc, localOrdAbq, 1));
        }
        max = Math.max(days[days.length - 1], min + 1);
      }
      plan[sku][ds] = { min, max, floor: Math.min(min, tier === 'dead' ? netAbq : netPx), tier };
    }
  }

  const nodeReport = {};
  for (const ds of DS_LIST) {
    nodeReport[ds] = {};
    for (const tc of ['thick', 'thin']) {
      const group = skus.filter(s => tclass[s] === tc);
      const used = group.reduce((a, s) => a + plan[s][ds].max, 0);
      const floorUsed = group.reduce((a, s) => a + plan[s][ds].floor + 1, 0);
      const cap = caps?.[ds]?.[tc];
      nodeReport[ds][tc] = {
        capacity: cap ?? null, floorUsed, used,
        overCapacity: cap != null && used > cap,
      };
    }
  }
  return { plan, nodeReport, floor, tclass };
}

// Tiered τ-service allocator: Min logic scales with LOCAL order frequency.
//   Frequent (NZD ≥ tierFrequentNZD): Min = max(localABQ, P[tau] 2-day rolling)
//   Moderate (NZD ≥ tierModerateNZD): same as frequent (quantile self-scales down)
//   Sparse   (NZD ≥ tierSparseNZD):   Min = max(localABQ, netABQ)
//   Dead     (below):                  lean Min from network signal (median order or 1)
// Max = max(local max regular order, Min+1) — no network tails (that's the lean trade).
// Capacity reported, not enforced.
export function allocateTiered(universe, demand, cfg) {
  const { regularDaily, regOrderQtys, regOrderQtysByDS, windowDates } = demand;
  const tau = cfg.tau ?? 99;
  const rollDays = cfg.rollingWindowDays ?? 2;
  const boundary = cfg.thickBoundaryMm ?? 9;
  const caps = cfg.dsCapacities || null;
  // NZD thresholds defined on a 90d basis; scale to the actual window length.
  const scale = windowDates.length / 90;
  const thFreq = Math.max(2, Math.ceil((cfg.tierFrequentNZD ?? 10) * scale));
  const thMod = Math.max(2, Math.ceil((cfg.tierModerateNZD ?? 5) * scale));
  const thSparse = cfg.tierSparseNZD ?? 2;
  const deadFloorMode = cfg.deadFloorMode ?? 'netMedian'; // 'netMedian' | 'lean1'

  const skus = Object.keys(universe).sort();
  const tclass = {};
  for (const sku of skus) tclass[sku] = thicknessClass(universe[sku].name, boundary);

  const plan = {};
  const floor = {};
  for (const sku of skus) {
    plan[sku] = {};
    const no = [...(regOrderQtys[sku] || [])].sort((a, b) => a - b);
    const netAbq = no.length ? Math.ceil(no.reduce((a, b) => a + b, 0) / no.length) : 1;
    const netMed = no.length ? Math.max(1, Math.round(medianOrderQty(no))) : 1;
    floor[sku] = deadFloorMode === 'lean1' ? 1 : netMed;

    for (const ds of DS_LIST) {
      const lo = regOrderQtysByDS?.[sku]?.[ds] || [];
      const dd = regularDaily[sku]?.[ds] || {};
      const nzd = Object.keys(dd).length;
      const vals = windowDates.map(d => dd[d] || 0);
      const roll = [];
      for (let i = 0; i + rollDays <= vals.length; i++) {
        let s = 0;
        for (let j = i; j < i + rollDays; j++) s += vals[j];
        roll.push(s);
      }
      roll.sort((a, b) => a - b);
      const q = roll.length ? Math.ceil(percentile(roll, tau) || 0) : 0;
      const localAbq = lo.length ? Math.ceil(lo.reduce((a, b) => a + b, 0) / lo.length) : 0;
      const localMax = lo.length ? Math.max(...lo) : 0;

      let min, tier;
      if (nzd >= thFreq) { tier = 'frequent'; min = Math.max(localAbq, q, 1); }
      else if (nzd >= thMod) { tier = 'moderate'; min = Math.max(localAbq, q, 1); }
      else if (nzd >= thSparse) { tier = 'sparse'; min = Math.max(localAbq, netAbq, 1); }
      else { tier = 'dead'; min = floor[sku]; }
      const max = Math.max(localMax, min + 1);
      plan[sku][ds] = { min, max, floor: floor[sku], tier };
    }
  }

  const nodeReport = {};
  for (const ds of DS_LIST) {
    nodeReport[ds] = {};
    for (const tc of ['thick', 'thin']) {
      const group = skus.filter(s => tclass[s] === tc);
      const used = group.reduce((a, s) => a + plan[s][ds].max, 0);
      const floorUsed = group.reduce((a, s) => a + plan[s][ds].floor + 1, 0);
      const cap = caps?.[ds]?.[tc];
      nodeReport[ds][tc] = {
        capacity: cap ?? null, floorUsed, used,
        overCapacity: cap != null && used > cap,
      };
    }
  }
  return { plan, nodeReport, floor, tclass };
}

export function allocateEmpirical(universe, demand, cfg) {
  const { regularDaily, regOrderQtys, regOrderQtysByDS, windowDates } = demand;
  const tau = cfg.tau ?? 99;
  const netTailPct = cfg.netOrderTailPct ?? 95;
  const rollDays = cfg.rollingWindowDays ?? 2;
  const boundary = cfg.thickBoundaryMm ?? 9;
  const caps = cfg.dsCapacities || null;

  const skus = Object.keys(universe).sort();
  const tclass = {};
  for (const sku of skus) tclass[sku] = thicknessClass(universe[sku].name, boundary);

  const plan = {};
  const floor = {};
  for (const sku of skus) {
    plan[sku] = {};
    const no = [...(regOrderQtys[sku] || [])].sort((a, b) => a - b);
    const netAbq = no.length ? Math.ceil(no.reduce((a, b) => a + b, 0) / no.length) : 1;
    const netTail = no.length ? Math.ceil(percentile(no, netTailPct)) : 1;
    floor[sku] = netAbq;

    for (const ds of DS_LIST) {
      const lo = regOrderQtysByDS?.[sku]?.[ds] || [];
      const dd = regularDaily[sku]?.[ds] || {};
      // rolling N-day sums over the calendar window (zero days included)
      const vals = windowDates.map(d => dd[d] || 0);
      const roll = [];
      for (let i = 0; i + rollDays <= vals.length; i++) {
        let s = 0;
        for (let j = i; j < i + rollDays; j++) s += vals[j];
        roll.push(s);
      }
      roll.sort((a, b) => a - b);
      const q = roll.length ? Math.ceil(percentile(roll, tau) || 0) : 0;

      const localAbq = lo.length ? Math.ceil(lo.reduce((a, b) => a + b, 0) / lo.length) : 0;
      const localMax = lo.length ? Math.max(...lo) : 0;

      const floorVal = Math.max(localAbq, netAbq, 1);
      const min = Math.max(floorVal, q);
      const max = Math.max(localMax, netTail, min + 1);
      plan[sku][ds] = { min, max, floor: floorVal };
    }
  }

  // Capacity is NOT enforced in this mode — report utilisation only.
  const nodeReport = {};
  for (const ds of DS_LIST) {
    nodeReport[ds] = {};
    for (const tc of ['thick', 'thin']) {
      const group = skus.filter(s => tclass[s] === tc);
      const used = group.reduce((a, s) => a + plan[s][ds].max, 0);
      const floorUsed = group.reduce((a, s) => a + plan[s][ds].floor + 1, 0);
      const cap = caps?.[ds]?.[tc];
      nodeReport[ds][tc] = {
        capacity: cap ?? null, floorUsed, used,
        overCapacity: cap != null && used > cap,
      };
    }
  }
  return { plan, nodeReport, floor, tclass };
}

export function allocate(universe, demand, cfg) {
  const { regularDaily, regOrderQtys, windowDates } = demand;
  const W = windowDates.length;
  const stopPct = cfg.minDepthStopPercentile ?? 99;
  const boundary = cfg.thickBoundaryMm ?? 9;
  const caps = cfg.dsCapacities || null;

  const skus = Object.keys(universe).sort();
  const floor = {};
  const tclass = {};
  for (const sku of skus) {
    floor[sku] = Math.max(1, Math.round(medianOrderQty(regOrderQtys[sku])) || 1);
    tclass[sku] = thicknessClass(universe[sku].name, boundary);
  }

  // Plan init = floors everywhere
  const plan = {};
  for (const sku of skus) {
    plan[sku] = {};
    for (const ds of DS_LIST) plan[sku][ds] = { min: floor[sku], max: floor[sku] + 1, floor: floor[sku] };
  }

  // Pre-compute per sku×ds: daily totals + total qty (regular)
  const dayQtys = {}; // `${sku}|${ds}` → number[] (non-zero day totals)
  const totQty = {};
  for (const sku of skus) {
    for (const ds of DS_LIST) {
      const m = regularDaily[sku]?.[ds] || {};
      const vals = Object.values(m);
      dayQtys[`${sku}|${ds}`] = vals;
      totQty[`${sku}|${ds}`] = vals.reduce((a, b) => a + b, 0);
    }
  }
  const daysGE = (sku, ds, k) => {
    let c = 0;
    for (const q of dayQtys[`${sku}|${ds}`]) if (q >= k) c++;
    return c;
  };
  // Depth ceiling: stop raising Min once exceedance prob ≤ (1 − stopPct/100).
  // With 90-day windows and stopPct=99: raise while ≥1 day needed the next sheet.
  const exceedFloor = W * (1 - stopPct / 100);

  const nodeReport = {};
  for (const ds of DS_LIST) nodeReport[ds] = {};

  for (const ds of DS_LIST) {
    for (const tc of ['thick', 'thin']) {
      const group = skus.filter(s => tclass[s] === tc);
      const cap = caps?.[ds]?.[tc];
      const budget = cap == null ? Infinity : cap;
      let used = group.reduce((a, s) => a + plan[s][ds].max, 0);
      const floorUsed = used;

      // ── Priority 2: Min depth, one sheet at a time ──
      while (used < budget) {
        let best = null, bestSku = null;
        for (const sku of group) {
          const m = plan[sku][ds].min;
          const need = daysGE(sku, ds, m + 1);
          if (need <= exceedFloor) continue; // beyond P99 ceiling
          const t = totQty[`${sku}|${ds}`];
          if (!best || need > best[0] || (need === best[0] && (t > best[1] || (t === best[1] && sku < best[2])))) {
            best = [need, t, sku]; bestSku = sku;
          }
        }
        if (!bestSku) break;
        plan[bestSku][ds].min += 1;
        plan[bestSku][ds].max += 1; // invariant max = min + 1 during depth phase
        used += 1;
      }

      // ── Priority 3: Max buffer toward min + median order ──
      if (used < budget) {
        const byFreq = [...group].sort((a, b) =>
          (dayQtys[`${b}|${ds}`].length - dayQtys[`${a}|${ds}`].length) ||
          (totQty[`${b}|${ds}`] - totQty[`${a}|${ds}`]) || (a < b ? -1 : 1));
        for (const sku of byFreq) {
          if (used >= budget) break;
          const p = plan[sku][ds];
          const target = p.min + Math.max(1, Math.round(medianOrderQty(regOrderQtys[sku])) || 1);
          while (p.max < target && used < budget) { p.max += 1; used += 1; }
        }
      }

      nodeReport[ds][tc] = {
        capacity: cap ?? null, floorUsed, used,
        overCapacity: cap != null && floorUsed > cap,
      };
    }
  }
  return { plan, nodeReport, floor, tclass };
}
