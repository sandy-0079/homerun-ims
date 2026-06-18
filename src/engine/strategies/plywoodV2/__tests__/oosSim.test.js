import { describe, it, expect } from 'vitest';
import { simulateOOS } from '../oosSim.js';
import { computePlywoodNetworkV2Results, V2_DEFAULTS } from '../index.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'A 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-B': { sku: 'PLY-B', name: 'B 6mm', brand: 'CenturyPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
};
const CFG = { ...V2_DEFAULTS };

// Original 90-day window the plan is fit on: PLY-A sells 2/day at DS01 → a small Max.
const ORIG_DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));
const origInv = [];
ORIG_DATES.forEach((d, i) => {
  origInv.push({ sku: 'PLY-A', ds: 'DS01', qty: 2, date: d, shopifyOrder: `O${i}` });
  origInv.push({ sku: 'PLY-B', ds: 'DS01', qty: 1, date: d, shopifyOrder: `OB${i}` }); // PLY-B sells at DS01 → gets a plan there
});

const publishedPlan = computePlywoodNetworkV2Results(origInv, SKUM, { plywoodNetworkV2Config: CFG });

// Uploaded window: dates AFTER the original 90d.
const U = Array.from({ length: 10 }, (_, i) =>
  new Date(Date.UTC(2026, 5, 11 + i)).toISOString().slice(0, 10));
const uploaded = [
  { sku: 'PLY-A', ds: 'DS01', qty: 8, date: U[0], shopifyOrder: 'SO-BIG' },   // > Max → OOS at DS01
  { sku: 'PLY-B', ds: 'DS01', qty: 1, date: U[0], shopifyOrder: 'SO-BIG' },   // served line in a missed order → green row
  { sku: 'PLY-A', ds: 'DS01', qty: 2, date: U[3], shopifyOrder: 'SO-OK' },    // covered
  { sku: 'PLY-B', ds: 'DS01', qty: 15, date: U[5], shopifyOrder: 'SO-BULK' }, // ≥10 → routes to DC
  { sku: 'NEW-X', ds: 'DS01', qty: 5, date: U[6], shopifyOrder: 'SO-NEW' },   // not in universe → unplanned
];

describe('simulateOOS', () => {
  const r = simulateOOS(uploaded, publishedPlan, SKUM, CFG);

  it('windows to the uploaded date range', () => {
    expect(r.window.from).toBe(U[0]);
    expect(r.window.to).toBe(U[6]);
    expect(r.window.days).toBeGreaterThan(0);
  });

  it('buckets unplanned (out-of-universe) SKUs separately, not as OOS', () => {
    expect(r.unplanned.skus).toContain('NEW-X');
    expect(r.unplanned.orders).toBeGreaterThanOrEqual(1);
    // NEW-X is never simulated → never appears in a DS OOS order
    const allTableSkus = Object.values(r.perDS).flatMap((d) => d.rows.map((x) => x.sku));
    expect(allTableSkus).not.toContain('NEW-X');
  });

  it('routes the ≥10-sheet order to the DC bulk tile', () => {
    expect(r.dc.total).toBeGreaterThanOrEqual(1);
    expect(r.network.bulkServedPct).toBeGreaterThanOrEqual(0);
    expect(r.network.bulkServedPct).toBeLessThanOrEqual(1);
  });

  it('flags the oversized regular order as OOS at its DS', () => {
    expect(Object.keys(r.perDS)).toEqual(expect.arrayContaining(['DS01', 'DS02', 'DS03', 'DS04', 'DS05']));
    expect(r.perDS.DS01.oos).toBeGreaterThanOrEqual(1);
    const ds01shortSkus = r.perDS.DS01.rows.filter((x) => x.short > 0).map((x) => x.sku);
    expect(ds01shortSkus).toContain('PLY-A');
    expect(r.network.dsOosPct).toBeGreaterThan(0);
  });

  it('table row carries qty/SOH/Min/Max/short/serviced + Item Name, and includes green served lines of a missed order', () => {
    const fail = r.perDS.DS01.rows.find((x) => x.ref === 'SO-BIG' && x.sku === 'PLY-A');
    expect(fail).toBeTruthy();
    expect(fail.qty).toBe(8);
    expect(fail.served).toBe(false);
    expect(fail.short).toBe(fail.qty - fail.soh);          // shortfall = ordered − on hand
    expect(fail.max).toBeGreaterThanOrEqual(fail.min);     // planned band
    expect(fail.itemName).toBe('A 18mm');                  // skuMaster lookup

    const served = r.perDS.DS01.rows.find((x) => x.ref === 'SO-BIG' && x.sku === 'PLY-B');
    expect(served).toBeTruthy();                           // served line of the same missed order
    expect(served.served).toBe(true);
    expect(served.short).toBe(0);

    // sorted by short desc → the failing line precedes the served line
    const idxFail = r.perDS.DS01.rows.findIndex((x) => x.ref === 'SO-BIG' && x.sku === 'PLY-A');
    const idxOk = r.perDS.DS01.rows.findIndex((x) => x.ref === 'SO-BIG' && x.sku === 'PLY-B');
    expect(idxFail).toBeLessThan(idxOk);
  });
});
