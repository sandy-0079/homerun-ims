import { describe, it, expect } from "vitest";
import { DEFAULT_PARAMS } from "../engine/constants.js";
import {
  HYD_HIDDEN_KEYS, buildHydParamsFromBangalore, mergeHydParams, isFloorsOnly, buildHydPlywoodFromBangalore,
} from "./hydParams.js";

const blr = () => ({
  ...structuredClone(DEFAULT_PARAMS),
  newDSList: ["DS06"], openingDSList: [], pincodeConfig: { a: 1 }, dsCapacities: { DS01: 1 },
  plywoodNetworkConfig: { x: 1 }, plywoodNetworkV2Config: { y: 1 }, activeDSCount: 8,
  pctDocCap: 30, categoryStrategies: { Plywood: "NetworkDesign" }, brandLeadTimeDays: { _default: 3, "Asian Paints": 4 },
});
const cap = (c) => ({ capacity: c, tier1NZD: 6, tier2NZD: 2, bufferPct: 20, coverDays: 3, minCoverDays: 1.5, thresholdPctl: 75 });
const plyCfg = () => {
  const brand = () => ({ nodes: { DS01: { covers: ["DS01"] }, DC: { covers: ["DS02"] }, DS08: { covers: ["DS08"] } }, dcMultMin: 0.75, dcMultMax: 1 });
  return {
    brands: { GreenPly: brand(), ArchidPly: brand(), CenturyPly: brand(), "Action Tesa": brand() },
    maxCap: 20, minNZD: 2, sparseNZD: 5, dcCapacity: { thin: 600, thick: 1200 }, lookbackDays: 45,
    abqMultiplier: 1.25, minPercentile: 95, thickBoundaryMm: 9, bulkMaxThreshold: 10, spikeCapMultiplier: 4, maxBufferPercentile: 45,
  };
};
const netCfg = () => ({
  DS01: { thin: cap(200), thick: cap(200), shared: { laminateThreshold: 1 }, fallbackLabel: "Om Timber" },
  DS07: { thin: cap(150), thick: cap(300) },
  DS08: { thin: cap(150), thick: cap(300) },
  global: { thickBoundaryMm: 9 },
});

describe("buildHydParamsFromBangalore", () => {
  it("drops hidden keys, keeps the rest deep-equal, adds hyd keys", () => {
    const src = blr();
    const h = buildHydParamsFromBangalore(src, "2026-11-10T00:00:00Z");
    for (const k of HYD_HIDDEN_KEYS) expect(h).not.toHaveProperty(k);
    expect(h.pctDocCap).toBe(src.pctDocCap);
    expect(h.categoryStrategies).toEqual(src.categoryStrategies);
    expect(h.brandLeadTimeDays).toEqual(src.brandLeadTimeDays);
    expect(h.floorsOnly).toEqual({ HYDS01: true });
    expect(h.orderCycleDays).toBe(3);
    expect(h.copiedFromBangaloreAt).toBe("2026-11-10T00:00:00Z");
  });
  it("is a deep copy", () => {
    const src = blr();
    const h = buildHydParamsFromBangalore(src, "t");
    h.brandLeadTimeDays["Asian Paints"] = 99;
    h.fixedUnitFloor.maxAdditive = 99;
    expect(src.brandLeadTimeDays["Asian Paints"]).toBe(4);
    expect(src.fixedUnitFloor.maxAdditive).toBe(DEFAULT_PARAMS.fixedUnitFloor.maxAdditive);
    expect(src.newDSList).toEqual(["DS06"]);
  });
});

describe("floorsOnly", () => {
  it("missing floorsOnly means floors-only", () => {
    expect(isFloorsOnly({}, "HYDS01")).toBe(true);
    expect(isFloorsOnly(null, "HYDS01")).toBe(true);
    expect(isFloorsOnly({ floorsOnly: { HYDS01: false } }, "HYDS01")).toBe(false);
  });
  it("mergeHydParams keeps default floorsOnly when stored is empty", () => {
    const d = { a: 1, floorsOnly: { HYDS01: true } };
    expect(mergeHydParams(d, { floorsOnly: {} }).floorsOnly).toEqual({ HYDS01: true });
    expect(mergeHydParams(d, null).floorsOnly).toEqual({ HYDS01: true });
    expect(mergeHydParams(d, { a: 2, floorsOnly: { HYDS01: false } })).toEqual({ a: 2, floorsOnly: { HYDS01: false } });
  });
});

describe("buildHydPlywoodFromBangalore", () => {
  it("gives 4 brands with only a HYDS01 node, no DC", () => {
    const { plywoodNetworkConfig: p } = buildHydPlywoodFromBangalore(plyCfg(), netCfg());
    expect(Object.keys(p.brands)).toHaveLength(4);
    for (const b of Object.values(p.brands)) {
      expect(Object.keys(b.nodes)).toEqual(["HYDS01"]);
      expect(b.nodes.HYDS01).toEqual({ covers: ["HYDS01"] });
      expect(b.dcMultMin).toBe(0.75);
      expect(b.dcMultMax).toBe(1);
    }
    expect(p.maxCap).toBe(20);
    expect(p.dcCapacity).toEqual({ thin: 600, thick: 1200 });
    expect(p.lookbackDays).toBe(45);
  });
  it("sets capacity 300/150 and copies DS07 settings otherwise", () => {
    const n = netCfg();
    n.DS07.thick.capacity = 111; n.DS07.thin.capacity = 222;
    const { networkConfigs: c } = buildHydPlywoodFromBangalore(plyCfg(), n);
    expect(c.HYDS01.thick.capacity).toBe(300);
    expect(c.HYDS01.thin.capacity).toBe(150);
    expect({ ...c.HYDS01.thick, capacity: 0 }).toEqual({ ...n.DS07.thick, capacity: 0 });
    expect({ ...c.HYDS01.thin, capacity: 0 }).toEqual({ ...n.DS07.thin, capacity: 0 });
    expect(c.global).toEqual({ thickBoundaryMm: 9 });
  });
  it("falls back to DS08 and does not share references", () => {
    const n = netCfg(); delete n.DS07;
    const src = plyCfg();
    const { plywoodNetworkConfig: p, networkConfigs: c } = buildHydPlywoodFromBangalore(src, n);
    expect(c.HYDS01.thick.tier1NZD).toBe(6);
    c.global.thickBoundaryMm = 1; c.HYDS01.thin.bufferPct = 0; p.dcCapacity.thin = 1;
    expect(n.global.thickBoundaryMm).toBe(9);
    expect(n.DS08.thin.bufferPct).toBe(20);
    expect(src.dcCapacity.thin).toBe(600);
    expect(src.brands.GreenPly.nodes.DC).toBeDefined();
  });
});
