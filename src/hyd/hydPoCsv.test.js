import { describe, it, expect } from "vitest";
import { HYD_PO_CSV_HEADERS, buildHydPoCsv, hydPoCsvFilename } from "./hydPoCsv.js";
import { PO_CSV_HEADERS } from "../poTargetsCsv.js";

const skuMaster = {
  A: { sku: "A", name: 'Floor Drain, 5" x 5"', category: "Plumbing", brand: "B1", status: "Active", inventorisedAt: "DC", purchase: "ON" },
  B: { sku: "B", name: "Pipe", category: "Plumbing", brand: "B2", status: "Active", inventorisedAt: "DC", purchase: "OFF" },
  C: { sku: "C", name: "Gone", category: "X", brand: "", status: "Inactive", inventorisedAt: "DC" },
};
const hydResults = { A: { meta: {}, stores: { HYDS01: { min: 3, max: 9 } }, dc: { min: 0, max: 0 } }, C: { stores: { HYDS01: { min: 0, max: 0 } } } };
const floors = { B: { HYDS01: { min: 1, max: 2 } } };
const build = (hydParams = { floorsOnly: { HYDS01: true } }) =>
  buildHydPoCsv({ skuMaster, hydResults, floors, hydParams });

// Minimal CSV line parser honouring quotes.
const parse = (line) => {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else if (c === '"') inQ = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
};

describe("hydPoCsv", () => {
  it("header is the frozen 9 names", () => {
    expect(HYD_PO_CSV_HEADERS).toEqual(["Item Name", "Inventorised At", "SKU", "Category", "Brand", "Status", "HYDS01 Min", "HYDS01 Max", "Purchase"]);
    expect(parse(build().split("\n")[0])).toEqual(HYD_PO_CSV_HEADERS);
  });
  it("every master SKU once, 9 columns each, even with comma and quote in name", () => {
    const lines = build().split("\n");
    expect(lines).toHaveLength(1 + 3);
    for (const l of lines) expect(parse(l)).toHaveLength(9);
    expect(parse(lines[1])[0]).toBe('Floor Drain, 5" x 5"');
    expect(lines.slice(1).map((l) => parse(l)[2])).toEqual(["A", "B", "C"]);
  });
  it("SKU missing from results reads 0,0; present reads its Min/Max", () => {
    const lines = build().split("\n");
    expect(parse(lines[1]).slice(6, 8)).toEqual(["3", "9"]);
    expect(parse(lines[2]).slice(6, 8)).toEqual(["0", "0"]);
  });
  it("floored Purchase=OFF SKU reads Yes; inactive reads No", () => {
    const lines = build().split("\n");
    expect(parse(lines[2])[8]).toBe("Yes");
    expect(parse(lines[3])[8]).toBe("No");
    // A has no floor: floors-only => No; engine mode => Zoho's ON => Yes
    expect(parse(lines[1])[8]).toBe("No");
    expect(parse(build({ floorsOnly: { HYDS01: false } }).split("\n")[1])[8]).toBe("Yes");
  });
  it("returns null with an empty master", () => {
    expect(buildHydPoCsv({ skuMaster: {}, hydResults, floors, hydParams: {} })).toBeNull();
  });
  it("filename", () => {
    expect(hydPoCsvFilename("2026-11-10")).toBe("PO_Hyderabad_2026-11-10.csv");
    expect(hydPoCsvFilename("2026-11-10T05:30:00.000Z")).toBe("PO_Hyderabad_2026-11-10.csv");
  });
  it("Bangalore PO_CSV_HEADERS is untouched", () => {
    expect(PO_CSV_HEADERS).toEqual(["Item Name","Inventorised At","SKU","Category","Brand","Status","DC Min","DC Max","DS01 Min","DS01 Max","DS02 Min","DS02 Max","DS03 Min","DS03 Max","DS04 Min","DS04 Max","DS05 Min","DS05 Max","DS06 Min","DS06 Max","DS07 Min","DS07 Max","DS08 Min","DS08 Max","Purchase","Move"]);
  });
});
