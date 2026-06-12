import { describe, it, expect } from 'vitest';
import { evaluatePlan, deriveNZDBuckets, bucketOf, planFootprint, fitPlan } from '../evaluate.js';
import { buildUniverse, prepareDemand } from '../demand.js';
import { V2_DEFAULTS } from '../index.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'A 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-B': { sku: 'PLY-B', name: 'B 6mm', brand: 'CenturyPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
};
const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));

// A sells 2/day at DS01 for first 75 days; then an 8-sheet day in the test window
const inv = [];
DATES.slice(0, 75).forEach((d, i) => inv.push({ sku: 'PLY-A', ds: 'DS01', qty: 2, date: d, shopifyOrder: `R${i}` }));
inv.push({ sku: 'PLY-A', ds: 'DS01', qty: 8, date: DATES[80], shopifyOrder: 'BIG' });
inv.push({ sku: 'PLY-B', ds: 'DS02', qty: 1, date: DATES[89], shopifyOrder: 'LAST' }); // anchors window end

const CFG = { ...V2_DEFAULTS };

describe('evaluatePlan', () => {
  const ev = evaluatePlan(inv, SKUM, CFG, { testDays: 15 });

  it('splits fit/test windows correctly', () => {
    expect(ev.fitWindow.to < ev.testWindow.from).toBe(true);
    expect(ev.testWindow.to).toBe(DATES[89]);
  });

  it('counts OOS orders per SKU×DS in the test window', () => {
    // fitted plan: Min ~2-3, Max ~3ish → the 8-sheet order misses
    expect(ev.oosCounts['PLY-A']?.['DS01']?.oosOrders).toBe(1);
    expect(ev.serviceLevels.regular.total).toBe(2); // BIG + LAST in test window
  });

  it('flags whether a miss self-corrects on full-window refit', () => {
    const e = ev.oosCounts['PLY-A']['DS01'].events[0];
    // full refit includes the 8-day → Max ≥ 8 → covered
    expect(e.fullRefitMax).toBeGreaterThanOrEqual(8);
    expect(typeof e.selfCorrects).toBe('boolean');
  });
});

describe('deriveNZDBuckets / bucketOf', () => {
  it('derives network-level edges with NZD 0 as its own bucket', () => {
    const universe = buildUniverse(SKUM, CFG);
    const demand = prepareDemand(inv, universe, { ...CFG, lookbackDays: 90 });
    const { edges, labels } = deriveNZDBuckets(demand, universe);
    expect(edges[0]).toBe(1);
    expect(labels[0]).toBe('NZD 0');
    expect(labels.length).toBe(edges.length + 1);
    expect(bucketOf(0, edges)).toBe(0);
    expect(bucketOf(1, edges)).toBe(1);
    expect(bucketOf(999, edges)).toBe(edges.length);
  });
});

describe('autoTune (smoke)', () => {
  it('returns a non-empty Pareto frontier with presets', async () => {
    const { autoTune } = await import('../evaluate.js');
    const r = autoTune(inv, SKUM, CFG);
    expect(r.frontier.length).toBeGreaterThan(0);
    expect(r.presets.lean).toBeTruthy();
    expect(r.presets.serviceFirst.service).toBeGreaterThanOrEqual(r.presets.lean.service);
    // frontier is sorted by footprint and strictly improving in service
    for (let i = 1; i < r.frontier.length; i++) {
      expect(r.frontier[i].footprint).toBeGreaterThanOrEqual(r.frontier[i-1].footprint);
      expect(r.frontier[i].service).toBeGreaterThan(r.frontier[i-1].service);
    }
  });
});

describe('planFootprint / fitPlan', () => {
  it('sums Max per DS and total', () => {
    const fitted = fitPlan(inv, SKUM, CFG, DATES[0], DATES[89]);
    const fp = planFootprint(fitted.plan);
    expect(fp.total).toBe(Object.values(fp.perDS).reduce((a, b) => a + b, 0));
    expect(fp.perDS.DS01).toBeGreaterThan(0);
  });
});
