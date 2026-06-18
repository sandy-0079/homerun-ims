import { describe, it, expect } from 'vitest';
import { computePlywoodNetworkV2Results, V2_DEFAULTS } from '../index.js';
import { DS_LIST } from '../../../constants.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'GreenPly 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-B': { sku: 'PLY-B', name: 'CenturyPly 6mm', brand: 'CenturyPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
};
const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));
const inv = [];
DATES.slice(0, 40).forEach((d, i) => inv.push({ sku: 'PLY-A', ds: 'DS01', qty: 2, date: d, shopifyOrder: `R${i}` }));
inv.push({ sku: 'PLY-A', ds: 'DS02', qty: 15, date: DATES[5], shopifyOrder: 'BULK1' });

describe('computePlywoodNetworkV2Results', () => {
  const params = {
    plywoodNetworkV2Config: {
      ...V2_DEFAULTS,
      dsCapacities: {
        DS01: { thick: 50, thin: 50 }, DS02: { thick: 50, thin: 50 }, DS03: { thick: 50, thin: 50 },
        DS04: { thick: 50, thin: 50 }, DS05: { thick: 50, thin: 50 },
      },
    },
  };
  const res = computePlywoodNetworkV2Results(inv, SKUM, params);

  it('returns runEngine-compatible shape for every universe SKU at every DS', () => {
    for (const sku of ['PLY-A', 'PLY-B']) {
      expect(res[sku].brand).toBeTruthy();
      for (const ds of DS_LIST) {
        const sr = res[sku].storeResults[ds];
        expect(sr.min).toBeGreaterThanOrEqual(1);    // floors everywhere
        expect(sr.max).toBeGreaterThan(sr.min - 1);
        expect(sr.covers).toEqual([ds]);
      }
      expect(res[sku].dcResult.min).toBeGreaterThanOrEqual(0);
      expect(res[sku].dcResult.max).toBeGreaterThanOrEqual(res[sku].dcResult.min);
    }
  });

  it('greedy mode respects capacity: ΣMax per ds×class ≤ cap', () => {
    const resG = computePlywoodNetworkV2Results(inv, SKUM, {
      plywoodNetworkV2Config: { ...params.plywoodNetworkV2Config, allocMode: 'greedy' },
    });
    const v2 = resG['PLY-A'].v2;
    for (const ds of DS_LIST) for (const tc of ['thick', 'thin']) {
      const node = v2.nodeReport[ds][tc];
      if (node.capacity != null) expect(node.used).toBeLessThanOrEqual(node.capacity);
    }
  });

  it('empirical mode (default) reports utilisation without trimming', () => {
    const v2 = res['PLY-A'].v2;
    for (const ds of DS_LIST) for (const tc of ['thick', 'thin']) {
      expect(v2.nodeReport[ds][tc]).toHaveProperty('used');
      expect(v2.nodeReport[ds][tc]).toHaveProperty('overCapacity');
    }
  });

  it('returns empty when config missing', () => {
    expect(computePlywoodNetworkV2Results(inv, SKUM, {})).toEqual({});
  });
});
