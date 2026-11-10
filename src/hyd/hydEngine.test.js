import { describe, it, expect } from "vitest";
import { DEFAULT_PARAMS } from "../engine/constants.js";
import { buildHydPlywoodFromBangalore } from "./hydParams.js";
import {
  hydPurchaseOf, bufferTargets, runHydEngine, hydEngineRows, HYD_PAD_SKU,
} from "./hydEngine.js";

// 50 consecutive network dates, oldest first.
const DATES = Array.from({ length: 50 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8, 1 + i));
  return d.toISOString().slice(0, 10);
});
const WINDOW = DATES.slice(-45);

const sku = (id, over = {}) => ({
  sku: id, name: id, category: "General Hardware", brand: "X",
  status: "Active", inventorisedAt: "DS", purchase: "", move: "", ...over,
});

const patiRows = (id, qtyPerDay, dates = WINDOW) =>
  dates.map(date => ({ sku: id, ds: "HYDS01", date, qty: qtyPerDay }));

// A Bangalore row on every network date, so the network window is all 50 dates.
const networkRows = () => DATES.map(date => ({ sku: "BLR-ONLY", ds: "DS02", date, qty: 1 }));

const params = (over = {}) => ({
  ...DEFAULT_PARAMS, overallPeriod: 45, categoryStrategies: {},
  brandLeadTimeDays: { _default: 3, "Asian Paints": 4 }, orderCycleDays: 3,
  floorsOnly: { HYDS01: true }, ...over,
});

const engineMode = (over = {}) => params({ floorsOnly: { HYDS01: false }, ...over });

const NO_PLY = { plywoodNetworkConfig: { brands: {} }, networkConfigs: { HYDS01: { thick: { capacity: 300 }, thin: { capacity: 150 } } } };

const run = ({ inv, master, floors = {}, hydParams = params(), deadStock = new Set(), hydPlywood = NO_PLY, priceData = {} }) =>
  runHydEngine({ invoiceData: inv, skuMaster: master, priceData, deadStock, floors, hydParams, hydPlywood });

describe("bufferTargets", () => {
  it("adds the lead-time buffer, then sizes Max off the post-buffer Min", () => {
    expect(bufferTargets({ min: 2, max: 3 }, 0.5, 3, 3)).toEqual({ min: 4, max: 6 });
    expect(bufferTargets({ min: 5, max: 20 }, 0.5, 3, 3)).toEqual({ min: 7, max: 22 });
  });
});

describe("hydPurchaseOf (spec §3.6 table)", () => {
  const master = {
    A: sku("A", { purchase: "OFF" }),
    I: sku("I", { status: "Inactive" }),
    N: sku("N", { purchase: "OFF" }),
    Y: sku("Y", { purchase: "ON" }),
  };
  const floors = { A: { HYDS01: { min: 2, max: 4 } }, I: { HYDS01: { min: 2, max: 4 } } };

  it("inactive in Zoho -> No, regardless of floor", () => {
    expect(hydPurchaseOf("I", { skuMaster: master, floors, floorsOnly: false })).toBe("No");
  });
  it("has a Hyderabad floor row -> Yes (the sheet wins over Purchase=OFF)", () => {
    expect(hydPurchaseOf("A", { skuMaster: master, floors, floorsOnly: false })).toBe("Yes");
  });
  it("no floor row, floors-only -> No", () => {
    expect(hydPurchaseOf("Y", { skuMaster: master, floors, floorsOnly: true })).toBe("No");
  });
  it("no floor row, after the flip -> Zoho's value normalised", () => {
    expect(hydPurchaseOf("N", { skuMaster: master, floors, floorsOnly: false })).toBe("No");
    expect(hydPurchaseOf("Y", { skuMaster: master, floors, floorsOnly: false })).toBe("Yes");
  });
});

