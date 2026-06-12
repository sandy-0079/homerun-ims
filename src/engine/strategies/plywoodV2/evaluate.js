// Evaluation + auto-tune for Plywood v2 (spec §6b).
//
// evaluatePlan: fit the unified formula on the window minus the last `testDays`,
// replay those test days, aggregate per-SKU×DS OOS and per-DS service. Each miss is
// flagged selfCorrects=true when a full-window refit would have covered the order.
//
// autoTune: grid sweep over (localDayPct, netOrderPct, docCapDays), each candidate
// scored OUT-OF-WINDOW on two folds; returns the Pareto frontier + presets. Stage 2
// tests one structural split (DOC cap by NZD bucket) behind a +0.3pt out-of-fold gate.

import { DS_LIST } from '../../constants.js';
import { percentile } from '../../utils.js';
import { buildUniverse, prepareDemand } from './demand.js';
import { allocateUnified } from './allocator.js';
import { replay } from './replay.js';

function dateAdd(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Fit a unified plan on inv rows within [from, to]. Returns { plan, universe, demand }. */
export function fitPlan(inv, skuM, cfg, from, to) {
  const span = Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
  const c = { ...cfg, lookbackDays: span };
  const universe = buildUniverse(skuM, c);
  const fitInv = inv.filter(r => r.date >= from && r.date <= to);
  const demand = prepareDemand(fitInv, universe, c);
  if (!demand) return null;
  const { plan, nodeReport, floor, tclass } = allocateUnified(universe, demand, c);
  return { plan, nodeReport, floor, tclass, universe, demand };
}

/**
 * Evaluate the formula out-of-window.
 * Fits on [windowStart .. lastDate - testDays], replays the final `testDays`.
 * dcPlan is effectively infinite — this isolates DS-shelf performance.
 */
export function evaluatePlan(inv, skuM, cfg, { testDays = 15 } = {}) {
  const dates = [...new Set(inv.map(r => r.date))].sort();
  if (dates.length === 0) return null;
  const lastDate = dates[dates.length - 1];
  const testFrom = dateAdd(lastDate, -(testDays - 1));
  const fitTo = dateAdd(testFrom, -1);
  const firstDate = dates[0];

  const fitted = fitPlan(inv, skuM, cfg, firstDate, fitTo);
  if (!fitted) return null;
  const { plan, universe } = fitted;

  // full-window refit for selfCorrects flags
  const fullFit = fitPlan(inv, skuM, cfg, firstDate, lastDate);

  const tcfg = { ...cfg, lookbackDays: testDays };
  const testInv = inv.filter(r => r.date >= testFrom && r.date <= lastDate);
  const testDemand = prepareDemand(testInv, universe, tcfg);
  if (!testDemand) return null;
  const dcPlan = {};
  for (const sku of Object.keys(plan)) dcPlan[sku] = { min: 1e9, max: 1e9 };
  const sim = replay(plan, dcPlan, testDemand, tcfg);

  // per-SKU×DS OOS aggregation (regular only) + selfCorrects flag per miss
  const oosBySkuDs = {};   // sku → ds → { orders: Set, events: [...] }
  for (const e of sim.oosEvents) {
    if (e.type !== 'regular') continue;
    if (!oosBySkuDs[e.sku]) oosBySkuDs[e.sku] = {};
    if (!oosBySkuDs[e.sku][e.ds]) oosBySkuDs[e.sku][e.ds] = { orders: new Set(), events: [] };
    const fullMax = fullFit?.plan?.[e.sku]?.[e.ds]?.max ?? 0;
    // heuristic: the miss self-corrects if the full-window Max covers (shortfall + what was served)
    oosBySkuDs[e.sku][e.ds].orders.add(e.orderId);
    oosBySkuDs[e.sku][e.ds].events.push({ ...e, fullRefitMax: fullMax, selfCorrects: fullMax >= e.short + (fittedServed(plan, e)) });
  }
  // flatten counts
  const oosCounts = {};
  for (const [sku, byDs] of Object.entries(oosBySkuDs)) {
    oosCounts[sku] = {};
    for (const [ds, v] of Object.entries(byDs)) {
      oosCounts[sku][ds] = { oosOrders: v.orders.size, events: v.events };
    }
  }
  return {
    plan, universe,
    fitDemand: fitted.demand,
    tclass: fitted.tclass,
    fitWindow: { from: firstDate, to: fitTo },
    testWindow: { from: testFrom, to: lastDate },
    serviceLevels: sim.serviceLevels,
    oosCounts,
    opsLoad: sim.opsLoad,
    fullPlan: fullFit?.plan || null,
  };
}

// approximate qty served before the shortfall for the selfCorrects heuristic:
// the fitted Max is what the shelf could at best have held for that order.
function fittedServed(plan, e) {
  return plan?.[e.sku]?.[e.ds]?.max ?? 0;
}

/** Total ΣMax footprint of a plan, per DS and total. */
export function planFootprint(plan) {
  const perDS = {};
  let total = 0;
  for (const ds of DS_LIST) {
    perDS[ds] = 0;
    for (const sku of Object.keys(plan)) perDS[ds] += plan[sku][ds]?.max || 0;
    total += perDS[ds];
  }
  return { perDS, total };
}

/**
 * Auto-derive NZD display buckets (network-level) from the distribution of
 * local NZD across all SKU×DS combos with NZD ≥ 1. Returns sorted unique edges,
 * e.g. [1, 4, 10] → buckets: 0, 1–3, 4–9, 10+.
 */
export function deriveNZDBuckets(demand, universe) {
  const nzds = [];
  for (const sku of Object.keys(universe)) {
    for (const ds of DS_LIST) {
      const n = Object.keys(demand.regularDaily[sku]?.[ds] || {}).length;
      if (n >= 1) nzds.push(n);
    }
  }
  if (nzds.length === 0) return { edges: [1], labels: ['NZD 0', 'NZD 1+'] };
  nzds.sort((a, b) => a - b);
  const t1 = Math.max(2, Math.ceil(percentile(nzds, 33.3)) + 1);
  const t2 = Math.max(t1 + 1, Math.ceil(percentile(nzds, 66.7)) + 1);
  const edges = [...new Set([1, t1, t2])];
  const labels = ['NZD 0'];
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i];
    const hi = i + 1 < edges.length ? edges[i + 1] - 1 : null;
    labels.push(hi === null ? `NZD ${lo}+` : lo === hi ? `NZD ${lo}` : `NZD ${lo}–${hi}`);
  }
  return { edges, labels };
}

