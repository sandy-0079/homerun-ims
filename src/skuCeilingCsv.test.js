import { describe, it, expect } from "vitest";
import { parseSkuCeilingCsv, buildSkuCeilingCsv } from "./skuCeilingCsv.js";

const DS = ["DS01", "DS02", "DS03", "DS04", "DS05", "DS06"];
const HEADER = ["SKU", ...DS.map((d) => `${d} Cap`)].join(",");
const sheet = (...rows) => [HEADER, ...rows].join("\n");
/** 6 cap columns; pass "" for an uncapped DS. */
const row = (sku, vals) => [sku, ...vals, ...Array(6 - vals.length).fill("")].join(",");

// ⚠⚠ THE ENTIRE POINT OF THIS PARSER, and the one place it must NOT copy
// `parseFloorSheet`. That one folds a blank cell into 0 because for a FLOOR
// "0" and "no floor" are the same statement. For a CEILING they are opposites:
// blank = stock as much as the strategy says, 0 = stock nothing here. Fold them
// together and a mostly-blank sheet zeroes the network.
describe("parseSkuCeilingCsv — blank and 0 are OPPOSITES, not synonyms", () => {
  it("treats a blank cell as NO CAP — the DS is absent from the result", () => {
    const r = parseSkuCeilingCsv(sheet(row("G9NYZ", ["", "", "", "", "5", ""])), DS);
    expect(r.ok).toBe(true);
    expect(r.ceilings.G9NYZ).toEqual({ DS05: 5 });
    expect("DS01" in r.ceilings.G9NYZ).toBe(false);
  });

  it("treats 0 as a REAL cap of zero — stock nothing at that DS", () => {
    // Dead Stock cannot express this: it zeroes every location including the DC.
    // Capping at 0 for three stores while leaving three uncapped is exactly why
    // the input is per-SKU x per-DS.
    const r = parseSkuCeilingCsv(sheet(row("ABC", ["0", "0", "0", "", "", ""])), DS);
    expect(r.ok).toBe(true);
    expect(r.ceilings.ABC).toEqual({ DS01: 0, DS02: 0, DS03: 0 });
  });

  it("counts zero-caps separately — they are the destructive kind", () => {
    // The upload confirm step reports these on their own line. An export that
    // turned blanks into zeros is the one input that could quietly zero the
    // network, and there is no hard guard to catch it.
    const r = parseSkuCeilingCsv(sheet(row("A", ["0", "5", "", "", "", ""]), row("B", ["", "0", "", "", "", ""])), DS);
    expect(r.capCells).toBe(3);
    expect(r.zeroCells).toBe(2);
  });

  it("treats a missing trailing column as blank, not as 0", () => {
    // A short row from a trimmed export must never read as "cap at zero".
    // 7 header columns, 6 cells: the 4 lands on DS05 and DS06 has no cell at all.
    const r = parseSkuCeilingCsv([HEADER, "ABC,,,,,4"].join("\n"), DS);
    expect(r.ceilings.ABC).toEqual({ DS05: 4 });
    expect("DS06" in r.ceilings.ABC).toBe(false);
  });

  it("keeps an all-blank SKU as present-but-empty, mirroring the floors shape", () => {
    const r = parseSkuCeilingCsv(sheet(row("NONE", ["", "", "", "", "", ""])), DS);
    expect(r.ceilings.NONE).toEqual({});
    expect(r.skuCount).toBe(1);
  });
});

