import { describe, it, expect } from "vitest";
import { runEngine } from "../index.js";
import { DEFAULT_PARAMS, PLYWOOD_NETWORK_CONFIG_DEFAULT, DS_LIST } from "../constants.js";

// Dead Stock means Min=Max=0 at every DS and the DC, overriding every floor. It is
// a structural constraint, not a target, so no other rule may outrank it.
//
// ⚠⚠ THE RULE IS ENFORCED ONCE, OVER THE FINISHED `stores` MAP — not inline in each
// branch. `runEngine` writes `stores[dsId]` from FOUR places: the per-DS loop's
// HAS-DATA path, its three NO-DATA sub-branches (which `return` early), and the
// Network Design bypass, which builds its own `_stores` entirely separately.
//
// It used to be applied inline in three of those four. The one it missed was
// NO-DATA-with-a-manual-floor at a store outside `newDSList`. Found in production
// 2026-08-26: 4BK45, EDUNK, RYNJT, RU5YU, WUZUF and Y8SCD each carried a 1/1 floor
// at all six stores and read 1/1 at DS01 and DS02 while correctly reading 0/0 at
// DS03-DS06 — the four stores that ARE in newDSList and so took a branch that did
// carry the check. Same SKU, same floor, different code path, different answer.
// Rs0.86L, and DC 0/0 beside it, which is an incoherent state the TO tool acts on.
//
// Identical in shape to the SKU Ceiling four-writers bug of 2026-08-15, which
// CLAUDE.md predicted in writing: "Four copies of a clamp would have been the same
// bug waiting to recur." Dead Stock had three copies and one omission.
//
// The tell, both times: the main loop's stores carry `postBlendSteps: []`, the
// NO-DATA branches never create the key at all. A DIFFERING SHAPE MEANS A
// DIFFERENT CODE PATH — the fastest way to find this class of bug in this engine.

const DEAD = "DEADSKU";
const FILL = "FILLER"; // carries the date universe so allDates is populated

const master = (extra = {}) => ({
  [DEAD]: { sku: DEAD, name: "Dead thing", category: "Cement", brand: "X", status: "active", inventorisedAt: "DC" },
  [FILL]: { sku: FILL, name: "Live thing", category: "Cement", brand: "X", status: "active", inventorisedAt: "DC" },
  ...extra,
});

