import { describe, it, expect } from "vitest";
import { fixedUnitFloorStrategy } from "../strategies/fixedUnitFloor.js";
import { runEngine } from "../runEngine.js";
import { DEFAULT_PARAMS } from "../constants.js";

// ── Strategy-level: spike-cap (winsorising) ──────────────────────────────────
describe("fixedUnitFloorStrategy — spike cap (winsorise)", () => {
  const P = { fixedUnitFloor: { orderQtyPercentile: 90, maxMultiplier: 1.5, maxAdditive: 1, spikeCapMult: 5 } };

  it("clips a contractor spike buried among normal orders", () => {
    // [1,1,10]: median 1, cap 1×5=5 → [1,1,5] → P90 = 5 (was 9)
    const r = fixedUnitFloorStrategy({ orderQtys: [1, 1, 10], params: P });
    expect(r.minQty).toBe(5);
    expect(r.maxQty).toBe(8);
    expect(r.details.winsor.applied).toBe(true);
    expect(r.details.winsor.cap).toBe(5);
  });

  it("leaves regular orders (no outlier) untouched", () => {
    // [3,3,3]: median 3, cap 15, nothing exceeds → no winsor
    const r = fixedUnitFloorStrategy({ orderQtys: [3, 3, 3], params: P });
    expect(r.minQty).toBe(3);
    expect(r.details.winsor.applied).toBe(false);
  });

  it("does not winsorise with fewer than 3 orders (unstable median)", () => {
    const r = fixedUnitFloorStrategy({ orderQtys: [1, 20], params: P });
    expect(r.details.winsor.applied).toBe(false);
    expect(r.minQty).toBe(19); // P90([1,20]) = 19
  });

  it("spikeCapMult=0 disables winsorising", () => {
    const off = { fixedUnitFloor: { ...P.fixedUnitFloor, spikeCapMult: 0 } };
    const r = fixedUnitFloorStrategy({ orderQtys: [1, 1, 10], params: off });
    expect(r.details.winsor.applied).toBe(false);
    expect(r.minQty).toBe(9); // P90([1,1,10]) = 9, uncapped
  });

  it("returns null when there are no orders", () => {
    expect(fixedUnitFloorStrategy({ orderQtys: [], params: P })).toBeNull();
  });
});

// ── Engine-level: order-days gate ────────────────────────────────────────────
function mkParams() {
  return {
    ...DEFAULT_PARAMS,
    categoryStrategies: { "TestFUF": "fixed_unit_floor" },
    newDSList: [],
  };
}
function mkSkuM(price) {
  return { "SKU-X": { sku: "SKU-X", name: "Test Wire", brand: "TestBrand", status: "Active", category: "TestFUF", inventorisedAt: "DC" } };
}
function orders(qtysByDate, ds = "DS01") {
  return Object.entries(qtysByDate).map(([date, qty]) => ({ ds, sku: "SKU-X", date, qty }));
}

describe("runEngine — Fixed Unit Floor order-days gate", () => {
  it("gates a Premium single-order SKU → falls back to Standard, stocks ≥1, well below order size", () => {
    const inv = orders({ "2026-01-05": 20 }); // 1 order-day, qty 20, Premium price
    const res = runEngine(inv, mkSkuM(), {}, { "SKU-X": 6000 }, new Set(), {}, mkParams());
    const s = res["SKU-X"].stores.DS01;
    expect(s.strategyTag).toBe("standard");
    expect(s.strategyDetails.fufFallback).toBeTruthy();
    expect(s.strategyDetails.fufFallback.threshold).toBe(2);
    expect(s.min).toBeGreaterThanOrEqual(1);
    expect(s.min).toBeLessThan(20); // no longer dictated by the single 20-unit order
  });

  it("does NOT gate a cheap single-order SKU (stays Fixed Unit Floor)", () => {
    const inv = orders({ "2026-01-05": 20 }); // 1 order-day, cheap price
    const res = runEngine(inv, mkSkuM(), {}, { "SKU-X": 50 }, new Set(), {}, mkParams());
    const s = res["SKU-X"].stores.DS01;
    expect(s.strategyTag).toBe("fixed_unit_floor");
    expect(s.min).toBe(20); // P90([20]) = 20 — cheap items stay aggressive
  });

  it("does NOT gate a Premium SKU with ≥2 order-days; winsor still tames the spike", () => {
    const inv = orders({ "2026-01-03": 1, "2026-01-04": 1, "2026-01-05": 10 }); // 3 order-days
    const res = runEngine(inv, mkSkuM(), {}, { "SKU-X": 6000 }, new Set(), {}, mkParams());
    const s = res["SKU-X"].stores.DS01;
    expect(s.strategyTag).toBe("fixed_unit_floor");
    expect(s.strategyDetails.winsor.applied).toBe(true);
    expect(s.min).toBe(5); // winsor'd [1,1,5] → P90 = 5 (would be 9 uncapped)
  });

  it("minNZD=1 disables the gate (Premium single order keeps Fixed Unit Floor)", () => {
    const p = mkParams();
    p.fixedUnitFloor = { ...DEFAULT_PARAMS.fixedUnitFloor, minNZD: 1 };
    const inv = orders({ "2026-01-05": 20 });
    const res = runEngine(inv, mkSkuM(), {}, { "SKU-X": 6000 }, new Set(), {}, p);
    expect(res["SKU-X"].stores.DS01.strategyTag).toBe("fixed_unit_floor");
  });
});
