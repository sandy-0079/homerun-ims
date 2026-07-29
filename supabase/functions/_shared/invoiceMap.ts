// Pure mapping from Zoho Inventory invoice payloads to the engine's invoiceData
// row shape. Kept free of fetch/Deno so it can be unit-tested alongside the rest
// of the suite (see invoiceMap.test.ts).
//
// ⚠ The Inventory API's status vocabulary is NOT the CSV export's. The engine has
// always filtered ["Closed","Overdue"]; the API returns paid/overdue/void/draft.
// `paid` IS the API's spelling of Closed — measured 2026-07-27: 3,533 paid vs
// 58 overdue vs 32 void over 7 days. Filtering on the CSV words drops ~97% of rows.
//
// ⚠⚠ THAT MEASUREMENT WAS TAKEN OVER SETTLED DAYS, AND GENERALISED TOO FAR.
// A historical window contains only terminal statuses, so it structurally cannot
// observe the states a live invoice passes through. Measured 2026-07-29 at ~12:00
// IST over 224 in-flight invoices:
//
//     paid 112 (50%)     partially_paid 86 (38%)     sent 26 (12%)
//
// The old allowlist {paid, overdue} discarded half of that. The 2026-07-28 nightly
// run lost 312 rows / 2,081 units — 27.7% of the day's quantity — entirely this way,
// while reporting ok:true, because assessCoverage only measures the unknown-SKU rate
// among rows that arrived and a dropped invoice contributes none.
//
// So this is now a BLOCKLIST, deliberately. The model measures DEMAND: if the goods
// left the shelf, that is demand regardless of whether the customer has paid. Only
// `void` (cancelled) and `draft` (not yet a sale) are not demand. An allowlist fails
// closed on demand — expensive and silent. A blocklist fails open — a future Zoho
// status is counted rather than vanishing, and over-counting is visible and
// correctable, which under-counting is not.
//
// A missing status is still rejected: absent data is not evidence of a sale.

const NOT_DEMAND = new Set(["void", "draft"]);

export function isSellableStatus(status: string): boolean {
  const s = (status || "").trim().toLowerCase();
  return s !== "" && !NOT_DEMAND.has(s);
}

export type InvoiceRow = {
  date: string; sku: string; ds: string; qty: number; shopifyOrder: string; pin: string;
};

// DS code from a Zoho location string, matching src/engine/utils.js exactly:
// first whitespace-delimited token, uppercased ("DS02 Bileshivale" -> "DS02").
const dsOf = (s?: string) => (s || "").trim().split(/\s+/)[0].toUpperCase();

export function mapInvoiceToRows(inv: any): InvoiceRow[] {
  if (!inv || !isSellableStatus(inv.status)) return [];
  const date = inv.date || "";
  // Shipping Code == shipping_address.zip (a Bangalore pincode). Must be "" and
  // never undefined: applyAttribution falls back to the fulfilling DS on a falsy
  // pin, and undefined would also vanish through JSON round-tripping.
  const pin = (inv.shipping_address?.zip || "").toString().trim();
  const shopifyOrder = (inv.reference_number || "").toString().trim();
  const headerDs = dsOf(inv.location_name);

  const out: InvoiceRow[] = [];
  for (const li of inv.line_items || []) {
    const sku = (li?.sku || "").toString().trim();
    const qty = parseFloat(li?.quantity ?? 0);
    // Unnamed charge lines carry a quantity but no SKU — ~22% of a real export.
    // The CSV path drops them too, so the two sources stay comparable.
    if (!date || !sku || !(qty > 0)) continue;
    out.push({ date, sku, ds: dsOf(li.location_name) || headerDs, qty, shopifyOrder, pin });
  }
  return out;
}

// The guard that would have caught the 2026-07-01 SKU re-code automatically.
//
// On that day an invoice export preserved the code as at invoice time rather than
// the item's current code, so ~1,090 products split across two identities and
// 39.6% of window rows landed on codes absent from skuMaster. Nothing noticed for
// an hour, because the only symptom is counterintuitive: volume UP, value DOWN.
//
// Deliberately checked against the SKU master rather than solved with a stabler
// key (e.g. item_id). An item deleted and recreated in Zoho gets a NEW item_id
// too, so no identifier scheme survives a catalogue rebuild — but this check
// fires on any divergence, including ones we haven't seen yet.
export function assessCoverage(
  rows: InvoiceRow[],
  knownSkus: Set<string>,
  thresholdPct: number,
) {
  const missing = new Map<string, number>();
  let unknown = 0;
  for (const r of rows) {
    if (knownSkus.has(r.sku)) continue;
    unknown++;
    missing.set(r.sku, (missing.get(r.sku) || 0) + 1);
  }
  const unknownPct = rows.length ? (unknown / rows.length) * 100 : 100;
  return {
    rows: rows.length,
    unknown,
    unknownPct: +unknownPct.toFixed(2),
    distinctUnknown: missing.size,
    topUnknown: [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    // An empty pull is a failure, not a clean run: the cron fires nightly after
    // trading, and a day with zero sellable invoices means something broke
    // upstream (auth, filters, date window) rather than a genuinely quiet day.
    ok: rows.length > 0 && unknownPct <= thresholdPct,
  };
}

// Inclusive Zoho date_start/date_end covering `days` IST calendar days, ending
// `endOffsetDays` before the IST day that `nowMs` falls in. Shifting by +5:30 and
// then reading UTC parts gives the IST calendar date without a timezone library.
//
// endOffsetDays=1 is what the overnight schedule uses: the crons fire 19:05-22:20
// UTC, which is 00:35-03:50 IST the NEXT IST day, so the day worth pulling is
// "yesterday IST". Asking for today would return a day that has barely begun, and
// assessCoverage correctly refuses an empty pull — but the refusal path in
// sync-invoices returns before clearing the cursor, so every slot would retry that
// empty date all night. The offset avoids the situation rather than special-casing it.
export function istDateRange(nowMs: number, days: number, endOffsetDays = 0) {
  const istDay = (offsetDays: number) =>
    new Date(nowMs + 5.5 * 3600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
  return { from: istDay(days - 1 + endOffsetDays), to: istDay(endOffsetDays) };
}
