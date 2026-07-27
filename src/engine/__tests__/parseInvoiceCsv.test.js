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
});