/** Bucket index for a combo's NZD given derived edges (0 = the NZD-0 bucket). */
export function bucketOf(nzd, edges) {
  if (nzd === 0) return 0;
  let b = 1;
  for (let i = 1; i < edges.length; i++) if (nzd >= edges[i]) b = i + 1;
  return b;
}

/**
 * Auto-tune: sweep the knob grid, score each candidate on two out-of-window folds,
 * return all results + Pareto frontier + named presets.
 * onProgress(done, total) is optional (UI progress).
 */
export function autoTune(inv, skuM, baseCfg, { onProgress } = {}) {
  const dates = [...new Set(inv.map(r => r.date))].sort();
  const lastDate = dates[dates.length - 1];
  const firstDate = dates[0];

  const GRID = [];
  for (const localPct of [80, 90, 95]) {
    for (const netPct of [50, 70, 80, 90]) {
      for (const docCap of [0, 30, 45, 60]) {
        GRID.push({ minLocalDayPercentile: localPct, minNetOrderPercentile: netPct, minDocCapDays: docCap });
      }
    }
  }

  const folds = [
    { fitTo: dateAdd(lastDate, -15), testFrom: dateAdd(lastDate, -14) },
    { fitTo: dateAdd(lastDate, -30), testFrom: dateAdd(lastDate, -29) },
  ];

  const scoreOne = (knobs) => {
    let svcSum = 0;
    let fp = 0;
    for (const f of folds) {
      const cfg = { ...baseCfg, ...knobs };
      const fitted = fitPlan(inv, skuM, cfg, firstDate, f.fitTo);
      if (!fitted) return null;
      const span = Math.round((new Date(lastDate + 'T00:00:00Z') - new Date(f.testFrom + 'T00:00:00Z')) / 86400000) + 1;
      const tcfg = { ...cfg, lookbackDays: span };
      const testInv = inv.filter(r => r.date >= f.testFrom && r.date <= lastDate);
      const testDemand = prepareDemand(testInv, fitted.universe, tcfg);
      if (!testDemand) return null;
      const dcPlan = {};
      for (const sku of Object.keys(fitted.plan)) dcPlan[sku] = { min: 1e9, max: 1e9 };
      const sim = replay(fitted.plan, dcPlan, testDemand, tcfg);
      svcSum += sim.serviceLevels.regular.overall;
      if (f === folds[0]) fp = planFootprint(fitted.plan).total;
    }
    return { service: svcSum / folds.length, footprint: fp };
  };

  const results = [];
  GRID.forEach((knobs, i) => {
    const s = scoreOne(knobs);
    if (s) results.push({ knobs, ...s });
    if (onProgress) onProgress(i + 1, GRID.length);
  });

  // Pareto frontier (ascending footprint, strictly improving service)
  const sorted = [...results].sort((a, b) => a.footprint - b.footprint);
  const frontier = [];
  let best = -1;
  for (const r of sorted) if (r.service > best) { frontier.push(r); best = r.service; }

  // Presets: Lean = first frontier point ≥ (min service + 60% of range);
  // Service-first = max service; Balanced = knee (max service-per-sheet gain mid-frontier).
  const svcMin = frontier[0].service, svcMax = frontier[frontier.length - 1].service;
  const serviceFirst = frontier[frontier.length - 1];
  const lean = frontier.find(r => r.service >= svcMin + (svcMax - svcMin) * 0.4) || frontier[0];
  const mid = frontier.find(r => r.service >= svcMin + (svcMax - svcMin) * 0.75) || serviceFirst;
  const presets = { lean, balanced: mid, serviceFirst };

  // ── Stage 2: complexity gate — DOC cap split by NZD tercile, adopt only if it
  // beats the best single-cap config by ≥ 0.3pts out-of-fold at ≤ its footprint+2%.
  const bestSingle = serviceFirst;
  let bucketSplit = null;
  const splitCandidates = [
    { low: 30, high: 0 },   // tight cap on slow combos, none on fast
    { low: 30, high: 60 },
    { low: 45, high: 0 },
  ];
  for (const cand of splitCandidates) {
    const knobs = { ...bestSingle.knobs, _docCapSplit: cand };
    const s = scoreSplit(inv, skuM, baseCfg, knobs, folds, firstDate, lastDate);
    if (s && s.service >= bestSingle.service + 0.003 && s.footprint <= bestSingle.footprint * 1.02) {
      bucketSplit = { ...cand, service: s.service, footprint: s.footprint };
      break;
    }
  }
  return { results, frontier, presets, bucketSplit };
}

