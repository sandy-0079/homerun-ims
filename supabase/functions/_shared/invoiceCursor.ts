// Cursor state for the chunked nightly invoice pull.
//
// WHY CHUNKING EXISTS. The 2026-07-28 run fetched a whole day in one invocation at
// CONCURRENCY 8 and hit Zoho's rate limit hard: 44 calls got 429 on the first
// attempt, 26 on the second, and 15 exhausted all three and were dropped. Each 429
// costs a 10s then 20s sleep, so 70 retries burned ~960 worker-seconds — which is
// why the run took 172s against a 150s wall clock and was killed with a 504 (the
// isolate kept going and still wrote, so the status row said ok:true while the day
// was 27.7% short).
//
// The fix is not a cleverer backoff, it is not needing one. The pull moved to the
// idle 00:35-04:00 IST window, where there are eight cron slots and no deadline, so
// we can go slow: a few hundred invoices per invocation at low concurrency, an hour
// apart, which lets Zoho's per-minute budget reset completely between chunks.
//
// This module is the pure state machine for that. No fetch, no Deno, no Supabase —
// so the awkward parts (partial progress, retrying only what failed, refusing to
// call a lossy date "done") are unit-testable. See invoiceCursor.test.ts.

import { istDateRange } from "./invoiceMap.ts";

export type DateProgress = {
  date: string;
  ids: string[];      // invoice ids still to work through this round
  total: number;      // invoices listed for the date; NOT ids.length once retrying
  offset: number;     // how far into `ids` we have got
  retryIds: string[]; // ids that failed this round, queued for the next one
  round: number;      // 0 = first pass, 1+ = retry rounds
};

// The dates a night should pull, most important first.
//
// `voidRecheckDaysBack` re-fetches one older day so a late void gets corrected —
// an invoice counted while `sent` may be voided the next day, leaving us
// over-counted. A FIXED lag is deliberately used rather than a rotation: it gives
// every day exactly one recheck (day D is pulled fresh on D+1, rechecked on D+4),
// which is uniform coverage with no state to track. mergeInvoiceRows replaces a
// fetched date wholesale, so the correction lands automatically.
export function planNightDates(nowMs: number, voidRecheckDaysBack: number): string[] {
  // endOffsetDays=1: at 00:35-03:50 IST the current IST day has barely begun, so the
  // last COMPLETE day is yesterday. See istDateRange.
  const yesterday = istDateRange(nowMs, 1, 1).to;
  if (!voidRecheckDaysBack) return [yesterday];
  return [yesterday, istDateRange(nowMs, 1, 1 + voidRecheckDaysBack).to];
}

// The ids this invocation should detail-fetch.
export function sliceToFetch(p: DateProgress, chunkSize: number): string[] {
  return p.ids.slice(p.offset, p.offset + chunkSize);
}

// Fold the outcome of one chunk back into progress.
//
// The important property: a date is only ever "complete" when every id has been
// fetched AND nothing is outstanding. Anything else keeps the date open so a later
// slot retries it — because the atomic swap publishes only complete dates, and a
// short day published as if whole is exactly the failure we are removing.
export function advance(
  p: DateProgress,
  attempted: number,
  failedIds: string[],
  maxRounds: number,
): { progress: DateProgress; status: "more" | "complete" | "exhausted" } {
  const offset = p.offset + attempted;
  const retryIds = [...p.retryIds, ...failedIds];

  if (offset < p.ids.length) {
    return { progress: { ...p, offset, retryIds }, status: "more" };
  }

  if (retryIds.length === 0) {
    return { progress: { ...p, offset, retryIds }, status: "complete" };
  }

  // Bounded, so a permanently-dead id cannot consume all eight nightly slots.
  if (p.round >= maxRounds) {
    return { progress: { ...p, offset, retryIds }, status: "exhausted" };
  }

  return {
    progress: { ...p, ids: retryIds, offset: 0, retryIds: [], round: p.round + 1 },
    status: "more",
  };
}
