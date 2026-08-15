import { describe, it, expect } from "vitest";
import { runEngine } from "../index.js";
import { capFor, clampToCeiling } from "../skuCeiling.js";
import { DEFAULT_PARAMS } from "../constants.js";

describe("capFor — lookup", () => {
  const c = { G9NYZ: { DS05: 5, DS01: 0 } };

  it("returns the cap for a capped DS", () => expect(capFor(c, "G9NYZ", "DS05")).toBe(5));
  it("returns 0 as a real cap, not as absent", () => expect(capFor(c, "G9NYZ", "DS01")).toBe(0));
  it("returns null for an uncapped DS", () => expect(capFor(c, "G9NYZ", "DS02")).toBe(null));
  it("returns null for an unknown SKU", () => expect(capFor(c, "NOPE", "DS05")).toBe(null));
  it("returns null for an empty map", () => expect(capFor({}, "G9NYZ", "DS05")).toBe(null));
  it("returns null when the map is undefined", () => expect(capFor(undefined, "G9NYZ", "DS05")).toBe(null));

  it("matches the SKU case-insensitively, like the floor lookup does", () => {
    // SKU Master and a hand-edited CSV disagree on casing more often than you
    // would think; runEngine's nsq lookup already guards this.
    expect(capFor({ g9nyz: { DS05: 5 } }, "G9NYZ", "DS05")).toBe(5);
  });

  it("ignores a non-numeric cap rather than producing NaN", () => {
    expect(capFor({ A: { DS01: "abc" } }, "A", "DS01")).toBe(null);
  });
});

describe("clampToCeiling — only ever reduces", () => {
  it("clamps BOTH fields, or Min would exceed Max", () => {
    expect(clampToCeiling(19, 29, 5)).toEqual({ min: 5, max: 5, applied: true });
  });

  it("clamps Max alone when Min is already under the cap", () => {
    expect(clampToCeiling(2, 29, 5)).toEqual({ min: 2, max: 5, applied: true });
  });

  it("does nothing when both are already under the cap", () => {
    expect(clampToCeiling(1, 3, 5)).toEqual({ min: 1, max: 3, applied: false });
  });

  it("never RAISES a value to meet the cap", () => {
    // A ceiling is not a target. 0/0 with a cap of 5 stays 0/0.
    expect(clampToCeiling(0, 0, 5)).toEqual({ min: 0, max: 0, applied: false });
  });

  it("a cap of 0 zeroes the cell", () => {
    expect(clampToCeiling(19, 29, 0)).toEqual({ min: 0, max: 0, applied: true });
  });
});

// ── End-to-end through the real engine ──────────────────────────────────────
// One SKU, one DS, demand large enough that the strategy comfortably exceeds any
// cap we set, so the assertions are about the ceiling and not about the blend.
const SKU = "CAPME";
const skuMaster = () => ({
  [SKU]: { name: "Capped thing", category: "Cement", brand: "X", status: "active", inventorisedAt: "DC" },
});
const invoice = () => {
  const rows = [];
  for (let d = 1; d <= 20; d++) {
    const date = `2026-07-${String(d).padStart(2, "0")}`;
    rows.push({ date, ds: "DS01", pin: "560001", qty: 10, shopifyOrder: `o${d}`, sku: SKU });
  }
  return rows;
};
const params = () => ({ ...DEFAULT_PARAMS, overallPeriod: 45, newDSList: [], dsSeed: {} });

const run = (ceilings, nsq = {}) =>
  runEngine(invoice(), skuMaster(), {}, {}, new Set(), nsq, params(), ceilings);

