import { describe, it, expect } from 'vitest';
import { rollingSums, sizeDC } from '../dc.js';

const DATES = Array.from({ length: 10 }, (_, i) =>
  new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10));

describe('rollingSums', () => {
  it('computes L-day rolling sums including zero days', () => {
    const series = { [DATES[0]]: 2, [DATES[1]]: 2 };
    // window 3 over 10 dates → 8 windows: [2+2+0, 2+0+0, 0,0,0,0,0,0]
    expect(rollingSums(series, DATES, 3)).toEqual([4, 2, 0, 0, 0, 0, 0, 0]);
  });
});

describe('sizeDCOrderBulk + trimDCComponents (DC v2)', () => {
  it('sizes bulk from per-SKU order sizes × share; repl from drain', async () => {
    const { sizeDCOrderBulk } = await import('../dc.js');
    const toDrain = { A: Object.fromEntries(DATES.map(d => [d, 2])) };  // 4-day sums = 8
    const bulkOrderQty = { A: [12, 20, 30] };                           // P90 ≈ 28
    const { dcPlan, detail } = sizeDCOrderBulk(toDrain, bulkOrderQty, DATES, {
      leadDays: 3, dcReplPercentile: 98, dcBulkOrderPct: 90, dcCoverDays: 2, bulkDcServedShare: 1.0,
    });
    expect(detail['A'].repl).toBe(8);
    expect(detail['A'].bulk).toBe(28);
    expect(dcPlan['A'].min).toBe(36);
    expect(dcPlan['A'].max).toBe(36 + detail['A'].cycle);
    // α must NOT shrink the buffer — a DC-routed order needs its full quantity
    const half = sizeDCOrderBulk(toDrain, bulkOrderQty, DATES, {
      leadDays: 3, dcReplPercentile: 98, dcBulkOrderPct: 90, dcCoverDays: 2, bulkDcServedShare: 0.5,
    });
    expect(half.detail['A'].bulk).toBe(28);
  });

  it('replay routes (1−α) of bulk orders supplier-direct, deterministically', async () => {
    const { replay } = await import('../replay.js');
    const plan = { A: { DS01: { min: 1, max: 2 } } };
    const orders = Array.from({ length: 40 }, (_, i) => ({
      id: 'B' + i, ds: 'DS01', date: DATES[i % DATES.length], lines: [{ sku: 'A', qty: 12 }], isBulk: true,
    }));
    const d = { orders, windowDates: DATES, bulkDaily: {} };
    const full = replay(plan, { A: { min: 0, max: 0 } }, d, { leadDays: 3, bulkDcServedShare: 1.0 });
    expect(full.serviceLevels.bulk.total).toBe(40);
    expect(full.serviceLevels.bulk.supplierRouted).toBe(0);
    const split = replay(plan, { A: { min: 0, max: 0 } }, d, { leadDays: 3, bulkDcServedShare: 0.7 });
    expect(split.serviceLevels.bulk.supplierRouted).toBeGreaterThan(4);
    expect(split.serviceLevels.bulk.total + split.serviceLevels.bulk.supplierRouted).toBe(40);
    const split2 = replay(plan, { A: { min: 0, max: 0 } }, d, { leadDays: 3, bulkDcServedShare: 0.7 });
    expect(split2.serviceLevels.bulk.supplierRouted).toBe(split.serviceLevels.bulk.supplierRouted);
  });

  it('trim order: cycle first, then bulk (fewest bulk orders first), repl never', async () => {
    const { trimDCComponents } = await import('../dc.js');
    const dcPlan = { A: { min: 20, max: 24 }, B: { min: 30, max: 32 } };
    const detail = {
      A: { repl: 10, bulk: 10, cycle: 4, bulkOrders: 2 },   // rare bulk → trimmed first
      B: { repl: 10, bulk: 20, cycle: 2, bulkOrders: 9 },
    };
    // both thick; capacity 40 → over by 16: cycle gives 6, bulk A gives 10 → fits exactly
    const { dcPlan: p, detail: d, trimReport } = trimDCComponents(dcPlan, detail, { thick: 40, thin: 0 }, () => 'thick');
    expect(p.A.max + p.B.max).toBe(40);
    expect(d.A.trimmedCycle).toBe(4);
    expect(d.B.trimmedCycle).toBe(2);
    expect(d.A.trimmedBulk).toBe(10);                        // A's bulk gone before B's touched
    expect(d.B.trimmedBulk).toBeUndefined();
    expect(d.A.repl).toBe(10);                               // repl untouched
    expect(trimReport.stillOver).toBe(false);
  });
});

describe('sizeDC', () => {
  it('repl component = P98 of rolling (L+1)-day drain sums; bulk additive; cycle stock on top', () => {
    // constant drain 2/day for all 10 days, L=3 → all 4-day sums = 8 → P98 = 8
    const toDrain = { A: Object.fromEntries(DATES.map(d => [d, 2])) };
    const bulkDaily = { A: { [DATES[2]]: 10 } };
    const { dcPlan, detail } = sizeDC(toDrain, bulkDaily, DATES, {
      leadDays: 3, dcReplPercentile: 98, dcBulkPercentile: 90, dcCoverDays: 2, bulkDcServedShare: 1.0,
    });
    expect(detail['A'].repl).toBe(8);
    expect(detail['A'].bulk).toBeGreaterThanOrEqual(8); // P90 of the bulk window sums
    expect(dcPlan['A'].min).toBe(detail['A'].repl + detail['A'].bulk);
    expect(dcPlan['A'].max).toBe(dcPlan['A'].min + detail['A'].cycle);
    expect(detail['A'].cycle).toBe(Math.ceil(2 * 2)); // mean drain 2/day × coverDays 2
  });

  it('share scales the bulk component', () => {
    const toDrain = { A: {} };
    const bulkDaily = { A: { [DATES[2]]: 10 } };
    const a = sizeDC(toDrain, bulkDaily, DATES, { leadDays: 3, dcBulkPercentile: 90, dcCoverDays: 0, bulkDcServedShare: 1.0 });
    const b = sizeDC(toDrain, bulkDaily, DATES, { leadDays: 3, dcBulkPercentile: 90, dcCoverDays: 0, bulkDcServedShare: 0.5 });
    expect(b.detail['A'].bulk).toBeLessThan(a.detail['A'].bulk);
  });
});