// score a DOC-cap-split candidate: slow combos (below NZD median of active combos)
// get cand.low cap; fast combos get cand.high. Implemented by post-processing the plan.
function scoreSplit(inv, skuM, baseCfg, knobs, folds, firstDate, lastDate) {
  let svcSum = 0, fp = 0;
  for (const f of folds) {
    const cfg = { ...baseCfg, ...knobs, minDocCapDays: 0 };
    const fitted = fitPlan(inv, skuM, cfg, firstDate, f.fitTo);
    if (!fitted) return null;
    const { plan, universe, demand } = fitted;
    const span = demand.windowDates.length;
    // median NZD among active combos
    const nzds = [];
    for (const sku of Object.keys(universe)) for (const ds of DS_LIST) {
      const n = Object.keys(demand.regularDaily[sku]?.[ds] || {}).length;
      if (n >= 1) nzds.push(n);
    }
    nzds.sort((a, b) => a - b);
    const medNZD = nzds.length ? nzds[Math.floor(nzds.length / 2)] : 1;
    const split = knobs._docCapSplit;
    for (const sku of Object.keys(plan)) {
      for (const ds of DS_LIST) {
        const dd = demand.regularDaily[sku]?.[ds] || {};
        const days = Object.values(dd);
        if (days.length === 0) continue;
        const capDays = days.length <= medNZD ? split.low : split.high;
        if (!capDays) continue;
        const qty = days.reduce((a, b) => a + b, 0);
        const doc = Math.ceil((qty / span) * capDays);
        const lAbq = Math.ceil(qty / days.length);
        const p = plan[sku][ds];
        const newMin = Math.min(p.min, Math.max(doc, lAbq, 1));
        if (newMin < p.min) {
          p.min = newMin;
          p.max = Math.max(Math.max(...days), newMin + 1);
        }
      }
    }
    const tspan = Math.round((new Date(lastDate + 'T00:00:00Z') - new Date(f.testFrom + 'T00:00:00Z')) / 86400000) + 1;
    const tcfg = { ...cfg, lookbackDays: tspan };
    const testInv = inv.filter(r => r.date >= f.testFrom && r.date <= lastDate);
    const testDemand = prepareDemand(testInv, universe, tcfg);
    if (!testDemand) return null;
    const dcPlan = {};
    for (const sku of Object.keys(plan)) dcPlan[sku] = { min: 1e9, max: 1e9 };
    const sim = replay(plan, dcPlan, testDemand, tcfg);
    svcSum += sim.serviceLevels.regular.overall;
    if (f === folds[0]) fp = planFootprint(plan).total;
  }
  return { service: svcSum / folds.length, footprint: fp };
}
