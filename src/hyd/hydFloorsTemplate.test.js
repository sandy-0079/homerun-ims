import { describe, it, expect } from "vitest";
import { buildHydFloorsTemplateCsv, HYD_FLOORS_TEMPLATE_HEADER, buildOutOfRangeTemplate, outOfRangeTemplateFilename, soldWithoutFloor } from "./hydFloorsTemplate.js";
import { parseHydFloorsCsv } from "./hydFloors.js";

describe("buildHydFloorsTemplateCsv", () => {
  it("header only when there are no floors", () => {
    expect(buildHydFloorsTemplateCsv({}, {})).toBe("SKU,Item Name,Category,HYDS01 Min,HYDS01 Max");
    expect(HYD_FLOORS_TEMPLATE_HEADER).toEqual(["SKU", "Item Name", "Category", "HYDS01 Min", "HYDS01 Max"]);
  });
  it("prefills the current floors and round-trips through the real parser", () => {
    const floors = { A: { HYDS01: { min: 2, max: 5 } }, B: { HYDS01: { min: 0, max: 3 } }, Z: {} };
    const master = { A: { name: "Floor Drain, 5 x 5", category: "Plumbing" }, B: { name: "B" } };
    const csv = buildHydFloorsTemplateCsv(floors, master);
    const r = parseHydFloorsCsv(csv, { dsList: ["HYDS01"], knownSkus: new Set(["A", "B"]) });
    expect(r.ok).toBe(true);
    expect(r.floors).toEqual({ A: { HYDS01: { min: 2, max: 5 } }, B: { HYDS01: { min: 0, max: 3 } } });
  });
});

describe("buildOutOfRangeTemplate — SKUs sold at Pati with no floor, as a sheet to fill", () => {
  const master = { A: { name: "Alpha", category: "Tiles" }, B: { name: "Floor Drain, 5 x 5", category: "Plumbing" } };
  it("header + one row per SKU with name and category, blank Min/Max", () => {
    const csv = buildOutOfRangeTemplate(["A", "B"], master);
    expect(csv.split("\n")).toEqual([
      "SKU,Item Name,Category,HYDS01 Min,HYDS01 Max",
      '"A","Alpha","Tiles",,',
      '"B","Floor Drain, 5 x 5","Plumbing",,',
    ]);
  });
  it("null when there is nothing to fill", () => {
    expect(buildOutOfRangeTemplate([], master)).toBeNull();
    expect(buildOutOfRangeTemplate(null, master)).toBeNull();
  });
  it("quotes a name with a comma (the column count stays 5)", () => {
    const row = buildOutOfRangeTemplate(["B"], master).split("\n")[1];
    expect(row).toContain('"Floor Drain, 5 x 5"');
  });
  it("a SKU missing from the master still gets a row, with blank name/category", () => {
    expect(buildOutOfRangeTemplate(["Q"], master).split("\n")[1]).toBe('"Q","","",,');
  });
  it("round-trips through the real parser: ok, both SKUs present and out of range until filled", () => {
    const r = parseHydFloorsCsv(buildOutOfRangeTemplate(["A", "B"], master), { dsList: ["HYDS01"], knownSkus: new Set(["A", "B"]) });
    expect(r.ok).toBe(true);
    expect(r.skuCount).toBe(2);
    expect(r.floors).toEqual({ A: {}, B: {} });
  });
  it("filename", () => {
    expect(outOfRangeTemplateFilename("2026-11-10")).toBe("Hyderabad_floors_to_fill_2026-11-10.csv");
  });
});

describe("soldWithoutFloor", () => {
  it("keeps only SKUs active in Zoho and present in the SKU master (hydEngine's isActive)", () => {
    const master = { A: { name: "A" }, B: { status: "Active" }, C: { status: " active " }, D: { status: "Inactive" }, E: { status: "" } };
    // A: no status = active; D inactive; E empty-string status = NOT active; Q absent from the master.
    expect(soldWithoutFloor(["A", "B", "C", "D", "E", "Q"], master)).toEqual(["A", "B", "C"]);
  });
  it("empty / missing input → []", () => {
    expect(soldWithoutFloor(undefined, {})).toEqual([]);
    expect(soldWithoutFloor(["A"], undefined)).toEqual([]);
  });
});
