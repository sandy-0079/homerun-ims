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
