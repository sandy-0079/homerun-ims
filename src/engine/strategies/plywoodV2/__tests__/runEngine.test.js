import { describe, it, expect } from 'vitest';
import { runEngine } from '../../../runEngine.js';
import { V2_DEFAULTS } from '../index.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'GreenPly 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR', inventorisedAt: 'DC' },
};
const inv = [{ sku: 'PLY-A', ds: 'DS01', qty: 2, date: '2026-06-01', shopifyOrder: 'O1' }];

describe('runEngine network_design_v2 dispatch', () => {
  it('routes ply SKUs through v2 when strategy selected', () => {
    const p = {
      overallPeriod: 45,
      categoryStrategies: { 'Plywood, MDF & HDHMR': 'network_design_v2' },
      plywoodNetworkV2Config: { ...V2_DEFAULTS },
    };
    const res = runEngine(inv, SKUM, {}, {}, new Set(), {}, p);
    expect(res['PLY-A'].stores.DS01.strategyTag).toBe('network_design');
    expect(res['PLY-A'].stores.DS01.min).toBeGreaterThanOrEqual(1);
  });
  it('does NOT run v2 when strategy is network_design (v1)', () => {
    const p = { overallPeriod: 45, categoryStrategies: { 'Plywood, MDF & HDHMR': 'network_design' } };
    const res = runEngine(inv, SKUM, {}, {}, new Set(), {}, p);
    // v1 with no plywoodNetworkConfig.brands → falls through to non-network path
    expect(res['PLY-A'].stores.DS01.strategyTag).not.toBe('network_design');
  });
});
