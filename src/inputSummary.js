// The canonical count for each model input — ONE implementation, used by every
// surface that shows these numbers.
//
// WHY THIS EXISTS: the Upload Data cards each counted keys inline, and two of them
// were counting the wrong thing (measured 2026-07-30):
//
//   New DS Floor Qty  card said 1,921 · actual floors 1,021  — 900 entries are `0`,
//                     and a zero floor is the ABSENCE of a floor. 47% overstated.
//   SKU Master        card said 2,105 · active 2,101 — inactive SKUs get no Min/Max,
//                     so counting them answers a question nobody asked.
//   Invoice Data      card said "74,381 rows" — line items, not invoices.
//
// Meanwhile Overview's "Active SKUs" card read 2,106 off the ENGINE RESULTS while the
// master held 2,101, because engine results include SKUs that appear in invoice data
// but not in the master. Two denominators, no way to tell which was right.
//
// So: every count derives from the stored value, which makes it correct whether the
// data arrived from a nightly sync or a manual CSV, and identical on every screen
// because there is only one function per number.
//
// ⚠ Each input has a DIFFERENT shape. Getting these wrong is how the bugs above
// happened, so they are spelled out:
//   invoiceData  Array  [{date, ds, pin, qty, shopifyOrder, sku}]
//   skuMaster    Object {sku: {name, status, category, brand, inventorisedAt}}
//   priceData    Object {sku: number}
//   minReqQty    Object {sku: number}                  <- flat, 0 means "no floor"
//   newSKUQty    Object {sku: {DS: {min, max}}}        <- per-DS, NOT flat
//   deadStock    Array  ["SKU", ...]                   <- array, not a map
//   skuCeiling   Object {sku: {DS: cap}}                <- per-DS; 0 is a REAL cap

const isMap = (v) => v && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Invoices, not rows. Distinct `shopifyOrder`, which is 1:1 with Invoice Number
 *  across the statuses we store (measured 2026-07-30: 571 vs 571 on a full day,
 *  0 invoices spanning multiple orders, 0 orders spanning multiple invoices).
 *
 *  ⚠ BLANKS ARE EXCLUDED, not bucketed. A blank ref would collapse every invoice
 *  that had one into a single "" entry and silently undercount. There are 0 blanks
 *  across all 74,381 stored rows today; `blankRefs` surfaces it if that changes. */
export function invoiceSummary(invoiceData) {
  const rows = Array.isArray(invoiceData) ? invoiceData : [];
  const refs = new Set();
  let blankRefs = 0;
  const dates = new Set();
  for (const r of rows) {
    const ref = (r?.shopifyOrder ?? "").trim();
    if (ref) refs.add(ref); else blankRefs++;
    if (r?.date) dates.add(r.date);
  }
  const sorted = [...dates].sort();
  return {
    count: refs.size, unit: "invoices", label: "Invoice Data",
    rows: rows.length, days: dates.size,
    from: sorted[0] ?? null, through: sorted[sorted.length - 1] ?? null,
    blankRefs,
  };
}

/** Active SKUs. Anything not `active` gets Min=Max=0 everywhere, so it is not
 *  part of what this tool is stocking. Missing status defaults to Active to match
 *  every existing downstream filter (`(status || "Active").toLowerCase()`). */
export function skuMasterSummary(skuMaster) {
  const m = isMap(skuMaster) ? skuMaster : {};
  let count = 0;
  for (const v of Object.values(m)) {
    if (String(v?.status ?? "Active").toLowerCase() === "active") count++;
  }
  return { count, unit: "active SKUs", label: "SKU Master", total: Object.keys(m).length };
}

/** SKUs we actually have a price for. A 0 or missing price is "No Price", which
 *  PCT reads as the 95th percentile — so it is the absence of a price, not a price. */
export function priceSummary(priceData) {
  const m = isMap(priceData) ? priceData : {};
  return {
    count: Object.values(m).filter((v) => num(v) > 0).length,
    unit: "SKUs priced", label: "Purchase Prices", total: Object.keys(m).length,
  };
}

/** SKUs with a New DS floor actually set. ⚠ 900 of 1,921 stored entries are `0`
 *  (measured 2026-07-30) — counting keys here was the single biggest wrong number
 *  on the tab. */
export function dsFloorSummary(minReqQty) {
  const m = isMap(minReqQty) ? minReqQty : {};
  return {
    count: Object.values(m).filter((v) => num(v) > 0).length,
    unit: "SKUs with a floor", label: "New DS Floor Qty", total: Object.keys(m).length,
  };
}

/** SKUs with a per-DS floor set at one or more DS. An entry whose every DS is
 *  0/0 is not a floor, same rule as above applied to the nested shape. */
export function skuFloorSummary(newSKUQty) {
  const m = isMap(newSKUQty) ? newSKUQty : {};
  let count = 0;
  for (const perDS of Object.values(m)) {
    if (!isMap(perDS)) continue;
    if (Object.values(perDS).some((v) => num(v?.min) > 0 || num(v?.max) > 0)) count++;
  }
  return { count, unit: "SKUs with floors", label: "SKU Floors", total: Object.keys(m).length };
}

/** SKU x DS ceilings: `{sku: {DS: cap}}`, where a DS key is present ONLY when capped.
 *
 *  ⚠ COUNTS PRESENCE, NOT TRUTHINESS — the opposite of `dsFloorSummary`, and the
 *  difference is the whole semantics of the input. There a `0` means "no floor", so
 *  zeros are excluded. Here `0` is a REAL cap meaning "stock nothing at this DS", so
 *  `Object.values(perDS).filter(v => v > 0)` would hide exactly the most severe
 *  entries and report "0 SKUs capped" for a file that zeroed six stores. */
export function skuCeilingSummary(skuCeiling) {
  const m = isMap(skuCeiling) ? skuCeiling : {};
  let count = 0, cells = 0, zeroCells = 0;
  for (const perDS of Object.values(m)) {
    if (!isMap(perDS)) continue;
    const caps = Object.values(perDS).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (!caps.length) continue;
    count++;
    cells += caps.length;
    zeroCells += caps.filter((v) => v === 0).length;
  }
  return { count, unit: "SKUs capped", label: "SKU Ceilings", total: Object.keys(m).length, cells, zeroCells };
}

/** Dead stock is stored as an ARRAY of SKU codes, not a map. */
export function deadStockSummary(deadStock) {
  const n = Array.isArray(deadStock) ? new Set(deadStock.filter(Boolean)).size
    : deadStock instanceof Set ? deadStock.size : 0;
  return { count: n, unit: "SKUs", label: "Dead Stock", total: n };
}

/** Everything, keyed the same way `saveTeamData`'s overrides are, so a caller can
 *  look up a summary by the key it just wrote. */
export function summariseInputs({ invoiceData, skuMaster, priceData, minReqQty, newSKUQty, deadStock, skuCeiling }) {
  return {
    invoiceData: invoiceSummary(invoiceData),
    skuMaster:   skuMasterSummary(skuMaster),
    priceData:   priceSummary(priceData),
    minReqQty:   dsFloorSummary(minReqQty),
    newSKUQty:   skuFloorSummary(newSKUQty),
    deadStock:   deadStockSummary(deadStock),
    skuCeiling:  skuCeilingSummary(skuCeiling),
  };
}
