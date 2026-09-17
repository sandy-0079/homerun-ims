import { describe, it, expect } from "vitest";
import {
  ZERO_SALE_CSV_HEADERS, ZERO_SALE_WINDOWS,
  summariseZeroSale, buildZeroSaleCsv, zeroSaleFilename,
} from "./zeroSaleCsv.js";

/* ── Fixtures ──────────────────────────────────────────────────────────────
   Deliberately tiny windows (2/3/4 dates) rather than 60/75/90: the module must
   not care what the numbers are, and a 90-date fixture would hide an off-by-one
   behind noise. The nesting property is what matters, not the magnitudes.       */


const master = {
  SOLD_RECENT: { sku: "SOLD_RECENT", name: "Sold yesterday", category: "Tiling", brand: "MYK", status: "active", inventorisedAt: "DC" },
  SOLD_OLD:    { sku: "SOLD_OLD",    name: "Sold long ago",  category: "Tiling", brand: "MYK", status: "active", inventorisedAt: "DC" },
  NEVER:       { sku: "NEVER",       name: "Never sold",     category: "Tiling", brand: "MYK", status: "active", inventorisedAt: "DC" },
  INACTIVE:    { sku: "INACTIVE",    name: "Deactivated",    category: "Tiling", brand: "MYK", status: "inactive", inventorisedAt: "DC" },
  NO_STATUS:   { sku: "NO_STATUS",   name: "Status omitted", category: "Tiling", brand: "MYK", inventorisedAt: "DC" },
};

// ⚠ A window is "the last N DATES PRESENT IN THE DATA", so a date with no invoice row
// does not exist as far as the slice is concerned. FILLER therefore has to occupy the
// middle dates or `slice(-2)` would reach straight back to 01-01 and the test below
// would assert nothing. (It is absent from the master on purpose: unknown SKUs really
// do appear in invoice data, and they must never reach the output.)
//
// SOLD_OLD sells only on the OLDEST date, so it is inside a 4-date window and outside
// a 2-date one — the one row that proves the slice is doing real work.
const invoiceData = [
  { date: "2026-01-04", sku: "SOLD_RECENT", ds: "DS01", qty: 1 },
  { date: "2026-01-03", sku: "FILLER",      ds: "DS01", qty: 1 },
  { date: "2026-01-02", sku: "FILLER",      ds: "DS01", qty: 1 },
  { date: "2026-01-01", sku: "SOLD_OLD",    ds: "DS01", qty: 1 },
];

const skusIn = (summary, days) => summary.windows.find((w) => w.days === days).skus.map((s) => s.sku);

/** Strict-ish RFC4180 reader. A naive split(",") passes on clean data and hides
 *  exactly the escaping bug this module has to avoid, so tests parse properly. */
const parseRow = (line) => {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
};

describe("ZERO_SALE_CSV_HEADERS", () => {
  it("is the SKU Master column set minus Top N, in order", () => {
    expect(ZERO_SALE_CSV_HEADERS).toEqual([
      "Item Name", "Inventorised At", "SKU", "Category",
      "Status", "Purchase", "Move", "Brand", "Price Tag",
    ]);
  });

  it("does not carry Top N — it is a windowed engine verdict, not a catalogue fact", () => {
    expect(ZERO_SALE_CSV_HEADERS).not.toContain("Top N");
  });

  it("offers the three windows the operator asked for", () => {
    expect(ZERO_SALE_WINDOWS).toEqual([60, 75, 90]);
  });
});

describe("summariseZeroSale — window membership", () => {
  const summary = summariseZeroSale({ invoiceData, skuMaster: master, windows: [2, 4] });

  it("excludes a SKU with an invoice row inside the window", () => {
    expect(skusIn(summary, 2)).not.toContain("SOLD_RECENT");
  });

  it("includes a SKU whose only row falls OUTSIDE the window", () => {
    // SOLD_OLD sold on 01-01; the 2-date window is 01-03..01-04.
    expect(skusIn(summary, 2)).toContain("SOLD_OLD");
  });

  it("excludes that same SKU once the window widens to reach its row", () => {
    expect(skusIn(summary, 4)).not.toContain("SOLD_OLD");
  });

  it("includes a SKU that never sold, in every window", () => {
    expect(skusIn(summary, 2)).toContain("NEVER");
    expect(skusIn(summary, 4)).toContain("NEVER");
  });

  it("never emits an inactive SKU", () => {
    expect(skusIn(summary, 2)).not.toContain("INACTIVE");
    expect(skusIn(summary, 4)).not.toContain("INACTIVE");
  });

  it("never emits a SKU that is absent from the master", () => {
    // FILLER appears in invoice data only. `assessCoverage` tolerates ~0.1% of these
    // (orphaned pre-July codes from the Zoho re-code); they have no category, brand or
    // status, so they must not reach a catalogue file.
    expect(skusIn(summary, 2)).not.toContain("FILLER");
    expect(skusIn(summary, 4)).not.toContain("FILLER");
  });

  it("counts a MISSING status as active", () => {
    // The established (status || "active") convention for a master row that omits
    // the field — distinct from a SKU absent from the master entirely.
    expect(skusIn(summary, 2)).toContain("NO_STATUS");
  });

  it("nests: every SKU zero-sale over the WIDER window is zero-sale over the narrower one", () => {
    const wide = new Set(skusIn(summary, 4));
    const narrow = new Set(skusIn(summary, 2));
    for (const sku of wide) expect(narrow.has(sku)).toBe(true);
  });
});

