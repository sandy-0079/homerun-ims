import { describe, it, expect } from "vitest";
import { isSellableStatus, mapInvoiceToRows, assessCoverage, istDateRange } from "./invoiceMap.ts";

// Shape mirrors a real GET /invoices/{id} response (probe, 2026-07-27).
const invoice = (over: Record<string, unknown> = {}) => ({
  date: "2026-07-15",
  status: "paid",
  reference_number: "HR/26/87724",
  location_name: "DS02 Bileshivale",
  shipping_address: { zip: "560016", city: "Bengaluru" },
  line_items: [
    { sku: "SKU1", quantity: 3, location_name: "DS02 Bileshivale", item_id: "i1", name: "Item 1" },
  ],
  ...over,
});

describe("isSellableStatus", () => {
  // ⚠ INVERTED 2026-07-29 from an allowlist {paid, overdue} to a blocklist
  // {void, draft}. The allowlist was derived from a 7-day HISTORICAL probe, which
  // can only ever observe terminal statuses — and it silently discarded a quarter
  // of every same-day pull.
  //
  // Measured live on 2026-07-29 at ~12:00 IST, 224 invoices in flight:
  //   paid 112 (50%)   partially_paid 86 (38%)   sent 26 (12%)
  // Neither partially_paid nor sent was in the allowlist, so half a live day was
  // thrown away. The 07-28 nightly run lost 27.7% of quantity this way.
  //
  // The model measures DEMAND: the goods left the shelf. Payment state is an
  // accounts fact. Only void (cancelled) and draft (not yet a sale) are not demand.
  it("treats paid as sellable — the API's spelling of the CSV's Closed", () => {
    expect(isSellableStatus("paid")).toBe(true);
  });

  it("treats overdue as sellable", () => {
    expect(isSellableStatus("overdue")).toBe(true);
  });

  it("treats partially_paid as sellable — 38% of a live day", () => {
    expect(isSellableStatus("partially_paid")).toBe(true);
  });

  it("treats sent as sellable — raised but unpaid is still stock that left", () => {
    expect(isSellableStatus("sent")).toBe(true);
  });

  it("treats a status we have never seen as sellable, so Zoho cannot silently delete demand", () => {
    // The whole point of the inversion: an allowlist fails closed on demand, which
    // is the expensive direction. A blocklist fails open, which is recoverable.
    expect(isSellableStatus("unpaid")).toBe(true);
    expect(isSellableStatus("viewed")).toBe(true);
  });

  it("still rejects void — a cancelled invoice is not demand", () => {
    expect(isSellableStatus("void")).toBe(false);
  });

  it("still rejects draft — not yet a sale", () => {
    expect(isSellableStatus("draft")).toBe(false);
  });

  it("rejects a missing status rather than assuming a sale", () => {
    expect(isSellableStatus("")).toBe(false);
    expect(isSellableStatus(undefined as unknown as string)).toBe(false);
  });

  it("normalises case and whitespace", () => {
    expect(isSellableStatus("  VOID ")).toBe(false);
    expect(isSellableStatus("  Partially_Paid ")).toBe(true);
  });
});

describe("mapInvoiceToRows", () => {
  it("produces the engine's row shape", () => {
    expect(mapInvoiceToRows(invoice())).toEqual([
      { date: "2026-07-15", sku: "SKU1", ds: "DS02", qty: 3, shopifyOrder: "HR/26/87724", pin: "560016" },
    ]);
  });

  it("takes ds from the line item, matching how the CSV path resolves it", () => {
    const inv = invoice({
      location_name: "DS02 Bileshivale",
      line_items: [{ sku: "SKU1", quantity: 1, location_name: "DS05 Basavanapura" }],
    });
    expect(mapInvoiceToRows(inv)[0].ds).toBe("DS05");
  });

  it("falls back to the header location when a line item has none", () => {
    const inv = invoice({ line_items: [{ sku: "SKU1", quantity: 1 }] });
    expect(mapInvoiceToRows(inv)[0].ds).toBe("DS02");
  });

  it("drops unnamed charge lines — ~22% of a real export has no SKU", () => {
    const inv = invoice({
      line_items: [
        { sku: "SKU1", quantity: 2, location_name: "DS02 X" },
        { sku: "", quantity: 1, location_name: "DS02 X" },
      ],
    });
    expect(mapInvoiceToRows(inv).map((r) => r.sku)).toEqual(["SKU1"]);
  });

  it("drops non-positive quantities", () => {
    const inv = invoice({ line_items: [{ sku: "SKU1", quantity: 0, location_name: "DS02 X" }] });
    expect(mapInvoiceToRows(inv)).toEqual([]);
  });

  it("returns nothing for a void invoice, whatever its line items say", () => {
    expect(mapInvoiceToRows(invoice({ status: "void" }))).toEqual([]);
  });

  it("yields an empty pin rather than undefined when there is no shipping zip", () => {
    // Attribution falls back to the fulfilling location on a falsy pin, so this
    // must be "" and not undefined — the stored rows feed applyAttribution.
    expect(mapInvoiceToRows(invoice({ shipping_address: {} }))[0].pin).toBe("");
  });

  it("handles an invoice with no line items at all", () => {
    expect(mapInvoiceToRows(invoice({ line_items: undefined }))).toEqual([]);
  });
});

