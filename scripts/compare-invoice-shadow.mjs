// Stage 4 exit criteria: does the Zoho-synced shadow row agree with the
// manually-uploaded CSV in team_data/invoice_data?
//
//   node scripts/compare-invoice-shadow.mjs
//
// Reads Supabase only — no Zoho calls, no writes. Compares only the dates the
// shadow actually holds, since it accumulates from empty while the live row
// already has 90 days.
//
// Stage 5 (pointing the sync at the live row) should not happen until this
// reports OK for ~5 consecutive days.

const URL = "https://rgyupnrogkbugsadwlye.supabase.co";
const KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";

// Row-count and quantity drift we accept per date. Invoices legitimately change
// between the CSV export and the sync (edits, late voids), so exact equality is
// the wrong bar — a small, symmetric drift is expected.
const TOLERANCE_PCT = 1;

async function row(table, id) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=payload&id=eq.${id}`, { headers: { apikey: KEY } });
  if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
  const d = await r.json();
  return d[0]?.payload ?? null;
}

const pct = (a, b) => (b === 0 ? (a === 0 ? 0 : 100) : Math.abs(a - b) / b * 100);
const key = (r) => `${r.sku}|${r.ds}`;

const [live, shadow, status] = await Promise.all([
  row("team_data", "invoice_data"),
  row("team_data", "invoice_data_shadow"),
  row("params", "invoiceSyncStatus"),
]);

if (!shadow?.invoiceData?.length) {
  console.log("shadow row is empty — the sync has not produced anything yet");
  process.exit(0);
}

const liveRows = live?.invoiceData || [];
const shadowRows = shadow.invoiceData;
const shadowDates = [...new Set(shadowRows.map((r) => r.date))].sort();

console.log(`last sync : ${status?.at ?? "?"}  ok=${status?.ok}`);
console.log(`shadow    : ${shadowRows.length} rows over ${shadowDates.length} dates (${shadowDates[0]} -> ${shadowDates.at(-1)})`);
console.log(`live      : ${liveRows.length} rows\n`);

console.log("date        live rows  sync rows   drift   live qty   sync qty    drift   sku×ds diff");
console.log("-".repeat(88));

let bad = 0;
for (const date of shadowDates) {
  const L = liveRows.filter((r) => r.date === date);
  const S = shadowRows.filter((r) => r.date === date);
  if (!L.length) { console.log(`${date}  (not in live — nothing to compare against)`); continue; }

  const lq = L.reduce((a, r) => a + r.qty, 0), sq = S.reduce((a, r) => a + r.qty, 0);
  const rowDrift = pct(S.length, L.length), qtyDrift = pct(sq, lq);

  // The check that actually matters: per SKU×DS quantity, since that is the
  // granularity the engine consumes. Matching row counts with mismatched
  // aggregates would still produce different Min/Max.
  const agg = (rows) => rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) || 0) + r.qty), new Map());
  const [la, sa] = [agg(L), agg(S)];
  let diff = 0;
  for (const k of new Set([...la.keys(), ...sa.keys()])) if ((la.get(k) || 0) !== (sa.get(k) || 0)) diff++;

  const ok = rowDrift <= TOLERANCE_PCT && qtyDrift <= TOLERANCE_PCT && diff === 0;
  if (!ok) bad++;
  console.log(
    `${date}  ${String(L.length).padStart(9)}  ${String(S.length).padStart(9)}  ${rowDrift.toFixed(1).padStart(5)}%  ` +
    `${String(Math.round(lq)).padStart(9)}  ${String(Math.round(sq)).padStart(9)}  ${qtyDrift.toFixed(1).padStart(5)}%  ` +
    `${String(diff).padStart(11)}  ${ok ? "OK" : "<-- MISMATCH"}`);
}

console.log("-".repeat(88));
console.log(bad === 0
  ? `\n✅ all ${shadowDates.length} shadow dates agree with the manual CSV`
  : `\n❌ ${bad} of ${shadowDates.length} dates disagree — do NOT proceed to Stage 5`);
process.exit(bad === 0 ? 0 : 1);
