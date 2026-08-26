// Dead Stock — Min=Max=0 at every DS and the DC, overriding every floor, every
// strategy and every seed. Ops judgement that a SKU is not to be replenished.
//
// ⚠⚠ APPLIED ONCE, TO THE FINISHED `stores` MAP — never inline in the branch that
// computed a store. `runEngine` writes `stores[dsId]` from FOUR places: the per-DS
// loop's HAS-DATA path, its three NO-DATA sub-branches (which `return` early), and
// the Network Design bypass, which builds its own `_stores` separately.
//
// It used to be three inline copies and one omission. The branch missed was
// NO-DATA-with-a-manual-floor at a store outside `newDSList`, so a Dead Stock SKU
// with a floor and no sales at that store kept the floor as its Min/Max. Found in
// production 2026-08-26: six SKUs (4BK45, EDUNK, RYNJT, RU5YU, WUZUF, Y8SCD) each
// carried an identical 1/1 floor at all six stores and read 1/1 at DS01/DS02 while
// reading 0/0 at DS03-DS06 — the four stores in `newDSList`, whose branch did carry
// the check. One SKU, one floor, two different answers. Rs0.86L, with DC 0/0 beside
// it: an incoherent state, since the TO tool would propose DC->DS transfers of a
// dead SKU against a DC target of zero.
//
// Exactly the shape of the SKU Ceiling four-writers bug of 2026-08-15, which
// CLAUDE.md predicted in writing: "Four copies of a clamp would have been the same
// bug waiting to recur."
//
// ⚠ THE DC IS NOT DONE HERE. Both DC derivations already branch on `isDead` on the
// finished-map side and were never affected. Zeroing the stores first is harmless
// to them (`sumMin`/`sumMax` only feed the `!isDead` branches) but is not what
// makes the DC zero — don't remove those checks on the strength of this helper.

/**
 * Zero every store for a Dead Stock SKU, in place. Returns how many cells moved.
 *
 * ⚠ `preFloorMin`/`preFloorMax` are deliberately left intact — same convention as
 * the Active-only and Inventorised-At passes, so the Overrides tab can still show
 * what the SKU would have been had it not been marked dead.
 *
 * ⚠ Tags EVERY store of a dead SKU, including one already at 0/0. The tag states
 * the REASON the cell is zero, and "Base Logic" beside a dead SKU reads as "no
 * demand" when the truth is "ops zeroed it" — a distinction that matters when
 * someone is deciding whether to un-mark it.
 */
export function applyDeadStockToStores(stores, isDead, dsList) {
  if (!isDead || !stores) return 0;
  let moved = 0;
  for (const ds of dsList) {
    const st = stores[ds];
    if (!st) continue;
    if (st.min !== 0 || st.max !== 0) moved++;
    st.min = 0;
    st.max = 0;
    st.logicTag = "Dead Stock";
  }
  return moved;
}
