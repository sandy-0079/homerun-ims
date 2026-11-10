import { describe, it, expect } from "vitest";
import { buildHydFloorsTemplateCsv, HYD_FLOORS_TEMPLATE_HEADER } from "./hydFloorsTemplate.js";
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
