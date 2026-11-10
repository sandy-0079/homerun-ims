// Hyderabad (HYDS01) floor-sheet parser. The category team's sheet DEFINES Pati's
// range, so this is strict: a Bangalore sheet (DS01/DC columns) is refused loudly.
// Semantics mirror supabase/functions/_shared/skuFloorSheet.ts (not imported — that
// file is bundled into a deployed nightly function): blank = 0, only ^\d+$,
// max raised to min, last row wins, an all-zero SKU is kept as {} (out of range).
// Pure: no React, no Supabase.
import { parseCSV } from "../engine/utils.js";

const INTEGER = /^\d+$/;
const HYD_COLUMN = /^(HYDS\d+)\s+(Min|Max)$/i;
const FOREIGN_COLUMN = /^(DS\d+|DC)\s+(Min|Max)$/i;

export function parseHydFloorsCsv(text, opts = {}) {
  const dsList = (opts.dsList ?? []).map((d) => String(d).toUpperCase());
  const knownSkus = opts.knownSkus ?? new Set();
  const out = (reason, extra = {}) => ({
    ok: reason === "ok", reason, floors: {}, skuCount: 0, foreignColumns: [],
    invalid: [], duplicateSkus: [], unknownSkus: [], blankSkuRows: 0, ...extra,
  });

  const clean = String(text ?? "").replace(/^﻿/, "").replace(/\r/g, "");
  if (clean.trim() === "") return out("empty");

  // Same header normalisation as parseCSV (split on commas, strip surrounding quotes).
  const header = clean.trim().split("\n")[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  if (!header.some((h) => h.toUpperCase() === "SKU")) return out("header_mismatch");
  const skuCol = header.find((h) => h.toUpperCase() === "SKU");

  const foreignColumns = [];
  const cols = []; // {name, ds, kind}
  for (const h of header) {
    if (FOREIGN_COLUMN.test(h)) { foreignColumns.push(h); continue; }
    const m = HYD_COLUMN.exec(h);
    if (!m) continue;
    const ds = m[1].toUpperCase();
    if (!dsList.includes(ds)) { foreignColumns.push(h); continue; }
    cols.push({ name: h, ds, kind: m[2].toLowerCase() });
  }
  if (foreignColumns.length) return out("foreign_columns", { foreignColumns });
  if (cols.length === 0) return out("header_mismatch");

  const rows = parseCSV(clean);
  if (rows.length === 0) return out("empty");

  const floors = {};
  const invalid = [];
  const dup = new Set();
  let blankSkuRows = 0;

  for (const row of rows) {
    const sku = (row[skuCol] ?? "").trim();
    if (!sku) { blankSkuRows++; continue; }
    const cells = {};
    for (const c of cols) {
      const v = (row[c.name] ?? "").trim();
      if (v !== "" && !INTEGER.test(v)) { invalid.push({ sku, column: c.name, value: v }); continue; }
      (cells[c.ds] ??= { min: 0, max: 0 })[c.kind] = v === "" ? 0 : Number(v);
    }
    const perDs = {};
    for (const [ds, f] of Object.entries(cells)) {
      const max = Math.max(f.max, f.min);
      if (f.min === 0 && max === 0) continue;
      perDs[ds] = { min: f.min, max };
    }
    if (sku in floors) dup.add(sku);
    floors[sku] = perDs; // last row wins
  }

  if (invalid.length) return out("invalid_value", { invalid, floors, skuCount: Object.keys(floors).length });

  const skus = Object.keys(floors);
  return out("ok", {
    floors, skuCount: skus.length, duplicateSkus: [...dup],
    unknownSkus: skus.filter((s) => !knownSkus.has(s)), blankSkuRows,
  });
}
