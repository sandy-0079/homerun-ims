import { describe, it, expect } from "vitest";
import { flattenParamRows, setParamPath } from "./hydParamRows.js";

describe("flattenParamRows", () => {
  it("flattens nested objects as a.b and types each leaf", () => {
    const rows = flattenParamRows({
      overallPeriod: 45, label: "x", on: true,
      fixedUnitFloor: { minNZD: 2, inner: { k: 1 } },
      tiers: [1, 2], gone: null,
    });
    const by = Object.fromEntries(rows.map(r => [r.path, r]));
    expect(by.overallPeriod).toMatchObject({ kind: "number", value: 45, keys: ["overallPeriod"] });
    expect(by.label.kind).toBe("string");
    expect(by.on.kind).toBe("boolean");
    expect(by["fixedUnitFloor.minNZD"]).toMatchObject({ kind: "number", keys: ["fixedUnitFloor", "minNZD"] });
    expect(by["fixedUnitFloor.inner.k"].value).toBe(1);
    expect(by.tiers).toMatchObject({ kind: "array", value: [1, 2] });
    expect(by.gone.kind).toBe("readonly");
  });

  it("excludes top-level keys only, and sorts by path", () => {
    const rows = flattenParamRows({ b: 1, a: 2, newDSList: ["DS06"], x: { newDSList: 3 } }, ["newDSList"]);
    expect(rows.map(r => r.path)).toEqual(["a", "b", "x.newDSList"]);
  });

  it("keeps a key containing a dot as one segment", () => {
    const rows = flattenParamRows({ m: { "v1.2": 5 } });
    expect(rows[0].keys).toEqual(["m", "v1.2"]);
  });

  it("an empty object is a read-only row, not dropped", () => {
    expect(flattenParamRows({ e: {} })).toEqual([{ path: "e", keys: ["e"], kind: "readonly", value: {} }]);
  });

  it("tolerates null/undefined input", () => {
    expect(flattenParamRows(null)).toEqual([]);
  });
});

describe("setParamPath", () => {
  it("sets a nested leaf without mutating the input", () => {
    const src = { a: { b: 1, c: 2 }, d: 3 };
    const out = setParamPath(src, ["a", "b"], 9);
    expect(out).toEqual({ a: { b: 9, c: 2 }, d: 3 });
    expect(src.a.b).toBe(1);
    expect(out.d).toBe(3);
  });

  it("sets a top-level leaf", () => {
    expect(setParamPath({ a: 1 }, ["a"], 2)).toEqual({ a: 2 });
  });
});