describe("SKU ceiling through runEngine", () => {
  it("is a NO-OP when no ceilings are supplied — the rollout safety property", () => {
    // Deploying the engine with an empty skuCeiling must not move a single number.
    const before = run(undefined)[SKU].stores.DS01;
    const after = run({})[SKU].stores.DS01;
    expect(after).toEqual(before);
    expect(before.logicTag).not.toBe("SKU Ceiling");
  });

  it("caps Min and Max at the ceiling", () => {
    const bare = run({})[SKU].stores.DS01;
    expect(bare.max).toBeGreaterThan(5);
    const capped = run({ [SKU]: { DS01: 5 } })[SKU].stores.DS01;
    expect(capped.min).toBeLessThanOrEqual(5);
    expect(capped.max).toBe(5);
  });

  it("tags the row and records the pre-cap values for the audit trail", () => {
    const bare = run({})[SKU].stores.DS01;
    const st = run({ [SKU]: { DS01: 5 } })[SKU].stores.DS01;
    expect(st.logicTag).toBe("SKU Ceiling");
    const step = st.postBlendSteps.find((s) => s.rule === "SKU Ceiling");
    expect(step).toMatchObject({ cap: 5, beforeMin: bare.min, beforeMax: bare.max });
  });

  it("a cap of 0 zeroes that DS only, leaving other stores alone", () => {
    // The case Dead Stock cannot express — it zeroes every location incl. the DC.
    const res = run({ [SKU]: { DS01: 0 } })[SKU];
    expect(res.stores.DS01).toMatchObject({ min: 0, max: 0 });
    expect(res.dc.max).toBeGreaterThan(0);
  });

  it("BEATS a SKU floor — a cap a floor can overrule is not a cap", () => {
    const nsq = { [SKU]: { DS01: { min: 8, max: 12 } } };
    const st = run({ [SKU]: { DS01: 3 } }, nsq)[SKU].stores.DS01;
    expect(st).toMatchObject({ min: 3, max: 3, logicTag: "SKU Ceiling" });
  });

  it("does not touch an uncapped DS on a capped SKU", () => {
    const inv = invoice().concat(
      Array.from({ length: 20 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, "0")}`,
        ds: "DS02", pin: "560002", qty: 10, shopifyOrder: `p${i}`, sku: SKU,
      })),
    );
    const res = runEngine(inv, skuMaster(), {}, {}, new Set(), {}, params(), { [SKU]: { DS01: 5 } });
    expect(res[SKU].stores.DS01.max).toBe(5);
    expect(res[SKU].stores.DS02.max).toBeGreaterThan(5);
  });

  it("Dead Stock still wins — it zeroes a capped SKU everywhere", () => {
    const res = runEngine(invoice(), skuMaster(), {}, {}, new Set([SKU]), {}, params(), { [SKU]: { DS01: 5 } });
    expect(res[SKU].stores.DS01).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
    expect(res[SKU].dc).toMatchObject({ min: 0, max: 0 });
  });

  it("pulls the DC down with it on the FLOORED branch", () => {
    // dcMin = round(sumMin x 0.2) for any SKU carrying a manual floor, so a DS cap
    // reaches the DC automatically. 94.5% of realistic ceiling candidates are here.
    const nsq = { [SKU]: { DS01: { min: 1, max: 1 } } };
    const before = run({}, nsq)[SKU].dc;
    const after = run({ [SKU]: { DS01: 2 } }, nsq)[SKU].dc;
    expect(after.max).toBeLessThan(before.max);
  });

  it("⚠ does NOT reach the DC on the rate-based branch — known and documented", () => {
    // dcMin = ceil(sumDailyAvg x (leadTime+1)) is derived from raw demand, which a
    // DS cap does not change. Measured 2026-08-15: 81 of 1,486 candidate SKUs
    // (Rs4.4L of Rs290L) sit here. Pinned so the gap is a decision, not a surprise.
    const before = run({})[SKU].dc;
    const after = run({ [SKU]: { DS01: 1 } })[SKU].dc;
    expect({ min: after.min, max: after.max }).toEqual({ min: before.min, max: before.max });
    // The audit DOES see the capped DS sums even though the formula ignores them —
    // which is how you would spot this from a SKU Detail dump.
    expect(after.dcDetails.sumMin).toBeLessThan(before.dcDetails.sumMin);
  });
});
