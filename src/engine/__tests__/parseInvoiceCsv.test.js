import { describe, it, expect } from "vitest";
import { parseInvoiceCsv } from "../utils.js";

const HEAD = "Invoice Date,Invoice Number,Invoice Status,Shopify Order,Item Name,SKU,Category Name,Quantity,Line Item Location Name,Shipping Code";

describe("parseInvoiceCsv", () => {
  it("captures the shipping code as pin so attribution can be re-resolved later", () => {
    const csv = `${HEAD}\n2026-07-01,INV1,Closed,HR/26/1,Item A,SKU1,Cement,5,DS02 Bileshivale,560077`;
    expect(parseInvoiceCsv(csv)[0]).toMatchObject({ ds: "DS02", pin: "560077" });
  });

  it("still resolves ds from the fulfilling location, not the pincode", () => {
    const csv = `${HEAD}\n2026-07-01,INV1,Closed,HR/26/1,Item A,SKU1,Cement,5,DS02 Bileshivale,560077`;
    expect(parseInvoiceCsv(csv)[0].ds).toBe("DS02");
  });

  it("yields an empty pin for exports that predate the Shipping Code column", () => {
    const oldHead = "Invoice Date,Invoice Number,Invoice Status,Shopify Order,Item Name,SKU,Category Name,Quantity,Line Item Location Name";
    const csv = `${oldHead}\n2026-07-01,INV1,Closed,HR/26/1,Item A,SKU1,Cement,5,DS02 Bileshivale`;
    expect(parseInvoiceCsv(csv)[0].pin).toBe("");
  });

  it("drops rows the engine cannot use, regardless of shipping code", () => {
    // Unnamed charge lines: no SKU, qty 1 — ~22% of a real Zoho line-item export.
    const csv = `${HEAD}\n2026-07-01,INV1,Closed,HR/26/1,,,,1,DS02 Bileshivale,560077`;
    expect(parseInvoiceCsv(csv)).toHaveLength(0);
  });

  // ── Date-format guard, added 2026-07-29 after a live prod outage.
  //
  // An export wrote the two newest days as DD/MM/YYYY while the older 88 were ISO.
  // The parser stored `Invoice Date` verbatim with no validation, so the mixed row
  // set reached Supabase. String-sorting puts "28/07/2026" AFTER "2026-07-26"
  // ('0' < '8' at index 1), making it look like the latest date — and
  // plywoodNetwork.js does `new Date(latest).toISOString()`, which throws
  // RangeError: Invalid time value on an unparseable date. That threw inside
  // runEngine during the page-load effect, so EVERY user got a blank page, and
  // nobody could reach the Upload tab to fix it because the app crashed before
  // rendering. Recovery needed a Supabase restore.
  //
  // So the parser must refuse the file rather than store it. Rejecting, not
  // auto-correcting: DD/MM vs MM/DD is genuinely ambiguous for days <= 12, and
  // guessing wrong would misattribute demand by weeks — silently.
  describe("date format guard", () => {
    const row = (date) => `${date},INV1,Closed,HR/26/1,Item A,SKU1,Cement,5,DS02 Bileshivale,560077`;

    it("accepts ISO dates, the format every healthy export uses", () => {
      expect(parseInvoiceCsv(`${HEAD}\n${row("2026-07-01")}`)).toHaveLength(1);
    });

    it("throws rather than storing a DD/MM/YYYY date", () => {
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("28/07/2026")}`)).toThrow();
    });

    it("names the offending value so the fix is obvious", () => {
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("28/07/2026")}`)).toThrow(/28\/07\/2026/);
    });

    it("says what format is required", () => {
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("28/07/2026")}`)).toThrow(/YYYY-MM-DD/);
    });

    it("catches the real incident shape — mostly ISO with a couple of bad days", () => {
      const csv = [HEAD, row("2026-07-25"), row("2026-07-26"), row("27/07/2026"), row("28/07/2026")].join("\n");
      expect(() => parseInvoiceCsv(csv)).toThrow(/27\/07\/2026|28\/07\/2026/);
    });

    it("reports how many rows are affected, not just that something is wrong", () => {
      const csv = [HEAD, row("2026-07-25"), row("28/07/2026"), row("28/07/2026")].join("\n");
      expect(() => parseInvoiceCsv(csv)).toThrow(/2 row/);
    });

    it("rejects other plausible locale formats too", () => {
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("07-28-2026")}`)).toThrow();
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("28-Jul-2026")}`)).toThrow();
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("2026/07/28")}`)).toThrow();
    });

    it("rejects a date that is well-formed but not a real calendar day", () => {
      // Passes a regex but new Date() would still give Invalid Date.
      expect(() => parseInvoiceCsv(`${HEAD}\n${row("2026-13-45")}`)).toThrow();
    });

    it("ignores rows that were already dropped, so a blank date is not an error", () => {
      // The unnamed-charge-line row has no SKU and never reaches the engine.
      const csv = `${HEAD}\n,INV1,Closed,HR/26/1,,,,1,DS02 Bileshivale,560077`;
      expect(parseInvoiceCsv(csv)).toHaveLength(0);
    });
  });
});
