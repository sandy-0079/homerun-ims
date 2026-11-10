import { describe, it, expect } from "vitest";
import { parseHydFloorsCsv } from "./hydFloors.js";

const opts = { dsList: ["HYDS01"], knownSkus: new Set(["A", "B"]) };
const H = "SKU,Item Name,HYDS01 Min,HYDS01 Max";

describe("parseHydFloorsCsv", () => {
  it("parses min/max", () => {
    const r = parseHydFloorsCsv(`${H}\nA,x,2,5`, opts);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.floors.A.HYDS01).toEqual({ min: 2, max: 5 });
    expect(r.skuCount).toBe(1);
  });
  it("raises max to min", () => {
    const r = parseHydFloorsCsv(`${H}\nA,,5,2`, opts);
    expect(r.floors.A.HYDS01).toEqual({ min: 5, max: 5 });
  });
  it("treats blank cells as 0 and keeps the SKU as {}", () => {
    const r = parseHydFloorsCsv(`${H}\nA,x,,`, opts);
    expect(r.ok).toBe(true);
    expect(r.floors.A).toEqual({});
  });
  it("last row wins and duplicates are reported", () => {
    const r = parseHydFloorsCsv(`${H}\nA,x,2,5\nA,x,0,0`, opts);
    expect(r.floors.A).toEqual({});
    expect(r.duplicateSkus).toEqual(["A"]);
  });
  it("refuses DS01/DC columns", () => {
    const r = parseHydFloorsCsv(`SKU,DS01 Min,HYDS01 Min,HYDS01 Max\nA,1,3,4`, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("foreign_columns");
    expect(r.foreignColumns).toEqual(["DS01 Min"]);
  });
  it("refuses DC columns too", () => {
    const r = parseHydFloorsCsv(`SKU,dc max,HYDS01 Min\nA,1,2`, opts);
    expect(r.reason).toBe("foreign_columns");
    expect(r.foreignColumns).toEqual(["dc max"]);
  });
  it("refuses a HYDS column not in dsList", () => {
    const r = parseHydFloorsCsv(`SKU,HYDS01 Min,HYDS02 Min\nA,1,2`, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("foreign_columns");
    expect(r.foreignColumns).toEqual(["HYDS02 Min"]);
  });
  it("rejects non-integer values", () => {
    const r = parseHydFloorsCsv(`${H}\nA,x,2.5,5`, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_value");
    expect(r.invalid).toEqual([{ sku: "A", column: "HYDS01 Min", value: "2.5" }]);
  });
  it("reports unknown SKUs without refusing", () => {
    const r = parseHydFloorsCsv(`${H}\nZZZ,x,1,2`, opts);
    expect(r.ok).toBe(true);
    expect(r.unknownSkus).toEqual(["ZZZ"]);
  });
  it("header_mismatch without SKU; empty on empty text", () => {
    expect(parseHydFloorsCsv("Item,HYDS01 Min,HYDS01 Max\nA,1,2", opts).reason).toBe("header_mismatch");
    expect(parseHydFloorsCsv("<html>", opts).reason).toBe("header_mismatch");
    expect(parseHydFloorsCsv("", opts).reason).toBe("empty");
    expect(parseHydFloorsCsv("   \n", opts).reason).toBe("empty");
  });
  it("handles BOM and CRLF", () => {
    const r = parseHydFloorsCsv(`﻿${H}\r\nA,x,2,5\r\nB,y,1,1\r\n`, opts);
    expect(r.ok).toBe(true);
    expect(r.floors.A.HYDS01).toEqual({ min: 2, max: 5 });
    expect(r.floors.B.HYDS01).toEqual({ min: 1, max: 1 });
  });
  it("handles quoted item names with commas, and counts blank-SKU rows", () => {
    const r = parseHydFloorsCsv(`${H}\nA,"Pipe, 5 inch",2,5\n,orphan,1,1`, opts);
    expect(r.ok).toBe(true);
    expect(r.floors.A.HYDS01).toEqual({ min: 2, max: 5 });
    expect(r.blankSkuRows).toBe(1);
  });
});
