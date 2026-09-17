// Zero Sale SKUs download — the Active SKUs that sold NOTHING, anywhere, over a
// trailing window. Three windows (60 / 75 / 90 days) as separate files.
//
// ⚠⚠ DO NOT REACH FOR `results[sku].meta.t150Tag === "Zero Sale"`. It exists, it says
// exactly these words, and it answers a DIFFERENT question. That tag is computed over
// `invSliced = allDatesRaw.slice(-overallPeriod)` (runEngine.js:105-112) and
// `overallPeriod` is 45 live — so it is an L45D verdict. Wiring three buttons to it
// yields three IDENTICAL files containing the 45-day answer, labelled 60/75/90. Every
// count looks plausible, every column is right, nothing fails. That is why this module
// recomputes from raw invoice rows and never imports the engine's results.
// (Same shape as the `maxBufferPercentile` post-mortem: a coherent-looking value
// already in scope that answers a different question than the one being asked.)
//
// ⚠ RAW `invoiceData` IS CORRECT HERE — do not "fix" this to `attributedInvoice`.
// CLAUDE.md says any tab reading `invoiceData` should take the attributed rows. That
// rule exists for anything grouping by `r.ds`. Zero-sale asks "did this SKU sell
// ANYWHERE?", so the membership test reads `r.sku` alone and never `r.ds`;
// `applyAttribution` only ever RELABELS `r.ds`, dropping no rows and creating none.
// Raw and attributed inputs therefore produce byte-identical output, and passing the
// attributed rows would imply a dependency that does not exist. Same reasoning as
// OverviewTab's raw input.
//
// ⚠ A SKU created last week is indistinguishable from one dead for a year: `skuMaster`
// has NO created-date field (sku, name, category, brand, status, inventorisedAt,
// purchase, move). The master grew 2,573 -> 2,781 between 2026-09-07 and 2026-09-16,
// so genuinely-new SKUs ARE in these lists. Accepted by the operator; surfaced in the
// card blurb, because a delisting decision made from an unqualified list is the
// failure mode.
//
// Output is byte-identical to scripts/adhoc-zero-sale-lists.mjs, the oracle this was
// verified against — hence the unquoted header and trailing newline.

import { normaliseStatus } from "./skuStatus.js";
import { normalisePolicy } from "./skuPolicy.js";
import { getPriceTag } from "./engine/utils.js";

/** The SKU Master download's columns minus `Top N`.
 *
 *  `Top N` is deliberately absent: it is `meta.t150Tag`, an L45D engine verdict, so it
 *  would contradict the window named in the filename.
 *
 *  ⚠ Unlike `PO_CSV_HEADERS` this is NOT a frozen contract — nobody's sheet formulas
 *  key on these positions. Pinned by a test for regression safety only; do not carry
 *  the PO file's append-only ceremony into it. */
export const ZERO_SALE_CSV_HEADERS = [
  "Item Name",
  "Inventorised At",
  "SKU",
  "Category",
  "Status",
  "Purchase",
  "Move",
  "Brand",
  "Price Tag",
];

/** The windows the operator asked for. 90 is the hard ceiling: `RETENTION_DAYS = 90`
 *  in sync-invoices trims the invoice row nightly, so L90D sits permanently at the
 *  edge of the data and is the first to go unavailable after a bad night. */
export const ZERO_SALE_WINDOWS = [60, 75, 90];

// Item names carry commas AND apostrophes AND quotes
// (`Ashirvad CPVC Brass Female Threaded Adaptor FABT, 11, 2''`). One unescaped comma
// shifts that row alone, which no eyeball catches in a 550-row file.
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** The engine's allowlist is exactly `"active"`. A MISSING status counts as active —
 *  the established `(status || "Active")` convention for a master row that omits the
 *  field, and distinct from a SKU absent from the master entirely. */
const isActive = (s) => (s?.status || "active").toLowerCase() === "active";

/** Category -> Brand -> Item Name, the same ordering the Reverse TO list uses, so a
 *  reviewer walks the catalogue in coherent groups rather than by SKU code. */
const byCatBrandName = (a, b) =>
  (a.category || "").localeCompare(b.category || "") ||
  (a.brand || "").localeCompare(b.brand || "") ||
  (a.name || "").localeCompare(b.name || "");