const dates = Array.from({ length: 25 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`);
// FILLER sells at DS05 throughout. DEADSKU's own sales are added per-test.
const baseInv = () => dates.map((date, i) => ({
  date, ds: "DS05", pin: "560005", qty: 3, shopifyOrder: `f${i}`, sku: FILL,
}));

// DS01/DS02 deliberately OUTSIDE newDSList — the live value is ["DS04","DS05","DS06","DS03"],
// which is why the production leak landed on exactly DS01 and DS02.
const params = (over = {}) => ({
  ...DEFAULT_PARAMS, overallPeriod: 45, newDSList: ["DS03", "DS04", "DS05", "DS06"],
  newDSFloorTopN: 250, dsSeed: {}, ...over,
});

const floorEverywhere = { [DEAD]: Object.fromEntries(DS_LIST.map((ds) => [ds, { min: 1, max: 1 }])) };

const run = (inv, nsq, p = params(), mrq = {}) =>
  runEngine(inv, master(), mrq, {}, new Set([DEAD]), nsq, p, {});

describe("Dead Stock zeroes every store, whatever branch built it", () => {
  it("⚠ REGRESSION: a floored store with NO demand, outside newDSList (the production bug)", () => {
    // The exact shape of all six leaked SKUs: floor 1/1, zero sales at that store,
    // store not in newDSList. This is the branch that had no isDead check.
    const res = run(baseInv(), floorEverywhere)[DEAD];
    expect(res.stores.DS01).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
    expect(res.stores.DS02).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
  });

  it("zeroes EVERY store and the DC, on one SKU floored at all six", () => {
    const res = run(baseInv(), floorEverywhere)[DEAD];
    for (const ds of DS_LIST) {
      expect({ ds, ...{ min: res.stores[ds].min, max: res.stores[ds].max } })
        .toEqual({ ds, min: 0, max: 0 });
    }
    expect({ min: res.dc.min, max: res.dc.max }).toEqual({ min: 0, max: 0 });
  });

  it("no store disagrees with any other — the invariant the leak broke", () => {
    // The production symptom was not "a wrong number" but TWO ANSWERS for one SKU:
    // 1/1 at DS01-DS02, 0/0 at DS03-DS06, from an identical floor.
    const res = run(baseInv(), floorEverywhere)[DEAD];
    const distinct = new Set(DS_LIST.map((ds) => `${res.stores[ds].min}/${res.stores[ds].max}`));
    expect([...distinct]).toEqual(["0/0"]);
  });

  it("still zeroes a floored store INSIDE newDSList (branch that already worked)", () => {
    const res = run(baseInv(), floorEverywhere)[DEAD];
    expect(res.stores.DS03).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
  });

  it("still zeroes a store WITH demand (the has-data branch)", () => {
    const inv = baseInv().concat(dates.map((date, i) => ({
      date, ds: "DS01", pin: "560001", qty: 10, shopifyOrder: `d${i}`, sku: DEAD,
    })));
    const res = run(inv, floorEverywhere)[DEAD];
    expect(res.stores.DS01).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
    expect(res.stores.DS01.nonZeroDays).toBeGreaterThan(0); // guards the fixture
  });

  it("still zeroes a new-DS store held up by minReqQty (the new-DS branch)", () => {
    const res = run(baseInv(), {}, params(), { [DEAD]: 8 })[DEAD];
    expect(res.stores.DS03).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
  });

  it("beats a floor that would otherwise WIN — floors only ever raise", () => {
    // Without the dead flag this same floor produces 1/1, so the assertion is about
    // the cap and not about the floor being ignored for some other reason.
    const live = runEngine(baseInv(), master(), {}, {}, new Set(), floorEverywhere, params(), {});
    expect(live[DEAD].stores.DS01).toMatchObject({ min: 1, max: 1, logicTag: "SKU Floor" });
  });

  it("leaves a NON-dead SKU completely untouched", () => {
    const res = run(baseInv(), floorEverywhere)[FILL];
    expect(res.stores.DS05.max).toBeGreaterThan(0);
  });
});

// The Network Design bypass builds its own `_stores` and its own DC, and is the
// path that was silently missed for half a day by the ceiling fix.
describe("Dead Stock on the Network Design (plywood) path", () => {
  const PLY = "PLYDEAD";
  const CAT = "Plywood, MDF & HDHMR";
  const plyMaster = () => ({
    [PLY]: { sku: PLY, name: "ArchidPly 18mm", category: CAT, brand: "ArchidPly", status: "active", inventorisedAt: "DC" },
  });
  const plyInv = () => dates.map((date, i) => ({
    date, ds: "DS01", pin: "560001", qty: 6, shopifyOrder: `n${i}`, sku: PLY,
  }));
  const plyParams = () => ({
    ...params(),
    categoryStrategies: { [CAT]: "network_design" },
    plywoodNetworkConfig: {
      ...PLYWOOD_NETWORK_CONFIG_DEFAULT,
      brands: { ArchidPly: { nodes: { DS01: { covers: ["DS01"] } }, dcMultMin: 0.75, dcMultMax: 1.0 } },
    },
  });

  it("routes through the network path at all (guards the fixture)", () => {
    const live = runEngine(plyInv(), plyMaster(), {}, {}, new Set(), {}, plyParams(), {})[PLY];
    expect(live.stores.DS01.strategyTag).toBe("network_design");
    expect(live.stores.DS01.max).toBeGreaterThan(0);
  });

  it("zeroes a network-design store and its DC", () => {
    const res = runEngine(plyInv(), plyMaster(), {}, {}, new Set([PLY]), {}, plyParams(), {})[PLY];
    expect(res.stores.DS01).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
    expect({ min: res.dc.min, max: res.dc.max }).toEqual({ min: 0, max: 0 });
  });

  it("zeroes a network-design store that a SKU floor had lifted", () => {
    const nsq = { [PLY]: { DS01: { min: 9, max: 12 } } };
    const res = runEngine(plyInv(), plyMaster(), {}, {}, new Set([PLY]), nsq, plyParams(), {})[PLY];
    expect(res.stores.DS01).toMatchObject({ min: 0, max: 0, logicTag: "Dead Stock" });
    expect({ min: res.dc.min, max: res.dc.max }).toEqual({ min: 0, max: 0 });
  });
});