describe("runHydEngine — floors-only (launch)", () => {
  it("floors-only target equals the floor", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("A", 1).slice(0, 30)],
      master: { A: sku("A") },
      floors: { A: { HYDS01: { min: 2, max: 5 } } },
    });
    const s = results.A.stores.HYDS01;
    expect({ min: s.min, max: s.max }).toEqual({ min: 2, max: 5 });
    expect(s.logicTag).toBe("Hyd Floor");
    expect(s.source).toBe("floor");
    expect(results.A.dc).toEqual({ min: 0, max: 0 });
  });

  it("floors-only, sold but no floor → 0/0", () => {
    const { results, report } = run({
      inv: [...networkRows(), ...patiRows("B", 3)],
      master: { B: sku("B") },
    });
    const s = results.B.stores.HYDS01;
    expect({ min: s.min, max: s.max }).toEqual({ min: 0, max: 0 });
    expect(s.logicTag).toBe("Out of range");
    expect(s.engineMax).toBeGreaterThan(0); // the "would be" engine number is still computed
    expect(report.outOfRangeSales).toContain("B");
  });

  it("missing floorsOnly setting means floors-only", () => {
    const { floorsOnly, ...rest } = params();
    void floorsOnly;
    const { results } = run({ inv: [...networkRows(), ...patiRows("B", 3)], master: { B: sku("B") }, hydParams: rest });
    expect(results.B.stores.HYDS01.max).toBe(0);
  });
});

describe("runHydEngine — engine mode (after the flip)", () => {
  it("engine mode lifts above the floor", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("A", 10)],
      master: { A: sku("A") },
      floors: { A: { HYDS01: { min: 1, max: 2 } } },
      hydParams: engineMode(),
    });
    const s = results.A.stores.HYDS01;
    // rate = 450 / 45 = 10/day; lead time 3 → +30 on Min; cycle 3 → Max ≥ Min + 30.
    expect(s.dailyAvg).toBe(10);
    expect(s.rawEngineMin).toBeGreaterThan(0);
    expect(s.engineMin).toBe(s.rawEngineMin + 30);
    expect(s.engineMax).toBeGreaterThanOrEqual(s.engineMin + 30);
    expect(s.min).toBeGreaterThanOrEqual(Math.max(1, s.engineMin));
    expect(s.max).toBeGreaterThanOrEqual(Math.max(2, s.engineMax));
    expect(s.logicTag).toBe("Hyd Engine");
  });

  it("a floor above the buffered engine number wins", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("A", 1, WINDOW.slice(-3))],
      master: { A: sku("A") },
      floors: { A: { HYDS01: { min: 40, max: 80 } } },
      hydParams: engineMode(),
    });
    const s = results.A.stores.HYDS01;
    expect({ min: s.min, max: s.max }).toEqual({ min: 40, max: 80 });
    expect(s.logicTag).toBe("Hyd Floor (beats engine)");
  });

  const flagCases = [
    ["Purchase=OFF", sku("F", { purchase: "OFF" }), new Set()],
    ["Supplier", sku("F", { inventorisedAt: "Supplier" }), new Set()],
    ["Dead Stock", sku("F"), new Set(["F"])],
  ];
  for (const [reason, meta, dead] of flagCases) {
    it(`floor beats ${reason}`, () => {
      const { results, report } = run({
        inv: networkRows(), master: { F: meta }, deadStock: dead,
        floors: { F: { HYDS01: { min: 3, max: 6 } } }, hydParams: engineMode(),
      });
      const s = results.F.stores.HYDS01;
      expect({ min: s.min, max: s.max }).toEqual({ min: 3, max: 6 });
      expect(report.overrides).toContainEqual({ sku: "F", reason });
    });
  }

  it("floor beats a flag in floors-only mode too, and is reported", () => {
    const { results, report } = run({
      inv: networkRows(), master: { F: sku("F", { purchase: "OFF" }) },
      floors: { F: { HYDS01: { min: 3, max: 6 } } },
    });
    expect(results.F.stores.HYDS01.max).toBe(6);
    expect(report.overrides).toContainEqual({ sku: "F", reason: "Purchase=OFF" });
  });

  it("engine mode, no floor and no Pati sales → No demand", () => {
    const { results } = run({ inv: networkRows(), master: { Q: sku("Q") }, hydParams: engineMode() });
    expect(results.Q.stores.HYDS01).toMatchObject({ min: 0, max: 0, logicTag: "No demand", source: "none" });
  });

  it("engine-only SKU with Purchase=OFF → 0/0", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("P", 10)],
      master: { P: sku("P", { purchase: "OFF" }) }, hydParams: engineMode(),
    });
    const s = results.P.stores.HYDS01;
    expect({ min: s.min, max: s.max }).toEqual({ min: 0, max: 0 });
    expect(s.engineMax).toBeGreaterThan(0);
    expect(s.logicTag).toBe("Flag: Purchase=OFF");
  });

  it("engine-only Supplier and Dead Stock SKUs → 0/0", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("S", 10), ...patiRows("D", 10)],
      master: { S: sku("S", { inventorisedAt: "Supplier" }), D: sku("D") },
      deadStock: new Set(["D"]), hydParams: engineMode(),
    });
    expect(results.S.stores.HYDS01.max).toBe(0);
    expect(results.S.stores.HYDS01.logicTag).toBe("Flag: Supplier");
    expect(results.D.stores.HYDS01.max).toBe(0);
    expect(results.D.stores.HYDS01.logicTag).toBe("Flag: Dead Stock");
  });

  it("a DC-inventorised SKU still gets a Pati target (no Hyderabad DC)", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("C", 10)],
      master: { C: sku("C", { inventorisedAt: "DC", move: "No" }) }, hydParams: engineMode(),
    });
    expect(results.C.stores.HYDS01.min).toBeGreaterThan(0);
    expect(results.C.meta.inventorisedAt).toBe("DC"); // original meta, not the neutralised clone
  });
});

