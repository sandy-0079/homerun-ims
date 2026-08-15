// Parse + guard for the ops SKU-floor Google Sheet (published-to-web CSV export).
//
// The sheet is AUTHORITATIVE: it replaces `newSKUQty` wholesale. `0` (or a
// deleted row) removes a floor, which is exactly why this module fails closed on
// anything it does not fully understand — the failure mode we are guarding is a
// SILENT mass removal, and a replace-entirely writer turns one bad fetch into
// "every floor is gone". Any rejection leaves the previous complete state in
// place, the same property as the invoice sync's atomic publish.
//
// ⚠ The output shape must match the browser uploader (`App.jsx` handleFloors)
// EXACTLY, because the engine reads whichever one wrote last:
//   floors[sku][ds] = { min, max }   with max floored at min, DSes at 0/0 omitted,
//   and an all-zero SKU kept as a present-but-EMPTY object (not dropped).
// `skuFloorSheet.test.ts` pins that shape; changing either side must fail there.

export type Floor = { min: number; max: number };
export type FloorMap = Record<string, Record<string, Floor>>;

// ⚠ `duplicate_sku` WAS a reason here and is deliberately gone (2026-08-15). It
// refused two nights running, and re-uploading the very same sheet by hand fixed
// it — because `App.jsx handleNSQ` resolves duplicates by last-row-wins and says
// nothing. Two writers of `newSKUQty` disagreeing about which row is live is the
// real defect; the sync now mirrors the browser. See the append-rule note below.
export type ParseReason =
  | "ok"
  | "header_mismatch"
  | "unknown_ds"
  | "invalid_value"
  | "empty";

export type ParseResult = {
  ok: boolean;
  reason: ParseReason;
  floors: FloorMap;
  skuCount: number;
  unknownDs: string[];
  /** SKUs that appeared more than once; resolved to their LAST row, reported for cleanup. */
  duplicateSkus: string[];
  /** Superseded ROWS, not SKUs — 96 rows across 95 SKUs on the live sheet 2026-08-15. */
  duplicateRows: number;
  invalid: { sku: string; column: string; value: string }[];
  blankSkuRows: number;
};

// Only unsigned integers. A blank cell is 0; anything else (2.5, -1, "abc", a
// stray space-and-text) is REJECTED rather than coerced, because `parseFloat`
// silently turning a typo into 0 is indistinguishable from ops removing a floor.
const INTEGER = /^\d+$/;
const DS_COLUMN = /^(DS\d+)\s+(Min|Max)$/i;

const splitRow = (line: string) => line.split(",").map((c) => c.trim());

