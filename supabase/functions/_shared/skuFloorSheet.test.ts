import { describe, it, expect } from "vitest";
import { parseFloorSheet, assessFloorChange } from "./skuFloorSheet.ts";

const DS = ["DS01", "DS02", "DS03", "DS04", "DS05", "DS06"];

// Header exactly as the ops sheet (and the app's SKU_Floors_Template.csv) emits it.
const HEADER = ["SKU", ...DS.flatMap((d) => [`${d} Min`, `${d} Max`])].join(",");
const sheet = (...rows: string[]) => [HEADER, ...rows].join("\n");
// 12 value columns; helper keeps the tests readable.
const row = (sku: string, vals: (number | string)[]) =>
  [sku, ...vals, ...Array(12 - vals.length).fill(0)].join(",");

describe("parseFloorSheet — shape must match the browser uploader exactly", () => {
  it("builds nsq[sku][ds] = {min,max}, omitting DSes that are 0/0", () => {
    const r = parseFloorSheet(sheet(row("SMBTV", [2, 5, 0, 0, 1, 3])), DS);
    expect(r.ok).toBe(true);
    expect(r.floors).toEqual({
      SMBTV: { DS01: { min: 2, max: 5 }, DS03: { min: 1, max: 3 } },
    });
  });

  it("keeps an all-zero SKU as a present-but-empty entry", () => {
    // The browser does `nsq[s]={}` for every row with a SKU, so a fully-zeroed
    // row is a SKU with no floors — NOT an absent SKU. Live count 1,148 depends
    // on this, and `0` is the agreed way ops removes a floor.
    const r = parseFloorSheet(sheet(row("ZEROED", [0, 0])), DS);
    expect(r.floors).toEqual({ ZEROED: {} });
  });

  it("floors max at min, mirroring Math.max(mn,mx)", () => {
    const r = parseFloorSheet(sheet(row("BADMAX", [7, 3])), DS);
    expect(r.floors.BADMAX.DS01).toEqual({ min: 7, max: 7 });
  });

  it("reads columns BY HEADER NAME, not position", () => {
    // DS07 will be appended to the right; column order must never be assumed.
    const reordered = ["SKU", "DS02 Min", "DS02 Max", "DS01 Min", "DS01 Max"].join(",");
    const r = parseFloorSheet([reordered, "ABC,4,6,1,2"].join("\n"), ["DS01", "DS02"]);
    expect(r.ok).toBe(true);
    expect(r.floors.ABC).toEqual({ DS01: { min: 1, max: 2 }, DS02: { min: 4, max: 6 } });
  });
});