describe("runHydEngine — rules for both modes", () => {
  for (const [label, hp] of [["floors-only", params()], ["engine", engineMode()]]) {
    it(`inactive with floor → 0/0 (${label})`, () => {
      const { results, report } = run({
        inv: [...networkRows(), ...patiRows("I", 10)],
        master: { I: sku("I", { status: "Inactive" }) },
        floors: { I: { HYDS01: { min: 3, max: 6 } } }, hydParams: hp,
      });
      const s = results.I.stores.HYDS01;
      expect({ min: s.min, max: s.max }).toEqual({ min: 0, max: 0 });
      expect(s.logicTag).toBe("Inactive in Zoho");
      expect(report.inactiveFloored).toEqual(["I"]);
      expect(report.overrides).toEqual([]);
    });
  }

  it("window follows network dates", () => {
    // Pati sold only on the 2 oldest of 50 network dates; overallPeriod 45 excludes them.
    const { results, report } = run({
      inv: [...networkRows(), ...patiRows("W", 50, DATES.slice(0, 2))],
      master: { W: sku("W") }, hydParams: engineMode(),
    });
    const s = results.W.stores.HYDS01;
    expect(s.dailyAvg).toBe(0);
    expect({ min: s.min, max: s.max }).toEqual({ min: 0, max: 0 });
    expect(report.outOfRangeSales).not.toContain("W");
  });

  it("the engine sees every network window date, not only Pati's sale days", () => {
    const inv = [...networkRows(), ...patiRows("A", 4, WINDOW.slice(-5))];
    const rows = hydEngineRows(inv, WINDOW);
    expect([...new Set(rows.map(r => r.date))].sort().slice(-45)).toEqual(WINDOW);
    expect(rows.every(r => r.ds !== "HYDS01")).toBe(true);
    expect(rows.filter(r => r.sku === HYD_PAD_SKU).every(r => r.qty === 0)).toBe(true);
    expect(rows.filter(r => r.sku === "A").every(r => r.ds === "DS01")).toBe(true);
    expect(rows.some(r => r.sku === "BLR-ONLY")).toBe(false);
  });

  it("ignores Bangalore rows", () => {
    const base = [...networkRows(), ...patiRows("A", 10)];
    const blr = WINDOW.map(date => ({ sku: "A", ds: "DS01", date, qty: 99 }));
    const args = { master: { A: sku("A") }, floors: { A: { HYDS01: { min: 1, max: 2 } } }, hydParams: engineMode() };
    expect(run({ inv: [...base, ...blr], ...args })).toEqual(run({ inv: base, ...args }));
  });

  it("a master row with no status field counts as active", () => {
    const { status, ...noStatus } = sku("A");
    void status;
    const { results, report } = run({
      inv: networkRows(), master: { A: noStatus }, floors: { A: { HYDS01: { min: 2, max: 4 } } },
    });
    expect(results.A.stores.HYDS01).toMatchObject({ min: 2, max: 4, logicTag: "Hyd Floor" });
    expect(report.inactiveFloored).toEqual([]);
    expect(hydPurchaseOf("A", { skuMaster: { A: noStatus }, floors: {}, floorsOnly: false })).toBe("Yes");
  });

  it("a SKU absent from the master gets no target and Purchase No", () => {
    const { results } = run({ inv: [...networkRows(), ...patiRows("GONE", 10)], master: { A: sku("A") }, hydParams: engineMode() });
    expect(results.GONE).toBeUndefined();
    expect(hydPurchaseOf("GONE", { skuMaster: { A: sku("A") }, floors: { GONE: { HYDS01: { min: 1, max: 2 } } }, floorsOnly: false })).toBe("No");
  });

  it("pad rows never appear in results or the report", () => {
    const { results, report } = run({ inv: [...networkRows(), ...patiRows("A", 2)], master: { A: sku("A") }, hydParams: engineMode() });
    expect(results[HYD_PAD_SKU]).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(HYD_PAD_SKU);
  });

  it("unknown sku gets no target", () => {
    const { results, report } = run({
      inv: networkRows(), master: { A: sku("A") },
      floors: { ZZZ: { HYDS01: { min: 2, max: 4 } } },
    });
    expect(results.ZZZ).toBeUndefined();
    expect(report.unknownFloorSkus).toEqual(["ZZZ"]);
    expect(results[HYD_PAD_SKU]).toBeUndefined();
  });

  it("results hold every master SKU and only master SKUs", () => {
    const { results } = run({
      inv: [...networkRows(), ...patiRows("ORPHAN", 5)], master: { A: sku("A"), B: sku("B") },
    });
    expect(Object.keys(results).sort()).toEqual(["A", "B"]);
  });

  it("Max is never below Min", () => {
    const { results } = run({
      inv: networkRows(), master: { A: sku("A") }, floors: { A: { HYDS01: { min: 5, max: 2 } } },
    });
    expect(results.A.stores.HYDS01.max).toBeGreaterThanOrEqual(results.A.stores.HYDS01.min);
  });
});

