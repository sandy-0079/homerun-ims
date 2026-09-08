// What would uploading this SKU Master CSV actually do? READ-ONLY.
//
//   npx vite-node scripts/dryrun-sku-master.mjs <file.csv> <snapshot.json>
//   (snapshot from scripts/snapshot-engine-inputs.mjs)
//
// ⚠⚠ WHY THIS EXISTS: THE SKU MASTER UPLOAD REPLACES `skuMaster` ENTIRELY AND HAS NO
// GUARD. Floors have `assessFloorChange`, invoices have `assessCoverage` +
// `mergeInvoiceRows`, ceilings have a confirm modal that runs the engine both ways.
// The SKU Master has none of them — per the operator there is no hard guard on this
// input — so a file short by 200 rows silently deletes 200 SKUs from the catalogue,
// and `inventorisedAt` alone decides whether a SKU is stocked anywhere at all.
//
// It parses with the REAL `parseCSV` and reproduces `handleSKU`'s field mapping
// exactly, so a column-name mismatch shows up here rather than as blank data in prod.
// That is not hypothetical: the first bulk file used `Item Name`, which IMS did not
// read (it read only `Name`), and every one of 2,573 item names would have been
// blanked — including on the Reverse TO list, which is a physical walk sheet where
// the name is how the DS team finds the item on the shelf.
//
// `handleSKU` now accepts `Item Name` as an ALIAS for `Name` (the Tool Output tab's
// SKU_Master.csv emits the former), and this script mirrors that. ⚠ The mirroring is
// the whole point: a diagnostic that reads a different field than the code it checks
// produces a confident wrong answer — see the diag-items post-mortem in CLAUDE.md.
//
// Exits 1 on anything that would lose data, so it can gate an upload.

import { readFileSync } from "node:fs";
import { parseCSV } from "/Users/sandy/Documents/GitHub/homerun-ims/src/engine/utils.js";
import { normalisePolicy, isPolicyNo, isUnrecognisedPolicy } from "/Users/sandy/Documents/GitHub/homerun-ims/src/skuPolicy.js";
import { runEngine } from "/Users/sandy/Documents/GitHub/homerun-ims/src/engine/index.js";
import { DS_LIST } from "/Users/sandy/Documents/GitHub/homerun-ims/src/engine/constants.js";
import { computeInvValue } from "/Users/sandy/Documents/GitHub/homerun-ims/src/invValue.js";

const [csvPath, snapPath] = process.argv.slice(2);
const rows = parseCSV(readFileSync(csvPath, "utf8"));
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const I = snap.inputs;
const liveMaster = I.skuMaster;

console.log(`FILE  ${rows.length} data rows`);
console.log(`  header: ${Object.keys(rows[0] ?? {}).join(" | ")}`);

// ── 1. Column names IMS actually reads ───────────────────────────────────────
// `Name` and `Item Name` are ALIASES, so they are checked as a pair — listing both in
// READS would report a missing column on every well-formed file.
const READS = ["SKU", "Category", "Category Name", "Brand", "Status", "Inventorised At", "Purchase", "Move"];
const NAME_COLS = ["Name", "Item Name"];
const present = new Set(Object.keys(rows[0] ?? {}));
const nameCol = NAME_COLS.find((c) => present.has(c)) ?? null;
const missing = READS.filter((c) => !present.has(c));
const unread = [...present].filter((c) => !READS.includes(c) && !NAME_COLS.includes(c));
console.log(`\nCOLUMNS IMS READS`);
console.log(`  name column resolved  : ${nameCol ?? "NONE — every item name would be BLANK"}`);
console.log(`  missing from the file : ${missing.join(", ") || "(none)"}`);
console.log(`  in file but IGNORED   : ${unread.join(", ") || "(none)"}`);

