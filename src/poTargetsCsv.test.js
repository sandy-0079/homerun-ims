import { describe, it, expect } from "vitest";
import {
  buildPoTargetsCsv, buildPoCsvHeaders, PO_CSV_HEADERS,
  poFirstNumericCol, poNumericColCount, poCsvFilename,
} from "./poTargetsCsv.js";
import { DS_LIST, liveDsList, OPENING_DS_DEFAULT } from "./engine/constants.js";

// The six stores trading on 2026-09-18. Everything the PO team sees is keyed to
// this list, so it is written out literally rather than derived — a test that
// derives its own expectation from the code under test proves nothing.
const LIVE6 = ["DS01", "DS02", "DS03", "DS04", "DS05", "DS06"];
const NUM6 = poNumericColCount(LIVE6);
const FIRST = poFirstNumericCol(LIVE6);
const build = (args) => buildPoTargetsCsv({ dsList: LIVE6, ...args });

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

describe("the PO column contract", () => {
  // ⚠⚠ THE REGRESSION GUARD FOR THE DS07/DS08 ROLLOUT. Wiring two dark stores weeks
  // before they open must not move one byte of the file the PO team downloads each
  // morning, because their sheet formulas key on POSITION and the symptom of being
  // wrong is incorrect purchase orders rather than an error. This asserts the exact
  // 22 columns that shipped before DS07/DS08 existed.
  it("is byte-identical to the pre-DS07 header for the six trading stores", () => {
    expect(buildPoCsvHeaders(LIVE6)).toEqual([
      "Item Name", "Inventorised At", "SKU", "Category", "Brand", "Status",
      "DC Min", "DC Max",
      "DS01 Min", "DS01 Max", "DS02 Min", "DS02 Max", "DS03 Min", "DS03 Max",
      "DS04 Min", "DS04 Max", "DS05 Min", "DS05 Max", "DS06 Min", "DS06 Max",
      // Appended 2026-09-07, AFTER DS06 Max — positions 0-19 untouched.
      "Purchase", "Move",
    ]);
    expect(buildPoCsvHeaders(LIVE6)).toHaveLength(22);
  });

  // The store universe and the trading set are different things. If these ever
  // coincide by accident the test above stops proving anything, so assert the gap.
  it("keeps wired-but-unopened stores out of the header entirely", () => {
    expect(DS_LIST).toContain("DS07");
    expect(DS_LIST).toContain("DS08");
    expect(buildPoCsvHeaders(LIVE6).join()).not.toMatch(/DS0[78]/);
    // …and the default gate is what produces that list from the full universe.
    expect(liveDsList({})).toEqual(LIVE6);
    expect(liveDsList({ openingDSList: OPENING_DS_DEFAULT })).toEqual(LIVE6);
  });

  it("puts Purchase and Move last at every store count, never mid-block", () => {
    for (const list of [[], LIVE6, [...LIVE6, "DS07"], DS_LIST]) {
      expect(buildPoCsvHeaders(list).slice(-2)).toEqual(["Purchase", "Move"]);
    }
  });

  it("grows the DS block by exactly two columns when a store opens", () => {
    const before = buildPoCsvHeaders(LIVE6);
    const after = buildPoCsvHeaders([...LIVE6, "DS07"]);
    expect(after).toHaveLength(before.length + 2);
    // Everything up to the end of the DS block is untouched: opening a store shifts
    // Purchase/Move RIGHT, which is announced, and never reorders what precedes them.
    expect(after.slice(0, before.length - 2)).toEqual(before.slice(0, -2));
    expect(after.slice(before.length - 2, before.length)).toEqual(["DS07 Min", "DS07 Max"]);
  });

  it("derives the numeric-block bounds rather than hardcoding them", () => {
    expect(FIRST).toBe(6);
    expect(buildPoCsvHeaders(LIVE6)[FIRST]).toBe("DC Min");
    expect(NUM6).toBe(14); // 2 DC + 12 DS
    // The numeric block ENDS at the last trading store — text follows it, so an
    // unbounded slice from FIRST would include "Yes"/"No".
    expect(buildPoCsvHeaders(LIVE6)[FIRST + NUM6 - 1]).toBe("DS06 Max");
    expect(buildPoCsvHeaders(LIVE6).slice(FIRST + NUM6)).toEqual(["Purchase", "Move"]);
  });

  it("PO_CSV_HEADERS covers the whole universe and so must not be shipped", () => {
    // Exported for tooling only. If a caller ever used it the PO team would get
    // columns for stores that are not trading — the exact disruption being avoided.
    expect(PO_CSV_HEADERS).toEqual(buildPoCsvHeaders(DS_LIST));
    expect(PO_CSV_HEADERS.length).toBeGreaterThan(buildPoCsvHeaders(LIVE6).length);
  });
});

describe("buildPoTargetsCsv", () => {
  it("emits a header plus one row per master SKU", () => {
    const r = rows(build({ skuMaster: master, results }));
    expect(r).toHaveLength(4);
    expect(cells(r[0])).toHaveLength(22);
  });

  it("places every value in its contracted column", () => {
    const c = cells(rows(build({ skuMaster: master, results }))[1]);
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
    const line = rows(build({ skuMaster: master, results }))[2];
    expect(line.startsWith('"Floor Drain 5"" x 5"""')).toBe(true);
    expect(cells(line)).toHaveLength(22);
  });

  it("quotes Brand, so a comma in a brand name cannot shift the columns", () => {
    const c = cells(rows(build({ skuMaster: master, results }))[3]);
    expect(c[4]).toBe('"Polycab, Ltd"');
    expect(c).toHaveLength(22);
  });

  it("emits an empty quoted cell for a missing Brand, never a shifted row", () => {
    const c = cells(rows(build({ skuMaster: master, results }))[2]);
    expect(c[4]).toBe('""');
    expect(c).toHaveLength(22);
  });

  it("writes 0, never blank, for stores with no target", () => {
    const c = cells(rows(build({ skuMaster: master, results }))[2]);
    // B2 is Supplier with no stores at all — every numeric cell must be a literal 0
    expect(c.slice(FIRST, FIRST + NUM6)).toEqual(Array(14).fill("0"));
    expect(c.slice(FIRST, FIRST + NUM6).some((v) => v === "")).toBe(false);
  });

  it("keeps Supplier and non-active SKUs as rows, so the sheet can filter them", () => {
    const csv = build({ skuMaster: master, results });
    expect(csv).toContain('"Supplier"');
    expect(csv).toContain('"Confirmation Pending"');
    expect(csv).toContain('"Inactive"');
  });

  it("applies a coreOverride only upward, matching the Tool Output DS button", () => {
    const csv = build({
      skuMaster: master, results,
      coreOverrides: { A1: { DS01: { min: 5, max: 1 } } },  // min raises, max is lower
    });
    const c = cells(rows(csv)[1]);
    expect(c[8]).toBe("5");   // override min 5 beats engine 1
    expect(c[9]).toBe("2");   // engine max 2 beats override max 1 — never lowered
  });

  it("survives a master SKU the engine has no entry for", () => {
    const csv = build({ skuMaster: { Z9: { sku: "Z9", name: "Z9" } }, results: {} });
    const c = cells(rows(csv)[1]);
    expect(c[5]).toBe('"Active"');
    expect(c.slice(FIRST, FIRST + NUM6)).toEqual(Array(14).fill("0"));
  });

  it("returns null rather than a header-only file when there is no master", () => {
    expect(build({ skuMaster: {}, results })).toBeNull();
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
