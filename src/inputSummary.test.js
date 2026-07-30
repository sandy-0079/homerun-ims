import { describe, it, expect } from "vitest";
import {
  invoiceSummary, skuMasterSummary, priceSummary,
  dsFloorSummary, skuFloorSummary, deadStockSummary, summariseInputs,
} from "./inputSummary.js";

describe("invoiceSummary — invoices, not rows", () => {
  const rows = [
    { date: "2026-07-28", shopifyOrder: "HR/1", sku: "A", ds: "DS01", qty: 1 },
    { date: "2026-07-28", shopifyOrder: "HR/1", sku: "B", ds: "DS01", qty: 2 }, // same invoice
    { date: "2026-07-29", shopifyOrder: "HR/2", sku: "A", ds: "DS02", qty: 1 },
  ];

  it("counts distinct orders, which are 1:1 with invoices", () => {
    // Measured 2026-07-30 on a full day of Closed+Overdue: 571 unique Invoice
    // Numbers vs 571 unique Shopify Orders, 0 spanning either way.
    const s = invoiceSummary(rows);
    expect(s.count).toBe(2);
    expect(s.rows).toBe(3);
    expect(s.unit).toBe("invoices");
  });

  it("reports the date window, which is what an admin needs from this card", () => {
    const s = invoiceSummary(rows);
    expect(s.days).toBe(2);
    expect(s.from).toBe("2026-07-28");
    expect(s.through).toBe("2026-07-29");
  });

  it("EXCLUDES blank order refs rather than bucketing them", () => {
    // A blank would collapse every invoice that had one into a single "" entry and
    // undercount silently. 0 blanks across 74,381 stored rows today.
    const s = invoiceSummary([...rows, { date: "2026-07-29", shopifyOrder: "", sku: "C", ds: "DS01", qty: 1 }]);
    expect(s.count).toBe(2);
    expect(s.blankRefs).toBe(1);
  });

  it("treats whitespace as blank", () => {
    expect(invoiceSummary([{ date: "d", shopifyOrder: "   " }]).count).toBe(0);
  });

  it("survives an empty or non-array value", () => {
    for (const v of [[], null, undefined, {}]) expect(invoiceSummary(v).count).toBe(0);
  });
});

describe("skuMasterSummary — active only", () => {
  const master = {
    A: { status: "active" }, B: { status: "active" },
    C: { status: "inactive" }, D: { status: "confirmation_pending" },
    E: { status: "Inactive" },      // CSV-cased, from the retain rule
    F: {},                          // no status at all
  };

  it("counts only active, because nothing else gets Min/Max", () => {
    const s = skuMasterSummary(master);
    expect(s.count).toBe(3);        // A, B, and F (defaulted)
    expect(s.total).toBe(6);
  });

  it("is case-insensitive, because Zoho is lowercase and the CSV is not", () => {
    expect(skuMasterSummary({ A: { status: "ACTIVE" }, B: { status: "Active" } }).count).toBe(2);
  });

  it("defaults a missing status to active, matching every downstream filter", () => {
    expect(skuMasterSummary({ A: {} }).count).toBe(1);
  });
});

describe("priceSummary — a zero price is no price", () => {
  it("counts only SKUs with a price above zero", () => {
    const s = priceSummary({ A: 100, B: 0, C: null, D: 5325 });
    expect(s.count).toBe(2);
    expect(s.total).toBe(4);
  });
});

describe("dsFloorSummary — THE 900-entry correction", () => {
  it("does not count a zero floor as a floor", () => {
    // The live data on 2026-07-30: 1,921 keys, 900 of them 0, so 1,021 real floors.
    // The card said 1,921 — a 47% overstatement.
    const s = dsFloorSummary({ A: 2, B: 0, C: 0, D: 5 });
    expect(s.count).toBe(2);
    expect(s.total).toBe(4);
  });

  it("ignores negatives and non-numbers rather than counting them", () => {
    expect(dsFloorSummary({ A: -1, B: "3", C: null, D: 1 }).count).toBe(1);
  });
});

describe("skuFloorSummary — nested per-DS shape", () => {
  it("counts a SKU with a floor at any single DS", () => {
    const s = skuFloorSummary({
      A: { DS01: { min: 1, max: 2 }, DS02: { min: 0, max: 0 } },
      B: { DS01: { min: 0, max: 0 } },                            // all zero => not set
      C: { DS03: { min: 0, max: 4 } },                            // max only still counts
    });
    expect(s.count).toBe(2);
    expect(s.total).toBe(3);
  });

  it("does not mistake the flat minReqQty shape for a floor", () => {
    // Guards against passing the wrong input in — a flat number has no DS entries.
    expect(skuFloorSummary({ A: 5 }).count).toBe(0);
  });
});

describe("deadStockSummary — an array, not a map", () => {
  it("counts array entries", () => {
    expect(deadStockSummary(["A", "B"]).count).toBe(2);
  });

  it("accepts a Set, which is what React state holds", () => {
    expect(deadStockSummary(new Set(["A", "B", "C"])).count).toBe(3);
  });

  it("de-duplicates and drops blanks", () => {
    expect(deadStockSummary(["A", "A", "", null]).count).toBe(1);
  });
});

describe("summariseInputs", () => {
  it("keys results the same way saveTeamData's overrides are keyed", () => {
    const s = summariseInputs({
      invoiceData: [{ date: "d", shopifyOrder: "o" }],
      skuMaster: { A: { status: "active" } },
      priceData: { A: 1 }, minReqQty: { A: 1 }, minReqQtyIgnored: 1,
      newSKUQty: { A: { DS01: { min: 1, max: 1 } } }, deadStock: ["Z"],
    });
    expect(Object.keys(s).sort()).toEqual(
      ["deadStock", "invoiceData", "minReqQty", "newSKUQty", "priceData", "skuMaster"],
    );
    for (const v of Object.values(s)) expect(v.count).toBe(1);
  });

  it("returns zeroed summaries for a totally empty state rather than throwing", () => {
    const s = summariseInputs({});
    for (const v of Object.values(s)) expect(v.count).toBe(0);
  });
});