// ── 2. Build the master exactly as handleSKU does ────────────────────────────
const built = {};
let blankSku = 0;
for (const r of rows) {
  const s = r["SKU"] || "";
  if (!s) { blankSku++; continue; }
  built[s] = {
    sku: s, name: r["Name"] || r["Item Name"] || "", category: r["Category"] || r["Category Name"] || "",
    brand: r["Brand"] || "", status: r["Status"] || "Active",
    inventorisedAt: r["Inventorised At"] || "DS",
    purchase: normalisePolicy(r["Purchase"]), move: normalisePolicy(r["Move"]),
  };
}
const keys = Object.keys(built);
console.log(`\nPARSED  ${keys.length} SKUs (${blankSku} blank-SKU rows skipped, ${rows.length - keys.length - blankSku} duplicate rows collapsed)`);
console.log(`  blank Item Name after parse : ${keys.filter((s) => !built[s].name).length}`);
console.log(`  blank Category              : ${keys.filter((s) => !built[s].category).length}`);
// Blank in the file but populated live = a category LOST. Category drives strategy
// dispatch, so losing one silently drops the SKU to Standard.
const catLostCount = keys.filter((s) => !built[s].category && String(liveMaster[s]?.category ?? "").trim() !== "").length;
console.log(`  categories that would be LOST : ${catLostCount}`);

// ── 3. ⚠ The upload REPLACES ENTIRELY — anything absent is DROPPED ───────────
const liveKeys = Object.keys(liveMaster);
const dropped = liveKeys.filter((s) => !built[s]);
const added = keys.filter((s) => !liveMaster[s]);
console.log(`\n⚠ REPLACE-ENTIRELY CHECK   live ${liveKeys.length} -> file ${keys.length}`);
console.log(`  would be DROPPED (${dropped.length}): ${dropped.slice(0, 12).join(", ") || "(none)"}${dropped.length > 12 ? " …" : ""}`);
console.log(`  new in the file  (${added.length}): ${added.slice(0, 12).join(", ") || "(none)"}${added.length > 12 ? " …" : ""}`);

// ── 4. Vocabulary / value validation ─────────────────────────────────────────
const vals = (f) => keys.reduce((d, s) => { const v = String(built[s][f]); d[v] = (d[v] || 0) + 1; return d; }, {});
const rawVals = (col) => rows.reduce((d, r) => { const v = String(r[col] ?? "").trim() || "(blank)"; d[v] = (d[v] || 0) + 1; return d; }, {});
console.log(`\nVALUES (raw, as written in the file)`);
console.log(`  Inventorised At : ${JSON.stringify(rawVals("Inventorised At"))}`);
console.log(`  Status          : ${JSON.stringify(rawVals("Status"))}`);
console.log(`  Purchase        : ${JSON.stringify(rawVals("Purchase"))}`);
console.log(`  Move            : ${JSON.stringify(rawVals("Move"))}`);
const unrec = rows.filter((r) => isUnrecognisedPolicy(r["Purchase"]) || isUnrecognisedPolicy(r["Move"]))
  .map((r) => `${r["SKU"]}(P="${r["Purchase"]}",M="${r["Move"]}")`);
console.log(`  unreadable policy values: ${unrec.length}${unrec.length ? " -> " + unrec.slice(0, 10).join(", ") : ""}`);
console.log(`  after normalisation -> Purchase ${JSON.stringify(vals("purchase"))} · Move ${JSON.stringify(vals("move"))}`);

// ── 5. The DC-only set ───────────────────────────────────────────────────────
const moveNo = keys.filter((s) => isPolicyNo(built[s].move));
const invAt = (s) => String(built[s].inventorisedAt).trim().toLowerCase();
const dcOnly = moveNo.filter((s) => invAt(s) === "dc");
const incoherent = moveNo.filter((s) => invAt(s) !== "dc" && !isPolicyNo(built[s].purchase));
const purchNo = keys.filter((s) => isPolicyNo(built[s].purchase));
const act = (s) => String(built[s].status).trim().toLowerCase() === "active";
console.log(`\nDC-ONLY SET   Move=No: ${moveNo.length} · of which Inventorised At=DC: ${dcOnly.length}`);
console.log(`  active ${dcOnly.filter(act).length} · not active ${dcOnly.filter((s) => !act(s)).length}`);
console.log(`  ⚠ RED incoherent (Move=No, Purchase=Yes, invAt != DC): ${incoherent.length}${incoherent.length ? " -> " + incoherent.join(", ") : ""}`);
console.log(`  Purchase=No: ${purchNo.length}${purchNo.length ? " -> " + purchNo.slice(0, 10).join(", ") : ""}`);
for (const s of dcOnly) {
  console.log(`    ${s.padEnd(8)} ${built[s].status.padEnd(10)} ${built[s].inventorisedAt.padEnd(9)} P=${built[s].purchase.padEnd(3)} M=${built[s].move.padEnd(3)} ${built[s].name.slice(0, 44) || "(NO NAME)"}`);
}

