// Greedy capacity-first allocator (spec §5).
// Priority 1: floors (breadth, sacred). Priority 2: Min depth by marginal coverage.
// Priority 3: Max buffer toward Min + median order. Budget = ΣMax per (DS × class).

import { DS_LIST } from '../../constants.js';
import { inferThickness } from '../../utils.js';
import { medianOrderQty } from './demand.js';

export function thicknessClass(name, boundaryMm = 9) {
  const mm = inferThickness(name);
  return mm !== null && mm > boundaryMm ? 'thick' : 'thin';
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
