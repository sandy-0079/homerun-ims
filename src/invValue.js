// Network inventory value from engine results — the Overview "Inv Value" cards.
//
// ⚠ ONE IMPLEMENTATION, TWO CALLERS: App.jsx's `kpis` (what you see on screen) and
// api/run-engine.js (what gets stamped onto params/toTargets and mailed out in the
// nightly digest). The formula used to live inline in `kpis` only; the moment a
// second caller needed it, an inline copy would have been a number in your inbox
// that quietly disagreed with the number on the card. Same shape of fix as
// src/toTargets.js and buildInvoiceCsv living beside parseInvoiceCsv.
//
// ⚠ SUMS **EVERY** ENTRY IN `results`, not just the active set. That is deliberate
// and matches the card: CLAUDE.md records that reconciling an Inv-Value delta went
// wrong once precisely because the KPI sums Object.entries(results) rather than the
// activeSkus set. Non-active and Supplier SKUs are already zeroed by the engine's
// own passes, so they contribute nothing — but the iteration basis must match.
//
// ⚠ INCLUDES THE DC. Measured on live data 2026-08-04, the DC is 27.0% of network
// Max (₹2.14Cr of ₹7.93Cr). This is why the digest cannot derive the figure from
// params/toTargets, which carries DS columns only — that route came out ₹5.29Cr,
// a third below the card.

/**
 * @param results   runEngine output: { [sku]: { stores: { [ds]: {min,max} }, dc: {min,max} } }
 * @param priceData { [sku]: unitPrice }
 * @param dsList    DS codes to include, alongside the DC
 * @returns {{min:number,max:number}} rupees, rounded — as the card displays them
 */
export function computeInvValue(results, priceData, dsList) {
  let min = 0, max = 0;
  for (const [sku, r] of Object.entries(results || {})) {
    // `|| 0` rather than `?? 0`: a SKU absent from priceData must contribute zero,
    // and a NaN escaping here would render the whole figure as "₹NaNCr".
    const p = priceData?.[sku] || 0;
    for (const ds of dsList) {
      min += (r?.stores?.[ds]?.min || 0) * p;
      max += (r?.stores?.[ds]?.max || 0) * p;
    }
    min += (r?.dc?.min || 0) * p;
    max += (r?.dc?.max || 0) * p;
  }
  return { min: Math.round(min), max: Math.round(max) };
}
