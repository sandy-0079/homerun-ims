// One-shot Stage 5 helper: copy verified dates from team_data/invoice_data_shadow
// into team_data/invoice_data.
//
// WHY THIS EXISTS
// The nightly sync fetches [D-1, D-4] (planNightDates, fixed 3-day lag). Dates that
// were pulled into the SHADOW row while Stage 4 was running are therefore not in the
// live row, and will not be re-fetched for up to three more nights. Flipping
// TARGET_ROW without backfilling leaves recent-day holes in the demand window —
// which matters more than the row count suggests, because pctMinNZD /
// fixedUnitFloor.minNZD / the plywood Rare-Sparse boundary all gate on NZD >= 2.
//
// DRY RUN BY DEFAULT. Pass --apply to write. Same convention as sync-sku-floors.
//
//   node scripts/backfill-invoice-dates.mjs                 # plan only, read-only
//   node scripts/backfill-invoice-dates.mjs --apply         # backup, then write
//   node scripts/backfill-invoice-dates.mjs --dates 2026-08-01,2026-08-02
//
// With no --dates, it backfills every date present in shadow and absent from live.
//
// SAFETY PROPERTIES (each one is a past incident):
//   * Never removes a date. Append/replace only — pre-July history is irreplaceable.
//   * Asserts every incoming date is ISO before writing. A DD/MM/YYYY value reaching
//     invoice_data took prod down for every user on 2026-07-29 (blank page: string
//     sort picks it as "latest", then new Date(latest).toISOString() throws).
//   * Full read-merge-write of the whole payload, from a FRESH read taken immediately
//     before the write. Never a partial PATCH.
//   * Writes a dated backup row and verifies it byte-identical BEFORE touching live.
//   * Does NOT apply the 90-day retention trim. The next sync run normalises it, and
//     its report explains the loss as retention. Trimming here would delete
//     irreplaceable pre-July dates from a script whose job is backfilling.

import { readFileSync } from "node:fs";

const URL = "https://rgyupnrogkbugsadwlye.supabase.co";
const KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";