describe("assessCoverage", () => {
  const rows = (skus: string[]) => skus.map((sku) => ({ date: "d", sku, ds: "DS02", qty: 1, shopifyOrder: "o", pin: "560016" }));
  const master = new Set(["A", "B"]);

  it("passes a clean pull", () => {
    const r = assessCoverage(rows(["A", "B", "A"]), master, 1);
    expect(r).toMatchObject({ unknownPct: 0, ok: true });
  });

  it("fails the pull when too many SKUs are missing from the master", () => {
    // The 2026-07-01 re-code put 39.6% of rows on codes skuMaster had never seen.
    // Healthy runs measure 0.08-0.1%, so 1% leaves ~10x headroom.
    const r = assessCoverage(rows(["A", "X", "Y", "Z"]), master, 1);
    expect(r.ok).toBe(false);
    expect(r.unknownPct).toBe(75);
  });

  it("names the worst offenders so the failure is actionable", () => {
    const r = assessCoverage(rows(["X", "X", "X", "Y", "A"]), master, 1);
    expect(r.topUnknown[0]).toEqual(["X", 3]);
  });

  it("stays under the threshold at a realistic healthy rate", () => {
    const skus = [...Array(999).fill("A"), "UNKNOWN"];
    expect(assessCoverage(rows(skus), master, 1).ok).toBe(true);
  });

  it("treats an empty pull as a failure — a night with no invoices is not normal", () => {
    expect(assessCoverage([], master, 1).ok).toBe(false);
  });
});

describe("istDateRange", () => {
  // The cron fires 15:00 UTC = 20:30 IST, after the 8pm trading close. Two days
  // gives a one-day overlap so late-evening invoices missed by the previous run
  // are picked up, at ~1,100 invoices / ~80s — still inside one invocation.
  const at = (iso: string) => Date.parse(iso);

  it("returns today and yesterday in IST for a 2-day window", () => {
    expect(istDateRange(at("2026-07-27T15:00:00Z"), 2)).toEqual({ from: "2026-07-26", to: "2026-07-27" });
  });

  it("uses the IST calendar day, not UTC's", () => {
    // 19:00 UTC on the 27th is already 00:30 IST on the 28th.
    expect(istDateRange(at("2026-07-27T19:00:00Z"), 1)).toEqual({ from: "2026-07-28", to: "2026-07-28" });
  });

  it("handles a single-day window", () => {
    expect(istDateRange(at("2026-07-27T15:00:00Z"), 1)).toEqual({ from: "2026-07-27", to: "2026-07-27" });
  });

  it("crosses a month boundary correctly", () => {
    expect(istDateRange(at("2026-08-01T15:00:00Z"), 3)).toEqual({ from: "2026-07-30", to: "2026-08-01" });
  });

  // ── endOffsetDays: added 2026-07-29 for the overnight schedule.
  //
  // The pull moved from 21:30 IST to 00:50-04:00 IST so it runs against a settled
  // day. At those hours the IST calendar day has just rolled over, so "today" holds
  // ~zero invoices — and assessCoverage treats an empty pull as a failure by design
  // (`ok: rows.length > 0 && ...`). Worse, the early return in sync-invoices does not
  // clear the cursor, so an empty date would be retried by every slot, forever.
  //
  // endOffsetDays shifts the whole window back so it ends on the last COMPLETE day.
  describe("endOffsetDays", () => {
    it("returns yesterday IST only, for the overnight one-date pull", () => {
      // 19:20 UTC on the 29th is 00:50 IST on the 30th; the settled day is the 29th.
      expect(istDateRange(at("2026-07-29T19:20:00Z"), 1, 1)).toEqual({ from: "2026-07-29", to: "2026-07-29" });
    });

    it("resolves to the same date across every slot in the overnight window", () => {
      // All 8 cron firings (19:05-22:20 UTC) must agree, or chunking would switch
      // dates mid-drain and the buffer would mix two days.
      const first = istDateRange(at("2026-07-29T19:05:00Z"), 1, 1);
      const last = istDateRange(at("2026-07-29T22:20:00Z"), 1, 1);
      expect(first).toEqual({ from: "2026-07-29", to: "2026-07-29" });
      expect(last).toEqual(first);
    });

    it("shifts a multi-day window back as a whole", () => {
      expect(istDateRange(at("2026-07-29T19:20:00Z"), 2, 1)).toEqual({ from: "2026-07-28", to: "2026-07-29" });
    });

    it("crosses a month boundary with the offset applied", () => {
      // 19:20 UTC on 31 Jul is 00:50 IST on 1 Aug; the settled day is 31 Jul.
      expect(istDateRange(at("2026-07-31T19:20:00Z"), 1, 1)).toEqual({ from: "2026-07-31", to: "2026-07-31" });
    });

    it("defaults to no offset so existing callers are unchanged", () => {
      expect(istDateRange(at("2026-07-27T15:00:00Z"), 2)).toEqual(istDateRange(at("2026-07-27T15:00:00Z"), 2, 0));
    });
  });
});
