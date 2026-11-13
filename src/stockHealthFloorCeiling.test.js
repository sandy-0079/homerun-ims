import { describe, it, expect } from "vitest";
import {
  keyIndex, floorAt, ceilingAt, fmtFloor, fmtCeiling, matchesSetupFilter,
} from "./stockHealthFloorCeiling.js";

describe("floorAt", () => {
  const floors = {
    AAA01: { DS01: { min: 3, max: 5 }, DC: { min: 10, max: 20 } },
    BBB02: { DS01: 4 },                 // old bare-number shape
    CCC03: { DS01: { min: 2 } },        // missing max → falls back to min
    DDD04: { DS01: { min: 0, max: 0 } },// 0/0 has no effect in the engine
  };
  const idx = keyIndex(floors);

  it("reads an object floor at the location", () => {
    expect(floorAt(floors, idx, "AAA01", "DS01")).toEqual({ min: 3, max: 5 });
    expect(floorAt(floors, idx, "AAA01", "DC")).toEqual({ min: 10, max: 20 });
  });
  it("is per-location", () => {
    expect(floorAt(floors, idx, "AAA01", "DS02")).toBeNull();
  });
  it("normalises like runEngine", () => {
    expect(floorAt(floors, idx, "BBB02", "DS01")).toEqual({ min: 4, max: 4 });
    expect(floorAt(floors, idx, "CCC03", "DS01")).toEqual({ min: 2, max: 2 });
  });
  it("treats 0/0 as no floor", () => {
    expect(floorAt(floors, idx, "DDD04", "DS01")).toBeNull();
  });
  it("looks SKUs up case-insensitively, as the engine does", () => {
    expect(floorAt(floors, idx, "aaa01", "DS01")).toEqual({ min: 3, max: 5 });
  });
  it("tolerates missing data", () => {
    expect(floorAt({}, keyIndex({}), "AAA01", "DS01")).toBeNull();
    expect(floorAt(undefined, keyIndex(undefined), "AAA01", "DS01")).toBeNull();
  });
});

describe("ceilingAt", () => {
  const ceilings = { AAA01: { DS01: 6, DS02: 0 } };
  const idx = keyIndex(ceilings);

  it("reads the cap", () => {
    expect(ceilingAt(ceilings, idx, "AAA01", "DS01")).toBe(6);
  });
  it("keeps a cap of 0 — it is a real cap, not blank", () => {
    expect(ceilingAt(ceilings, idx, "AAA01", "DS02")).toBe(0);
  });
  it("returns null when uncapped", () => {
    expect(ceilingAt(ceilings, idx, "AAA01", "DS03")).toBeNull();
    expect(ceilingAt(ceilings, idx, "ZZZ99", "DS01")).toBeNull();
    expect(ceilingAt({}, keyIndex({}), "AAA01", "DS01")).toBeNull();
  });
  it("is case-insensitive", () => {
    expect(ceilingAt(ceilings, idx, "aaa01", "DS01")).toBe(6);
  });
});

describe("formatting", () => {
  it("shows the floor Min only, and none as a dash", () => {
    expect(fmtFloor({ min: 3, max: 5 })).toBe("3");
    expect(fmtFloor(null)).toBe("—");
  });
  it("prints a 0 ceiling as 0, not a dash", () => {
    expect(fmtCeiling(0)).toBe("0");
    expect(fmtCeiling(null)).toBe("—");
  });
});

describe("matchesSetupFilter", () => {
  const both    = { floor: { min: 1, max: 2 }, ceiling: 5 };
  const floorOn = { floor: { min: 1, max: 2 }, ceiling: null };
  const ceilOn  = { floor: null, ceiling: 0 };
  const neither = { floor: null, ceiling: null };
  const rows = { both, floorOn, ceilOn, neither };
  const pick = (f) => Object.entries(rows).filter(([, r]) => matchesSetupFilter(r, f)).map(([k]) => k);

  it("All keeps everything", () => {
    expect(pick("All")).toEqual(["both", "floorOn", "ceilOn", "neither"]);
  });
  it("No Floor ignores the ceiling", () => {
    expect(pick("No Floor")).toEqual(["ceilOn", "neither"]);
  });
  it("No Ceiling ignores the floor, and a 0 cap counts as having one", () => {
    expect(pick("No Ceiling")).toEqual(["floorOn", "neither"]);
  });
  it("No Floor or No Ceiling is the union — everything except rows with both set", () => {
    expect(pick("No Floor or No Ceiling")).toEqual(["floorOn", "ceilOn", "neither"]);
  });
  it("No Floor & No Ceiling is the intersection", () => {
    expect(pick("No Floor & No Ceiling")).toEqual(["neither"]);
  });
});
