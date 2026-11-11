import { describe, it, expect } from "vitest";
import { buildHydPlywoodRows, capacityState, HYD_PLYWOOD_EMPTY } from "./hydPlywoodRows.js";

const PLY = "Plywood, MDF & HDHMR";
const m = (sku, name, over = {}) => ({ sku, name, category: PLY, brand: "Greenply", status: "Active", ...over });
const store = (min, max, over = {}) => ({ stores: { HYDS01: { min, max, logicTag: "Hyd Engine", engineMin: min, engineMax: max, ...over } } });

const skuMaster = {
  THICK18: m("THICK18", "Greenply BWP 18 mm 8x4"),
  THIN6: m("THIN6", "Greenply MR 6mm 8x4"),
  LAM: m("LAM", "Laminate 1mm"),
  NOMM: m("NOMM", "Greenply flexi board"),
  FLOORONLY: m("FLOORONLY", "Century 12 mm"),
  SOLD: m("SOLD", "Century 4 mm"),
  OLDSALE: m("OLDSALE", "Century 25 mm"),
  NOTHING: m("NOTHING", "Century 19 mm"),
  CEMENT: m("CEMENT", "Cement 50kg", { category: "Cement" }),
};
const results = {
  THICK18: store(3, 6),
  THIN6: store(2, 4),
  LAM: store(1, 2),
  NOMM: store(1, 3),
  FLOORONLY: store(0, 0, { logicTag: "Out of range" }),
  SOLD: store(0, 0, { logicTag: "No demand" }),
  OLDSALE: store(0, 0),
  NOTHING: store(0, 0),
  CEMENT: store(5, 9),
};
const floors = { FLOORONLY: { HYDS01: { min: 1, max: 2 } }, CEMENT: { HYDS01: { min: 1, max: 1 } } };
const invoiceData = [
  { sku: "SOLD", ds: "HYDS01", date: "2026-11-01", qty: 2 },
  { sku: "OLDSALE", ds: "HYDS01", date: "2026-01-01", qty: 5 }, // before the lookback
  { sku: "NOTHING", ds: "DS01", date: "2026-11-02", qty: 9 },   // Bangalore sale, not Pati
  { sku: "X", ds: "DS02", date: "2026-11-10", qty: 1 },          // network latest date
];
const base = { skuMaster, results, floors, invoiceData, thickBoundaryMm: 9, lookbackDays: 90, floorsOnly: false };

describe("row inclusion", () => {
  const { rows } = buildHydPlywoodRows(base);
  const ids = rows.map(r => r.sku);
  it("plywood with a target, a floor, or Pati sales in the lookback", () => {
    expect(ids).toEqual(expect.arrayContaining(["THICK18", "THIN6", "LAM", "NOMM", "FLOORONLY", "SOLD"]));
  });
  it("excludes non-plywood, sales older than the lookback, Bangalore-only sales", () => {
    expect(ids).not.toContain("CEMENT");
    expect(ids).not.toContain("OLDSALE");
    expect(ids).not.toContain("NOTHING");
  });
  it("sorted by final Max desc, then SKU", () => {
    expect(ids).toEqual(["THICK18", "THIN6", "NOMM", "LAM", "FLOORONLY", "SOLD"]);
  });
  it("carries floor, engine, final and logic tag", () => {
    const f = rows.find(r => r.sku === "FLOORONLY");
    expect(f).toMatchObject({ name: "Century 12 mm", brand: "Greenply", mm: 12, thickness: "Thick",
      floorMin: 1, floorMax: 2, finalMin: 0, finalMax: 0, logicTag: "Out of range" });
    expect(rows.find(r => r.sku === "SOLD").patiQty).toBe(2);
    expect(rows.find(r => r.sku === "THICK18")).toMatchObject({ engineMin: 3, engineMax: 6, finalMin: 3, finalMax: 6, floorMin: null, floorMax: null });
  });
});

describe("thick / thin split", () => {
  it("uses the boundary: > boundary is Thick, ≤ is Thin, ≤1mm Laminate, no mm Unknown", () => {
    const { rows } = buildHydPlywoodRows(base);
    const t = Object.fromEntries(rows.map(r => [r.sku, r.thickness]));
    expect(t).toMatchObject({ THICK18: "Thick", THIN6: "Thin", LAM: "Laminate", NOMM: "Unknown", FLOORONLY: "Thick", SOLD: "Thin" });
  });
  it("moving the boundary moves the split", () => {
    const { rows } = buildHydPlywoodRows({ ...base, thickBoundaryMm: 12 });
    expect(rows.find(r => r.sku === "FLOORONLY").thickness).toBe("Thin");
  });
});

describe("capacity used (Bangalore: Σ final Max; thin = not Thick, laminates excluded)", () => {
  it("sums final Max per bucket", () => {
    const { capacity } = buildHydPlywoodRows(base);
    expect(capacity).toEqual({ thick: 6, thin: 4 + 3 }); // THIN6 + NOMM (Unknown counts thin); LAM excluded
  });
  it("unknown when there are no engine results", () => {
    const { rows, capacity } = buildHydPlywoodRows({ ...base, results: null });
    expect(capacity).toEqual({ thick: null, thin: null });
    expect(rows.find(r => r.sku === "FLOORONLY").finalMax).toBeNull();
    expect(rows.map(r => r.sku)).toEqual(["FLOORONLY", "SOLD"]);
  });
});

describe("floors-only mode", () => {
  it("engine figures are blanked", () => {
    const { rows } = buildHydPlywoodRows({ ...base, floorsOnly: true });
    expect(rows.find(r => r.sku === "THICK18")).toMatchObject({ engineMin: null, engineMax: null, finalMax: 6 });
  });
});

describe("empty state", () => {
  it("no rows when nothing is in Pati's range", () => {
    const { rows, capacity } = buildHydPlywoodRows({ ...base, results: {}, floors: {}, invoiceData: [] });
    expect(rows).toEqual([]);
    expect(capacity).toEqual({ thick: 0, thin: 0 });
    expect(HYD_PLYWOOD_EMPTY).toBe("No plywood SKUs in Pati's range yet — add plywood rows to the Hyderabad floor sheet, or switch Pati to Engine.");
  });
  it("tolerates missing inputs", () => {
    expect(buildHydPlywoodRows({}).rows).toEqual([]);
  });
});

describe("capacityState (Bangalore's inline bar thresholds)", () => {
  it("ok / at limit / over", () => {
    expect(capacityState(100, 100)).toMatchObject({ pct: 100, level: "ok" });
    expect(capacityState(105, 100)).toMatchObject({ level: "atLimit" });
    expect(capacityState(111, 100)).toMatchObject({ level: "over" });
  });
  it("no cap or unknown use", () => {
    expect(capacityState(5, 0)).toMatchObject({ level: "noCap" });
    expect(capacityState(null, 100)).toMatchObject({ level: "unknown" });
  });
});
