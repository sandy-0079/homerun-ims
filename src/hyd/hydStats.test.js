import { describe, it, expect } from "vitest";
import {
  uniqueOverrideSkus, unitsSoldLastDays, hydOverviewKpis, patiDailySales,
  engineFlipImpact, zeroedByFlag,
} from "./hydStats.js";

const st = (min, max, extra = {}) => ({ stores: { HYDS01: { min, max, ...extra } }, dc: { min: 0, max: 0 } });

describe("uniqueOverrideSkus", () => {
  it("dedupes by SKU and keeps every reason", () => {
    const out = uniqueOverrideSkus([
      { sku: "A", reason: "Purchase=OFF" }, { sku: "B", reason: "Supplier" }, { sku: "A", reason: "Dead Stock" },
    ]);
    expect(out).toEqual([{ sku: "A", reasons: ["Purchase=OFF", "Dead Stock"] }, { sku: "B", reasons: ["Supplier"] }]);
  });
  it("tolerates null", () => expect(uniqueOverrideSkus(null)).toEqual([]));
});

describe("unitsSoldLastDays", () => {
  const inv = [
    { date: "2026-11-09", ds: "HYDS01", sku: "A", qty: 2 },
    { date: "2026-11-03", ds: "HYDS01", sku: "A", qty: 5 },  // exactly 7 days inclusive from 11-09
    { date: "2026-11-02", ds: "HYDS01", sku: "A", qty: 100 }, // 8th day back: out
    { date: "2026-11-09", ds: "DS01", sku: "A", qty: 50 },   // Bangalore: never counted
  ];
  it("counts Pati only, over calendar days ending at the network's latest date", () => {
    expect(unitsSoldLastDays(inv, 7)).toBe(7);
    expect(unitsSoldLastDays(inv, 30)).toBe(107);
  });
  it("a Bangalore row can set the latest date", () => {
    expect(unitsSoldLastDays([...inv, { date: "2026-11-20", ds: "DS02", sku: "B", qty: 1 }], 7)).toBe(0);
  });
  it("a malformed latest date yields null rather than throwing", () => {
    expect(unitsSoldLastDays([{ date: "28/07/2026", ds: "HYDS01", sku: "A", qty: 1 }], 7)).toBeNull();
    expect(unitsSoldLastDays([], 7)).toBeNull();
  });
});

describe("hydOverviewKpis", () => {
  it("aggregates range, floors, inventory value and mode", () => {
    const k = hydOverviewKpis({
      results: { A: st(2, 4), B: st(0, 0), C: st(1, 1) },
      floors: { A: { HYDS01: { min: 2, max: 4 } }, D: {} },
      priceData: { A: 10, C: 100 },
      invoiceData: [],
      hydParams: { floorsOnly: { HYDS01: true } },
    });
    expect(k).toMatchObject({ inRange: 2, floorRows: 2, floorRowsInRange: 1, invMin: 120, invMax: 140, mode: "Floors only", sold7: null });
  });
  it("mode is Engine only on an explicit false", () => {
    expect(hydOverviewKpis({ hydParams: { floorsOnly: { HYDS01: false } } }).mode).toBe("Engine");
    expect(hydOverviewKpis({}).mode).toBe("Floors only");
  });
});

describe("patiDailySales", () => {
  it("lists Pati's sales of one SKU per window date, newest first, with totals", () => {
    const inv = [
      { date: "d1", ds: "HYDS01", sku: "A", qty: 1 }, { date: "d1", ds: "HYDS01", sku: "A", qty: 2 },
      { date: "d3", ds: "HYDS01", sku: "A", qty: 4 }, { date: "d3", ds: "DS01", sku: "A", qty: 9 },
      { date: "d0", ds: "HYDS01", sku: "A", qty: 7 }, // outside the window
      { date: "d2", ds: "HYDS01", sku: "B", qty: 1 },
    ];
    expect(patiDailySales(inv, "A", ["d1", "d2", "d3"])).toEqual({
      days: [{ date: "d3", qty: 4 }, { date: "d1", qty: 3 }], total: 7, windowDays: 3,
    });
  });
});

describe("engineFlipImpact", () => {
  it("counts targets, zeroed SKUs per flag, and Inv Value Max before → after", () => {
    const before = { results: { A: st(1, 2), B: st(0, 0) } };
    const after = { results: {
      A: st(1, 3), B: st(2, 2),
      C: st(0, 0, { logicTag: "Flag: Purchase=OFF" }), D: st(0, 0, { logicTag: "Flag: Purchase=OFF" }),
      E: st(0, 0, { logicTag: "Flag: Supplier" }), F: st(0, 0, { logicTag: "Flag: Dead Stock" }),
    } };
    expect(engineFlipImpact(before, after, { A: 10, B: 1 })).toEqual({
      before: { withTargets: 1, invMax: 20 },
      after: { withTargets: 2, invMax: 32 },
      zeroedByFlag: { "Purchase=OFF": 2, Supplier: 1, "Dead Stock": 1 },
    });
  });
  it("zeroedByFlag tolerates missing results", () => {
    expect(zeroedByFlag(null)).toEqual({ "Purchase=OFF": 0, Supplier: 0, "Dead Stock": 0 });
  });
});
