// The `params/toTargets` slice the standalone TO tool reads.
//
// WHY THIS FILE EXISTS: the serialization used to live inline in `applyAndRun`
// (App.jsx), which was fine while a human clicking Apply was its only writer.
// Stage 6 adds a second writer — a headless nightly run — and two copies of a
// filter this consequential drift. The drift would surface as WRONG TRANSFER
// QUANTITIES found by ops, which is the worst place for it to surface.
//
// Same shape of fix as `paramConfigRows.js` (one list of own-row configs, not
// three hand-rolled copies) and `buildInvoiceCsv` living beside
// `parseInvoiceCsv`. Keep the two writers on one implementation.
//
// ⚠ THE TWO FILTERS BELOW ARE THE SAFETY BOUNDARY between the engine and the DC
// team's transfer orders, and their DEFAULTS matter more than the happy path:
//
//   * `inventorisedAt` defaults to **"DS"**, i.e. EXCLUDED. The engine fabricates
//     meta for any SKU seen in invoice data but absent from `skuMaster`
//     (`{ status:"Unknown", inventorisedAt:"DS" }`). CLAUDE.md records that
//     toTargets escaping those phantom SKUs "was luck, not design" — had the
//     default been "DC" they would have been reaching real transfer orders. A test
//     pins it.
//   * `status` defaults to **"Active"**, i.e. INCLUDED — the established
//     `(status || "Active")` convention for a master row that omits the field.
//     Distinct from a SKU absent from the master, which the engine now zeroes
//     anyway via the active-only pass. The allowlist is exactly "active": Zoho's
//     vocabulary already includes `confirmation_pending` and can grow.

/**
 * Apply Overrides-tab core overrides to engine results as a per-field MAX.
 *
 * An override is a FLOOR, never an assignment — it can raise a target but must
 * never lower one, so a stale override cannot quietly de-stock a SKU whose demand
 * has grown. Returns a new object; the input is not mutated.
 *
 * @param results   runEngine output, keyed by SKU
 * @param overrides `overrides/global` payload: { [sku]: { [ds]: {min,max} } }
 */
export function mergeCoreOverrides(results, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return { ...results };
  const merged = { ...results };
  for (const [sku, dsList] of Object.entries(overrides)) {
    // An override for a SKU the engine did not emit, or a DS the SKU is not
    // stocked at, is ignored rather than invented — Min/Max for a location the
    // engine excluded is not ours to create here.
    if (!merged[sku]) continue;
    const stores = { ...merged[sku].stores };
    for (const [ds, ov] of Object.entries(dsList || {})) {
      if (!stores[ds]) continue;
      stores[ds] = {
        ...stores[ds],
        min: Math.max(stores[ds].min, ov.min),
        max: Math.max(stores[ds].max, ov.max),
      };
    }
    merged[sku] = { ...merged[sku], stores };
  }
  return merged;
}

// The freshness block stamped into `params/toTargets` alongside `refreshedAt`.
//
// ⚠ WHY IT EXISTS: `refreshedAt` alone is the WEAK signal — a run timestamp says a
// computer did something, not that the answer is current. Demonstrated 2026-07-31:
// the first headless run reported `refreshedAt` "just now" while `invoiceDataThrough`
// was 2026-07-28, because Stage 5 was not flipped and the invoice sync was still
// publishing to a shadow row. A fresh-looking stamp over stale inputs is worse than
// no stamp at all.
//
// ⚠ WHY IT IS SHARED: `applyAndRun` (browser) and `api/run-engine.js` (nightly) both
// write this row. Before this existed, the browser wrote only `{targets,
// refreshedAt}` and so ERASED `engineCommit`/`inputs` on every Apply — which would
// have made the TO tool's freshness display blank intermittently, the fastest way to
// make people stop trusting it. One builder, one key set, whoever writes.
export function buildInputsStamp({
  invoiceData, skuMaster, priceData, newSKUQty, minReqQty, deadStock,
  skuCeiling, coreOverrides, params, lastSyncs,
}) {
  // MAX date, not the last row — stored invoice rows are not sorted.
  let through = null;
  for (const r of invoiceData || []) {
    if (r?.date && (through === null || r.date > through)) through = r.date;
  }
  // deadStock is a Set in React state and an array from Supabase. Serve both.
  const count = (v) => (v == null ? 0 : (v.size ?? (Array.isArray(v) ? v.length : Object.keys(v).length)));
  return {
    invoiceDataThrough: through,
    invoiceRows: (invoiceData || []).length,
    skuMaster: count(skuMaster),
    priceData: count(priceData),
    newSKUQty: count(newSKUQty),
    minReqQty: count(minReqQty),
    deadStock: count(deadStock),
    // ⚠ Stamped mainly as a DETECTOR. `runEngine`'s ceilings argument is optional
    // and defaults to a no-op, so a writer that forgot to pass it would publish
    // uncapped targets with nothing looking wrong. This count next to a non-empty
    // `team_data/global.skuCeiling` is how you would catch that.
    skuCeiling: count(skuCeiling),
    coreOverrides: count(coreOverrides),
    attributionMode: params?.pincodeConfig?.mode ?? null,
    // The browser does not read the sync status rows (not worth the extra I/O on
    // Apply), so it stamps null. Present either way so the key set never varies.
    lastSyncs: lastSyncs ?? null,
  };
}

