// Stock Health — Floor / Ceiling display columns and the "missing setup" filter.
//
// READ-ONLY reference data: these values are shown beside Min/Max so ops can see
// which manual bound exists at a location. They never feed the health tag, the
// Req Qty, or anything the engine computes — runEngine already applied both.
//
// Shapes (both keyed SKU → location, location = "DS01".."DS08" | "DC" | "HYDS01"):
//   floors   — Bangalore `newSKUQty` / Hyderabad `hyd_inputs.floors`:
//              {min, max} objects, or a bare number on old uploads (min = max = n)
//   ceilings — Bangalore `skuCeiling`: a single cap number. Hyderabad has none.
//
// ⚠ A CEILING OF 0 IS A REAL CAP and counts as "has a ceiling" — blank and 0 are
// opposites (see engine/skuCeiling.js). A FLOOR of 0/0 is NOT a floor: the engine
// skips it (`fMin > minQty || fMax > maxQty` can never fire), so showing it as one
// would claim a bound that has no effect.

import { capFor } from "./engine/skuCeiling.js";

/** Lower-cased key → original key. The engine looks SKUs up case-insensitively in
 *  both sources, so the display must too, or a casing mismatch would show "no
 *  floor" on a SKU the engine is actually flooring. Built once per data change,
 *  not per row: a per-row `Object.keys().find()` is O(rows × keys). */
export function keyIndex(obj) {
  const idx = new Map();
  for (const k of Object.keys(obj || {})) {
    const lk = k.toLowerCase();
    if (!idx.has(lk)) idx.set(lk, k);
  }
  return idx;
}

const resolve = (obj, idx, sku) =>
  obj?.[sku] !== undefined ? sku : idx.get(String(sku).toLowerCase());

/** The floor at one location as `{min, max}`, or null when there is none (absent,
 *  or 0/0). Normalised exactly as runEngine reads it: a bare number is min = max,
 *  and a missing max falls back to min. */
export function floorAt(floors, idx, sku, loc) {
  const key = resolve(floors, idx, sku);
  if (key === undefined) return null;
  const fl = floors[key]?.[loc];
  if (fl == null) return null;
  const min = typeof fl === "number" ? fl : (Number(fl.min) || 0);
  const max = typeof fl === "number" ? fl : (Number(fl.max) || min);
  if (!(min > 0) && !(max > 0)) return null;
  return { min, max };
}

/** The ceiling at one location, or null when uncapped. 0 is a cap. Delegates the
 *  validity rule to the engine's own `capFor` so the column can never disagree
 *  with what was applied. */
export function ceilingAt(ceilings, idx, sku, loc) {
  const key = resolve(ceilings, idx, sku);
  if (key === undefined) return null;
  return capFor(ceilings, key, loc);
}

/** Cell text. Blank-vs-zero matters for the ceiling, so "—" means none. */
export const fmtFloor   = (f) => (f ? `${f.min}/${f.max}` : "—");
export const fmtCeiling = (c) => (c === null || c === undefined ? "—" : String(c));

export const SETUP_FILTERS = ["All", "No Floor", "No Ceiling", "No Floor or No Ceiling", "No Floor & No Ceiling"];

/** Filter predicate. "No Floor" and "No Ceiling" are each independent of the other
 *  bound. "No Floor or No Ceiling" is the UNION (at least one missing — i.e. every
 *  row except those with both set); "No Floor & No Ceiling" the intersection. */
export function matchesSetupFilter(row, filter) {
  const noFloor = !row.floor;
  const noCeil  = row.ceiling === null || row.ceiling === undefined;
  switch (filter) {
    case "No Floor":               return noFloor;
    case "No Ceiling":             return noCeil;
    case "No Floor or No Ceiling": return noFloor || noCeil;
    case "No Floor & No Ceiling":  return noFloor && noCeil;
    default:                       return true;
  }
}
