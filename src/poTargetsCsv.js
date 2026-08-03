// PO Team download — the Min/Max target file the PO team pastes into their Google
// Sheet each morning to raise POs.
//
// ⚠⚠ THE COLUMN ORDER IS A FROZEN CONTRACT. The PO team's sheet formulas key on
// column POSITION, so reordering or inserting a column silently breaks every formula
// they have — and the symptom is wrong purchase orders, not an error. Anything added
// later MUST go AFTER `DS06 Max`. Same rule as the Stock Health CSV's two appended
// columns, and `PO_CSV_HEADERS` below is pinned by a test so a reorder fails loudly.
//
// Targets only, by design: no stock, no in-transit, no suggested quantity. The sheet
// owns the ordering arithmetic, so this file has no dependency on stock freshness.
//
// ⚠ Every SKU in the master is emitted, including Supplier and non-active ones, which
// the engine correctly reports as 0/0. That is why `Inventorised At` and `Status` are
// present as columns at all — they are what let the PO team filter those ~89 rows out
// in the sheet. Before this file existed they had no way to tell a genuine
// "stock nothing" from a structurally-excluded SKU. A stable row set also keeps sheet
// formulas from shifting when a SKU is deactivated.
//
// (Column POSITIONS are deliberately not restated in prose — `PO_CSV_HEADERS` is the
// single source of truth, and a hand-written index in a comment goes stale the moment
// someone inserts a column, which is exactly what happened when `Brand` was added.)

import { DS_LIST } from "./engine/constants.js";
import { normaliseStatus } from "./skuStatus.js";

export const PO_CSV_HEADERS = [
  "Item Name",
  "Inventorised At",
  "SKU",
  "Category",
  "Brand",
  "Status",
  "DC Min",
  "DC Max",
  ...DS_LIST.flatMap((ds) => [`${ds} Min`, `${ds} Max`]),
];

/** Index of the first numeric column. Everything from here on is a bare number, and
 *  everything before it is a quoted text field. Derived, not hardcoded, so inserting
 *  another identity column (as `Brand` was on 2026-08-03) cannot desynchronise it. */
export const PO_FIRST_NUMERIC_COL = PO_CSV_HEADERS.indexOf("DC Min");

// `normaliseStatus` lives in ./skuStatus.js — shared with the SKU Master CSV so the two
// downloads can never disagree on how a status is spelled.

// Text fields are quoted (item names contain commas, and really do contain quotes —
// e.g. a floor drain described as 5" x 5"). Numbers are left UNQUOTED so Sheets reads
// them as numbers rather than text, which is what the PO team's formulas need.
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** A missing engine entry or store yields 0, never blank — blanks break SUM and
 *  comparison in Sheets, and 0/0 is the honest value for a SKU with no target. */
const num = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Build the PO team CSV.
 *
 * @param {object}  skuMaster      { [sku]: { sku, name, category, status, inventorisedAt } }
 * @param {object}  results        engine output: { [sku]: { dc, stores } }
 * @param {object}  coreOverrides  { [sku]: { [ds]: {min,max} } } — DS-keyed only, no DC key
 * @returns {string|null} CSV text, or null if there is nothing to write
 */
export function buildPoTargetsCsv({ skuMaster, results, coreOverrides } = {}) {
  const master = skuMaster || {};
  const res = results || {};
  const ovr = coreOverrides || {};
  const skus = Object.values(master);
  if (!skus.length) return null;

  const lines = skus.map((s) => {
    const r = res[s.sku];
    const dsCols = DS_LIST.flatMap((ds) => {
      const st = r?.stores?.[ds];
      // Manual overrides win only upward, matching the existing Tool Output DS button
      // exactly — the two files must never disagree on the same store.
      const ov = ovr[s.sku]?.[ds];
      const min = num(st?.min);
      const max = num(st?.max);
      return ov ? [Math.max(min, num(ov.min)), Math.max(max, num(ov.max))] : [min, max];
    });
    return [
      q(s.name || s.sku),
      q(s.inventorisedAt || "DC"),
      q(s.sku),
      q(s.category || ""),
      q(s.brand || ""),
      q(normaliseStatus(s.status)),
      num(r?.dc?.min),
      num(r?.dc?.max),
      ...dsCols,
    ].join(",");
  });

  return [PO_CSV_HEADERS.map(q).join(","), ...lines].join("\n");
}

/**
 * Filename carrying BOTH dates, deliberately.
 *
 * `refreshedOn` is when the file was produced; `demandThrough` is the newest invoice
 * date the numbers were computed from — and only the second one tells you whether the
 * file is current. They are in the filename rather than a metadata row because a row
 * above the header would break paste-into-sheet, which is exactly why the TO tool's
 * CSV starts at its header row.
 */
export function poCsvFilename({ refreshedOn, demandThrough }) {
  const safe = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? "")) ? d : "unknown");
  return `PO_Targets_${safe(refreshedOn)}_demand-thru-${safe(demandThrough)}.csv`;
}

// Freshness gating lives in ./freshness.js (`assessOutputFreshness`) — it now governs all
// four Tool Output downloads, not just this one, so it does not belong in this file.
