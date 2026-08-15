// SKU x DS Ceilings — DRY RUN. Reads prod Supabase and a candidate CSV, runs the
// REAL engine both ways, prints exactly what would change. Writes NOTHING.
//
//   npx vite-node scripts/dryrun-sku-ceiling.mjs path/to/SKU_Ceilings.csv
//   npx vite-node scripts/dryrun-sku-ceiling.mjs            # assess what is STORED
//
// ⚠ WHY THIS EXISTS AND NOT JUST THE UI: `.env` points at production, so
// `npm run dev` on localhost READS AND WRITES PROD — confirming the upload modal
// writes `team_data/global` for every user immediately. This script is the only way
// to measure a candidate ceiling file without touching anything.
//
// Imports the same `parseSkuCeilingCsv` and the same `runEngine` the app uses, on
// purpose: a dry run that re-implements either proves nothing about the thing that
// will actually write. Same reasoning as dryrun-sku-floors.mjs.

import { readFileSync } from "node:fs";
import { runEngine } from "../src/engine/index.js";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";
import { parseSkuCeilingCsv } from "../src/skuCeilingCsv.js";
import { computeInvValue } from "../src/invValue.js";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };
const load = async (t, id) => {
  const r = await fetch(`${B}/${t}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${t}/${id}: HTTP ${r.status}`);
  return (await r.json())[0]?.payload ?? null;
};

const cr = (n) => `Rs${(n / 1e7).toFixed(4)}Cr`;
const lakh = (n) => `${n < 0 ? "-" : "+"}Rs${(Math.abs(n) / 1e5).toFixed(2)}L`;
const list = (a, n = 10) => (a.length <= n ? a.join(", ") : `${a.slice(0, n).join(", ")} ... (+${a.length - n})`);

const file = process.argv[2];

const [sbParams, team, invRow] = await Promise.all([
  load("params", "global"), load("team_data", "global"), load("team_data", "invoice_data"),
]);
const activeParams = { ...DEFAULT_PARAMS, ...sbParams };
Object.assign(activeParams, (await loadParamConfigRows((id) => load("params", id), DS_LIST)).extra);

const invoiceData = invRow?.invoiceData ?? [];
const skuMaster = team?.skuMaster ?? {};
const priceData = team?.priceData ?? {};
const newSKUQty = team?.newSKUQty ?? {};
const stored = team?.skuCeiling ?? {};

console.log("LOAD");
console.log(`  invoiceData ${invoiceData.length.toLocaleString()} rows · skuMaster ${Object.keys(skuMaster).length} · newSKUQty ${Object.keys(newSKUQty).length}`);
console.log(`  stored skuCeiling: ${Object.keys(stored).length} SKUs`);

// ── The candidate ───────────────────────────────────────────────────────────
let proposed = stored;
if (file) {
  const p = parseSkuCeilingCsv(readFileSync(file, "utf8"), DS_LIST);
  console.log(`\nPARSE  ${file}`);
  console.log(`  ok=${p.ok} reason=${p.reason} · ${p.skuCount} SKUs · ${p.capCells} caps · ${p.zeroCells} at ZERO`);
  if (p.unknownDs.length) console.log(`  x unknown DS columns: ${p.unknownDs.join(", ")}`);
  if (p.duplicateRows) console.log(`  ! ${p.duplicateRows} duplicate row(s) across ${p.duplicateSkus.length} SKU(s) — last row won (append rule)`);
  if (p.invalid.length) {
    console.log(`  x ${p.invalid.length} invalid values:`);
    for (const v of p.invalid.slice(0, 10)) console.log(`      ${v.sku} · ${v.column} = "${v.value}"`);
  }
  if (!p.ok) { console.log("\nX parse failed — the app would REFUSE this file and save nothing"); process.exit(1); }
  proposed = p.ceilings;
} else {
  console.log("\n(no file given — assessing the STORED ceilings against an uncapped run)");
}

// ── Both runs. Only the ceiling map differs. ────────────────────────────────
const run = (c) => runEngine(invoiceData, skuMaster, team?.minReqQty ?? {}, priceData,
  new Set(team?.deadStock ?? []), newSKUQty, activeParams, c);
const before = run(file ? stored : {});
const after = run(proposed);

const bv = computeInvValue(before, priceData, DS_LIST);
const av = computeInvValue(after, priceData, DS_LIST);

const moves = [];
for (const sku of Object.keys(after)) {
  for (const ds of DS_LIST) {
    const a = before[sku]?.stores?.[ds], b = after[sku]?.stores?.[ds];
    if (!a || !b || (a.min === b.min && a.max === b.max)) continue;
    moves.push({ sku, ds, from: `${a.min}/${a.max}`, to: `${b.min}/${b.max}`,
      value: (Number(priceData[sku]) || 0) * (a.max - b.max) });
  }
}
moves.sort((x, y) => y.value - x.value);

console.log(`\nIMPACT`);
console.log(`  SKU x DS cells changed : ${moves.length}`);
console.log(`  Inv Value (Max)        : ${cr(bv.max)} -> ${cr(av.max)}   ${lakh(av.max - bv.max)}`);
console.log(`  Inv Value (Min)        : ${cr(bv.min)} -> ${cr(av.min)}   ${lakh(av.min - bv.min)}`);
if (moves.length) {
  console.log(`\n  biggest reductions:`);
  for (const m of moves.slice(0, 15)) {
    console.log(`    ${m.sku.padEnd(8)} ${m.ds}  ${m.from.padStart(8)} -> ${m.to.padEnd(8)}  ${lakh(-m.value)}  ${skuMaster[m.sku]?.name?.slice(0, 44) ?? ""}`);
  }
}

// ── Caps that cannot do anything, and caps that fight a floor ───────────────
// Nothing to do with the engine; this is the output ops actually acts on. Same
// spirit as dryrun-sku-floors.mjs reporting floors that can never take effect.
const absent = [], notActive = [], conflicts = [], inert = [];
for (const [sku, caps] of Object.entries(proposed)) {
  if (!Object.keys(caps).length) continue;
  const meta = skuMaster[sku];
  if (!meta) { absent.push(sku); continue; }
  if (String(meta.status ?? "Active").toLowerCase() !== "active") { notActive.push(sku); continue; }
  for (const [ds, cap] of Object.entries(caps)) {
    const fl = newSKUQty[sku]?.[ds];
    const fMin = typeof fl === "number" ? fl : Number(fl?.min || 0);
    if (fl && fMin > cap) conflicts.push(`${sku}/${ds} (floor ${fMin} > cap ${cap})`);
    const b = before[sku]?.stores?.[ds];
    if (b && b.max <= cap) inert.push(`${sku}/${ds} (max ${b.max} <= cap ${cap})`);
  }
}
console.log(`\nCAPS WORTH A LOOK`);
console.log(`  absent from skuMaster (cap can never apply) : ${absent.length}${absent.length ? " — " + list(absent, 8) : ""}`);
console.log(`  in master but not Active (already 0/0)      : ${notActive.length}${notActive.length ? " — " + list(notActive, 8) : ""}`);
console.log(`  cap BELOW an existing floor (ceiling wins)  : ${conflicts.length}${conflicts.length ? " — " + list(conflicts, 6) : ""}`);
console.log(`  cap above current Max (no effect today)     : ${inert.length}${inert.length ? " — " + list(inert, 6) : ""}`);

console.log(`\nNothing was written. To apply, upload the CSV in Upload Data and confirm the preview.`);
