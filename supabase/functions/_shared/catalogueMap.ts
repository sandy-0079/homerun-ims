// Pure mapping for the two non-invoice model inputs: SKU Master and Purchase
// Prices. Kept free of fetch/Deno so it is unit-tested with the rest of the suite.
//
// ⚠ INVENTORISED AT DOES NOT EXIST IN ZOHO YET (2026-07-28). It is currently set
// by hand in the SKU Master CSV, and it is the highest-consequence field in the
// master: the engine's final normalization pass zeroes DC targets for
// DS-inventorised SKUs and zeroes everything for Supplier ones.
//
// Live distribution is 2,004 DC / 58 Supplier / 12 DS, and the CSV upload path
// defaults a missing value to "DS". So a sync that treated Zoho as authoritative
// today would reclassify ~2,000 SKUs DC -> DS and zero the entire DC plan.
//
// Therefore: Zoho wins ONLY where it actually has a value. Otherwise the stored
// value stands. As the field gets populated, Zoho progressively takes over with
// no cutover moment — and `report` makes that migration observable rather than
// invisible.

// ── STATUS OWNERSHIP (decided 2026-07-29)
//
// "We need Min and Max only for the active SKUs on Zoho. SKUs with any other status
// — Inactive, Confirmation Pending — are immaterial to us."
//
// So Zoho is authoritative and there is no local vocabulary to preserve: a stored
// `Confirmation Pending` deliberately loses to Zoho's `active`. Every downstream
// filter is `(status || "Active").toLowerCase() === "active"`, so this single field
// decides whether a SKU is stocked at all — which drives the two rules below.
//
//   1. A MISSING status is NOT active. Absent data is not evidence, and defaulting
//      to active would stock a SKU on no information. (Same reasoning as
//      isSellableStatus rejecting an empty invoice status.)
//   2. A SKU absent from the Zoho pull is RETAINED and marked not-active, never
//      dropped. A partial /items response is indistinguishable from a deletion, and
//      dropping the SKU would also make its invoice rows unknown to assessCoverage —
//      the guard that refuses to write invoice data at all. Retaining gets the
//      no-Min/Max outcome while keeping category (which drives strategy dispatch).
const NOT_ACTIVE = "Inactive"; // matches the live master's spelling

const CF_INVENTORISED_AT = "cf_inventorised_at";
const DEFAULT_INV_AT = "DC"; // 96% of the live master

export type MasterEntry = {
  sku: string; name: string; category: string; brand: string; status: string; inventorisedAt: string;
};

// Zoho exposes item custom fields in THREE different shapes depending on the
// endpoint, and the /items LIST — the one this function uses — puts them as
// TOP-LEVEL `cf_*` keys. Verified 2026-07-28: cf_dc01_rampura, cf_ds01_sarjapur
// … cf_ds06_kogilu all arrive that way, with no custom_fields array and no
// custom_field_hash present at all.
//
// Reading only the array/hash shapes would mean cf_inventorised_at is never
// found once created — a silent permanent fallback that looks identical to "the
// field hasn't been populated yet". So check all three, most specific first.
function customField(item: any, apiName: string): string | null {
  const candidates = [
    item?.[apiName],
    (item?.custom_fields || []).find((f: any) => f?.api_name === apiName)?.value,
    item?.custom_field_hash?.[apiName],
  ];
  for (const v of candidates) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return null;
}

export function mapItemsToMaster(items: any[], currentMaster: Record<string, any>) {
  const master: Record<string, MasterEntry> = {};
  let invAtFromZoho = 0, invAtFromStored = 0;
  const newSkusDefaulted: string[] = [];

  for (const it of items || []) {
    const sku = (it?.sku || "").toString().trim();
    if (!sku) continue;

    const fromZoho = customField(it, CF_INVENTORISED_AT);
    const stored = currentMaster?.[sku]?.inventorisedAt;
    let inventorisedAt: string;
    if (fromZoho) { inventorisedAt = fromZoho; invAtFromZoho++; }
    else if (stored) { inventorisedAt = stored; invAtFromStored++; }
    else { inventorisedAt = DEFAULT_INV_AT; newSkusDefaulted.push(sku); }

    master[sku] = {
      sku,
      name: it.name ?? "",
      category: it.category_name ?? it.category ?? "",
      brand: it.brand ?? "",
      // Zoho verbatim, but a missing status is not active — see STATUS OWNERSHIP.
      status: (it.status ?? "").toString().trim() || NOT_ACTIVE,
      inventorisedAt,
    };
  }

  // Carry forward anything Zoho did not return, marked not-active. Never drop.
  const absentFromZoho: string[] = [];
  for (const [sku, entry] of Object.entries(currentMaster || {})) {
    if (master[sku]) continue;
    absentFromZoho.push(sku);
    master[sku] = { ...(entry as MasterEntry), sku, status: NOT_ACTIVE };
  }

  return {
    master,
    report: {
      items: Object.keys(master).length,
      invAtFromZoho, invAtFromStored, newSkusDefaulted,
      absentFromZoho,
    },
  };
}

