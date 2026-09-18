// Opening Shortly — the gate that lets a dark store be wired weeks before it trades.
//
// Replaces dsSeed.test.js. The property under test is inverted: DS Seed had to prove
// it INVENTED sensible numbers for a store with no history; this has to prove it
// SUPPRESSES numbers a store would otherwise legitimately earn. A gate that has
// never been asked to stop anything is a gate nobody has tested.

import { describe, it, expect } from "vitest";
import { applyOpeningToStores } from "../openingStores.js";
import { runEngine } from "../runEngine.js";
import { DEFAULT_PARAMS, DS_LIST, OPENING_DS_DEFAULT, liveDsList } from "../constants.js";

describe("liveDsList", () => {
  it("defaults to gating DS07/DS08 when the param is absent", () => {
    // ⚠ THE CASE THAT NEARLY SHIPPED BROKEN. Prod's params/global predates this key
    // and the merge is shallow, so `p.openingDSList` really is undefined on the
    // first nightly run after deploy. Without the fallback the gate is simply off.
    expect(liveDsList({})).toEqual(["DS01", "DS02", "DS03", "DS04", "DS05", "DS06"]);
    expect(liveDsList(undefined)).not.toContain("DS07");
  });

  it("treats an empty list as 'everything trades', not as absent", () => {
    // ⚠⚠ THE `??` vs `||` BUG, PINNED. `[] || OPENING_DS_DEFAULT` yields the default,
    // so with `||` the two stores would silently re-gate on the day the last one
    // opened — reading as "the go-live reverted overnight" with nothing in any log.
    expect(liveDsList({ openingDSList: [] })).toEqual(DS_LIST);
    expect(liveDsList({ openingDSList: [] })).toContain("DS08");
  });

  it("opens stores one at a time and preserves DS_LIST order", () => {
    expect(liveDsList({ openingDSList: ["DS08"] })).toEqual([...DS_LIST].filter((d) => d !== "DS08"));
    expect(liveDsList({ openingDSList: ["DS02", "DS07", "DS08"] })).not.toContain("DS02");
  });

  it("DEFAULT_PARAMS ships the two unopened stores gated", () => {
    expect(DEFAULT_PARAMS.openingDSList).toEqual(OPENING_DS_DEFAULT);
    expect(OPENING_DS_DEFAULT).toEqual(["DS07", "DS08"]);
  });
});

describe("applyOpeningToStores", () => {
  const stores = () => ({
    DS01: { min: 4, max: 9, logicTag: "Base Logic" },
    DS07: { min: 12, max: 30, logicTag: "SKU Floor" },
    DS08: { min: 0, max: 0, logicTag: "Base Logic" },
  });

  it("zeroes a gated store however it got its numbers", () => {
    const s = stores();
    applyOpeningToStores(s, new Set(["DS07", "DS08"]), DS_LIST);
    expect(s.DS07).toMatchObject({ min: 0, max: 0, logicTag: "Opening Shortly" });
  });

  it("never touches a trading store", () => {
    const s = stores();
    applyOpeningToStores(s, new Set(["DS07", "DS08"]), DS_LIST);
    expect(s.DS01).toEqual({ min: 4, max: 9, logicTag: "Base Logic" });
  });

  it("tags a gated store that was already 0/0", () => {
    // Same reason Dead Stock tags an already-zero cell: "Base Logic" beside DS07
    // reads as "no demand", and on go-live morning that is the difference between a
    // working rollout and a panic that attribution failed.
    const s = stores();
    applyOpeningToStores(s, new Set(["DS08"]), DS_LIST);
    expect(s.DS08.logicTag).toBe("Opening Shortly");
  });

  it("reports how many cells actually moved, not how many it tagged", () => {
    const s = stores();
    expect(applyOpeningToStores(s, new Set(["DS07", "DS08"]), DS_LIST)).toBe(1);
  });

  it("is a no-op with an empty gate, so an all-open network costs nothing", () => {
    const s = stores();
    expect(applyOpeningToStores(s, new Set(), DS_LIST)).toBe(0);
    expect(s.DS07.min).toBe(12);
  });
});

// ── The integration property, which is the one that matters ──────────────────
// Every path that can write a store must be unable to leave a gated one non-zero.
describe("runEngine — a gated store resists every input that would stock it", () => {
  const inv = [];
  for (let d = 1; d <= 20; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    // Demand lands at DS07 via attribution, exactly as it will on go-live day.
    inv.push({ date, sku: "SKU-A", ds: "DS02", qty: 3, shopifyOrder: `o${d}`, pin: "560077" });
  }
  const skuM = { "SKU-A": { sku: "SKU-A", name: "A", category: "Tiling", brand: "", status: "Active", inventorisedAt: "DC" } };

  const run = (openingDSList) => runEngine(
    inv, skuM,
    { "SKU-A": 40 },                                  // minReqQty — feeds New DS Floor
    { "SKU-A": 100 },                                 // priceData
    new Set(),
    { "SKU-A": { DS07: { min: 25, max: 50 } } },      // an explicit SKU floor at DS07
    {
      ...DEFAULT_PARAMS, overallPeriod: 20, newDSFloorTopN: 250,
      newDSList: ["DS07"],                             // …and New DS Floor eligibility
      categoryStrategies: {},
      pincodeConfig: { mode: "shippingCode", map: { "560077": "DS07" } },
      openingDSList,
    },
    {},
  );

  it("holds DS07 at 0/0 against attributed demand AND a floor AND newDSList", () => {
    const s = run(["DS07", "DS08"])["SKU-A"].stores.DS07;
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.logicTag).toBe("Opening Shortly");
  });

  it("…and the same inputs DO stock it once opened — or the test above is vacuous", () => {
    // ⚠ THE LOAD-BEARING HALF. Without this, a gate that had accidentally been
    // wired to a store with no data would pass every assertion above.
    const s = run([])["SKU-A"].stores.DS07;
    expect(s.min).toBeGreaterThan(0);
    expect(s.logicTag).not.toBe("Opening Shortly");
  });

  it("keeps the gated store out of the DC sums, not merely off the screen", () => {
    // ⚠⚠ THE ORDERING BUG THIS EXISTS TO CATCH. Applied after `sumMin`/`sumMax`, the
    // store would read 0/0 while the DC had already been stocked to supply it —
    // zero on screen, real inventory in the warehouse. Measured on live data
    // 2026-09-18: DC total Min 24,547 gated vs 28,516 open.
    expect(run(["DS07", "DS08"])["SKU-A"].dc.min)
      .toBeLessThan(run([])["SKU-A"].dc.min);
  });

  it("publishes no TO-tool target for a gated store", () => {
    expect(liveDsList({ openingDSList: ["DS07", "DS08"] })).not.toContain("DS07");
  });
});
