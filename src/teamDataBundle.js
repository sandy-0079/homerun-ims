// Builds the `team_data/global` payload that the browser writes.
//
// WHY THIS EXISTS (2026-07-30): `saveTeamData` used to rebuild the WHOLE bundle
// from React state on every call —
//
//     const bundle = { ...existing, skuMaster: overrides.skuMaster ?? skuMaster, ... }
//
// The `...existing` spread only protects keys the app does not NAME. It named
// skuMaster, priceData, stockData and stockUploadedAt*, so those were always
// rewritten from whatever the tab happened to be holding. That was harmless while
// a human's CSV upload was the only writer of skuMaster: the human doing the
// upload was the human whose tab it was.
//
// Stage 7 ended that. `sync-catalogue` now writes skuMaster and priceData nightly,
// unattended — so a tab opened BEFORE the nightly sync would, on its next upload
// or Apply, silently revert the whole catalogue: new SKUs dropped, prices reverted,
// deleted SKUs re-activated. The symptom is maximally confusing, because
// `params/catalogueSyncStatus` still says ok:true with `lastOkNight` set — the sync
// really did succeed, and was overwritten afterwards.
//
// The realtime subscription in App.jsx does NOT cover this. It fires on any UPDATE
// to `team_data/global` (sync-catalogue's included), but its handler only refreshes
// stockData / stockDataAccounting / poData / toData / stockUploadedAtPerDS — it was
// written for the hourly STOCK sync and predates Stage 7. That is exactly why
// stockData was never clobbered and skuMaster now could be.
//
// So: write only what this session actually changed. Same discipline `invoiceData`
// has always had in saveTeamData (`if (overrides.invoiceData !== undefined)`),
// extended to the keys Zoho took ownership of.

// The only keys the browser may write. Everything else in the row belongs to an
// edge function and reaches the payload solely via the `...existing` fresh read.
//
// ⚠ Adding a key here grants the browser permission to overwrite it. Only add one
// that NO edge function writes, or you reintroduce the 2026-07-30 revert.
//
// Deliberately absent:
//   invoiceData          — lives in team_data/invoice_data. Putting it back here
//                          takes the global payload from ~1-2MB to ~7MB and
//                          re-exhausts the Disk IO burst the row split fixed.
//   stockData,
//   stockDataAccounting,
//   stockUploadedAt*     — sync-stock owns these. The browser only ever READS them
//                          (setStockData is called solely from Supabase reads), so
//                          writing them back can only lose data.
//   poData, toData,
//   _poCache, _toCache,
//   _transferredTodayCache,
//   ordersUploadedAt     — sync-orders owns these.
export const BROWSER_OWNED_KEYS = Object.freeze([
  "skuMaster",
  "minReqQty",
  "newSKUQty",
  "deadStock",
  "priceData",
  // SKU x DS ceilings (2026-08-15). Browser-only today — no edge function writes
  // it, so it is the one clean case for this list. A sheet sync is a deliberate
  // non-goal for now; when one arrives it inherits the `newSKUQty` situation and
  // both writers must agree on ambiguous input (append rule, blank vs 0).
  "skuCeiling",
]);

/**
 * @param existing    the payload from a FRESH read of team_data/global
 * @param overrides   only the fields this action changed
 * @param publishedAt ISO timestamp to stamp
 */
export function buildTeamDataBundle({ existing = {}, overrides = {}, publishedAt }) {
  const bundle = { ...existing };

  for (const key of BROWSER_OWNED_KEYS) {
    // `undefined` means "not changed by this action". An empty object or Set is a
    // DELIBERATE clear (the Upload Data tab's clear buttons pass `{skuMaster:{}}`),
    // so this must not test falsiness.
    if (overrides[key] === undefined) continue;
    const value = overrides[key];
    // deadStock is a Set in React state and must land as an array in JSON.
    bundle[key] = value instanceof Set ? [...value] : value;
  }

  bundle.publishedAt = publishedAt;
  return bundle;
}
