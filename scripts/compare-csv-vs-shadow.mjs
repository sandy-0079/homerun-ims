// Stage 4 verification, CSV-on-disk edition.
//
// The committed scripts/compare-invoice-shadow.mjs can only compare dates that
// already exist in team_data/invoice_data. The nightly sync fetches today+yesterday
// IST, which the live row does not have yet — so it silently skips them.
//
// This compares the shadow row against a Zoho CSV export sitting on disk, so no
// prod write is needed to verify a date. Reads Supabase once; no Zoho calls.
//
//   node compare-csv-vs-shadow.mjs <path-to-csv>
//
// The CSV side is parsed by the REAL parseInvoiceCsv from src/engine/utils.js —
// not a reimplementation — so a parser difference cannot masquerade as a sync bug.

import { readFileSync } from "node:fs";
import { parseInvoiceCsv } from "../src/engine/utils.js";

const CSV = process.argv[2];
const URL = "https://rgyupnrogkbugsadwlye.supabase.co";
const KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";

const res = await fetch(`${URL}/rest/v1/team_data?select=payload&id=eq.invoice_data_shadow`, { headers: { apikey: KEY } });
const shadowRows = (await res.json())[0].payload.invoiceData;

const csvRows = parseInvoiceCsv(readFileSync(CSV, "utf8"));

const dates = [...new Set(csvRows.map((r) => r.date))].sort();
const sum = (rows) => rows.reduce((a, r) => a + r.qty, 0);
const skuDsAgg = (rows) =>
  rows.reduce((m, r) => m.set(`${r.sku}|${r.ds}`, (m.get(`${r.sku}|${r.ds}`) || 0) + r.qty), new Map());

console.log(`csv    : ${csvRows.length} sellable rows over ${dates.length} dates (${dates.join(", ")})`);
console.log(`shadow : ${shadowRows.length} rows total\n`);

let anyBad = false;

for (const date of dates) {
  const C = csvRows.filter((r) => r.date === date);
  const S = shadowRows.filter((r) => r.date === date);

  console.log("=".repeat(78));
  console.log(`${date}`);
  console.log("=".repeat(78));
  console.log(`rows   csv ${C.length}   shadow ${S.length}   delta ${S.length - C.length}`);
  console.log(`qty    csv ${Math.round(sum(C))}   shadow ${Math.round(sum(S))}   delta ${Math.round(sum(S) - sum(C))}`);

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

  console.log(`orders csv ${co.size}   shadow ${so.size}`);
  console.log(`  in CSV but MISSING from shadow : ${missing.length}` +
    (missing.length ? `  (${missing.reduce((a, k) => a + co.get(k).rows, 0)} rows, ${Math.round(missing.reduce((a, k) => a + co.get(k).qty, 0))} qty)` : ""));
  for (const k of missing.slice(0, 25)) console.log(`     - ${k}  ${co.get(k).rows} rows, ${Math.round(co.get(k).qty)} qty`);
  if (missing.length > 25) console.log(`     ... and ${missing.length - 25} more`);

  console.log(`  in shadow but not in CSV       : ${extra.length}`);
  for (const k of extra.slice(0, 25)) console.log(`     + ${k}  ${so.get(k).rows} rows, ${Math.round(so.get(k).qty)} qty`);
  if (extra.length > 25) console.log(`     ... and ${extra.length - 25} more`);

  // ── SKU×DS: the granularity the engine actually consumes. Matching totals with
  // mismatched aggregates would still move Min/Max.
  const [ca, sa] = [skuDsAgg(C), skuDsAgg(S)];
  const diffs = [];
  for (const k of new Set([...ca.keys(), ...sa.keys()])) {
    const [c, s] = [ca.get(k) || 0, sa.get(k) || 0];
    if (c !== s) diffs.push({ k, csv: c, shadow: s, d: s - c });
  }
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`sku×ds combos  csv ${ca.size}  shadow ${sa.size}  differing ${diffs.length}`);
  for (const d of diffs.slice(0, 20)) console.log(`     ${d.k.padEnd(16)} csv ${String(Math.round(d.csv)).padStart(6)}  shadow ${String(Math.round(d.shadow)).padStart(6)}  ${d.d > 0 ? "+" : ""}${Math.round(d.d)}`);
  if (diffs.length > 20) console.log(`     ... and ${diffs.length - 20} more`);

  // Pin coverage drives attribution; a drop here silently reverts DSes to the
  // fulfilling-store default without any other symptom.
  const pinPct = (rows) => (rows.length ? Math.round(rows.filter((r) => r.pin).length / rows.length * 100) : 0);
  console.log(`pin%   csv ${pinPct(C)}   shadow ${pinPct(S)}`);

  if (diffs.length || missing.length || extra.length) anyBad = true;
  console.log("");
}

console.log(anyBad ? "❌ differences found — see above" : "✅ shadow matches the CSV exactly on every date");
