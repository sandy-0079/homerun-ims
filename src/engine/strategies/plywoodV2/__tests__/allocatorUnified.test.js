import { describe, it, expect } from 'vitest';
import { allocateUnified } from '../allocator.js';

const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));

const U = { A: { sku: 'A', name: 'A 18mm', brand: 'GreenPly' } };
const CFG = { minLocalDayPercentile: 90, minNetOrderPercentile: 90, dsCapacities: null };

function demandOf({ regularDaily = {}, regOrderQtys = {} }) {
  return { regularDaily, regOrderQtys, windowDates: DATES };
}

describe('allocateUnified', () => {
  it('active: Min = max(local P90 day, network P90 order); Max covers worst local day', () => {
    // local days at DS01: 2×9 days + one 6-day → P90 ≈ 6 region; network orders incl a 9 → netP90 large
    const dd = { A: { DS01: {} } };
    DATES.slice(0, 9).forEach(dt => { dd.A.DS01[dt] = 2; });
    dd.A.DS01[DATES[10]] = 6;
    const d = demandOf({
      regularDaily: dd,
      regOrderQtys: { A: [2, 2, 2, 2, 2, 2, 2, 2, 2, 6] },  // netP90 = 6 (interp ≈ 5.6 → ceil 6)
    });
    const { plan } = allocateUnified(U, d, CFG);
    const p = plan['A']['DS01'];
    expect(p.tier).toBe('active');
    // P90 of [2×9, 6] interpolates to 2.4 → ceil 3 (both local and network)
    expect(p.min).toBe(3);
    expect(p.max).toBe(6);                       // worst observed local day
  });

  it('network floor lifts a small-but-frequent location', () => {
    // DS01 sells 1/day on 20 days (local P90 = 1) but network orders are big
    const dd = { A: { DS01: {} } };
    DATES.slice(0, 20).forEach(dt => { dd.A.DS01[dt] = 1; });
    const d = demandOf({
      regularDaily: dd,
      regOrderQtys: { A: [1, 1, 1, 5, 5, 5, 5, 5, 5, 5] },  // netP90 = 5
    });
    const { plan } = allocateUnified(U, d, CFG);
    expect(plan['A']['DS01'].min).toBe(5);       // network floor dominates
  });

  it('dead at node: Min = network ABQ, Max = Min+1', () => {
    const d = demandOf({ regOrderQtys: { A: [2, 2, 5] } });  // ABQ = ceil(9/3) = 3
    const { plan } = allocateUnified(U, d, CFG);
    expect(plan['A']['DS02']).toMatchObject({ min: 3, max: 4, tier: 'dead' });
  });

  it('no network history at all: 1/2 presence', () => {
    const { plan } = allocateUnified(U, demandOf({}), CFG);
    expect(plan['A']['DS05']).toMatchObject({ min: 1, max: 2, tier: 'dead' });
  });

  it('reports capacity utilisation without enforcing', () => {
    const dd = { A: { DS01: { [DATES[0]]: 8 } } };
    const d = demandOf({ regularDaily: dd, regOrderQtys: { A: [8] } });
    const { nodeReport } = allocateUnified(U, d, { ...CFG, dsCapacities: { DS01: { thick: 2, thin: 0 } } });
    expect(nodeReport['DS01'].thick.overCapacity).toBe(true);
  });
});
