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
  it('(s,S): Min = lean reorder cover; Max = Min + max(one bulk order, lead-time drain) — bulk dominates', async () => {
    const { sizeDCSS } = await import('../dc.js');
    const toDrain = { A: Object.fromEntries(DATES.map(d => [d, 2])) };  // constant 2/day → 3-day windows = 6
    const bulkOrderQty = { A: [10, 20, 30] };                          // P90 ≈ 28
    const { dcPlan, detail } = sizeDCSS(toDrain, bulkOrderQty, DATES, {
      leadDays: 3, dcServicePct: 98, dcBulkServicePct: 90,
    });
    expect(detail['A'].s).toBe(6);              // reorder point = P98 of 3-day drain
    expect(detail['A'].leadBatch).toBe(6);      // mean 3-day drain (reorder batch floor)
    expect(detail['A'].bulkUnit).toBe(28);      // one bulk order @P90
    expect(dcPlan['A'].min).toBe(6);
    expect(dcPlan['A'].max).toBe(6 + 28);       // Min + max(28, 6) = one bulk order wins
  });

  it('(s,S): a non-bulk SKU floors the buffer at the lead-time batch (Min ≠ Max, sane reorder cycle)', async () => {
    const { sizeDCSS } = await import('../dc.js');
    const toDrain = { A: Object.fromEntries(DATES.map(d => [d, 2])) };  // no bulk orders for A
    const { dcPlan, detail } = sizeDCSS(toDrain, {}, DATES, {
      leadDays: 3, dcServicePct: 98, dcBulkServicePct: 90,
    });
    expect(detail['A'].bulkUnit).toBe(0);
    expect(dcPlan['A'].max).toBe(6 + 6);        // Min + max(0, leadBatch 6) = lead-time batch wins
  });

  it('(s,S): the bulk-service percentile is the dial — higher P → bigger buffer', async () => {
    const { sizeDCSS } = await import('../dc.js');
    const toDrain = { A: { [DATES[0]]: 1 } };
    const bulkOrderQty = { A: [10, 20, 30, 40, 50] };
    const lean = sizeDCSS(toDrain, bulkOrderQty, DATES, { leadDays: 3, dcServicePct: 98, dcBulkServicePct: 50 });
    const rich = sizeDCSS(toDrain, bulkOrderQty, DATES, { leadDays: 3, dcServicePct: 98, dcBulkServicePct: 90 });
    expect(rich.dcPlan.A.max).toBeGreaterThan(lean.dcPlan.A.max);
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

  it('TO rationing: a short DC splits stock proportionally across DSes (not first-come-first-served)', async () => {
    const { replay } = await import('../replay.js');
    const [d0, d1, d2] = DATES;
    const plan = { A: { DS01: { min: 0, max: 4 }, DS05: { min: 0, max: 8 } } };
    const dcPlan = { A: { min: 0, max: 3 } };          // DC starts with only 3 sheets
    const orders = [
      { id: 'a', ds: 'DS01', date: d0, isBulk: false, lines: [{ sku: 'A', qty: 4 }] }, // drains DS01 → TO 4
      { id: 'b', ds: 'DS05', date: d0, isBulk: false, lines: [{ sku: 'A', qty: 8 }] }, // drains DS05 → TO 8
      { id: 'c', ds: 'DS01', date: d1, isBulk: false, lines: [{ sku: 'A', qty: 1 }] }, // needs the 1 it should be rationed
      { id: 'e', ds: 'DS05', date: d1, isBulk: false, lines: [{ sku: 'A', qty: 2 }] }, // needs the 2 it should be rationed
    ];
    const demand = { orders, windowDates: [d0, d1], bulkDaily: {} };  // 2-day window → single TO wave
    const sim = replay(plan, dcPlan, demand, { leadDays: 1, bulkDcServedShare: 1.0 });
    // proportional (DS01←1, DS05←2) serves BOTH day-1 orders → 0 regular OOS.
    // first-come (DS01←3, DS05←0) would starve DS05 → 1 OOS. This asserts proportional.
    expect(sim.serviceLevels.regular.oos).toBe(0);
    // qty-fill is invariant to the split: 3 shipped of 12 requested either way
    expect(sim.serviceLevels.toFill.qtyShort).toBe(9);
  });

  it('trimDCDepth: reduces order-up-to depth (Max→Min) on least-active SKUs first; Min never moves', async () => {
    const { trimDCDepth } = await import('../dc.js');
    // min = reorder point (s), max = order-up-to (S). depth = S − s is the trimmable buffer.
    const dcPlan = { A: { min: 6, max: 12 }, B: { min: 6, max: 20 } };
    const detail = {
      A: { s: 6, S: 12, nzd: 8 },    // active SKU → trimmed last
      B: { s: 6, S: 20, nzd: 2 },    // least-active SKU → trimmed first
    };
    // both thick; capacity 24 → over by 8: trim B's depth (14) by 8 → B.max 20→12, fits
    const { dcPlan: p, detail: d, trimReport } = trimDCDepth(dcPlan, detail, { thick: 24, thin: 0 }, () => 'thick');
    expect(p.A.max + p.B.max).toBe(24);
    expect(p.B.max).toBe(12);                 // B trimmed first (lowest NZD)
    expect(d.B.trimmedDepth).toBe(8);
    expect(p.A.max).toBe(12);                 // A untouched
    expect(d.A.trimmedDepth).toBeUndefined();
    expect(p.A.min).toBe(6);                  // Min (reorder floor) never moves
    expect(p.B.min).toBe(6);
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
