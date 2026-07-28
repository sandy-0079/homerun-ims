// Append-merge for the invoice store.
//
// ⚠ DATA-SAFETY CRITICAL. The current Zoho org (60075214606) holds no invoices
// before 2026-07-01 — the org migrated then, and the previous Books org is
// retired. Everything before that date exists ONLY in the Supabase payload,
// uploaded by hand from CSV. The API cannot reproduce it.
//
// So a sync must never rebuild the whole window: it replaces rows only for the
// dates it actually fetched, leaves every other date alone, and trims only at
// the retention boundary. `report.safe` is false if any date would disappear for
// a reason the trim does not explain — callers must refuse to write on that.
//
// Once the retention window starts on or after 2026-07-01 the API can serve the
// whole thing (45-day retention: ~2026-08-14; 90-day: ~2026-09-28) and this
// becomes belt-and-braces rather than load-bearing.

import type { InvoiceRow } from "./invoiceMap.ts";

export function mergeInvoiceRows(
  existing: InvoiceRow[],
  incoming: InvoiceRow[],
  fetchedDates: string[],
  retentionDays: number,
) {
  const fetched = new Set(fetchedDates);
  const datesBefore = new Set(existing.map((r) => r.date)).size;

  // Drop the fetched dates wholesale, then re-add what came back. A fetched date
  // with no incoming rows is a genuinely empty day (everything voided) and
  // correctly ends up removed.
  const kept = existing.filter((r) => !fetched.has(r.date));
  const merged = kept.concat(incoming);

  // Retention is counted in distinct dates present, matching the engine's
  // `allDates.slice(-op)` — not calendar days, so non-trading days don't
  // silently shorten the effective history.
  const allDates = [...new Set(merged.map((r) => r.date))].sort();
  const keepDates = new Set(allDates.slice(-retentionDays));
  const rows = merged.filter((r) => keepDates.has(r.date));

  const datesAfter = keepDates.size;
  const datesTrimmed = allDates.length - keepDates.size;

  const existingDates = new Set(existing.map((r) => r.date));

  // The invariant: a sync may only ever lose dates to the retention trim.
  //
  // Deliberately NOT "did the arithmetic come out as predicted" — an earlier
  // version computed an expected count from the same inputs that produced the
  // result, which is tautological and can never fail. In particular it would
  // have waved through the dangerous case: a bad window marking all 90 dates as
  // fetched while only 2 days of rows come back, silently destroying 88 days of
  // history the API cannot re-serve.
  //
  // A day that is genuinely 100% voided does trip this. That is intended: it is
  // rare enough to be worth a human look, and far likelier to be a bug.
  const safe = datesAfter >= datesBefore - datesTrimmed;

  return {
    rows,
    report: {
      datesBefore,
      datesAfter,
      datesTrimmed,
      datesReplaced: [...fetched].filter((d) => existingDates.has(d)).length,
      rowsBefore: existing.length,
      rowsAfter: rows.length,
      safe,
    },
  };
}
