import { describe, it, expect } from 'vitest';
import { buildUniverse, prepareDemand, medianOrderQty } from '../demand.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'GreenPly 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-B': { sku: 'PLY-B', name: 'CenturyPly 6mm', brand: 'CenturyPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-M': { sku: 'PLY-M', name: 'Merino Lam', brand: 'Merino', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-X': { sku: 'PLY-X', name: 'Dead 12mm', brand: 'GreenPly', status: 'Inactive', category: 'Plywood, MDF & HDHMR' },
  'OTHER': { sku: 'OTHER', name: 'Cement', brand: 'ACC', status: 'Active', category: 'Cement' },
};
const CFG = { lookbackDays: 90, bulkOrderThreshold: 10, excludedBrands: ['Merino'] };

describe('buildUniverse', () => {
  it('includes active ply SKUs, excludes Merino / inactive / other categories', () => {
    const u = buildUniverse(SKUM, CFG);
    expect(Object.keys(u).sort()).toEqual(['PLY-A', 'PLY-B']);
  });
});

describe('medianOrderQty', () => {
  it('odd count', () => expect(medianOrderQty([3, 2, 2])).toBe(2));
  it('even count', () => expect(medianOrderQty([1, 3])).toBe(2));
  it('empty', () => expect(medianOrderQty([])).toBe(0));
});

describe('prepareDemand', () => {
  const u = buildUniverse(SKUM, CFG);
  const inv = [
    // regular order: single small line
    { sku: 'PLY-A', ds: 'DS01', qty: 3, date: '2026-06-01', shopifyOrder: 'O1' },
    // bulk order (mixed): 12 + 4 in one order → order is bulk
    { sku: 'PLY-A', ds: 'DS02', qty: 12, date: '2026-06-02', shopifyOrder: 'O2' },
    { sku: 'PLY-B', ds: 'DS02', qty: 4, date: '2026-06-02', shopifyOrder: 'O2' },
    // non-universe line ignored
    { sku: 'OTHER', ds: 'DS01', qty: 5, date: '2026-06-02', shopifyOrder: 'O3' },
  ];
  const d = prepareDemand(inv, u, CFG);

  it('classifies orders at order level', () => {
    const o2 = d.orders.find(o => o.id === 'O2');
    expect(o2.isBulk).toBe(true);
    expect(d.orders.find(o => o.id === 'O1').isBulk).toBe(false);
  });
  it('regular stream is line-level: small line inside bulk order still counts', () => {
    expect(d.regularDaily['PLY-B']['DS02']['2026-06-02']).toBe(4);
    expect(d.regularDaily['PLY-A']['DS01']['2026-06-01']).toBe(3);
    // bulk-sized line NOT in regular stream
    expect(d.regularDaily['PLY-A']?.['DS02']).toBeUndefined();
  });
  it('bulk stream is order-level: all lines of bulk orders, network-keyed', () => {
    expect(d.bulkDaily['PLY-A']['2026-06-02']).toBe(12);
    expect(d.bulkDaily['PLY-B']['2026-06-02']).toBe(4);   // small line rides with bulk order
    expect(d.bulkDaily['PLY-A']?.['2026-06-01']).toBeUndefined();
  });
  it('collects network regular order qtys', () => {
    expect(d.regOrderQtys['PLY-A']).toEqual([3]);
    expect(d.regOrderQtys['PLY-B']).toEqual([4]);
  });
});
