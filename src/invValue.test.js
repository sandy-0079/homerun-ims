import { describe, it, expect } from "vitest";
import { computeInvValue } from "./invValue.js";

const DS = ["DS01", "DS02"];
// Shape mirrors runEngine output: { stores: { [ds]: {min,max} }, dc: {min,max} }
const sku = (stores, dc) => ({ stores, dc });

describe("computeInvValue — must reproduce the Overview KPI card exactly", () => {
  it("sums every DS plus the DC, priced per SKU", () => {
    const r = computeInvValue(
      { A: sku({ DS01: { min: 1, max: 2 }, DS02: { min: 3, max: 4 } }, { min: 5, max: 6 }) },
      { A: 10 }, DS,
    );
    expect(r).toEqual({ min: (1 + 3 + 5) * 10, max: (2 + 4 + 6) * 10 });
  });

  it("INCLUDES the DC — omitting it is a 27% understatement on live data", () => {
    // params/toTargets carries DS columns only, which is why the digest cannot
    // derive this number from that row: measured 2026-08-04, DS-only came out
    // ₹5.29Cr against the card's ₹7.93Cr.
    const withDc = computeInvValue({ A: sku({ DS01: { min: 0, max: 10 } }, { min: 0, max: 90 }) }, { A: 1 }, DS);
    const dsOnly = computeInvValue({ A: sku({ DS01: { min: 0, max: 10 } }, { min: 0, max: 0 }) }, { A: 1 }, DS);
    expect(withDc.max).toBe(100);
    expect(dsOnly.max).toBe(10);
  });

  it("treats a SKU with no price as zero value, never NaN", () => {
    // A NaN here would propagate through the whole sum and render as "₹NaNCr".
    const r = computeInvValue({ A: sku({ DS01: { min: 1, max: 2 } }, { min: 1, max: 1 }) }, {}, DS);
    expect(r).toEqual({ min: 0, max: 0 });
  });

  it("tolerates a SKU stocked at no location and one with no dc block", () => {
    const r = computeInvValue({ A: sku({}, undefined), B: sku({ DS02: { min: 2, max: 2 } }, undefined) }, { A: 5, B: 5 }, DS);
    expect(r).toEqual({ min: 10, max: 10 });
  });

  it("rounds, as the card does", () => {
    const r = computeInvValue({ A: sku({ DS01: { min: 1, max: 1 } }, { min: 0, max: 0 }) }, { A: 10.4 }, DS);
    expect(r).toEqual({ min: 10, max: 10 });
  });

  it("returns zeroes rather than throwing on empty or missing input", () => {
    expect(computeInvValue({}, {}, DS)).toEqual({ min: 0, max: 0 });
    expect(computeInvValue(null, null, DS)).toEqual({ min: 0, max: 0 });
  });
});