/**
 * Resolve every window in one pass over the invoice rows.
 *
 * ⚠ A window is the last N DATES PRESENT IN THE DATA, not a calendar subtraction —
 * exactly what `allDates = allDatesRaw.slice(-op)` does (runEngine.js:77-78), so this
 * card and the engine cannot disagree about what a window is. The two readings
 * coincide only while the invoice row is contiguous (it is today: 90 dates over a
 * 90-day span). A gap would stretch the window further back in calendar time, which is
 * why `from`/`to` are returned and named in the filename rather than asserting "60
 * days" and hoping.
 *
 * @param {Array}  invoiceData raw rows `{date, sku, ds, qty, ...}` — NOT attributed
 * @param {object} skuMaster   `{ [sku]: {sku, name, category, brand, status, ...} }`
 * @param {number[]} windows   trailing window sizes, in dates
 * @returns {{dateCount:number, latest:string|null, activeCount:number, windows:Array}}
 *   each window: `{days, from, to, dateCount, available, skus}` — `skus` are the full
 *   master rows, already sorted, and `available` is false when fewer dates exist than
 *   the window asks for.
 */
export function summariseZeroSale({ invoiceData, skuMaster, windows = ZERO_SALE_WINDOWS } = {}) {
  const inv = invoiceData || [];
  const master = skuMaster || {};

  const dates = [...new Set(inv.map((r) => r.date))].sort();
  const latest = dates.length ? dates[dates.length - 1] : null;

  const active = Object.values(master).filter(isActive).sort(byCatBrandName);

  const specs = (windows || []).map((days) => {
    const span = dates.slice(-days);
    return {
      days,
      from: span[0] ?? null,
      to: span[span.length - 1] ?? null,
      dateCount: span.length,
      // Short window => the button is refused rather than silently emitting a file
      // whose name claims a duration it does not cover.
      available: dates.length >= days && days > 0,
      _span: new Set(span),
      _sold: new Set(),
    };
  });

  // ONE pass over ~100k rows with a membership test per window (3 today), rather than
  // one full pass per window.
  for (const r of inv) {
    for (const s of specs) if (s._span.has(r.date)) s._sold.add(r.sku);
  }

  return {
    dateCount: dates.length,
    latest,
    activeCount: active.length,
    // Built explicitly rather than by rest-destructuring the private `_span`/`_sold`
    // away — the discarded binding reads as dead code to eslint, and a lint error
    // parked in the baseline is one nobody looks at again.
    windows: specs.map((w) => ({
      days: w.days,
      from: w.from,
      to: w.to,
      dateCount: w.dateCount,
      available: w.available,
      skus: active.filter((s) => !w._sold.has(s.sku)),
    })),
  };
}

/**
 * Render resolved master rows as CSV.
 *
 * `Price Tag` is WINDOW-INDEPENDENT — derived from `priceData`, not from demand — so it
 * is identical across all three files and only the row set varies. It is computed here
 * rather than read from `results[sku].meta.priceTag` so this module never touches
 * engine output at all (see the t150Tag warning at the top).
 *
 * @returns {string|null} CSV text with a trailing newline, or null if there is nothing
 *   to write — callers must handle null rather than downloading an empty file.
 */
export function buildZeroSaleCsv({ skus, priceData, priceTiers } = {}) {
  const rows = skus || [];
  if (!rows.length) return null;
  const prices = priceData || {};

  const lines = rows.map((s) =>
    [
      q(s.name),
      q(s.inventorisedAt),
      q(s.sku),
      q(s.category),
      // The three formatters below are the REAL ones, shared with the PO Team Download
      // and the SKU Master CSV. Zoho sends four status spellings, and the two policy
      // fields speak DIFFERENT vocabularies (cf_purchase_status is ON/OFF, cf_move is
      // Yes/No) — a sheet formula on `="Active"` or `="Yes"` would match nothing.
      q(normaliseStatus(s.status)),
      q(normalisePolicy(s.purchase)),
      q(normalisePolicy(s.move)),
      q(s.brand),
      q(getPriceTag(prices[s.sku] || 0, priceTiers)),
    ].join(","),
  );

  return [ZERO_SALE_CSV_HEADERS.join(","), ...lines].join("\n") + "\n";
}

/**
 * Filename carrying the RESOLVED date range.
 *
 * The window is "the last N dates present", so `L90D` is a claim the data can fail to
 * back — after a bad night or a restore it could cover 84 days. Naming the real range
 * makes the file state what it covers instead of asserting a duration. It goes in the
 * filename rather than a comment row because a row above the header breaks
 * paste-into-sheet — the same reason the PO file puts its dates here.
 */
export function zeroSaleFilename({ days, from, to }) {
  const safe = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? "")) ? d : "unknown");
  return `Zero_Sale_SKUs_L${days}D_${safe(from)}_to_${safe(to)}.csv`;
}