describe("summariseZeroSale — window resolution", () => {
  it("resolves each window to the last N DATES PRESENT, matching runEngine's slice", () => {
    const s = summariseZeroSale({ invoiceData, skuMaster: master, windows: [2] });
    const w = s.windows[0];
    expect(w.from).toBe("2026-01-03");
    expect(w.to).toBe("2026-01-04");
    expect(w.dateCount).toBe(2);
  });

  it("reports the newest date and the total dates held", () => {
    const s = summariseZeroSale({ invoiceData, skuMaster: master, windows: [2] });
    expect(s.latest).toBe("2026-01-04");
    expect(s.dateCount).toBe(4);
  });

  it("marks a window UNAVAILABLE when fewer dates exist than it asks for", () => {
    // RETENTION_DAYS = 90 is the ceiling, so L90D sits permanently at the edge:
    // one bad night makes it short, and a file named L90D holding 84 days lies.
    const s = summariseZeroSale({ invoiceData, skuMaster: master, windows: [90] });
    expect(s.windows[0].available).toBe(false);
    expect(s.windows[0].dateCount).toBe(4);
  });

  it("marks a window available when exactly enough dates exist", () => {
    const s = summariseZeroSale({ invoiceData, skuMaster: master, windows: [4] });
    expect(s.windows[0].available).toBe(true);
  });

  it("survives an empty invoice row without throwing", () => {
    const s = summariseZeroSale({ invoiceData: [], skuMaster: master, windows: [60] });
    expect(s.dateCount).toBe(0);
    expect(s.latest).toBe(null);
    expect(s.windows[0].available).toBe(false);
  });

  it("sorts Category -> Brand -> Item Name, matching the Reverse TO list", () => {
    const m = {
      C: { sku: "C", name: "Alpha", category: "Zinc",  brand: "AA", status: "active" },
      A: { sku: "A", name: "Beta",  category: "Acid",  brand: "BB", status: "active" },
      B: { sku: "B", name: "Gamma", category: "Acid",  brand: "AA", status: "active" },
    };
    const s = summariseZeroSale({ invoiceData, skuMaster: m, windows: [2] });
    expect(skusIn(s, 2)).toEqual(["B", "A", "C"]);
  });
});

describe("buildZeroSaleCsv", () => {
  const priceTiers = [3000, 1500, 400, 100];
  const build = (skus, priceData = {}) => buildZeroSaleCsv({ skus, priceData, priceTiers });

  // ⚠ Header UNQUOTED and a trailing newline, both deliberate: they make the output
  // byte-identical to scripts/adhoc-zero-sale-lists.mjs, the oracle this card is
  // verified against. A difference that has to be explained away is exactly the noise
  // that hides a real one. (poTargetsCsv quotes its header; it has no oracle to match,
  // and this column set is explicitly NOT a frozen contract.)
  it("emits the header row first, unquoted", () => {
    const csv = build([master.NEVER]);
    expect(csv.split("\n")[0]).toBe(ZERO_SALE_CSV_HEADERS.join(","));
  });

  it("ends with a trailing newline", () => {
    expect(build([master.NEVER]).endsWith("\n")).toBe(true);
  });

  it("emits exactly 9 fields per row", () => {
    const csv = build([master.NEVER, master.SOLD_OLD]);
    for (const line of csv.trimEnd().split("\n")) expect(parseRow(line)).toHaveLength(9);
  });

  it("normalises Status rather than leaking Zoho's four spellings", () => {
    const csv = build([{ ...master.NEVER, status: "confirmation_pending" }]);
    expect(parseRow(csv.split("\n")[1])[4]).toBe("Confirmation Pending");
  });

  it("renders a blank Purchase/Move as Yes — blank means yes, the opposite of status", () => {
    const csv = build([master.NEVER]);
    const row = parseRow(csv.split("\n")[1]);
    expect(row[5]).toBe("Yes");
    expect(row[6]).toBe("Yes");
  });

  it("canonicalises the two DIFFERENT Zoho vocabularies into one spelling", () => {
    // cf_purchase_status speaks ON/OFF; cf_move speaks Yes/No.
    const csv = build([{ ...master.NEVER, purchase: "OFF", move: "No" }]);
    const row = parseRow(csv.split("\n")[1]);
    expect(row[5]).toBe("No");
    expect(row[6]).toBe("No");
  });

  it("derives Price Tag from priceData, and reads an unpriced SKU as No Price", () => {
    const csv = build([master.NEVER, master.SOLD_OLD], { NEVER: 5000 });
    expect(parseRow(csv.split("\n")[1])[8]).toBe("Premium");
    expect(parseRow(csv.split("\n")[2])[8]).toBe("No Price");
  });

  it("round-trips an item name carrying BOTH a comma and a quote", () => {
    const name = `Ashirvad CPVC Adaptor FABT, 11, 2"`;
    const csv = build([{ ...master.NEVER, name }]);
    const row = parseRow(csv.split("\n")[1]);
    expect(row).toHaveLength(9);
    expect(row[0]).toBe(name);
  });

  it("returns null when there is nothing to write", () => {
    expect(build([])).toBe(null);
  });
});

describe("zeroSaleFilename", () => {
  it("names the RESOLVED date range, so the file cannot assert a duration it lacks", () => {
    expect(zeroSaleFilename({ days: 60, from: "2026-07-19", to: "2026-09-16" }))
      .toBe("Zero_Sale_SKUs_L60D_2026-07-19_to_2026-09-16.csv");
  });

  it("degrades to 'unknown' rather than emitting a malformed date", () => {
    expect(zeroSaleFilename({ days: 90, from: null, to: undefined }))
      .toBe("Zero_Sale_SKUs_L90D_unknown_to_unknown.csv");
  });
});
