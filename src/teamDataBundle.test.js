import { describe, it, expect } from "vitest";
import { buildTeamDataBundle, BROWSER_OWNED_KEYS } from "./teamDataBundle.js";

const PUBLISHED = "2026-07-30T10:00:00.000Z";

// A realistic `team_data/global` as the sync functions leave it.
const existing = () => ({
  skuMaster: { A: { status: "active" }, B: { status: "active" }, NEW: { status: "active" } },
  priceData: { A: 100, B: 200, NEW: 300 },
  minReqQty: { A: 5 },
  newSKUQty: { A: 2 },
  deadStock: ["Z"],
  stockData: { A: { DS01: { stock_on_hand: 7 } } },
  stockDataAccounting: { A: { DS01: { stock_on_hand: 7 } } },
  poData: { DS01: { A: { qty: 3 } } },
  toData: { DS01: { A: { qty: 4 } } },
  _poCache: { p1: 1 },
  _toCache: { t1: 1 },
  _transferredTodayCache: { x1: 1 },
  stockUploadedAtPerDS: { DS01: "2026-07-30T09:00:00Z" },
  ordersUploadedAt: "2026-07-30T09:20:00Z",
});

const build = (overrides) =>
  buildTeamDataBundle({ existing: existing(), overrides, publishedAt: PUBLISHED });

describe("buildTeamDataBundle", () => {
  it("does NOT rewrite skuMaster when only SKU floors were uploaded", () => {
    // THE REGRESSION THIS EXISTS FOR (2026-07-30). sync-catalogue began writing
    // skuMaster/priceData nightly. saveTeamData rebuilt the whole bundle from React
    // state, so ANY upload wrote a possibly-stale skuMaster back over it. A tab
    // opened before the nightly sync would silently revert the entire catalogue —
    // dropping new SKUs, reverting prices, and re-activating deleted SKUs — while
    // catalogueSyncStatus still reported ok:true with lastOkNight set.
    const b = build({ newSKUQty: { A: 2, NEW: 9 } });

    expect(b.newSKUQty).toEqual({ A: 2, NEW: 9 });
    // Untouched, straight from the fresh read:
    expect(b.skuMaster).toEqual(existing().skuMaster);
    expect(b.priceData).toEqual(existing().priceData);
  });

  it("writes the key that WAS overridden", () => {
    expect(build({ skuMaster: { ONLY: { status: "active" } } }).skuMaster)
      .toEqual({ ONLY: { status: "active" } });
  });

  it("treats an empty override as a deliberate clear, not as absent", () => {
    // The Upload Data tab's clear buttons pass {skuMaster:{}} on purpose. Testing
    // `undefined` rather than falsiness is what keeps clearing possible.
    const b = build({ skuMaster: {} });
    expect(b.skuMaster).toEqual({});
  });

  it("preserves every key the sync functions own", () => {
    const b = build({ minReqQty: { A: 6 } });
    for (const k of ["stockData", "stockDataAccounting", "poData", "toData",
                     "_poCache", "_toCache", "_transferredTodayCache",
                     "stockUploadedAtPerDS", "ordersUploadedAt"]) {
      expect(b[k]).toEqual(existing()[k]);
    }
  });

  it("never writes stockData, even if a caller passes it", () => {
    // The browser only ever READS stock — setStockData is called solely from
    // Supabase reads (initial load, realtime, refresh). Writing it back can only
    // ever lose data the hourly sync just wrote.
    const b = build({ stockData: { HACKED: {} } });
    expect(b.stockData).toEqual(existing().stockData);
  });

  it("never puts invoiceData into the global row", () => {
    // invoiceData lives in team_data/invoice_data. Letting it back in here takes
    // the global payload from ~1-2MB to ~7MB and re-exhausts the Supabase Disk IO
    // burst that the row split was created to fix.
    const b = build({ invoiceData: [{ sku: "A" }] });
    expect(b.invoiceData).toBeUndefined();
  });

  it("serialises deadStock from a Set to an array", () => {
    expect(build({ deadStock: new Set(["X", "Y"]) }).deadStock).toEqual(["X", "Y"]);
  });

  it("passes an already-array deadStock through unchanged", () => {
    expect(build({ deadStock: ["X"] }).deadStock).toEqual(["X"]);
  });

  it("stamps publishedAt", () => {
    expect(build({ minReqQty: {} }).publishedAt).toBe(PUBLISHED);
  });

  it("writes nothing but publishedAt when there are no overrides", () => {
    const b = build({});
    expect(b).toEqual({ ...existing(), publishedAt: PUBLISHED });
  });

  it("lists exactly the keys the browser may write", () => {
    // Guard rail: adding a key here means the browser can clobber it, so it must
    // be a key no edge function writes. Change deliberately, not incidentally.
    expect([...BROWSER_OWNED_KEYS].sort()).toEqual(
      ["deadStock", "minReqQty", "newSKUQty", "priceData", "skuCeiling", "skuMaster"],
    );
  });

  it("writes skuCeiling only when the caller passed it", () => {
    // The whole point of the 96a1bf4 rewrite: an unrelated save must not rewrite
    // ceilings from whatever React state happened to be holding.
    expect(build({ minReqQty: { A: 1 } }).skuCeiling).toBeUndefined();
    expect(build({ skuCeiling: { G9NYZ: { DS05: 5 } } }).skuCeiling).toEqual({ G9NYZ: { DS05: 5 } });
  });

  it("treats an empty skuCeiling as a deliberate clear, not as 'unchanged'", () => {
    // The Upload Data clear button passes `{}`. Testing falsiness here would make
    // "remove every ceiling" silently impossible.
    expect(build({ skuCeiling: {} }).skuCeiling).toEqual({});
  });

  it("tolerates a missing/empty existing payload", () => {
    const b = buildTeamDataBundle({ overrides: { minReqQty: { A: 1 } }, publishedAt: PUBLISHED });
    expect(b).toEqual({ minReqQty: { A: 1 }, publishedAt: PUBLISHED });
  });
});