// reports/purchasesbyitem → { sku: average_price }. `average_price` is a
// Zoho-computed field over the requested window, not something we derive.
export function mapPricesReport(pages: any[]) {
  const prices: Record<string, number> = {};
  let dropped = 0;
  for (const page of pages || []) {
    for (const section of page?.purchases_by_item || []) {
      for (const row of section?.purchase || []) {
        const sku = (row?.item?.sku || "").toString().trim();
        const v = Number(row?.average_price) || 0;
        // Mirrors the CSV upload path, which keeps only sku && average_price > 0.
        if (sku && v > 0) prices[sku] = v; else dropped++;
      }
    }
  }
  return { prices, report: { priced: Object.keys(prices).length, dropped } };
}

// Guard before overwriting the master. The failure it exists for is a mass
// inventorisedAt reclassification, which is silent in the data and catastrophic
// in the engine. Also catches a pull that came back short or empty.
export function assessMasterChange(
  oldMaster: Record<string, any>,
  newMaster: Record<string, any>,
  thresholdPct: number,
) {
  const before = Object.keys(oldMaster || {}).length;
  const after = Object.keys(newMaster || {}).length;
  const dist = (m: Record<string, any>) => {
    const d: Record<string, number> = {};
    for (const v of Object.values(m || {})) {
      const k = (v?.inventorisedAt || "").toString().trim().toLowerCase() || "(blank)";
      d[k] = (d[k] || 0) + 1;
    }
    return d;
  };
  const dBefore = dist(oldMaster), dAfter = dist(newMaster);

  if (after === 0) return { safe: false, reason: "empty_result", before, after, dBefore, dAfter };
  if (before === 0) return { safe: true, reason: "first_run", before, after, dBefore, dAfter };

  if (after < before * (1 - thresholdPct / 100)) {
    return { safe: false, reason: "master_shrank", before, after, dBefore, dAfter };
  }

  // Status guard, added 2026-07-29 with the "Zoho owns status" decision.
  //
  // Until now this function watched only the inventorisedAt mix and the row count. A
  // pull that flipped SKUs to inactive changes NEITHER, so it passed every check and
  // silently zeroed their Min/Max. With 2,084 of 2,092 currently active, that is
  // most of the catalogue riding on an unguarded field. Compared case-insensitively
  // because the CSV path writes "Active" and Zoho writes "active".
  const activePct = (m: Record<string, any>, n: number) =>
    n === 0 ? 0 : Object.values(m || {})
      .filter((v: any) => (v?.status || "").toString().trim().toLowerCase() === "active").length / n * 100;
  const aBefore = activePct(oldMaster, before), aAfter = activePct(newMaster, after);
  if (Math.abs(aAfter - aBefore) > thresholdPct) {
    return {
      safe: false, reason: "active_share_shift",
      activePctBefore: +aBefore.toFixed(2), activePctAfter: +aAfter.toFixed(2),
      before, after, dBefore, dAfter,
    };
  }
  // Compare each bucket as a share of the whole, so growth doesn't trip it.
  for (const k of new Set([...Object.keys(dBefore), ...Object.keys(dAfter)])) {
    const pb = (dBefore[k] || 0) / before * 100, pa = (dAfter[k] || 0) / after * 100;
    if (Math.abs(pa - pb) > thresholdPct) {
      return { safe: false, reason: `inventorisedAt_shift:${k}`, before, after, dBefore, dAfter };
    }
  }
  return { safe: true, reason: "ok", before, after, dBefore, dAfter };
}

// Merge Zoho prices over the stored ones instead of replacing them.
//
// `reports/purchasesbyitem` can only see purchases made in the CURRENT Zoho org,
// i.e. since the 2026-07-01 migration — not the 12-month window we ask for.
// Measured 2026-07-28: 1,477 priced from Zoho against 1,822 stored. A wholesale
// replace would push 345 SKUs to "No Price", and the PCT strategy reads No Price
// as the 95th percentile — so those SKUs would be stocked MORE aggressively, not
// less. Coverage grows on its own as the new org accumulates purchase history.
export function mergePrices(current: Record<string, number>, incoming: Record<string, number>) {
  const prices: Record<string, number> = { ...(current || {}) };
  let updated = 0, added = 0;
  for (const [sku, v] of Object.entries(incoming || {})) {
    if (!(v > 0)) continue;
    if (prices[sku] === undefined) added++; else if (prices[sku] !== v) updated++;
    prices[sku] = v;
  }
  const retained = Object.keys(current || {}).filter((s) => incoming?.[s] === undefined).length;
  return { prices, report: { total: Object.keys(prices).length, updated, added, retained } };
}
