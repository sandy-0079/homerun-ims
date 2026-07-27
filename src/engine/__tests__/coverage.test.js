import { describe, it, expect } from "vitest";
import { summariseCoverage } from "../attribution.js";

const r = (pin) => ({ date: "2026-07-01", sku: "A", ds: "DS02", qty: 1, ...(pin !== undefined ? { pin } : {}) });

describe("summariseCoverage", () => {
  it("reports coverage as not-measurable when no row carries a pincode", () => {
    // Stored rows predate the pin field. Showing "0% mapped" here reads as
    // "your mapping is broken" when the mapping is fine — there is simply
    // nothing to measure. This is the number someone checks before flipping.
    const s = summariseCoverage([r(), r()], { "560077": "DS06" });
    expect(s.withPin).toBe(0);
    expect(s.coveragePct).toBeNull();
  });

  it("reports the share of rows carrying a pincode", () => {
    expect(summariseCoverage([r("560077"), r(), r(), r()], {}).pinPct).toBe(25);
  });

  it("measures coverage against only the rows that have a pincode", () => {
    const s = summariseCoverage([r("560077"), r("999999"), r()], { "560077": "DS06" });
    expect(s.withPin).toBe(2);
    expect(s.coveragePct).toBe(50);
  });

  it("returns 100 when every pincode-bearing row maps", () => {
    expect(summariseCoverage([r("560077"), r()], { "560077": "DS06" }).coveragePct).toBe(100);
  });

  it("tallies unmapped pincodes commonest-first so the biggest gap is actionable", () => {
    const inv = [r("560111"), r("560111"), r("500090"), r("560077")];
    const s = summariseCoverage(inv, { "560077": "DS06" });
    expect(s.unmapped).toEqual([["560111", 2], ["500090", 1]]);
  });

  it("handles an empty invoice set without dividing by zero", () => {
    expect(summariseCoverage([], {})).toMatchObject({ withPin: 0, pinPct: 0, coveragePct: null });
  });
});
