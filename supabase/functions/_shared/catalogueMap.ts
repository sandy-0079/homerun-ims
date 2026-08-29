// Pure mapping for the two non-invoice model inputs: SKU Master and Purchase
// Prices. Kept free of fetch/Deno so it is unit-tested with the rest of the suite.
//
// ✅ cf_inventorised_at NOW EXISTS AND IS POPULATED (verified 2026-07-29 by dry run:
// invAtFromZoho 2,092, invAtFromStored 0, and ZERO per-SKU reclassification — Zoho
// matched the hand-maintained master exactly). The fallback below is therefore no
// longer load-bearing for the migration it was written for, but is kept: it still
// covers a SKU whose field is blank, and it is what made the handover a non-event.
//
// It remains the highest-consequence field in the master — the engine's final
// normalization pass zeroes DC targets for DS-inventorised SKUs and zeroes
// everything for Supplier ones — and Zoho now owns it, so the stored value is no
// longer a safety net. Watch invAtChanged.toSupplier in catalogueSyncStatus.
//
// HISTORY, for why the logic is shaped this way: before the field existed, live was
// 2,004 DC / 58 Supplier / 12 DS while the CSV upload path defaulted a missing value
// to "DS" — so a sync that had treated Zoho as authoritative then would have
// reclassified ~2,000 SKUs DC -> DS and zeroed the entire DC plan.
//
// Hence the rule, which still holds: Zoho wins ONLY where it actually has a value,
// otherwise the stored value stands, otherwise DEFAULT_INV_AT with the SKU reported.
// That let Zoho take over progressively with no cutover moment, and it is exactly why
// the handover on 2026-07-29 was a non-event — 2,092 values arrived and every one
// matched what was already stored.

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

  // ⚠⚠ THE ACTIVE SHARE IS MEASURED AND REPORTED, AND DELIBERATELY DOES NOT BLOCK
  // (changed 2026-08-29). It blocked from 2026-07-29 until then, at `thresholdPct`.
  //
  // WHY IT WAS ADDED: once Zoho owned `status`, a pull flipping SKUs to inactive
  // changed neither the inventorisedAt mix nor the row count, so it passed every
  // check and silently zeroed their Min/Max.
  //
  // WHY IT NO LONGER BLOCKS: ops uses Zoho's status as a TEMPORARY OPERATIONAL
  // LEVER, not a stable statement about whether we stock something. On 2026-08-28
  // they deactivated 334 SKUs (active share 93.55% -> 79.70%, a 13.85pp move against
  // a 5pp limit) and re-activated them the same day because Zoho will not transact
  // an inactive item and the DC team could not raise TOs. The guard refused all five
  // slots, the catalogue went stale, and nothing self-healed until ops reverted.
  // A bulk flip of this size is routine here, so a threshold that treats it as an
  // emergency is a threshold that blocks normal work.
  //
  // ⚠ THE COST IS REAL AND WAS ACCEPTED KNOWINGLY. A transient flip now propagates
  // the same night: measured on the 25 SKUs that were recorded, 23 moved and 161
  // SKU x location cells zeroed, extrapolating to ~2,150 cells for the full 334 —
  // which then reverse the next night. The alternative considered was HYSTERESIS
  // (apply a deactivation only after N consecutive nights, apply a re-activation
  // immediately), which absorbs a same-day reversal with no downstream movement.
  // That remains the better design if the whipsaw ever bites; this is the simpler
  // one, chosen because it matches "Zoho owns status" literally.
  //
  // ⚠ Inv Value cannot be used to notice this. All 25 recorded SKUs were UNPRICED,
  // so the rupee figure moved Rs0.00 while 161 cells went to zero. Watch the cell
  // count and `statusChanged`, never the money.
  //
  // Compared case-insensitively: the CSV path writes "Active", Zoho writes "active".
  const activePct = (m: Record<string, any>, n: number) =>
    n === 0 ? 0 : Object.values(m || {})
      .filter((v: any) => (v?.status || "").toString().trim().toLowerCase() === "active").length / n * 100;
  // Returned on EVERY path, success included — it used to be attached only to the
  // rejection, so the one night it mattered was the one night you could read it.
  const share = {
    activePctBefore: +activePct(oldMaster, before).toFixed(2),
    activePctAfter: +activePct(newMaster, after).toFixed(2),
  };
  const base = { before, after, dBefore, dAfter, ...share };

  if (after === 0) return { safe: false, reason: "empty_result", ...base };
  if (before === 0) return { safe: true, reason: "first_run", ...base };

  if (after < before * (1 - thresholdPct / 100)) {
    return { safe: false, reason: "master_shrank", ...base };
  }

  // Compare each bucket as a share of the whole, so growth doesn't trip it.
  // ⚠ STILL BLOCKS, and must. Supplier zeroes Min/Max at every location including
  // the DC, DS zeroes the DC — and unlike `status`, nobody flips these as a daily
  // operational lever, so a mass move here is always either a mistake or a bad pull.
  for (const k of new Set([...Object.keys(dBefore), ...Object.keys(dAfter)])) {
    const pb = (dBefore[k] || 0) / before * 100, pa = (dAfter[k] || 0) / after * 100;
    if (Math.abs(pa - pb) > thresholdPct) {
      return { safe: false, reason: `inventorisedAt_shift:${k}`, ...base };
    }
  }
  return { safe: true, reason: "ok", ...base };
}