describe("runHydEngine — plywood", () => {
  const PLY = "Plywood, MDF & HDHMR";
  const blrCfg = {
    lookbackDays: 90,
    brands: { Century: { nodes: { DC: { covers: ["DC"] }, DS01: { covers: ["DS01"] } }, dcMultMin: 0.5, dcMultMax: 1 } },
  };
  const hydPlywood = buildHydPlywoodFromBangalore(blrCfg, { DS07: { thick: { capacity: 1 }, thin: { capacity: 1 } } });

  it("plywood has no DC", () => {
    const qtys = [3, 4, 5, 3, 4, 6, 3, 4, 5, 4];
    const inv = [...networkRows(), ...WINDOW.map((date, i) => ({ sku: "PLY1", ds: "HYDS01", date, qty: qtys[i % qtys.length] }))];
    const { results } = run({
      inv, master: { PLY1: sku("PLY1", { category: PLY, brand: "Century", inventorisedAt: "DC" }) },
      hydParams: engineMode({ categoryStrategies: { [PLY]: "network_design" } }), hydPlywood,
    });
    const r = results.PLY1;
    expect(r.dc).toEqual({ min: 0, max: 0 });
    expect(r.stores.HYDS01.strategyTag).toBe("network_design");
    expect(r.stores.HYDS01.rawEngineMin).toBeGreaterThan(0);
    expect(r.stores.HYDS01.min).toBeGreaterThanOrEqual(r.stores.HYDS01.rawEngineMin);
  });
});
