import { describe, it, expect } from 'vitest';
import { replay } from '../replay.js';

const DATES = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06'];
const mkOrder = (id, ds, date, lines, isBulk) => ({ id, ds, date, lines, isBulk });

const PLAN = { A: { DS01: { min: 2, max: 4 } } };
const CFG = { leadDays: 3, infiniteDC: false };

describe('replay', () => {
  it('TO raised when closing ≤ min, arrives next day, refills to max', () => {
    const orders = [mkOrder('O1', 'DS01', '2026-06-01', [{ sku: 'A', qty: 3 }], false)];
    const r = replay(PLAN, { A: { min: 100, max: 100 } }, { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    // day1: stock 4→1 ≤ min → TO 3 raised; day2 starts with 1+3=4
    expect(r.toDrain['A']['2026-06-02']).toBe(3);
    expect(r.serviceLevels.regular.overall).toBe(1); // no OOS
  });

  it('order-level OOS: one short line fails the whole order', () => {
    const plan = { A: { DS01: { min: 1, max: 2 } }, B: { DS01: { min: 1, max: 2 } } };
    const orders = [
      mkOrder('O1', 'DS01', '2026-06-01', [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 5 }], false), // B short (2 < 5)
    ];
    const r = replay(plan, { A: { min: 0, max: 0 }, B: { min: 0, max: 0 } },
      { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    expect(r.serviceLevels.regular.overall).toBe(0);   // 1 of 1 orders OOS
    expect(r.oosEvents).toHaveLength(1);
    expect(r.oosEvents[0]).toMatchObject({ orderId: 'O1', sku: 'B', short: 3, type: 'regular' });
  });

  it('bulk orders draw DC stock, scored separately', () => {
    const orders = [mkOrder('O2', 'DS01', '2026-06-01', [{ sku: 'A', qty: 12 }], true)];
    const dcPlan = { A: { min: 5, max: 20 } };
    const r = replay(PLAN, dcPlan, { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    expect(r.serviceLevels.bulk.overall).toBe(1);      // 20 ≥ 12
    expect(r.serviceLevels.regular.overall).toBe(1);   // unaffected
  });

  it('DC PO arrives after leadDays', () => {
    // drain DC below min on day1 via bulk, check refill on day 1+3
    const orders = [mkOrder('O2', 'DS01', '2026-06-01', [{ sku: 'A', qty: 16 }], true)];
    const dcPlan = { A: { min: 5, max: 20 } };
    const r = replay(PLAN, dcPlan, { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    // day1 close: 20-16=4 ≤ 5 → PO 16 raised, arrives start of day4
    expect(r.dcStockByDate['A']['2026-06-03']).toBe(4);
    expect(r.dcStockByDate['A']['2026-06-04']).toBe(20);
  });

  it('infiniteDC mode never shorts TOs and still records drain', () => {
    const orders = [mkOrder('O1', 'DS01', '2026-06-01', [{ sku: 'A', qty: 3 }], false)];
    const r = replay(PLAN, null, { orders, windowDates: DATES, bulkDaily: {} }, { ...CFG, infiniteDC: true });
    expect(r.toDrain['A']['2026-06-02']).toBe(3);
  });
});