// A write to `toTargets` REPLACES it wholesale, and the TO tool has no fallback if
// it arrives empty — the DC team would see no targets at all. So the headless
// writer needs the same discipline as every other replace-entirely writer here
// (`assessCoverage`, `mergeInvoiceRows`, `assessFloorChange`): fail closed on a
// collapse and leave the previous complete row in place.
//
// The realistic failure is not a bad engine, it is an input that failed to load —
// an empty `invoiceData` yields almost no targets, and nothing legitimately takes
// this row to zero. Ordinary churn (SKUs going inactive, new SKUs appearing) is a
// fraction of a percent of ~2,030.
const MAX_TARGETS_DROP_PCT = 20;

export function assessTargetsChange({ built, live, maxDropPct = MAX_TARGETS_DROP_PCT }) {
  const b = Object.keys(built ?? {});
  const l = Object.keys(live ?? {});
  const added = b.filter((s) => !(s in (live ?? {}))).sort();
  const removed = l.filter((s) => !(s in (built ?? {}))).sort();
  const out = { builtCount: b.length, liveCount: l.length, added, removed, dropPct: 0 };

  // No baseline yet — the first run is what establishes one.
  if (l.length === 0) return { safe: true, reason: "first_run", ...out };

  const dropPct = ((l.length - b.length) / l.length) * 100;
  if (dropPct > maxDropPct) return { safe: false, reason: "targets_collapse", ...out, dropPct };
  return { safe: true, reason: "ok", ...out, dropPct };
}

/**
 * Build the compact DC-inventorised, active slice the TO tool consumes.
 *
 * @param merged  engine results AFTER mergeCoreOverrides
 * @param dsList  DS_LIST — controls which stores appear, and their order
 */
// ⚠⚠ NEVER PUT A `DC` KEY IN `perDS`. Verified in homerun-to on 2026-09-07:
// `solver.js` does `const dsIds = Object.keys(perDS)` — it iterates the KEYS, not a
// hardcoded DS list — so a DC entry would make the TO tool render a DC row and try to
// allocate a DC->DC transfer. That was inert until the DC became a first-class
// location for floors (`newSKUQty[sku].DC`) and ceilings (`DC Cap`), so the instinct
// to "add DC everywhere for symmetry" now reaches it. `dsList` must stay DS-only.
//
// ⚠ A DC-only SKU (Move=No) is still EMITTED here, with every perDS entry at 0/0, and
// that is correct rather than an oversight: it is byte-identical to how Dead Stock
// SKUs have been published since May 2026, and the solver handles it — `triggered =
// cur <= min` with min 0 gives `req = max(0, 0 - cur - it) = 0`, and `cur > 0` does not
// trigger at all. Filtering them out instead would shrink the target count into
// assessTargetsChange's >20% collapse guard, which exists to catch an INPUT that
// failed to load, not a policy change.
export function buildToTargets(merged, dsList) {
  const targets = {};
  for (const [sku, r] of Object.entries(merged || {})) {
    const m = r?.meta || {};
    if ((m.inventorisedAt || "DS").toLowerCase() !== "dc") continue;
    if ((m.status || "Active").toLowerCase() !== "active") continue;
    const perDS = {};
    for (const ds of dsList) {
      const s = r.stores?.[ds];
      if (s) perDS[ds] = { min: s.min, max: s.max };
    }
    targets[sku] = {
      name: m.name || sku,
      category: m.category || "",
      brand: m.brand || "",
      perDS,
    };
  }
  return targets;
}
