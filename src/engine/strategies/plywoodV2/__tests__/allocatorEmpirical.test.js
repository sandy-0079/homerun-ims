import { describe, it, expect } from 'vitest';
import { allocateEmpirical } from '../allocator.js';

const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));

const U = {
  FAST: { sku: 'FAST', name: 'Fast 18mm', brand: 'GreenPly' },
  DEADLOCAL: { sku: 'DEADLOCAL', name: 'Dead 18mm', brand: 'GreenPly' },
};
const CFG = { tau: 99, netOrderTailPct: 95, rollingWindowDays: 2, dsCapacities: null };

function demandOf({ regularDaily = {}, regOrderQtys = {}, regOrderQtysByDS = {} }) {
  return { regularDaily, regOrderQtys, regOrderQtysByDS, windowDates: DATES };
}

describe('allocateEmpirical', () => {
  it('locally-dead combo gets network ABQ floor and network tail Max', () => {
    // DEADLOCAL sells only at DS01: orders [2,2,2,8] → netABQ ceil(14/4)=4, P95 tail ≈ 8
    const d = demandOf({
      regOrderQtys: { DEADLOCAL: [2, 2, 2, 8] },
      regOrderQtysByDS: { DEADLOCAL: { DS01: [2, 2, 2, 8] } },
      regularDaily: { DEADLOCAL: { DS01: { [DATES[0]]: 6, [DATES[10]]: 8 } } },
    });
    const { plan } = allocateEmpirical(U, d, CFG);
    // DS02 has no local history → floor = netABQ 4, Max ≥ network P95 tail
    expect(plan['DEADLOCAL']['DS02'].min).toBe(4);
    expect(plan['DEADLOCAL']['DS02'].max).toBeGreaterThanOrEqual(7);
  });

  it('frequent combo: Min driven by tau-quantile of 2-day rolling demand', () => {
    // FAST sells 3/day every day at DS01 → every 2-day window = 6 → P99 = 6 > ABQ 3
    const dd = { FAST: { DS01: {} } };
    DATES.forEach(dt => { dd.FAST.DS01[dt] = 3; });
    const d = demandOf({
      regularDaily: dd,
      regOrderQtys: { FAST: DATES.map(() => 3) },
      regOrderQtysByDS: { FAST: { DS01: DATES.map(() => 3) } },
    });
    const { plan } = allocateEmpirical(U, d, CFG);
    expect(plan['FAST']['DS01'].min).toBe(6);
    expect(plan['FAST']['DS01'].max).toBeGreaterThanOrEqual(7); // ≥ Min+1
  });

  it('Max covers the largest local order', () => {
    const d = demandOf({
      regOrderQtys: { FAST: [2, 9] },
      regOrderQtysByDS: { FAST: { DS01: [2, 9] } },
      regularDaily: { FAST: { DS01: { [DATES[0]]: 2, [DATES[5]]: 9 } } },
    });
    const { plan } = allocateEmpirical(U, d, CFG);
    expect(plan['FAST']['DS01'].max).toBeGreaterThanOrEqual(9);
  });

  it('zero-history SKU everywhere gets 1/2 minimum presence', () => {
    const { plan } = allocateEmpirical(U, demandOf({}), CFG);
    expect(plan['FAST']['DS03']).toMatchObject({ min: 1, max: 2 });
  });

  it('reports capacity utilisation without enforcing it', () => {
    const dd = { FAST: { DS01: {} } };
    DATES.forEach(dt => { dd.FAST.DS01[dt] = 5; });
    const d = demandOf({
      regularDaily: dd,
      regOrderQtys: { FAST: [5, 5, 5] },
      regOrderQtysByDS: { FAST: { DS01: [5, 5, 5] } },
    });
    const { plan, nodeReport } = allocateEmpirical(U, d, { ...CFG, dsCapacities: { DS01: { thick: 3, thin: 0 } } });
    expect(plan['FAST']['DS01'].min).toBe(10);            // P99 of 2-day = 10, not trimmed
    expect(nodeReport['DS01'].thick.overCapacity).toBe(true);
  });
});
