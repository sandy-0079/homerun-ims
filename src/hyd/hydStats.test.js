import { describe, it, expect } from "vitest";
import {
  uniqueOverrideSkus, engineFlipImpact, zeroedByFlag,
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

describe("engineFlipImpact", () => {
  it("counts targets, demand blocked per flag, flag carriers, and Inv Value Max before → after", () => {
    const before = { results: { A: st(1, 2), B: st(0, 0) } };
    const after = { results: {
      A: st(1, 3), B: st(2, 2),
      C: st(0, 0, { logicTag: "Flag: Purchase=OFF", engineMax: 4 }),  // Pati demand blocked
      D: st(0, 0, { logicTag: "Flag: Purchase=OFF", engineMax: 0 }),  // flag, but no Pati sales
      E: st(0, 0, { logicTag: "Flag: Supplier", engineMax: 1 }),
      F: st(0, 0, { logicTag: "Flag: Dead Stock" }),                  // no engineMax at all
    } };
    expect(engineFlipImpact(before, after, { A: 10, B: 1 })).toEqual({
      before: { withTargets: 1, invMax: 20 },
      after: { withTargets: 2, invMax: 32 },
      blockedByFlag: { "Purchase=OFF": 1, Supplier: 1, "Dead Stock": 0 },
      flaggedByFlag: { "Purchase=OFF": 2, Supplier: 1, "Dead Stock": 1 },
    });
  });
});

describe("engineFlipImpact — no DC in Hyderabad", () => {
  it("Inv Value ignores a results.dc entry (computeInvValue includeDC:false)", () => {
    const withDc = { results: { A: { stores: { HYDS01: { min: 1, max: 2 } }, dc: { min: 5, max: 9 } } } };
    const out = engineFlipImpact(withDc, withDc, { A: 10 });
    expect(out.before.invMax).toBe(20);
    expect(out.after.invMax).toBe(20);
  });
});

describe("zeroedByFlag", () => {
  const results = {
    sold: st(0, 0, { logicTag: "Flag: Purchase=OFF", engineMax: 3 }),
    unsold: st(0, 0, { logicTag: "Flag: Purchase=OFF", engineMax: 0 }),
  };
  it("counts only SKUs the engine would otherwise have stocked", () => {
    expect(zeroedByFlag(results)["Purchase=OFF"]).toBe(1);
  });
  it("with demandOnly=false counts every flag carrier", () => {
    expect(zeroedByFlag(results, { demandOnly: false })["Purchase=OFF"]).toBe(2);
  });
  it("tolerates missing results", () => {
    expect(zeroedByFlag(null)).toEqual({ "Purchase=OFF": 0, Supplier: 0, "Dead Stock": 0 });
  });
});