describe("parseSkuCeilingCsv — fails closed on anything it does not understand", () => {
  it("rejects an HTML page or any file without a SKU column", () => {
    expect(parseSkuCeilingCsv("<html>nope</html>", DS).reason).toBe("header_mismatch");
  });

  it("rejects a file with no Cap columns at all", () => {
    // Guards against someone uploading the FLOORS file here by mistake — its
    // columns are "DS01 Min"/"DS01 Max" and would match nothing.
    const floorsHeader = ["SKU", ...DS.flatMap((d) => [`${d} Min`, `${d} Max`])].join(",");
    const r = parseSkuCeilingCsv([floorsHeader, "ABC,1,2,0,0,0,0,0,0,0,0,0,0"].join("\n"), DS);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("header_mismatch");
  });

  it("rejects an unknown DS column instead of silently ignoring it", () => {
    const h = ["SKU", "DS01 Cap", "DS07 Cap"].join(",");
    const r = parseSkuCeilingCsv([h, "ABC,1,2"].join("\n"), ["DS01"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unknown_ds");
    expect(r.unknownDs).toEqual(["DS07"]);
  });

  it("rejects a non-integer, a negative and stray text rather than coercing", () => {
    for (const bad of ["2.5", "-1", "abc", "5 units"]) {
      const r = parseSkuCeilingCsv(sheet(row("X", [bad])), DS);
      expect(r.ok, `${bad} should be rejected`).toBe(false);
      expect(r.reason).toBe("invalid_value");
    }
  });

  it("names the offending cell so ops can find it", () => {
    const r = parseSkuCeilingCsv(sheet(row("TYPO", ["", "2.5"])), DS);
    expect(r.invalid[0]).toMatchObject({ sku: "TYPO", column: "DS02 Cap", value: "2.5" });
  });

  it("refuses a structurally valid file with zero SKUs", () => {
    // An empty tab or a filter hiding every row. Refused here rather than left to
    // the caller, exactly as parseFloorSheet does.
    expect(parseSkuCeilingCsv(HEADER, DS).reason).toBe("empty");
  });

  it("reads columns by header NAME, not position", () => {
    const h = ["DS02 Cap", "SKU", "DS01 Cap"].join(",");
    const r = parseSkuCeilingCsv([h, "7,ABC,3"].join("\n"), ["DS01", "DS02"]);
    expect(r.ceilings.ABC).toEqual({ DS01: 3, DS02: 7 });
  });

  it("is case-insensitive on the header and tolerates a BOM", () => {
    const h = ["﻿sku", "ds01 cap"].join(",");
    const r = parseSkuCeilingCsv([h, "ABC,3"].join("\n"), ["DS01"]);
    expect(r.ok).toBe(true);
    expect(r.ceilings.ABC).toEqual({ DS01: 3 });
  });
});

// Deliberately identical to the SKU-floor sheet's rule, agreed 2026-08-15. Ops
// revises by appending a row rather than editing in place, and two ops inputs
// resolving the same ambiguity differently is the bug that cost two nights.
describe("parseSkuCeilingCsv — duplicate rows follow the append rule", () => {
  it("resolves a duplicate SKU to the LAST row", () => {
    const r = parseSkuCeilingCsv(sheet(row("DUP", ["1"]), row("DUP", ["9"])), DS);
    expect(r.ok).toBe(true);
    expect(r.ceilings.DUP).toEqual({ DS01: 9 });
  });

  it("lets a later row REMOVE a cap by blanking it", () => {
    const r = parseSkuCeilingCsv(sheet(row("DUP", ["1"]), row("DUP", [""])), DS);
    expect(r.ceilings.DUP).toEqual({});
  });

  it("counts superseded rows and names the SKUs", () => {
    const r = parseSkuCeilingCsv(sheet(row("A", ["1"]), row("DUP", ["1"]), row("DUP", ["2"])), DS);
    expect(r.duplicateRows).toBe(1);
    expect(r.duplicateSkus).toEqual(["DUP"]);
    expect(r.skuCount).toBe(2);
  });
});

// The invoice ⬇ Data button round-tripped to ZERO rows for months because its
// writer and reader sat 3,000 lines apart with nothing asserting the invariant.
// This is that assertion, written the same day as the parser.
describe("buildSkuCeilingCsv — round-trips through the parser", () => {
  const DSL = DS;
  it("survives a round trip with caps, zero-caps and uncapped stores mixed", () => {
    const ceilings = {
      G9NYZ: { DS05: 5 },
      ZEROED: { DS01: 0, DS02: 0, DS03: 0 },
      MIXED: { DS01: 0, DS04: 12, DS06: 1 },
      NONE: {},
    };
    const back = parseSkuCeilingCsv(buildSkuCeilingCsv(ceilings, DSL), DSL);
    expect(back.ok).toBe(true);
    expect(back.ceilings).toEqual(ceilings);
  });

  it("writes an EMPTY cell for an uncapped DS, never a 0", () => {
    // The whole hazard: "0" here would turn "no cap" into "stock nothing" on
    // re-upload — a backup that zeroes the very stores it was taken to protect.
    const csv = buildSkuCeilingCsv({ A: { DS03: 7 } }, DSL);
    expect(csv.split("\n")[1]).toBe("A,,,7,,,");
  });

  it("preserves a 0 as a literal 0", () => {
    const csv = buildSkuCeilingCsv({ A: { DS01: 0 } }, DSL);
    expect(csv.split("\n")[1]).toBe("A,0,,,,,");
  });

  it("emits a header the parser accepts even with no rows", () => {
    expect(buildSkuCeilingCsv({}, DSL)).toBe(["SKU", ...DSL.map((d) => `${d} Cap`)].join(","));
  });
});
