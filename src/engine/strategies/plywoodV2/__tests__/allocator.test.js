import { describe, it, expect } from 'vitest';
import { allocate, thicknessClass } from '../allocator.js';

function demandOf({ regularDaily = {}, regOrderQtys = {}, windowDates }) {
  return { regularDaily, regOrderQtys, windowDates };
}
const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));

const U2 = {
  FAST: { sku: 'FAST', name: 'Fast 18mm', brand: 'GreenPly' },
  SLOW: { sku: 'SLOW', name: 'Slow 18mm', brand: 'GreenPly' },
};

describe('thicknessClass', () => {
  it('classifies by mm with boundary 9', () => {
    expect(thicknessClass('Ply 18mm', 9)).toBe('thick');
    expect(thicknessClass('Ply 6mm', 9)).toBe('thin');
    expect(thicknessClass('No mm here', 9)).toBe('thin'); // unknown → thin
  });
});

describe('allocate', () => {
  it('floors: zero-demand SKU gets Min=1/Max=2 at every DS', () => {
    const { plan } = allocate(U2, demandOf({ windowDates: DATES }), {
      dsCapacities: null, // unlimited
    });
    expect(plan['FAST']['DS01']).toEqual({ min: 1, max: 2, floor: 1 });
  });

  it('floor uses network median regular order', () => {
    const d = demandOf({ regOrderQtys: { FAST: [2, 2, 4] }, windowDates: DATES });
    const { plan } = allocate(U2, d, { dsCapacities: null });
    expect(plan['FAST']['DS01'].min).toBe(2);  // median 2
  });

  it('greedy: depth blocked at max day goes to Max buffer on the frequent seller', () => {
    // FAST sells 3/day on 30 days at DS01; SLOW sells 1 on 2 days.
    // FAST floor = median([3,3,...]) = 3 → floor min 3 / max 4; max observed day = 3 → no Min depth possible.
    // SLOW floor 1/2. Floors use 4+2 = 6 of cap 8. Two spare sheets → Priority 3 Max buffer:
    // FAST target max = min + median(3) = 6, raising 4→6 consumes both spare sheets.
    const rd = { FAST: { DS01: {} }, SLOW: { DS01: {} } };
    DATES.slice(0, 30).forEach(dt => { rd.FAST.DS01[dt] = 3; });
    DATES.slice(0, 2).forEach(dt => { rd.SLOW.DS01[dt] = 1; });
    const fastOrders = DATES.slice(0, 30).map(() => 3);
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: fastOrders, SLOW: [1, 1] }, windowDates: DATES });
    const { plan } = allocate(U2, d, { dsCapacities: { DS01: { thick: 8, thin: 0 } } });
    expect(plan['FAST']['DS01']).toMatchObject({ min: 3, max: 6 });
    expect(plan['SLOW']['DS01']).toMatchObject({ min: 1, max: 2 });
  });

  it('greedy depth goes to the SKU with higher marginal coverage', () => {
    // FAST: 5 sheets/day on 60 days (orders of 2+3 → median 2.5 → floor 3... keep orders [1] → floor 1)
    // Build: FAST daily total 5 via orders [1,...]; demand days 60. SLOW: 1 on 2 days.
    const rd = { FAST: { DS01: {} }, SLOW: { DS01: {} } };
    DATES.slice(0, 60).forEach(dt => { rd.FAST.DS01[dt] = 5; });
    DATES.slice(0, 2).forEach(dt => { rd.SLOW.DS01[dt] = 1; });
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [1, 1, 1], SLOW: [1, 1] }, windowDates: DATES });
    // floors: FAST 1/2, SLOW 1/2 → used 4. cap 8 → 4 spare. FAST needs depth up to 5 (needed 60/90 days each level).
    // 4 spare sheets all go to FAST Min: 1→5. SLOW marginal at min 2 = 0 days.
    const { plan } = allocate(U2, d, { dsCapacities: { DS01: { thick: 8, thin: 0 } } });
    expect(plan['FAST']['DS01'].min).toBe(5);
    expect(plan['SLOW']['DS01'].min).toBe(1);
  });

  it('never breaches capacity (ΣMax ≤ cap) and reports utilisation', () => {
    const rd = { FAST: { DS01: {} } };
    DATES.forEach(dt => { rd.FAST.DS01[dt] = 5; });
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [5] }, windowDates: DATES });
    const { plan, nodeReport } = allocate(U2, d, { dsCapacities: { DS01: { thick: 9, thin: 0 } } });
    const sumMax = plan['FAST']['DS01'].max + plan['SLOW']['DS01'].max;
    expect(sumMax).toBeLessThanOrEqual(9);
    expect(nodeReport['DS01'].thick.used).toBe(sumMax);
  });

  it('depth stops at the max observed demand day (P99 ceiling)', () => {
    const rd = { FAST: { DS01: { [DATES[0]]: 4 } } };
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [4] }, windowDates: DATES });
    const { plan } = allocate(U2, d, { dsCapacities: { DS01: { thick: 1000, thin: 0 } } });
    expect(plan['FAST']['DS01'].min).toBeLessThanOrEqual(4); // never beyond max day
  });

  it('is deterministic', () => {
    const rd = { FAST: { DS01: { [DATES[0]]: 2 } }, SLOW: { DS01: { [DATES[0]]: 2 } } };
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [2], SLOW: [2] }, windowDates: DATES });
    const a = allocate(U2, d, { dsCapacities: { DS01: { thick: 7, thin: 0 } } });
    const b = allocate(U2, d, { dsCapacities: { DS01: { thick: 7, thin: 0 } } });
    expect(a).toEqual(b);
  });
});
