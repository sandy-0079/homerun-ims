// Opening Shortly — a store that exists everywhere but is not trading yet holds
// Min=Max=0, whatever the strategy, the floor, the ceiling or the network said.
//
// WHY IT EXISTS: a dark store is wired weeks before it opens — Zoho branch, stock
// sync, floor-sheet columns, ceiling columns, `newDSList` membership, a plywood
// node. Every one of those inputs is safe to load early ONLY if loading it cannot
// move a number. This pass is what makes that true, so going live is removing the
// store from `openingDSList` and nothing else.
//
// It replaced the DS Seed pass (deleted 2026-09-18), and the inversion is the
// point. DS06 opened ~2026-07-08, three weeks before pincode attribution shipped,
// so it had no history of its own and had to BORROW its siblings' numbers.
// Attribution is retroactive, so a store opening now inherits its own real history
// the moment its catchment is mapped. The problem is no longer "invent numbers for
// a new store" but "hold a wired store at zero until its opening day".
//
// ⚠⚠ APPLIED ONCE, TO THE FINISHED `stores` MAP — never inline in the branch that
// computed a store, for exactly the reason `deadStock.js` records: `runEngine`
// writes `stores[dsId]` from FIVE places (the per-DS loop's HAS-DATA path, its
// three NO-DATA sub-branches, and the Network Design bypass, which builds its own
// `_stores` separately). Three inline copies and one omission is how the Dead
// Stock bug of 2026-08-26 and the SKU Ceiling four-writers bug of 2026-08-15 both
// happened. A branch added later cannot escape a pass that runs on the finished map.
//
// ⚠ CALLED BEFORE `sumMin`/`sumMax`, and that ordering IS load-bearing. Those sums
// feed the floored DC branch (`round(sumMin x multMin)`). Applied afterwards, a
// store in `newDSList` would take the New DS Floor, land ~250 non-zero targets, and
// the DC would already have absorbed them — leaving a store reading 0/0 beside a DC
// quietly stocked to supply it. Zero on screen, real inventory in the warehouse.
//
// ⚠⚠ `dsDailyAvgs` IS DELIBERATELY NOT ZEROED, and this is the subtle one.
// `sumDailyAvg` feeds the rate-based DC, and attribution only RELABELS rows — so
// when a catchment is mapped to a store that is still Opening Shortly, the donor
// stores have ALREADY lost that demand. Removing it from the DC too would delete it
// from the network entirely and under-stock the DC for demand that genuinely exists.
//
// ⚠ THAT PROTECTS THE RATE-BASED DC BRANCH ONLY — measured 2026-09-18, and the
// limit is worth stating because the obvious reading is that the network self-heals.
// The FLOORED branch sums `stores[ds].min`, which this pass has just zeroed, so
// remapping 19 pincodes to a gated DS07 moved 179 live-store cells and 132 DC
// values on the live snapshot: the donors gave the demand away and the gated store
// cannot claim it. Nothing here can fix that — it is the cost of the
// misconfiguration itself. Map a catchment and open the store in the SAME Apply,
// which is why the Logic Tweaker warns when a store has mapped pincodes and is not
// live. That warning is load-bearing, not cosmetic.

/**
 * Zero every not-yet-trading store, in place. Returns how many cells moved.
 *
 * @param stores      the finished per-DS map for one SKU
 * @param openingSet  Set of DS codes that are not trading yet
 * @param dsList      DS_LIST — the store universe to sweep
 *
 * ⚠ `preFloorMin`/`preFloorMax` are left intact, same convention as Dead Stock and
 * the Active-only pass: the Overrides tab still shows what the store WOULD hold on
 * opening day, which is exactly the number ops wants to see while planning it.
 *
 * ⚠ Tags every gated store, including one already at 0/0 — same reason Dead Stock
 * does. "Base Logic" beside DS07 reads as "no demand"; the truth is "not open yet",
 * and on Monday morning that is the difference between a working go-live and a
 * panic about attribution having failed.
 */
export function applyOpeningToStores(stores, openingSet, dsList) {
  if (!stores || !openingSet || openingSet.size === 0) return 0;
  let moved = 0;
  for (const ds of dsList) {
    if (!openingSet.has(ds)) continue;
    const st = stores[ds];
    if (!st) continue;
    if (st.min !== 0 || st.max !== 0) moved++;
    st.min = 0;
    st.max = 0;
    st.logicTag = "Opening Shortly";
  }
  return moved;
}
