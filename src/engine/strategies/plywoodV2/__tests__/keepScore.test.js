import { describe, it, expect } from 'vitest';
import { computeKeepScores } from '../keepScore.js';

describe('computeKeepScores', () => {
  const plan = { A: { DS01: { min: 2, max: 4 } } };       // avg position 3
  const dcPlan = { A: { min: 4, max: 6 } };                // avg position 5
  const cfg = { grossMarginPct: 0.06, carryRateQuarterly: 0.05, opsBuffer: 1.5, serviceNZDThreshold: 5 };

  it('computes rent and service ratios', () => {
    // holding value = (3 + 5) × PP 1000 = 8000; carrying = 8000×0.05×1.5 = 600
    // sales qty 100 × PP 1000 × 6% = 6000 margin → rent = 10
    const rows = computeKeepScores({ plan, dcPlan, priceData: { A: 1000 },
      windowQty: { A: 100 }, networkNZD: { A: 10 }, regularNZD: { A: 10 } }, cfg);
    const a = rows.find(r => r.sku === 'A');
    expect(a.rentRatio).toBeCloseTo(10, 5);
    expect(a.serviceRatio).toBeCloseTo(2, 5);
    expect(a.keepScore).toBeCloseTo(10, 5);
    expect(a.flag).toBe('Keep');
  });

  it('rent ratio gated to 0 when regular NZD < 2 (single fluke rule)', () => {
    const rows = computeKeepScores({ plan, dcPlan, priceData: { A: 1000 },
      windowQty: { A: 100 }, networkNZD: { A: 1 }, regularNZD: { A: 1 } }, cfg);
    const a = rows.find(r => r.sku === 'A');
    expect(a.rentRatio).toBe(0);
    expect(a.keepScore).toBeCloseTo(0.2, 5);  // service 1/5
    expect(a.flag).toBe('Cut');
  });

  it('watchlist band 1.0–1.3', () => {
    const rows = computeKeepScores({ plan, dcPlan, priceData: { A: 1000 },
      windowQty: { A: 0 }, networkNZD: { A: 6 }, regularNZD: { A: 6 } }, cfg);
    expect(rows[0].keepScore).toBeCloseTo(1.2, 5);
    expect(rows[0].flag).toBe('Watch');
  });
});
