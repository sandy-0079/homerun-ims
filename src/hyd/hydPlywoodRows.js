// Pati's plywood SKU table + capacity used, for the Hyderabad Plywood panel.
// Pure: no React, no Supabase.
//
// Capacity used mirrors Bangalore's NetworkDesignUnifiedTable (src/tabs/PlywoodNetworkTab.jsx,
// `thickUsed`/`thinUsed` ~line 820): Σ of the FINAL store Max (engine results
// `stores[ds].max`) over Thick SKUs, and over every non-Thick SKU for thin — Bangalore's
// thin list is `thicknessCat !== 'Thick'`, with laminates (≤1mm) dropped by
// applyNetworkFormula, so an SKU with no mm in its name counts as thin. Same here.
// The bar thresholds (capacityState) copy that table's `inlineCapBar`.
import { inferThickness, thicknessCategory } from "../engine/utils.js";
import { hydRowsOnly } from "../city.js";

const STORE = "HYDS01";
export const HYD_PLYWOOD_CATEGORY = "Plywood, MDF & HDHMR";

export const HYD_PLYWOOD_EMPTY =
  "No plywood SKUs in Pati's range yet — add plywood rows to the Hyderabad floor sheet, or switch Pati to Engine.";

/** First date inside the plywood lookback, the way plywoodNetwork.js cuts it: the
 *  network's latest date minus `lookbackDays`. Hyderabad's engine run sees a pad row
 *  on every network window date, so its latest date is the network's. */
function lookbackCutoff(invoiceData, lookbackDays) {
  let latest = "";
  for (const r of invoiceData) if (r?.date > latest) latest = r.date;
  if (!latest) return null;
  const d = new Date(latest);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - lookbackDays);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {{skuMaster:object, results:object|null, floors:object, invoiceData:object[],
 *   thickBoundaryMm:number, lookbackDays:number, floorsOnly:boolean}} args
 * @returns {{rows:object[], capacity:{thick:number|null, thin:number|null}}}
 *   rows: plywood SKUs with a Pati floor, a non-zero Pati target, or Pati sales in the
 *   plywood lookback. `null` = not known (no engine results; engine figures in Floors-only).
 */
export function buildHydPlywoodRows({ skuMaster, results, floors, invoiceData, thickBoundaryMm = 9, lookbackDays = 90, floorsOnly = false } = {}) {
  const inv = invoiceData || [];
  const cutoff = lookbackCutoff(inv, lookbackDays || 90);
  const sold = {};
  if (cutoff) {
    for (const r of hydRowsOnly(inv)) {
      if (r.date < cutoff) continue;
      const q = Number(r.qty) || 0;
      if (q > 0) sold[r.sku] = (sold[r.sku] || 0) + q;
    }
  }

  const rows = [];
  for (const [sku, meta] of Object.entries(skuMaster || {})) {
    if (meta?.category !== HYD_PLYWOOD_CATEGORY) continue;
    const s = results ? results[sku]?.stores?.[STORE] : null;
    const f = floors?.[sku]?.[STORE];
    const hasFloor = !!f && ((f.min || 0) > 0 || (f.max || 0) > 0);
    const hasTarget = !!s && ((s.min || 0) > 0 || (s.max || 0) > 0);
    if (!hasFloor && !hasTarget && !sold[sku]) continue;
    const mm = inferThickness(meta.name);
    rows.push({
      sku, name: meta.name || "", brand: meta.brand || "",
      mm, thickness: thicknessCategory(mm, 1, thickBoundaryMm || 9),
      floorMin: hasFloor ? f.min || 0 : null, floorMax: hasFloor ? f.max || 0 : null,
      engineMin: s && !floorsOnly ? s.engineMin ?? null : null,
      engineMax: s && !floorsOnly ? s.engineMax ?? null : null,
      finalMin: s ? s.min || 0 : null, finalMax: s ? s.max || 0 : null,
      logicTag: s?.logicTag || null,
      patiQty: sold[sku] || 0,
    });
  }
  rows.sort((a, b) => (b.finalMax ?? -1) - (a.finalMax ?? -1) || a.sku.localeCompare(b.sku));

  let capacity = { thick: null, thin: null };
  if (results) {
    capacity = { thick: 0, thin: 0 };
    for (const r of rows) {
      if (r.thickness === "Laminate") continue;
      capacity[r.thickness === "Thick" ? "thick" : "thin"] += r.finalMax || 0;
    }
  }
  return { rows, capacity };
}

/** Bangalore's inline capacity bar: >100% "At Limit" (amber), >110% "Over" (red).
 *  A capacity of 0 means no cap (the engine skips the trim). */
export function capacityState(used, total) {
  if (used == null) return { pct: null, level: "unknown" };
  if (!total || total <= 0) return { pct: null, level: "noCap" };
  const pct = (used / total) * 100;
  return { pct, level: pct > 110 ? "over" : pct > 100 ? "atLimit" : "ok" };
}
