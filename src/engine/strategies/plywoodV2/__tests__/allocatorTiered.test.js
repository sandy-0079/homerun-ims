import { describe, it, expect } from 'vitest';
import { allocateTiered } from '../allocator.js';

const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));

const U = {
  A: { sku: 'A', name: 'A 18mm', brand: 'GreenPly' },
};
const CFG = { tau: 99, rollingWindowDays: 2, tierFrequentNZD: 10, tierModerateNZD: 5, tierSparseNZD: 2, deadFloorMode: 'netMedian', dsCapacities: null };

function demandOf({ regularDaily = {}, regOrderQtys = {}, regOrderQtysByDS = {} }) {
  return { regularDaily, regOrderQtys, regOrderQtysByDS, windowDates: DATES };
}

describe('allocateTiered', () => {
  it('frequent combo: quantile-driven Min, Max = max local order', () => {
    const dd = { A: { DS01: {} } };
    DATES.slice(0, 30).forEach(dt => { dd.A.DS01[dt] = 4; });   // NZD 30 ≥ 10 → frequent
    const d = demandOf({
      regularDaily: dd,
      regOrderQtys: { A: [...Array(30)].map(() => 4).concat([7]) },
      regOrderQtysByDS: { A: { DS01: [...Array(30)].map(() => 4).concat([7]) } },
    });
    const { plan } = allocateTiered(U, d, CFG);
    expect(plan['A']['DS01'].tier).toBe('frequent');
    expect(plan['A']['DS01'].min).toBeGreaterThanOrEqual(4);    // ≥ ABQ/quantile
    expect(plan['A']['DS01'].max).toBeGreaterThanOrEqual(7);    // covers max local order
  });

  it('sparse combo: ABQ floor (local or network), no network tail Max', () => {
    const dd = { A: { DS01: { [DATES[0]]: 2, [DATES[20]]: 3 } } };  // NZD 2 → sparse
    const d = demandOf({
      regularDaily: dd,
      regOrderQtys: { A: [2, 3, 9, 9] },                            // netABQ ceil(23/4)=6
      regOrderQtysByDS: { A: { DS01: [2, 3] } },
    });
    const { plan } = allocateTiered(U, d, CFG);
    expect(plan['A']['DS01'].tier).toBe('sparse');
    expect(plan['A']['DS01'].min).toBe(6);                          // max(localABQ 3, netABQ 6)
    expect(plan['A']['DS01'].max).toBe(7);                          // max(localMax 3, min+1)
  });

  it('dead combo: netMedian floor', () => {
    const d = demandOf({
      regOrderQtys: { A: [2, 2, 4] },                               // net median 2
      regOrderQtysByDS: { A: { DS01: [2, 2, 4] } },
      regularDaily: { A: { DS01: { [DATES[0]]: 8 } } },
    });
    const { plan } = allocateTiered(U, d, CFG);
    expect(plan['A']['DS02']).toMatchObject({ min: 2, max: 3, tier: 'dead' });
  });

  it('dead combo: lean1 floor when configured', () => {
    const d = demandOf({ regOrderQtys: { A: [4, 4] }, regOrderQtysByDS: {}, regularDaily: {} });
    const { plan } = allocateTiered(U, d, { ...CFG, deadFloorMode: 'lean1' });
    expect(plan['A']['DS03']).toMatchObject({ min: 1, max: 2, tier: 'dead' });
  });
});
