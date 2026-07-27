import { describe, it, expect } from "vitest";
import { parsePincodeMapCsv } from "../attribution.js";

describe("parsePincodeMapCsv", () => {
  it("parses a plain two-column Pincode,DS sheet", () => {
    const csv = "Pincode,DS\n560035,DS01\n560016,DS02";
    expect(parsePincodeMapCsv(csv).map).toEqual({ "560035": "DS01", "560016": "DS02" });
  });

  it("parses the ops sheet where each DS owns a block of delivery-time columns", () => {
    // Mirrors "HomeRun Pin Codes — New Mapping": a counts row, a DS-name row,
    // a 60/90/120-min sub-header, then pincodes beneath.
    const csv = [
      "DS01 Pincode Count,,,2,,DS02 Pincode Count,,,2",
      "DS01 Sarjapur,,,,,DS02 Bileshivale,,,",
      "#,60 mins,90 mins,120 mins,,#,60 mins,90 mins,120 mins",
      "1,560035,560034,560017,,1,560016,560005,560007",
      "2,560087,,,,2,560036,,",
    ].join("\n");
    const { map } = parsePincodeMapCsv(csv);
    expect(map["560035"]).toBe("DS01");
    expect(map["560017"]).toBe("DS01");   // 120-min tier still belongs to DS01
    expect(map["560016"]).toBe("DS02");
    expect(map["560007"]).toBe("DS02");
    expect(Object.keys(map)).toHaveLength(8);
  });

  it("ignores the row-number column so indices are never read as pincodes", () => {
    const csv = [
      "DS01 Sarjapur,,,",
      "#,60 mins,90 mins,120 mins",
      "1,560035,,",
    ].join("\n");
    expect(parsePincodeMapCsv(csv).map).toEqual({ "560035": "DS01" });
  });

  it("reports pincodes claimed by more than one DS instead of silently picking one", () => {
    const csv = "Pincode,DS\n560035,DS01\n560035,DS02";
    const { conflicts } = parsePincodeMapCsv(csv);
    expect(conflicts).toEqual([{ pin: "560035", dses: ["DS01", "DS02"] }]);
  });

  it("returns no conflicts for a clean sheet", () => {
    expect(parsePincodeMapCsv("Pincode,DS\n560035,DS01").conflicts).toEqual([]);
  });
});