// ── 6. Engine impact ─────────────────────────────────────────────────────────
const run = (m) => runEngine(I.invoiceData, m, I.minReqQty, I.priceData, new Set(I.deadStock), I.newSKUQty, I.params, I.skuCeiling);
const before = run(liveMaster), after = run(built);
const LOCS = [...DS_LIST, "DC"];
const cell = (r, l) => (l === "DC" ? r?.dc : r?.stores?.[l]);
let moved = 0; const perSku = new Map();
for (const s of new Set([...Object.keys(before), ...Object.keys(after)])) {
  for (const l of LOCS) {
    const a = cell(before[s], l), b = cell(after[s], l);
    const am = a ? `${a.min}/${a.max}` : "—", bm = b ? `${b.min}/${b.max}` : "—";
    if (am !== bm) { moved++; perSku.set(s, [...(perSku.get(s) ?? []), `${l} ${am}->${bm}`]); }
  }
}
const bv = computeInvValue(before, I.priceData, DS_LIST), av = computeInvValue(after, I.priceData, DS_LIST);
const cr = (n) => `₹${(n / 1e7).toFixed(4)}Cr`, lakh = (n) => `${n >= 0 ? "+" : "-"}₹${Math.abs(n / 1e5).toFixed(2)}L`;
console.log(`\nENGINE IMPACT   ${moved} cells across ${perSku.size} SKUs`);
console.log(`  Inv Max ${cr(bv.max)} -> ${cr(av.max)}  ${lakh(av.max - bv.max)}`);
console.log(`  Inv Min ${cr(bv.min)} -> ${cr(av.min)}  ${lakh(av.min - bv.min)}`);
for (const [s, ch] of [...perSku].slice(0, 25)) console.log(`    ${s.padEnd(8)} ${ch.join("  ")}`);
if (perSku.size > 25) console.log(`    … (+${perSku.size - 25} more SKUs)`);

// ── Verdict ──────────────────────────────────────────────────────────────────
const problems = [];
if (!nameCol) problems.push(`header has neither a "Name" nor an "Item Name" column — all ${keys.length} item names would be BLANK`);
if (dropped.length) problems.push(`${dropped.length} SKU(s) in the live master are absent from this file and WOULD BE DELETED`);
if (unrec.length) problems.push(`${unrec.length} unreadable Purchase/Move value(s)`);
if (catLostCount > 0) problems.push(`${catLostCount} SKU(s) would LOSE their category, which drives strategy dispatch`);

console.log("");
if (incoherent.length) {
  console.log(`! ${incoherent.length} SKU(s) have Move=No but are not DC-inventorised. Move governs the`);
  console.log(`  DC->DS arc, so it does NOTHING there and they stay stocked at the dark stores.`);
  console.log(`  Harmless if deliberate, but the nightly digest will go RED every morning.`);
  console.log(`  Leave Move blank on DS-inventorised and Supplier SKUs unless you mean it.`);
}
if (problems.length === 0) {
  console.log("OK - safe to upload. Nothing would be lost.");
} else {
  console.log("PROBLEMS - do not upload until these are fixed:");
  for (const p of problems) console.log(`  x ${p}`);
}
console.log("\nNothing was written. Take a dated team_data/catalogue_backup before uploading for real.");
process.exit(problems.length === 0 ? 0 : 1);
