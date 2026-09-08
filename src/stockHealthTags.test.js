import { describe, it, expect } from "vitest";
import { applyDCReqCovered, getHealthTag } from "./stockHealthTags.js";

// Helpers build the exact shapes applyDCReqCovered reads, so a test failure means
// the RULE is wrong rather than the fixture.
const store = (min, max) => ({ min, max });
const soh = (n) => ({ stock_on_hand: n });
const meta = (over = {}) => ({ inventorisedAt: "DC", status: "active", purchase: "Yes", move: "Yes", ...over });

const call = ({ tag = "ec", ecs, min, stores, live, metaOver }) =>
  applyDCReqCovered(tag, {
    sku: "X", ecs, min,
    res: { meta: meta(metaOver), stores },
    activeStockData: { X: live },
  });

describe("applyDCReqCovered — condition C", () => {
  // ⚠ THE BUG, measured live on VZG3X 2026-09-08. Four of six stores are short and
  // need 69 units between them; the network's entire surplus is 17 units sitting at
  // DS04. The network is 52 units SHORT, and the DC holds 1 against a floor of 18 —
  // yet condC compared GROSS excess (17) + DC stock (1) against the DC's own Min (18)
  // and declared no purchase order was needed. The same 17 units were counted as
  // available to refill the DC while already being needed at the short stores.
  it("does not claim coverage when short stores need more than the network's surplus", () => {
    const tag = call({
      ecs: 1, min: 18,
      stores: {
        DS01: store(15, 25), DS02: store(15, 25), DS03: store(15, 25),
        DS04: store(16, 25), DS05: store(15, 25), DS06: store(15, 25),
      },
      live: {
        DS01: soh(0), DS02: soh(11), DS03: soh(13),
        DS04: soh(42), DS05: soh(18), DS06: soh(7),
      },
    });
    // excess 17 (DS04 only) · short stores need 69 · net −52 ⇒ a PO IS needed
    expect(tag).toBe("ec");
  });

  it("still claims coverage when the network is genuinely long after refilling", () => {
    // The case condC exists for: one short store needing 6, a surplus of 50 elsewhere.
    // Net 44 comfortably covers the DC's floor of 20, so no supplier PO is needed.
    const tag = call({
      ecs: 0, min: 20,
      stores: { DS01: store(5, 10), DS02: store(5, 10) },
      live: { DS01: soh(4), DS02: soh(60) },
    });
    expect(tag).toBe("dsReqCovered");
  });

  it("does not claim coverage when surplus exactly refills the short stores and no more", () => {
    // Boundary: excess 6, need 6, net 0, DC holds 0 against a Min of 3.
    const tag = call({
      ecs: 0, min: 3,
      stores: { DS01: store(5, 10), DS02: store(5, 10) },
      live: { DS01: soh(4), DS02: soh(16) },
    });
    expect(tag).toBe("ec");
  });
});

describe("applyDCReqCovered — the other two conditions", () => {
  it("A: covers when no store is short, whatever the DC holds", () => {
    const tag = call({
      ecs: 0, min: 5,
      stores: { DS01: store(5, 10), DS02: store(5, 10) },
      live: { DS01: soh(8), DS02: soh(9) },
    });
    expect(tag).toBe("dsReqCovered");
  });

  it("B: covers when DC stock alone can refill every short store", () => {
    // Isolates B: zero network excess, so condC (0 - 10 + 10 = 0 >= 5) is false.
    const tag = call({
      ecs: 10, min: 5,
      stores: { DS01: store(5, 10) },
      live: { DS01: soh(0) },
    });
    expect(tag).toBe("dsReqCovered");
  });

  it("B: does not cover when DC stock falls short of what the stores need", () => {
    const tag = call({
      ecs: 3, min: 5,
      stores: { DS01: store(5, 10) },
      live: { DS01: soh(0) },
    });
    expect(tag).toBe("ec");
  });
});

describe("applyDCReqCovered — guards", () => {
  // Regression for 7e484b1, which had no test. A DC-only SKU has all six DS at 0/0,
  // so without this guard the tag fired down BOTH paths and the DC team would never
  // see Critical for the one SKU class the DC is the only place to sell.
  it("never covers a DC-only SKU, however the network looks", () => {
    const tag = call({
      ecs: 0, min: 10,
      metaOver: { move: "No" },
      stores: { DS01: store(0, 0), DS02: store(0, 0) },
      live: { DS01: soh(0), DS02: soh(500) },
    });
    expect(tag).toBe("ec");
  });

  it("leaves a non-shortage tag untouched", () => {
    for (const tag of ["excess", "okay"]) {
      expect(call({ tag, ecs: 999, min: 1, stores: {}, live: {} })).toBe(tag);
    }
  });

  // Pins CURRENT behaviour, not an endorsement: a branch with no stock record is
  // skipped entirely, so a SKU with no records anywhere reads "no store is short"
  // and covers via condA. Rare since 2026-08-07 (every active SKU gets a row at
  // every location) and it is what made the DC-only guard above necessary.
  it("skips branches with no stock record", () => {
    const tag = call({ ecs: 0, min: 5, stores: { DS01: store(5, 10) }, live: {} });
    expect(tag).toBe("dsReqCovered");
  });
});

describe("getHealthTag — branch order is load-bearing", () => {
  // A 0/0 row can never reach the `ecs <= min` branch: the two earlier branches
  // catch every zero-target case. That is why the 2026-08-07 "every SKU gets a row"
  // change could not move the Critical / Low Stock counts.
  it("reads a stocked zero-target SKU as excess, and an empty one as okay", () => {
    expect(getHealthTag(4, 0, 0, 0)).toBe("excess");
    expect(getHealthTag(0, 0, 0, 0)).toBe("okay");
  });

  it("splits critical from low stock on the ros margin", () => {
    expect(getHealthTag(2, 5, 10, 3.5)).toBe("ec");        // ros - ecs >= 1
    expect(getHealthTag(2, 5, 10, 2.5)).toBe("critical");  // ros - ecs  < 1
  });
});
