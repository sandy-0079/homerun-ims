import { describe, it, expect } from "vitest";
import { mergeInvoiceRows } from "./invoiceMerge.ts";

const row = (date: string, sku = "A") => ({ date, sku, ds: "DS02", qty: 1, shopifyOrder: "o", pin: "560016" });

describe("mergeInvoiceRows", () => {
  it("replaces every row for a fetched date, so edits and voids are picked up", () => {
    const existing = [row("2026-07-25", "OLD"), row("2026-07-26", "OLD")];
    const incoming = [row("2026-07-26", "NEW")];
    const { rows } = mergeInvoiceRows(existing, incoming, ["2026-07-26"], 90);
    expect(rows.filter((r) => r.date === "2026-07-26").map((r) => r.sku)).toEqual(["NEW"]);
  });

  it("leaves dates outside the fetched window completely untouched", () => {
    // The current Zoho org has no invoices before 2026-07-01, so pre-July rows
    // exist ONLY here. Touching a date we did not fetch destroys them for good.
    const existing = [row("2026-05-10", "JUNE_ONLY"), row("2026-07-26", "OLD")];
    const { rows } = mergeInvoiceRows(existing, [row("2026-07-26", "NEW")], ["2026-07-26"], 90);
    expect(rows.filter((r) => r.date === "2026-05-10").map((r) => r.sku)).toEqual(["JUNE_ONLY"]);
  });

  it("clears a fetched date that returns no rows — a fully voided day", () => {
    const existing = [row("2026-07-26", "OLD")];
    const { rows } = mergeInvoiceRows(existing, [], ["2026-07-26"], 90);
    expect(rows).toEqual([]);
  });

  it("trims dates beyond the retention window", () => {
    const existing = [row("2026-01-01"), row("2026-07-25")];
    const { rows, report } = mergeInvoiceRows(existing, [row("2026-07-26")], ["2026-07-26"], 2);
    expect(rows.map((r) => r.date).sort()).toEqual(["2026-07-25", "2026-07-26"]);
    expect(report.datesTrimmed).toBe(1);
  });

  it("reports the run as safe when the only date loss is the retention trim", () => {
    const existing = [row("2026-01-01"), row("2026-07-25")];
    const { report } = mergeInvoiceRows(existing, [row("2026-07-26")], ["2026-07-26"], 2);
    expect(report.safe).toBe(true);
  });

  it("flags the run UNSAFE if dates would vanish for any reason but the trim", () => {
    // A bug in the window logic must not be able to silently shorten history.
    const existing = [row("2026-07-20"), row("2026-07-25")];
    const { report } = mergeInvoiceRows(existing, [], ["2026-07-20", "2026-07-25"], 90);
    expect(report.safe).toBe(false);
    expect(report.datesAfter).toBe(0);
  });

  it("adds a brand-new date without disturbing anything", () => {
    const existing = [row("2026-07-25")];
    const { rows, report } = mergeInvoiceRows(existing, [row("2026-07-26")], ["2026-07-26"], 90);
    expect(rows).toHaveLength(2);
    expect(report.datesBefore).toBe(1);
    expect(report.datesAfter).toBe(2);
    expect(report.safe).toBe(true);
  });

  it("works from an empty store — the shadow row's first ever run", () => {
    const { rows, report } = mergeInvoiceRows([], [row("2026-07-26")], ["2026-07-26"], 90);
    expect(rows).toHaveLength(1);
    expect(report.safe).toBe(true);
  });
});

describe("mergeInvoiceRows — the case the guard exists for", () => {
  it("refuses a bad window that would wipe history the API cannot re-serve", () => {
    // 90 stored dates; a window bug marks them all fetched but only 2 days of
    // rows come back. Pre-2026-07-01 rows exist nowhere else.
    const existing = Array.from({ length: 90 }, (_, i) =>
      ({ date: `2026-0${i < 30 ? 5 : i < 60 ? 6 : 7}-${String((i % 30) + 1).padStart(2, "0")}`, sku: "A", ds: "DS02", qty: 1, shopifyOrder: "o", pin: "560016" }));
    const allDates = [...new Set(existing.map((r) => r.date))];
    const incoming = existing.filter((r) => r.date >= "2026-07-25");
    const { report } = mergeInvoiceRows(existing, incoming, allDates, 90);
    expect(report.safe).toBe(false);
  });
});