// How many SKUs will actually see their targets move because of a price refresh?
//
// Purchase Prices are NOT display-only: getPriceTag selects the PCT percentile, the
// Fixed Unit Floor order-days gate and the DOC caps. So a price refresh moves Min/Max
// on SKUs whose demand never changed — and the number that matters is not "prices
// updated" but "prices that crossed a TIER boundary". 101 updated prices might move
// nothing, or might re-tier a hundred SKUs; only this tells them apart.
//
// Reported, deliberately NOT guarded: re-tiering is a legitimate consequence of fresh
// purchase data, and CLAUDE.md already asks that an Inv-Value delta be split into the
// revaluation effect and the target effect. This is the number that lets you do that.
//
// Mirrors src/engine/utils.js getPriceTag exactly, including "No Price" for 0/absent —
// which PCT reads as the 95th percentile, so losing a price stocks a SKU MORE.
function priceTag(p: unknown, tiers: number[]): string {
  const v = parseFloat(String(p ?? "")) || 0;
  const [t1, t2, t3, t4] = tiers;
  if (v >= t1) return "Premium";
  if (v >= t2) return "High";
  if (v >= t3) return "Medium";
  if (v >= t4) return "Low";
  if (v > 0) return "Super Low";
  return "No Price";
}

export function assessPriceTagChanges(
  oldPrices: Record<string, number>,
  newPrices: Record<string, number>,
  tiers: number[] = [3000, 1500, 400, 100],
) {
  const changes: Array<{ sku: string; from: string; to: string; oldPrice: unknown; newPrice: unknown }> = [];
  const mixBefore: Record<string, number> = {}, mixAfter: Record<string, number> = {};

  for (const sku of new Set([...Object.keys(oldPrices || {}), ...Object.keys(newPrices || {})])) {
    const from = priceTag(oldPrices?.[sku], tiers), to = priceTag(newPrices?.[sku], tiers);
    mixBefore[from] = (mixBefore[from] || 0) + 1;
    mixAfter[to] = (mixAfter[to] || 0) + 1;
    if (from !== to) changes.push({ sku, from, to, oldPrice: oldPrices?.[sku], newPrice: newPrices?.[sku] });
  }

  return {
    changed: changes.length,
    sample: changes.slice(0, 25),
    byTransition: changes.reduce((d: Record<string, number>, c) => {
      const k = `${c.from} -> ${c.to}`;
      d[k] = (d[k] || 0) + 1;
      return d;
    }, {}),
    mixBefore, mixAfter,
  };
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
