import { describe, it, expect } from "vitest";
import { parseInvoiceCsv, buildInvoiceCsv } from "../utils.js";

// ── The ⬇ Data / ⬆ Upload round trip MUST be lossless ────────────────────────
//
// WHY (measured 2026-07-30): the Upload Data tab's ⬇ Data button emitted an EMPTY
// `Invoice Status`, because stored rows carry no status — parseInvoiceCsv drops it
// after filtering. Re-uploading that file therefore matched neither "Closed" nor
// "Overdue" and parsed to ZERO rows: 74,381 -> 0. Since the invoice upload replaces
// entirely, the result was a total wipe of invoice history, and nothing before
// 2026-07-01 is re-fetchable from the API.
//
// It was a live trap: ⬇ Data sits beside ⬆ Upload CSV and reads as the SAFEST way to
// re-upload. buildInvoiceCsv now lives next to parseInvoiceCsv so the writer and the
// reader are visibly coupled, and this test is the guard.

const rows = [
  { date: "2026-04-30", sku: "749J9", ds: "DS05", qty: 2,  shopifyOrder: "HR/26/72356", pin: "560068" },
  { date: "2026-07-28", sku: "ABC12", ds: "DS01", qty: 13, shopifyOrder: "HR/26/99999", pin: "560077" },
  { date: "2026-07-28", sku: "ABC12", ds: "DC",   qty: 1,  shopifyOrder: "HR/26/99999", pin: "" },
];

describe("buildInvoiceCsv → parseInvoiceCsv", () => {
  it("round-trips every row losslessly", () => {
    // THE REGRESSION. Before the fix this returned [].
    expect(parseInvoiceCsv(buildInvoiceCsv(rows))).toEqual(rows);
  });

  it("emits a status that survives the parser's own filter", () => {
    const csv = buildInvoiceCsv(rows);
    const statusCol = csv.split("\n")[1].split(",")[2].replace(/"/g, "");
    expect(["Closed", "Overdue"]).toContain(statusCol);
  });

  it("keeps ISO dates, so the re-upload cannot trip the date guard", () => {
    expect(() => parseInvoiceCsv(buildInvoiceCsv(rows))).not.toThrow();
    expect(buildInvoiceCsv(rows)).toContain("2026-04-30");
  });

  it("preserves the DS, which the parser re-derives from the location column", () => {
    const back = parseInvoiceCsv(buildInvoiceCsv(rows));
    expect(back.map((r) => r.ds)).toEqual(["DS05", "DS01", "DC"]);
  });

  it("preserves a blank pincode as blank rather than inventing one", () => {
    // Attribution falls back to the fulfilling location on a blank pin; fabricating
    // one would silently re-attribute demand to the wrong DS.
    expect(parseInvoiceCsv(buildInvoiceCsv(rows))[2].pin).toBe("");
  });

  it("keeps columns aligned when a field contains a comma AND a quote", () => {
    // Item names legitimately contain both — 'Floor Drain, 5" x 5"' is a real name in
    // the master, and it lands in the Item Name column. This is the property that
    // matters: the comma must NOT split the row and shift every later column.
    //
    // ⚠ Known parseCSV limitation, deliberately not changed here: it toggles on each
    // `"` and drops it, so an embedded quote is silently STRIPPED from the value. That
    // is cosmetic — the affected columns (Item Name, Category Name) are ignored by
    // parseInvoiceCsv, and SKUs/order refs/pincodes never contain quotes. Fixing the
    // un-escaping would touch the parser shared by all six CSV uploaders, which is a
    // change that deserves its own diff and its own coverage.
    const rows = [{ date: "2026-07-28", sku: "SMBTV", ds: "DS01", qty: 1, shopifyOrder: "HR/26/1", pin: "560001" }];
    const master = { SMBTV: { name: 'Floor Drain, 5" x 5"', category: "Sanitary & Bath Fittings" } };
    const back = parseInvoiceCsv(buildInvoiceCsv(rows, master));
    expect(back).toEqual(rows);           // every parsed field still correct
    expect(back).toHaveLength(1);         // the comma did not split the row
  });

  it("returns null for empty input, matching the caller's no-data contract", () => {
    expect(buildInvoiceCsv([])).toBeNull();
    expect(buildInvoiceCsv(null)).toBeNull();
  });
});
