import { describe, it, expect } from "vitest";
import {
  INNER_CASE_PACK_CSV_HEADERS, PURCHASE_PRICE_CSV_HEADERS,
  buildInnerCasePackCsv, buildPurchasePriceCsv, innerCasePackFilename, purchasePriceFilename, countPricedSkus,
} from "./refDataCsv.js";

const master = {
  B: { sku: "B", name: "Tee, 1/2\"", category: "CPVC", brand: "Ashirvad", status: "active" },
  A: { sku: "A", name: "Adhesive", category: "Tiling", brand: "Roff", status: "Inactive" },
  C: { sku: "C", name: "Elbow", category: "CPVC", brand: "Ashirvad", status: "confirmation_pending" },
};
const lines = (csv) => csv.trim().split("\n");
const lastCol = (line) => line.slice(line.lastIndexOf(",") + 1);
const skuOf = (line) => line.match(/,"([ABC])",/)[1];

describe("buildInnerCasePackCsv", () => {
  const csv = buildInnerCasePackCsv({ skuMaster: master, packs: { B: 10, C: 2.5 } });

  it("header is pinned", () => {
    expect(lines(csv)[0]).toBe(INNER_CASE_PACK_CSV_HEADERS.join(","));
  });

  it("emits every master SKU, Category → Brand → Name", () => {
    // CPVC/Ashirvad: "Elbow" (C) before "Tee" (B); then Tiling (A).
    expect(lines(csv).slice(1).map(skuOf)).toEqual(["C", "B", "A"]);
  });

  it("prints the pack in effect: stored value, else 1 (invalid → 1)", () => {
    const bySku = Object.fromEntries(lines(csv).slice(1).map((l) => [skuOf(l), lastCol(l)]));
    expect(bySku).toEqual({ A: "1", B: "10", C: "1" });
  });

  it("escapes quotes and commas in item names", () => {
    expect(csv).toContain('"Tee, 1/2"""');
  });

  it("normalises status spelling", () => {
    expect(csv).toContain('"Confirmation Pending"');
    expect(csv).toContain('"Inactive"');
  });

  it("no packs row → every SKU reads 1, never throws", () => {
    const c = buildInnerCasePackCsv({ skuMaster: master, packs: undefined });
    expect(lines(c).slice(1).every((l) => lastCol(l) === "1")).toBe(true);
  });

  it("empty master → null", () => {
    expect(buildInnerCasePackCsv({ skuMaster: {}, packs: {} })).toBeNull();
  });
});

describe("buildPurchasePriceCsv", () => {
  const csv = buildPurchasePriceCsv({ skuMaster: master, priceData: { A: 412.3456, B: 0, C: 18 } });

  it("header names the 12-month average, not a current rate", () => {
    expect(lines(csv)[0]).toBe(PURCHASE_PRICE_CSV_HEADERS.join(","));
    expect(lines(csv)[0]).toContain("Avg Purchase Price 12 mo");
  });

  it("price to 2 dp; missing or zero price is BLANK, never 0", () => {
    const bySku = Object.fromEntries(lines(csv).slice(1).map((l) => [skuOf(l), lastCol(l)]));
    expect(bySku).toEqual({ A: "412.35", B: "", C: "18" });
  });

  it("every row has the header's column count (commas inside quotes don't split)", () => {
    const split = (l) => l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    for (const l of lines(csv)) expect(split(l).length).toBe(PURCHASE_PRICE_CSV_HEADERS.length);
  });
});

describe("ordering + counts", () => {
  it("uncategorised SKUs sort last", () => {
    const m = { ...master, Z: { sku: "Z", name: "Placeholder", category: "", status: "active" } };
    const out = lines(buildInnerCasePackCsv({ skuMaster: m, packs: {} }));
    expect(out.at(-1)).toContain('"Z"');
  });

  it("countPricedSkus counts master SKUs with a price > 0 only", () => {
    expect(countPricedSkus(master, { A: 10, B: 0, NOT_IN_MASTER: 5 })).toBe(1);
  });
});

describe("filenames", () => {
  it("carry the local date", () => {
    const d = new Date(2026, 9, 7, 15, 0);
    expect(innerCasePackFilename(d)).toBe("Inner_Case_Pack_Mid_Mile_2026-10-07.csv");
    expect(purchasePriceFilename(d)).toBe("Purchase_Prices_2026-10-07.csv");
  });
});
