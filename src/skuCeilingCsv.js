// Parse for the SKU x DS Ceiling CSV — an absolute cap on what may be stocked at
// a store, whatever the strategy computed.
//
// WHY IT EXISTS: every strategy guardrail leaves outliers. Measured 2026-08-15,
// G9NYZ (Finolex 300m coil, Rs6,269) came out 19/29 at DS05 off two order-days —
// 20 units on 07-09 and 1 on 07-29 — because Fixed Unit Floor's P90 of [20,1] is
// 18.1, its order-days gate needs NZD >= 2 (it was exactly 2) and its spike cap
// needs >= 3 orders (there were 2). Rs1.82L of wire at one dark store. That is the
// "2-order spike" gap CLAUDE.md logged as consciously accepted in July. Rather than
// add a fourth guardrail that the fifth outlier will slip past, ops caps the SKU.
//
// ⚠⚠ BLANK AND 0 ARE OPPOSITES HERE — the single thing to get right, and the one
// place this must NOT copy `parseFloorSheet`. That parser folds a blank cell into
// 0 because for a FLOOR "0" and "no floor" say the same thing. For a CEILING:
//     blank -> NO CAP    (stock whatever the strategy says)
//     0     -> CAP AT 0  (stock nothing at this DS)
// Fold them together and a mostly-blank sheet zeroes the network. A cap of 0 is a
// real, wanted case: Dead Stock zeroes a SKU at EVERY location including the DC,
// so it cannot express "none at DS01-03, normal at DS04-06".
//
// ⚠ Everything else fails closed, exactly like the floor sheet: a non-integer, a
// negative, an unknown DS column or a file with no SKUs is REJECTED rather than
// coerced. `parseFloat` turning a typo into 0 would silently cap a store at zero.
//
// ⚠ Duplicate SKU rows follow the ops APPEND RULE — last row wins, reported. Held
// deliberately identical to `_shared/skuFloorSheet.ts` (2026-08-15): two ops inputs
// resolving the same ambiguity differently is exactly the bug that made the floor
// sync refuse two nights running while a manual re-upload of the same file worked.

/** `ceilings[sku][ds] = cap`. A DS absent from the inner object has NO cap. */

const INTEGER = /^\d+$/;
const CSV_SKU = "SKU";
const CAP_COLUMN = /^(DS\d+)\s+Cap$/i;

const splitRow = (line) => line.split(",").map((c) => c.trim());

export function parseSkuCeilingCsv(csv, dsList) {
  const base = {
    ok: false,
    reason: "header_mismatch",
    ceilings: {},
    skuCount: 0,
    capCells: 0,
    zeroCells: 0,
    unknownDs: [],
    duplicateSkus: [],
    duplicateRows: 0,
    invalid: [],
    blankSkuRows: 0,
  };

  const lines = String(csv ?? "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return base;

  const header = splitRow(lines[0]);
  const skuIdx = header.findIndex((h) => h.toUpperCase() === "SKU");
  if (skuIdx === -1) return base;

  const cols = [];
  const seenDs = new Set();
  for (let i = 0; i < header.length; i++) {
    const m = CAP_COLUMN.exec(header[i]);
    if (!m) continue;
    const ds = m[1].toUpperCase();
    seenDs.add(ds);
    cols.push({ ds, idx: i });
  }
  // No Cap columns at all also catches someone uploading the FLOORS file here by
  // mistake — its columns are "DS01 Min"/"DS01 Max" and match nothing.
  if (cols.length === 0) return base;

  const known = new Set(dsList.map((d) => d.toUpperCase()));
  const unknownDs = [...seenDs].filter((d) => !known.has(d)).sort();
  if (unknownDs.length) return { ...base, reason: "unknown_ds", unknownDs };

  const ceilings = {};
  const duplicateSkus = [];
  const invalid = [];
  let blankSkuRows = 0;
  let duplicateRows = 0;

  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const sku = (cells[skuIdx] ?? "").trim();
    if (!sku) { blankSkuRows++; continue; }
    // Append rule: no `continue`. A later row replaces the earlier one wholesale,
    // so blanking a cell in the later row genuinely removes that cap.
    if (Object.prototype.hasOwnProperty.call(ceilings, sku)) {
      duplicateRows++;
      if (!duplicateSkus.includes(sku)) duplicateSkus.push(sku);
    }

    const caps = {};
    for (const c of cols) {
      // ⚠ `?? ""` matters: a short row (trimmed export) gives `undefined`, which
      // must read as blank/no-cap, never as 0.
      const raw = (cells[c.idx] ?? "").trim();
      if (raw === "") continue;               // <- NO CAP. Not zero.
      if (!INTEGER.test(raw)) { invalid.push({ sku, column: header[c.idx], value: raw }); continue; }
      caps[c.ds] = Number(raw);               // 0 is legal and meaningful
    }
    ceilings[sku] = caps;
  }

  const skuCount = Object.keys(ceilings).length;
  let capCells = 0, zeroCells = 0;
  for (const caps of Object.values(ceilings)) {
    for (const v of Object.values(caps)) { capCells++; if (v === 0) zeroCells++; }
  }

  // A structurally valid header with zero SKUs is always an accident — an empty
  // tab, or a filter hiding every row. Same reasoning as parseFloorSheet.
  if (skuCount === 0) return { ...base, reason: "empty", blankSkuRows, invalid };
  if (invalid.length) {
    return { ...base, reason: "invalid_value", ceilings, skuCount, capCells, zeroCells, duplicateSkus, duplicateRows, invalid, blankSkuRows };
  }
  return {
    ok: true, reason: "ok", ceilings, skuCount, capCells, zeroCells,
    unknownDs: [], duplicateSkus, duplicateRows, invalid: [], blankSkuRows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialise ceilings back to the upload format — the Upload Data card's
 * `⬇ Data` backup button.
 *
 * ⚠⚠ DELIBERATELY DIRECTLY BELOW ITS READER, and pinned by a round-trip test.
 * The invoice `⬇ Data` button silently produced a file that re-imported as ZERO
 * rows for months, because the writer lived in App.jsx ~3,000 lines from the
 * parser with an unasserted invariant between them — and since an invoice upload
 * replaces entirely, using that backup would have wiped all history. Same shape
 * as `buildInvoiceCsv` / `parseInvoiceCsv` and `paramConfigRows` / `teamDataBundle`.
 *
 * ⚠ THE ROUND-TRIP HAZARD HERE IS BLANK vs 0. An uncapped DS must serialise to an
 * EMPTY cell, never to "0" — writing 0 would turn "no cap" into "stock nothing"
 * on re-upload, i.e. a backup that zeroes the stores it was meant to protect.
 */
export function buildSkuCeilingCsv(ceilings, dsList) {
  const header = [CSV_SKU, ...dsList.map((d) => `${d} Cap`)];
  const lines = [header.join(",")];
  for (const sku of Object.keys(ceilings ?? {}).sort()) {
    const caps = ceilings[sku] ?? {};
    const cells = dsList.map((ds) => {
      const v = caps[ds];
      // `typeof number` and not `v ? ... : ""` — 0 is falsy and is a real cap.
      return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
    });
    lines.push([sku, ...cells].join(","));
  }
  return lines.join("\n");
}
