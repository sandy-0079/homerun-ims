// Reconcile team_data/invoice_data against a Zoho CSV export on disk.
//
// Read-only: one Supabase read, no Zoho calls, no writes. This is the tool that
// answers "is the nightly sync actually capturing every sale?" — the check that
// would have caught 2026-07-28, when a status allowlist silently dropped 27.7% of a
// day's quantity while the status row still read ok:true.
//
//   npx vite-node scripts/compare-csv-vs-live.mjs <path-to-csv>
//
// ⚠ THE METRIC THAT MATTERS IS `in CSV but MISSING from live`, AND IT MUST BE ZERO
// ON EVERY DATE. A leak subtracts ONE-DIRECTIONALLY. Two-way drift is expected and
// benign: the CSV is a snapshot taken hours after the pull, so an invoice created or
// voided in between shows up as a difference. Check that every difference resolves to
// a named invoice; do not read "0 differing" literally against a same-day export.
//
// ⚠ THE ZOHO EXPORT LOCALE STILL EMITS DD/MM/YYYY (Open Work item 19), and
// parseInvoiceCsv correctly REFUSES that — it is the guard added after the 2026-07-29
// outage. So this script is blocked until that Zoho setting is fixed. Converting a
// scratch copy is safe ONLY when every distinct date's leading component is >12
// (provably a day); assert that rather than assuming, and never convert the file you
// would upload.
//
// The CSV side is parsed by the REAL parseInvoiceCsv from src/engine/utils.js — not a
// reimplementation — so a parser difference cannot masquerade as a sync bug.
//
// Renamed from compare-csv-vs-shadow.mjs on 2026-08-04 when team_data/
// invoice_data_shadow was deleted; it now reads the live row.

import { readFileSync } from "node:fs";
import { parseInvoiceCsv } from "../src/engine/utils.js";

const CSV = process.argv[2];
const URL = "https://rgyupnrogkbugsadwlye.supabase.co";
const KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";

const res = await fetch(`${URL}/rest/v1/team_data?select=payload&id=eq.invoice_data`, { headers: { apikey: KEY } });
const liveRows = (await res.json())[0].payload.invoiceData;

const csvRows = parseInvoiceCsv(readFileSync(CSV, "utf8"));

const dates = [...new Set(csvRows.map((r) => r.date))].sort();
const sum = (rows) => rows.reduce((a, r) => a + r.qty, 0);
const skuDsAgg = (rows) =>
  rows.reduce((m, r) => m.set(`${r.sku}|${r.ds}`, (m.get(`${r.sku}|${r.ds}`) || 0) + r.qty), new Map());

console.log(`csv    : ${csvRows.length} sellable rows over ${dates.length} dates (${dates.join(", ")})`);
console.log(`live   : ${liveRows.length} rows total\n`);

let anyBad = false;

for (const date of dates) {
  const C = csvRows.filter((r) => r.date === date);
  const S = liveRows.filter((r) => r.date === date);

  console.log("=".repeat(78));
  console.log(`${date}`);
  console.log("=".repeat(78));
  console.log(`rows   csv ${C.length}   live ${S.length}   delta ${S.length - C.length}`);
  console.log(`qty    csv ${Math.round(sum(C))}   live ${Math.round(sum(S))}   delta ${Math.round(sum(S) - sum(C))}`);

  // ── Invoice-level: which orders did the sync never get? This is the diagnostic
  // that turns "detailCallsFailed: 15" into named, re-fetchable invoices.
  const orders = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = r.shopifyOrder || "(blank)";
      if (!m.has(k)) m.set(k, { rows: 0, qty: 0 });
      const e = m.get(k); e.rows++; e.qty += r.qty;
    }
    return m;
  };
  const [co, so] = [orders(C), orders(S)];
  const missing = [...co.keys()].filter((k) => !so.has(k));
  const extra = [...so.keys()].filter((k) => !co.has(k));

  console.log(`orders csv ${co.size}   live ${so.size}`);
  console.log(`  in CSV but MISSING from live : ${missing.length}` +
    (missing.length ? `  (${missing.reduce((a, k) => a + co.get(k).rows, 0)} rows, ${Math.round(missing.reduce((a, k) => a + co.get(k).qty, 0))} qty)` : ""));
  for (const k of missing.slice(0, 25)) console.log(`     - ${k}  ${co.get(k).rows} rows, ${Math.round(co.get(k).qty)} qty`);
  if (missing.length > 25) console.log(`     ... and ${missing.length - 25} more`);

  console.log(`  in live but not in CSV         : ${extra.length}`);
  for (const k of extra.slice(0, 25)) console.log(`     + ${k}  ${so.get(k).rows} rows, ${Math.round(so.get(k).qty)} qty`);
  if (extra.length > 25) console.log(`     ... and ${extra.length - 25} more`);

  // ── SKU×DS: the granularity the engine actually consumes. Matching totals with
  // mismatched aggregates would still move Min/Max.
  const [ca, sa] = [skuDsAgg(C), skuDsAgg(S)];
  const diffs = [];
  for (const k of new Set([...ca.keys(), ...sa.keys()])) {
    const [c, s] = [ca.get(k) || 0, sa.get(k) || 0];
    if (c !== s) diffs.push({ k, csv: c, live: s, d: s - c });
  }
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`sku×ds combos  csv ${ca.size}  live ${sa.size}  differing ${diffs.length}`);
  for (const d of diffs.slice(0, 20)) console.log(`     ${d.k.padEnd(16)} csv ${String(Math.round(d.csv)).padStart(6)}  live ${String(Math.round(d.live)).padStart(6)}  ${d.d > 0 ? "+" : ""}${Math.round(d.d)}`);
  if (diffs.length > 20) console.log(`     ... and ${diffs.length - 20} more`);

  // Pin coverage drives attribution; a drop here silently reverts DSes to the
  // fulfilling-store default without any other symptom.
  const pinPct = (rows) => (rows.length ? Math.round(rows.filter((r) => r.pin).length / rows.length * 100) : 0);
  console.log(`pin%   csv ${pinPct(C)}   live ${pinPct(S)}`);

  if (diffs.length || missing.length || extra.length) anyBad = true;
  console.log("");
}

console.log(anyBad ? "❌ differences found — see above" : "✅ live matches the CSV exactly on every date");