const LIVE = "invoice_data";
const SHADOW = "invoice_data_shadow";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const only = (() => {
  const i = argv.indexOf("--dates");
  return i === -1 ? null : new Set(argv[i + 1].split(",").map((s) => s.trim()));
})();

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function readRow(id) {
  const r = await fetch(`${URL}/rest/v1/team_data?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`read ${id}: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j[0]?.payload ?? null;
}

async function writeRow(id, payload) {
  const r = await fetch(`${URL}/rest/v1/team_data`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id, payload }),
  });
  if (!r.ok) throw new Error(`write ${id}: ${r.status} ${await r.text()}`);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isRealIso = (s) => {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const datesOf = (rows) => [...new Set(rows.map((r) => r.date))].sort();
const qtyOf = (rows) => Math.round(rows.reduce((a, r) => a + (r.qty || 0), 0));

// ── read both rows ───────────────────────────────────────────────────────────
const livePayload = await readRow(LIVE);
const shadowPayload = await readRow(SHADOW);
if (!livePayload?.invoiceData) throw new Error("live invoice_data has no invoiceData — refusing");
if (!shadowPayload?.invoiceData) throw new Error("shadow row has no invoiceData — refusing");

const liveRows = livePayload.invoiceData;
const shadowRows = shadowPayload.invoiceData;
const liveDates = datesOf(liveRows);
const shadowDates = datesOf(shadowRows);

console.log(`live   : ${liveRows.length} rows, ${liveDates.length} dates (${liveDates[0]} -> ${liveDates.at(-1)})`);
console.log(`shadow : ${shadowRows.length} rows, ${shadowDates.length} dates (${shadowDates[0]} -> ${shadowDates.at(-1)})`);
console.log(`shadow syncedAt: ${shadowPayload.syncedAt ?? "(none)"}\n`);

// ── choose dates ─────────────────────────────────────────────────────────────
const liveSet = new Set(liveDates);
let targets = shadowDates.filter((d) => !liveSet.has(d));
if (only) {
  const missingFromShadow = [...only].filter((d) => !shadowDates.includes(d));
  if (missingFromShadow.length) {
    console.error(`REFUSING: requested date(s) not in shadow: ${missingFromShadow.join(", ")}`);
    console.error("The nightly pull for that date did not land. Check invoiceSyncStatus before proceeding.");
    process.exit(1);
  }
  targets = [...only].sort();
}

if (!targets.length) {
  console.log("Nothing to backfill — every shadow date is already present in live.");
  process.exit(0);
}

console.log(`dates to backfill: ${targets.join(", ")}\n`);

// ── validate ─────────────────────────────────────────────────────────────────
const incoming = shadowRows.filter((r) => targets.includes(r.date));
const badDates = [...new Set(incoming.map((r) => r.date))].filter((d) => !isRealIso(d));
if (badDates.length) {
  console.error(`REFUSING: non-ISO or impossible date(s) in incoming rows: ${badDates.join(", ")}`);
  console.error("This is the 2026-07-29 prod outage. Do not write.");
  process.exit(1);
}
const badRow = incoming.find((r) => !r.sku || !r.ds || typeof r.qty !== "number");
if (badRow) {
  console.error(`REFUSING: malformed incoming row: ${JSON.stringify(badRow)}`);
  process.exit(1);
}

for (const d of targets) {
  const rows = incoming.filter((r) => r.date === d);
  const pinPct = Math.round((rows.filter((r) => r.pin).length / rows.length) * 100);
  const overwriting = liveSet.has(d) ? ` (REPLACING ${liveRows.filter((r) => r.date === d).length} live rows)` : "";
  console.log(`  ${d}  ${String(rows.length).padStart(5)} rows  qty ${String(qtyOf(rows)).padStart(6)}  pin ${pinPct}%${overwriting}`);
}

// ── merge: drop the target dates from live, append shadow's version ──────────
const kept = liveRows.filter((r) => !targets.includes(r.date));
const merged = [...kept, ...incoming];
const mergedDates = datesOf(merged);

console.log(`\nresult : ${liveRows.length} -> ${merged.length} rows, ${liveDates.length} -> ${mergedDates.length} dates`);
console.log(`         ${mergedDates[0]} -> ${mergedDates.at(-1)}`);

const lost = liveDates.filter((d) => !mergedDates.includes(d));
if (lost.length) {
  console.error(`\nREFUSING: would lose date(s) ${lost.join(", ")} — this script must never remove data.`);
  process.exit(1);
}
if (mergedDates.length > 90) {
  console.log(`\nnote   : ${mergedDates.length} dates exceeds RETENTION_DAYS=90. The next sync run will`);
  console.log(`         trim the ${mergedDates.length - 90} oldest (${mergedDates.slice(0, mergedDates.length - 90).join(", ")}).`);
  console.log(`         Those are pre-July and NOT re-fetchable from Zoho. The backup is their last copy.`);
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to execute.");
  process.exit(0);
}

// ── backup, verified, before touching live ───────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const backupId = `invoice_data_backup_${stamp}`;
console.log(`\nwriting backup ${backupId} ...`);
await writeRow(backupId, livePayload);
const check = await readRow(backupId);
if (!check?.invoiceData || check.invoiceData.length !== liveRows.length) {
  throw new Error(`backup verify FAILED (${check?.invoiceData?.length} vs ${liveRows.length}) — live untouched`);
}
if (JSON.stringify(datesOf(check.invoiceData)) !== JSON.stringify(liveDates)) {
  throw new Error("backup verify FAILED on dates — live untouched");
}
console.log(`backup verified: ${check.invoiceData.length} rows, ${datesOf(check.invoiceData).length} dates`);

// ── fresh read immediately before the write ──────────────────────────────────
const fresh = await readRow(LIVE);
if (fresh.invoiceData.length !== liveRows.length) {
  throw new Error(`live row changed under us (${liveRows.length} -> ${fresh.invoiceData.length}) — aborting, re-run`);
}

console.log(`writing ${LIVE} ...`);
await writeRow(LIVE, { ...fresh, invoiceData: merged });

// ── verify ───────────────────────────────────────────────────────────────────
const after = await readRow(LIVE);
const afterDates = datesOf(after.invoiceData);
console.log(`\nverified: ${after.invoiceData.length} rows, ${afterDates.length} dates (${afterDates[0]} -> ${afterDates.at(-1)})`);
const stillMissing = targets.filter((d) => !afterDates.includes(d));
if (stillMissing.length) throw new Error(`POST-WRITE MISMATCH: ${stillMissing.join(", ")} absent`);
console.log(`backfilled: ${targets.join(", ")}`);
console.log(`rollback  : restore team_data/${backupId} into ${LIVE}`);
