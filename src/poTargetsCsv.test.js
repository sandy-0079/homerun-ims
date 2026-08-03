import { describe, it, expect } from "vitest";
import {
  buildPoTargetsCsv, PO_CSV_HEADERS, PO_FIRST_NUMERIC_COL,
  poCsvFilename,
} from "./poTargetsCsv.js";
import { DS_LIST } from "./engine/constants.js";

const master = {
  A1: { sku: "A1", name: "Widget, small", category: "Tiling", brand: "MYK Laticrete", status: "active", inventorisedAt: "DC" },
  B2: { sku: "B2", name: 'Floor Drain 5" x 5"', category: "Sanitary & Bath Fittings", brand: "", status: "confirmation_pending", inventorisedAt: "Supplier" },
  C3: { sku: "C3", name: "Cable", category: "Wires, MCB & Distribution Boards", brand: "Polycab, Ltd", status: "Inactive", inventorisedAt: "DS" },
};
const results = {
  A1: { dc: { min: 10, max: 20 }, stores: { DS01: { min: 1, max: 2 }, DS02: { min: 3, max: 4 } } },
  B2: { dc: { min: 0, max: 0 }, stores: {} },
  C3: { dc: { min: 5, max: 6 }, stores: { DS01: { min: 7, max: 8 } } },
};
const rows = (csv) => csv.split("\n");

// ⚠ A naive line.split(",") is WRONG here and silently shifts every column index by
// one, because "Widget, small" is a single quoted field containing a comma — which is
// precisely the escaping this file has to get right. Quotes are kept in the output so
// assertions can distinguish a quoted text cell from a bare number.
const cells = (line) => {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '""'; i++; continue; }
      inQ = !inQ; cur += ch; continue;
    }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
};

describe("PO_CSV_HEADERS — the frozen contract", () => {
  // ⚠ This test exists to FAIL if anyone reorders or inserts a column. The PO team's
  // sheet formulas key on position, so a reorder produces wrong POs, not an error.
  it("is exactly the agreed 20 columns in the agreed order", () => {
    expect(PO_CSV_HEADERS).toEqual([
      "Item Name", "Inventorised At", "SKU", "Category", "Brand", "Status",
      "DC Min", "DC Max",
      "DS01 Min", "DS01 Max", "DS02 Min", "DS02 Max", "DS03 Min", "DS03 Max",
      "DS04 Min", "DS04 Max", "DS05 Min", "DS05 Max", "DS06 Min", "DS06 Max",
    ]);
    expect(PO_CSV_HEADERS).toHaveLength(20);
  });

  it("derives PO_FIRST_NUMERIC_COL rather than hardcoding it", () => {
    expect(PO_FIRST_NUMERIC_COL).toBe(6);
    expect(PO_CSV_HEADERS[PO_FIRST_NUMERIC_COL]).toBe("DC Min");
    expect(PO_CSV_HEADERS.length - PO_FIRST_NUMERIC_COL).toBe(14); // 2 DC + 12 DS
  });

  it("keeps identity columns first, so anything appended lands after DS06 Max", () => {
    expect(PO_CSV_HEADERS.at(-1)).toBe(`${DS_LIST.at(-1)} Max`);
  });
});

describe("buildPoTargetsCsv", () => {
  it("emits a header plus one row per master SKU", () => {
    const r = rows(buildPoTargetsCsv({ skuMaster: master, results }));
    expect(r).toHaveLength(4);
    expect(cells(r[0])).toHaveLength(20);
  });

  it("places every value in its contracted column", () => {
    const c = cells(rows(buildPoTargetsCsv({ skuMaster: master, results }))[1]);
    expect(c[0]).toBe('"Widget, small"');   // quoted — the name contains a comma
    expect(c[1]).toBe('"DC"');
    expect(c[2]).toBe('"A1"');
    expect(c[3]).toBe('"Tiling"');
    expect(c[4]).toBe('"MYK Laticrete"');   // Brand — inserted after Category 2026-08-03
    expect(c[5]).toBe('"Active"');
    expect(c[6]).toBe("10");                 // DC Min, unquoted so Sheets reads a number
    expect(c[7]).toBe("20");
    expect(c[8]).toBe("1");                  // DS01 Min
    expect(c[9]).toBe("2");
    expect(c[10]).toBe("3");                 // DS02 Min
    expect(c[11]).toBe("4");
  });

  it("escapes embedded quotes so the row cannot break mid-name", () => {
    const line = rows(buildPoTargetsCsv({ skuMaster: master, results }))[2];
    expect(line.startsWith('"Floor Drain 5"" x 5"""')).toBe(true);
    expect(cells(line)).toHaveLength(20);
  });

  it("quotes Brand, so a comma in a brand name cannot shift the columns", () => {
    const c = cells(rows(buildPoTargetsCsv({ skuMaster: master, results }))[3]);
    expect(c[4]).toBe('"Polycab, Ltd"');
    expect(c).toHaveLength(20);
  });

  it("emits an empty quoted cell for a missing Brand, never a shifted row", () => {
    const c = cells(rows(buildPoTargetsCsv({ skuMaster: master, results }))[2]);
    expect(c[4]).toBe('""');
    expect(c).toHaveLength(20);
  });

  it("writes 0, never blank, for stores with no target", () => {
    const c = cells(rows(buildPoTargetsCsv({ skuMaster: master, results }))[2]);
    // B2 is Supplier with no stores at all — every numeric cell must be a literal 0
    expect(c.slice(PO_FIRST_NUMERIC_COL)).toEqual(Array(14).fill("0"));
    expect(c.slice(PO_FIRST_NUMERIC_COL).some((v) => v === "")).toBe(false);
  });

  it("keeps Supplier and non-active SKUs as rows, so the sheet can filter them", () => {
    const csv = buildPoTargetsCsv({ skuMaster: master, results });
    expect(csv).toContain('"Supplier"');
    expect(csv).toContain('"Confirmation Pending"');
    expect(csv).toContain('"Inactive"');
  });

  it("applies a coreOverride only upward, matching the Tool Output DS button", () => {
    const csv = buildPoTargetsCsv({
      skuMaster: master, results,
      coreOverrides: { A1: { DS01: { min: 5, max: 1 } } },  // min raises, max is lower
    });
    const c = cells(rows(csv)[1]);
    expect(c[8]).toBe("5");   // override min 5 beats engine 1
    expect(c[9]).toBe("2");   // engine max 2 beats override max 1 — never lowered
  });

  it("survives a master SKU the engine has no entry for", () => {
    const csv = buildPoTargetsCsv({ skuMaster: { Z9: { sku: "Z9", name: "Z9" } }, results: {} });
    const c = cells(rows(csv)[1]);
    expect(c[5]).toBe('"Active"');
    expect(c.slice(PO_FIRST_NUMERIC_COL)).toEqual(Array(14).fill("0"));
  });

  it("returns null rather than a header-only file when there is no master", () => {
    expect(buildPoTargetsCsv({ skuMaster: {}, results })).toBeNull();
    expect(buildPoTargetsCsv({})).toBeNull();
  });
});

describe("poCsvFilename", () => {
  it("carries both the run date and the demand-through date", () => {
    expect(poCsvFilename({ refreshedOn: "2026-08-03", demandThrough: "2026-08-02" }))
      .toBe("PO_Targets_2026-08-03_demand-thru-2026-08-02.csv");
  });

  it("degrades to 'unknown' rather than emitting a malformed name", () => {
    expect(poCsvFilename({ refreshedOn: "2026-08-03", demandThrough: null }))
      .toBe("PO_Targets_2026-08-03_demand-thru-unknown.csv");
  });
});
