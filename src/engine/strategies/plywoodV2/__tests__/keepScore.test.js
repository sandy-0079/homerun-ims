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

describe('keepScoreAnalysis (network-level wrapper)', () => {
  const SKUM = {
    FAST: { sku: 'FAST', name: 'Fast 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
    DUD: { sku: 'DUD', name: 'Dud 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  };
  const DATES = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));
  const inv = [];
  DATES.slice(0, 40).forEach((d, i) => inv.push({ sku: 'FAST', ds: 'DS01', qty: 3, date: d, shopifyOrder: `F${i}` }));
  inv.push({ sku: 'DUD', ds: 'DS01', qty: 1, date: DATES[5], shopifyOrder: 'D1' });  // 1 sale → cut

  it('grades on the real plan, totals incl bulk, and reports capacity impact', async () => {
    const { keepScoreAnalysis, V2_DEFAULTS } = await import('../index.js');
    const r = keepScoreAnalysis(inv, SKUM, { FAST: 1000, DUD: 1000 }, { ...V2_DEFAULTS, dsCapacities: { DS01:{thick:1000,thin:1000},DS02:{thick:1000,thin:1000},DS03:{thick:1000,thin:1000},DS04:{thick:1000,thin:1000},DS05:{thick:1000,thin:1000} } });
    expect(r.summary.total).toBe(2);
    const fast = r.rows.find(x => x.sku === 'FAST');
    const dud = r.rows.find(x => x.sku === 'DUD');
    expect(fast.flag).toBe('Keep');           // 40 selling days, fast turns
    expect(dud.flag).toBe('Cut');              // 1 sale network-wide → both ratios fail
    expect(dud.networkNZD).toBe(1);
    expect(r.summary.cut).toBe(1);
    expect(Array.isArray(r.summary.flipsGreen)).toBe(true);
    expect(r.nodes.length).toBe(12);           // (5 DS + DC) × 2 classes
  });
});
