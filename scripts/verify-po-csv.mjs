// Verify the PO Team Download CSV against LIVE production data, without a browser.
//
//   npx vite-node scripts/verify-po-csv.mjs
//
// READ-ONLY. Writes nothing anywhere. Loads exactly what App.jsx loads, runs the real
// engine, runs the real buildPoTargetsCsv, then asserts the properties the PO team's
// sheet formulas depend on — column count on EVERY row (an unescaped comma in one item
// name would shift that row's columns and silently misalign their formulas), the frozen
// header order, and that Supplier / non-active SKUs come out 0/0 but are still present
// so the sheet can filter them.

import { runEngine } from "../src/engine/index.js";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";
import { buildPoTargetsCsv, PO_CSV_HEADERS, PO_FIRST_NUMERIC_COL, poCsvFilename } from "../src/poTargetsCsv.js";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };
const load = async (t, id) => {
  const r = await fetch(`${B}/${t}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${t}/${id}: HTTP ${r.status}`);
  return (await r.json())[0]?.payload ?? null;
};

// Proper CSV field split — a naive split(",") shifts columns on any quoted comma.
const cells = (line) => {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '""'; i++; continue; } inQ = !inQ; cur += ch; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur); return out;
};
const unq = (c) => c.replace(/^"|"$/g, "").replace(/""/g, '"');

const [sbParams, team, invRow, sbOverrides] = await Promise.all([
  load("params", "global"), load("team_data", "global"),
  load("team_data", "invoice_data"), load("overrides", "global"),
]);

const activeParams = sbParams ? { ...DEFAULT_PARAMS, ...sbParams } : DEFAULT_PARAMS;
Object.assign(activeParams, (await loadParamConfigRows((id) => load("params", id), DS_LIST)).extra);

const invoiceData = invRow?.invoiceData ?? [];
const skuMaster = team?.skuMaster ?? {};
const coreOverrides = sbOverrides ?? {};
const pageThrough = [...new Set(invoiceData.map((r) => r.date))].sort().at(-1) ?? null;

console.log(`LOAD  invoiceData ${invoiceData.length.toLocaleString()} rows through ${pageThrough} · skuMaster ${Object.keys(skuMaster).length} · coreOverrides ${Object.keys(coreOverrides).length} SKUs`);

const results = runEngine(
  invoiceData, skuMaster, team?.minReqQty ?? {}, team?.priceData ?? {},
  new Set(team?.deadStock ?? []), team?.newSKUQty ?? {}, activeParams,
);
console.log(`ENGINE  ${Object.keys(results).length} SKUs\n`);

const csv = buildPoTargetsCsv({ skuMaster, results, coreOverrides });
const lines = csv.split("\n");
const hdr = cells(lines[0]).map(unq);

// ⚠ Indices derived from the header, never hardcoded — `Brand` was inserted after
// `Category` on 2026-08-03 and shifted every numeric column one right.
const IX = Object.fromEntries(PO_CSV_HEADERS.map((h, i) => [h, i]));
const N = PO_CSV_HEADERS.length;

let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};

console.log("HEADER");
check(JSON.stringify(hdr) === JSON.stringify(PO_CSV_HEADERS), "matches the frozen contract, in order");
console.log(`      ${hdr.join(" | ")}`);

console.log("\nSHAPE");
check(lines.length - 1 === Object.keys(skuMaster).length, "one row per master SKU", `${lines.length - 1} rows`);
const wrongWidth = lines.map((l, i) => ({ i, n: cells(l).length })).filter((x) => x.n !== N);
check(wrongWidth.length === 0, `EVERY row has exactly ${N} columns`,
  wrongWidth.length ? `BAD: lines ${wrongWidth.slice(0, 5).map((x) => x.i).join(", ")}` : "");

const body = lines.slice(1).map(cells);
const blanks = body.filter((c) => c.slice(PO_FIRST_NUMERIC_COL).some((v) => v.trim() === ""));
check(blanks.length === 0, "no blank numeric cells (0 everywhere instead)");
const nonNumeric = body.filter((c) => c.slice(PO_FIRST_NUMERIC_COL).some((v) => !/^-?\d+(\.\d+)?$/.test(v)));
check(nonNumeric.length === 0, "all 14 numeric cells are bare unquoted numbers",
  nonNumeric.length ? `BAD e.g. ${unq(nonNumeric[0][2])}` : "");

console.log("\nSTATUS + INVENTORISED AT (the two filter columns)");
const tally = (idx) => body.reduce((a, c) => { const k = unq(c[idx]); a[k] = (a[k] || 0) + 1; return a; }, {});
const st = tally(IX["Status"]), ia = tally(IX["Inventorised At"]);
console.log(`      Status:         ${Object.entries(st).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
console.log(`      InventorisedAt: ${Object.entries(ia).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
check(Object.keys(st).every((k) => /^[A-Z]/.test(k)), "every Status value is normalised (leading capital)");
check(!Object.keys(st).some((k) => k.includes("_")), "no snake_case leaked into Status");

console.log("\nSTRUCTURAL ZEROS (present so the sheet can filter them, but 0/0)");
const allZero = (c) => c.slice(PO_FIRST_NUMERIC_COL).every((v) => v === "0");
const supplier = body.filter((c) => unq(c[IX["Inventorised At"]]) === "Supplier");
const notActive = body.filter((c) => unq(c[IX["Status"]]) !== "Active");
check(supplier.length > 0 && supplier.every(allZero), `all ${supplier.length} Supplier rows are 0/0`);
check(notActive.every(allZero), `all ${notActive.length} non-active rows are 0/0`);
const dsInv = body.filter((c) => unq(c[IX["Inventorised At"]]) === "DS");
check(dsInv.every((c) => c[IX["DC Min"]] === "0" && c[IX["DC Max"]] === "0"), `all ${dsInv.length} DS-inventorised rows have DC 0/0 (bypasses the DC)`);

console.log("\nSANITY — rows the PO team will actually act on");
const actionable = body.filter((c) => unq(c[IX["Status"]]) === "Active" && unq(c[IX["Inventorised At"]]) !== "Supplier" && !allZero(c));
console.log(`      ${actionable.length} rows carry a non-zero target`);
check(actionable.length > 1000, "actionable row count is plausible");

console.log(`\nFILENAME  ${poCsvFilename({ refreshedOn: "2026-08-03", demandThrough: pageThrough })}`);
console.log("\nSAMPLE (first 3 actionable rows)");
for (const c of actionable.slice(0, 3)) {
  console.log(`      ${unq(c[IX["SKU"]]).padEnd(20)} ${unq(c[IX["Brand"]]).slice(0,16).padEnd(17)} ${unq(c[IX["Inventorised At"]]).padEnd(9)} DC ${c[IX["DC Min"]]}/${c[IX["DC Max"]]}  DS01 ${c[IX["DS01 Min"]]}/${c[IX["DS01 Max"]]}  DS06 ${c[IX["DS06 Min"]]}/${c[IX["DS06 Max"]]}`);
}

console.log(fail === 0 ? "\n✅ ALL CHECKS PASSED" : `\n❌ ${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