describe("parseFloorSheet — fails closed on anything it does not understand", () => {
  it("rejects an HTML error page from a revoked publish", () => {
    const r = parseFloorSheet("<!DOCTYPE html><html><body>Sorry, unavailable</body></html>", DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("header_mismatch");
  });

  it("rejects a missing SKU column", () => {
    const r = parseFloorSheet(["DS01 Min,DS01 Max", "1,2"].join("\n"), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("header_mismatch");
  });

  it("rejects an unknown DS column instead of writing floors for it", () => {
    // Ops appends DS07 to the sheet before DS_LIST gains it. Fail loudly.
    const h = ["SKU", "DS01 Min", "DS01 Max", "DS07 Min", "DS07 Max"].join(",");
    const r = parseFloorSheet([h, "ABC,1,2,3,4"].join("\n"), ["DS01"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown_ds");
    expect(r.unknownDs).toEqual(["DS07"]);
  });

  it("rejects a duplicate SKU rather than silently letting one win", () => {
    const r = parseFloorSheet(sheet(row("DUP", [1, 2]), row("DUP", [5, 6])), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate_sku");
    expect(r.duplicateSkus).toEqual(["DUP"]);
  });

  it("rejects a non-integer value — a typo must not become a silent floor removal", () => {
    const r = parseFloorSheet(sheet(row("TYPO", ["2.5", 5])), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_value");
    expect(r.invalid[0]).toMatchObject({ sku: "TYPO", column: "DS01 Min", value: "2.5" });
  });

  it("rejects a negative value", () => {
    const r = parseFloorSheet(sheet(row("NEG", [-1, 5])), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_value");
  });

  it("rejects non-numeric text where the browser would have silently dropped it", () => {
    const r = parseFloorSheet(sheet(row("TEXT", ["abc", 5])), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_value");
  });

  it("treats a blank cell as 0, not as invalid", () => {
    const r = parseFloorSheet(sheet(row("BLANK", ["", "", 3, 4])), DS);
    expect(r.ok).toBe(true);
    expect(r.floors.BLANK).toEqual({ DS02: { min: 3, max: 4 } });
  });

  it("skips a blank SKU row without failing the run", () => {
    const r = parseFloorSheet(sheet(row("REAL", [1, 2]), row("", [3, 4])), DS);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.floors)).toEqual(["REAL"]);
  });

  it("rejects a header-only sheet, so `force` can never wipe every floor", () => {
    // A valid header with zero data rows parses "successfully" to {}, and since
    // force widens the change guard to 100% it would then be written over 1,115
    // live floors. The authoritative sheet having no rows is always an accident
    // (empty tab, filter); force overrides POLICY, never CORRECTNESS.
    const r = parseFloorSheet(sheet(), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty");
  });
});

describe("assessFloorChange — defaults the edge function relies on", () => {
  it("falls back to the 20% threshold when maxDropPct is undefined", () => {
    // sync-sku-floors passes `maxDropPct: force ? 100 : undefined`, so an
    // undefined must mean "use the default", not "no limit".
    const live = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`SKU${i}`, { DS01: { min: 1, max: 2 } }]),
    );
    const parsed = Object.fromEntries(Object.entries(live).slice(0, 70)); // 30% drop
    const r = assessFloorChange({ parsed, live, maxDropPct: undefined });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("row_collapse");
  });
});

describe("assessFloorChange — small deliberate removals pass, a collapse fails closed", () => {
  const live = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`SKU${i}`, { DS01: { min: 1, max: 2 } }]));
  const parsedFrom = (liveMap: Record<string, unknown>, drop: number) =>
    Object.fromEntries(Object.entries(liveMap).slice(0, Object.keys(liveMap).length - drop));

  it("passes a 6-of-1148 removal — the deliberate case", () => {
    const l = live(1148);
    const r = assessFloorChange({ parsed: parsedFrom(l, 6), live: l });
    expect(r.safe).toBe(true);
    expect(r.removed).toHaveLength(6);
    expect(r.reason).toBe("ok");
  });

  it("passes a 50-of-1148 cleanup", () => {
    const l = live(1148);
    expect(assessFloorChange({ parsed: parsedFrom(l, 50), live: l }).safe).toBe(true);
  });

  it("blocks a 1148 -> 3 collapse", () => {
    const l = live(1148);
    const r = assessFloorChange({ parsed: parsedFrom(l, 1145), live: l });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("row_collapse");
  });

  it("blocks a filter-left-applied collapse to one DS's worth of rows", () => {
    const l = live(1148);
    const r = assessFloorChange({ parsed: parsedFrom(l, 948), live: l });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("row_collapse");
  });

  it("names added, removed and changed SKUs so a small edit is visible, not merely allowed", () => {
    const r = assessFloorChange({
      live: { KEEP: { DS01: { min: 1, max: 2 } }, GONE: { DS01: { min: 1, max: 2 } }, MOVED: { DS01: { min: 1, max: 2 } } },
      parsed: { KEEP: { DS01: { min: 1, max: 2 } }, MOVED: { DS01: { min: 2, max: 5 } }, FRESH: { DS02: { min: 1, max: 1 } } },
      maxDropPct: 100,
    });
    expect(r.added).toEqual(["FRESH"]);
    expect(r.removed).toEqual(["GONE"]);
    expect(r.changed).toEqual(["MOVED"]);
  });

  it("treats an empty live map as first run, not as a 100% collapse", () => {
    const r = assessFloorChange({ parsed: { A: {} }, live: {} });
    expect(r.safe).toBe(true);
    expect(r.reason).toBe("first_run");
  });

  it("blocks an empty parse against a populated live map", () => {
    const r = assessFloorChange({ parsed: {}, live: live(1148) });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("row_collapse");
  });
});

describe("assessFloorChange — a row count that never moves must not hide a mass removal", () => {
  // Ops removes a floor EITHER by deleting the row OR by setting it to 0,0. The
  // second keeps the SKU key, so a guard on key count alone reads dropPct 0 and
  // waves through a bad formula that zeroed every value column. Hence the second
  // dimension: SKUs actually CARRYING a floor.
  const withFloor = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`SKU${i}`, { DS01: { min: 1, max: 2 } }]));
  const zeroed = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`SKU${i}`, {}]));

  it("blocks a mass-zeroing that keeps every row — the blind spot", () => {
    const r = assessFloorChange({ parsed: zeroed(1148), live: withFloor(1148) });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("floor_collapse");
    expect(r.liveWithFloors).toBe(1148);
    expect(r.parsedWithFloors).toBe(0);
    expect(r.dropPct).toBe(0); // key count never moved — which is the whole point
  });

  it("passes ops zeroing 33 floors of 1148", () => {
    const parsed = withFloor(1148);
    for (const s of Object.keys(parsed).slice(0, 33)) parsed[s] = {};
    const r = assessFloorChange({ parsed, live: withFloor(1148) });
    expect(r.safe).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.changed).toHaveLength(33);
    expect(r.floorDropPct).toBeCloseTo(2.87, 1);
  });

  it("passes ops deleting 33 rows of 1148", () => {
    const l = withFloor(1148);
    const parsed = Object.fromEntries(Object.entries(l).slice(0, 1115));
    const r = assessFloorChange({ parsed, live: l });
    expect(r.safe).toBe(true);
    expect(r.removed).toHaveLength(33);
    expect(r.parsedWithFloors).toBe(1115);
  });

  it("does not block when live carried no floors at all", () => {
    // No baseline to collapse from; must not divide by zero and refuse forever.
    const r = assessFloorChange({ parsed: zeroed(5), live: zeroed(5) });
    expect(r.safe).toBe(true);
    expect(r.floorDropPct).toBe(0);
  });
});
