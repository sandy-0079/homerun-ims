// How a SKU's status is rendered for humans, in one place.
//
// ⚠ WHY THIS EXISTS: Zoho's status vocabulary reaches us lowercase and snake_case, and
// inconsistently. Measured live 2026-08-03 the master held FOUR spellings at once:
//
//     active 2090 · inactive 27 · Inactive 1 · confirmation_pending 3
//
// So a spreadsheet formula `=IF(E2="Active", …)` matched ZERO rows, and `="active"`
// missed one. Any CSV a human builds formulas on must therefore normalise, and every
// such CSV must normalise the SAME way — otherwise two downloads of the same fact
// disagree, which is worse than either being wrong on its own.
//
// Shared by the PO Team Download (`poTargetsCsv.js`) and the SKU Master CSV
// (`App.jsx`). If you add a third writer that emits status, import this — do not
// re-implement it.
//
// ⚠ NOT for engine logic. The engine gates Min/Max on an allowlist of exactly the raw
// lowercase `"active"` (`runEngine.js`), deliberately: Zoho's vocabulary can grow, and
// a display transform must never decide whether a SKU gets stocked.

/**
 * Render a raw Zoho status as a stable, human-readable value.
 *
 * Generic rather than a fixed lookup, so a status Zoho adds later arrives readable
 * ("on_hold" -> "On Hold") instead of leaking raw into someone's sheet.
 *
 * A MISSING status reads as "Active" — the established `(status || "Active")`
 * convention for a master row that omits the field. Note this differs from a SKU
 * absent from the master entirely, which the engine fabricates as "Unknown" and zeroes.
 *
 * @param {unknown} status raw value from `skuMaster[sku].status`
 * @returns {string} e.g. "Active" · "Inactive" · "Confirmation Pending"
 */
export function normaliseStatus(status) {
  const raw = String(status ?? "").trim();
  if (!raw) return "Active";
  return raw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