export function parseFloorSheet(csv: string, dsList: string[]): ParseResult {
  const base: ParseResult = {
    ok: false, reason: "header_mismatch", floors: {}, skuCount: 0,
    unknownDs: [], duplicateSkus: [], duplicateRows: 0, invalid: [], blankSkuRows: 0,
  };

  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return base;

  // ── Header. A revoked publish serves an HTML error page, which has no SKU
  //    column and so dies here — the cheapest and strongest of the guards.
  const header = splitRow(lines[0]);
  const skuIdx = header.findIndex((h) => h.toUpperCase() === "SKU");
  if (skuIdx === -1) return base;

  const cols: { ds: string; kind: "min" | "max"; idx: number }[] = [];
  const seenDs = new Set<string>();
  for (let i = 0; i < header.length; i++) {
    const m = DS_COLUMN.exec(header[i]);
    if (!m) continue;
    const ds = m[1].toUpperCase();
    seenDs.add(ds);
    cols.push({ ds, kind: m[2].toLowerCase() as "min" | "max", idx: i });
  }
  if (cols.length === 0) return base;

  // ⚠ A DS the engine does not know about is a hard stop, never a skip: ops adds
  // DS07 columns to the sheet before `DS_LIST` gains it, and writing floors for a
  // store the engine ignores would look like a successful sync that did nothing.
  const known = new Set(dsList.map((d) => d.toUpperCase()));
  const unknownDs = [...seenDs].filter((d) => !known.has(d)).sort();
  if (unknownDs.length) return { ...base, reason: "unknown_ds", unknownDs };

  const floors: FloorMap = {};
  const duplicateSkus: string[] = [];
  const invalid: ParseResult["invalid"] = [];
  let blankSkuRows = 0;
  let duplicateRows = 0;

  for (const line of lines.slice(1)) {
    const cells = splitRow(line);
    const sku = (cells[skuIdx] ?? "").trim();
    if (!sku) { blankSkuRows++; continue; }
    // ⚠ THE APPEND RULE: note there is NO `continue` here. Ops revises a floor by
    // appending a row rather than editing in place, so the last occurrence is the
    // current one and must overwrite — including when it zeroes a DS, which is how
    // ops removes a floor. This mirrors `App.jsx handleNSQ` (`nsq[s]={}` per row)
    // exactly, so the sheet sync and the manual CSV fallback can never resolve the
    // same sheet differently. Recorded, never silent: reporting is what refusing
    // used to buy us.
    if (Object.prototype.hasOwnProperty.call(floors, sku)) {
      duplicateRows++;
      if (!duplicateSkus.includes(sku)) duplicateSkus.push(sku);
    }

    const vals: Record<string, { min: number; max: number }> = {};
    for (const c of cols) {
      const raw = (cells[c.idx] ?? "").trim();
      const n = raw === "" ? 0 : (INTEGER.test(raw) ? Number(raw) : NaN);
      if (Number.isNaN(n)) {
        invalid.push({ sku, column: header[c.idx], value: raw });
        continue;
      }
      (vals[c.ds] ??= { min: 0, max: 0 })[c.kind] = n;
    }

    // Present-but-empty when every DS is 0/0 — mirrors the browser's `nsq[s]={}`.
    floors[sku] = {};
    for (const [ds, v] of Object.entries(vals)) {
      if (v.min > 0 || v.max > 0) floors[sku][ds] = { min: v.min, max: Math.max(v.min, v.max) };
    }
  }

  const skuCount = Object.keys(floors).length;
  // ⚠ Zero SKUs from a structurally VALID header is always an accident — an empty
  // tab, or a filter hiding every row. It must be refused here rather than left to
  // the change guard, because `force: true` widens that guard to 100% and would
  // then write `{}` over every live floor. Parse validation is the layer `force`
  // cannot reach: it overrides POLICY, never CORRECTNESS.
  if (skuCount === 0) {
    return { ...base, reason: "empty", floors, skuCount, duplicateSkus, duplicateRows, invalid, blankSkuRows };
  }
  if (invalid.length) {
    return { ...base, reason: "invalid_value", floors, skuCount, duplicateSkus, duplicateRows, invalid, blankSkuRows };
  }
  return {
    ok: true, reason: "ok", floors, skuCount, unknownDs: [],
    duplicateSkus, duplicateRows, invalid: [], blankSkuRows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export type ChangeReason = "ok" | "first_run" | "row_collapse" | "floor_collapse";

export type ChangeAssessment = {
  safe: boolean;
  reason: ChangeReason;
  dropPct: number;       // fall in SKU keys
  floorDropPct: number;  // fall in SKUs actually carrying a floor
  liveCount: number;
  parsedCount: number;
  liveWithFloors: number;
  parsedWithFloors: number;
  added: string[];
  removed: string[];
  changed: string[];
};

// Ops removing 5-10 floors of ~1,148 is routine and deliberate, so the guard is
// on the DROP, not on the count: a 20% fall blocks, anything smaller passes and
// is reported per-SKU. That admits even a 50-row cleanup (4.4%) while catching
// both named failure modes — `1,148 -> 3`, and a filter left applied leaving one
// DS's worth of rows. `force: true` exists for a genuine mass cleanup, so failing
// closed is never a dead end.
//
// ⚠ MEASURED ON TWO DIMENSIONS, and the second is the non-obvious one. Ops
// removes a floor EITHER by deleting the row OR by setting it to 0,0 — and the
// second leaves the SKU key in place, so a key-count guard alone reads a 0% drop
// and would wave through a bad formula that zeroed every value column: 1,148
// rows in, 1,148 rows out, every floor gone. So `floorDropPct` tracks SKUs
// actually CARRYING a floor. Either dimension falling too far fails closed.
const MAX_DROP_PCT = 20;

const countWithFloors = (m: FloorMap) =>
  Object.values(m ?? {}).filter((f) => Object.keys(f ?? {}).length > 0).length;

const canonical = (f: Record<string, Floor> = {}) =>
  JSON.stringify(Object.keys(f).sort().map((ds) => [ds, f[ds].min, f[ds].max]));

export function assessFloorChange(args: {
  parsed: FloorMap;
  live: FloorMap;
  maxDropPct?: number;
}): ChangeAssessment {
  const { parsed, live, maxDropPct = MAX_DROP_PCT } = args;
  const liveKeys = Object.keys(live ?? {});
  const parsedKeys = Object.keys(parsed ?? {});

  const added = parsedKeys.filter((s) => !(s in live)).sort();
  const removed = liveKeys.filter((s) => !(s in parsed)).sort();
  const changed = parsedKeys
    .filter((s) => s in live && canonical(parsed[s]) !== canonical(live[s]))
    .sort();

  const liveWithFloors = countWithFloors(live);
  const parsedWithFloors = countWithFloors(parsed);

  const out = {
    dropPct: 0, floorDropPct: 0,
    liveCount: liveKeys.length, parsedCount: parsedKeys.length,
    liveWithFloors, parsedWithFloors,
    added, removed, changed,
  };

  // Nothing stored yet — the first run has no baseline to collapse from, and
  // treating it as a 100% drop would block the very run that establishes one.
  if (liveKeys.length === 0) return { safe: true, reason: "first_run", ...out };

  const dropPct = ((liveKeys.length - parsedKeys.length) / liveKeys.length) * 100;
  // Guard the same way on floors carried; skip when there is no baseline to fall
  // from, or a catalogue that legitimately held no floors would refuse forever.
  const floorDropPct = liveWithFloors === 0
    ? 0
    : ((liveWithFloors - parsedWithFloors) / liveWithFloors) * 100;

  if (dropPct > maxDropPct) {
    return { safe: false, reason: "row_collapse", ...out, dropPct, floorDropPct };
  }
  if (floorDropPct > maxDropPct) {
    return { safe: false, reason: "floor_collapse", ...out, dropPct, floorDropPct };
  }
  return { safe: true, reason: "ok", ...out, dropPct, floorDropPct };
}
