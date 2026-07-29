// sync-invoices — nightly invoice pull from Zoho Inventory.
//
// TARGET IS STILL THE SHADOW ROW. `TARGET_ROW` below is `invoice_data_shadow`, which
// nothing reads, so this cannot affect Min/Max, Stock Health or the TO tool whatever
// it produces. Stage 5 is a one-line change of that constant, after a morning
// reconciliation against a manual CSV export (scripts/compare-invoice-shadow.mjs).
//
// SCHEDULE — 19:05-22:20 UTC = 00:35-03:50 IST, eight slots (`5,20 19-22 * * *`).
//   Moved 2026-07-29 from a single 21:30 IST run. Two reasons:
//
//   1. 21:30 IST was chosen on a false premise. The old note here said invoices are
//      "complete by ~20:30" — they are RAISED by then, but not settled. Measured
//      2026-07-29 at ~12:00 IST over 224 in-flight invoices: 50% paid,
//      38% partially_paid, 12% sent. Pulling mid-settlement is pulling a partial day.
//   2. TOs can be raised as late as ~02:00 IST on occasion. A partial invoice row
//      would have IMS recompute Min/Max from half a day (IMS runs the engine
//      client-side on every page load), so the write must be all-or-nothing.
//
//   The window is idle: trading ends 20:00 IST and ops POs start ~06:00 IST. Slots at
//   :05 and :20 leave 15+ minutes clear of stock-sync-1..4 (:35-:44) and
//   orders-sync-hourly (:50).
//
// PACING, NOT BACKOFF. The old design fetched a whole day in one invocation at
// CONCURRENCY 8 to beat the 150s wall clock, and paid for it: on 2026-07-28, 44 calls
// got 429 / 26 again / 15 exhausted and were dropped, and the ~960 worker-seconds of
// backoff sleeping pushed the run to 172s where the gateway killed it with a 504. The
// isolate kept running and still wrote, so the status row said ok:true over a day that
// was 27.7% short. With eight slots and no deadline we go slow instead: a few hundred
// invoices per invocation at CONCURRENCY 4, an hour apart, so Zoho's per-minute budget
// resets fully between chunks and 429s stop being generated rather than retried.
//
// ALL-OR-NOTHING. Chunks accumulate in `team_data/invoice_sync_buffer` (small — only
// the 1-2 in-flight dates). The target row is written exactly ONCE, when every planned
// date is fully pulled and both guards pass. Any failure leaves the target untouched
// holding the previous complete pull. A date with outstanding fetch failures is never
// counted as complete.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoFetchWithRetry } from "../_shared/zohoClient.ts";
import { mapInvoiceToRows, assessCoverage, type InvoiceRow } from "../_shared/invoiceMap.ts";
import { mergeInvoiceRows } from "../_shared/invoiceMerge.ts";
import { planNightDates, sliceToFetch, advance, type DateProgress } from "../_shared/invoiceCursor.ts";
import { shouldRun } from "../_shared/syncCooldown.ts";

const BASE = "https://www.zohoapis.in/inventory/v1";
const ORG = () => Deno.env.get("ZOHO_ORG_ID")!;

const TARGET_ROW = "invoice_data_shadow";  // ⚠ Stage 5 flips this to "invoice_data"
const BUFFER_ROW = "invoice_sync_buffer";  // in-flight rows; not read by anything else

const VOID_RECHECK_DAYS_BACK = 3;  // re-fetch D-3 so a late void gets corrected
const CHUNK_INVOICES = 250;        // detail calls per invocation
const CONCURRENCY = 4;             // was 8 — see PACING above
const MAX_RETRY_ROUNDS = 3;        // bounded so a dead id can't eat all eight slots
const MAX_LOST_PCT = 0.5;          // % of a date's invoices we tolerate losing
const RETENTION_DAYS = 90;
const UNKNOWN_SKU_LIMIT = 1;       // % — healthy runs measure 0.02-0.1%
const ORG_FIRST_DATE = "2026-07-01";
const COOLDOWN_MS = 15 * 60_000;
const REPUBLISH_GUARD_MS = 12 * 3600_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: CORS });

type Cursor = {
  pending: string[];
  current: DateProgress | null;
  done: string[];
  plan: string[];
  degradedDates: string[];  // dates published with a tolerated (reported) row loss
};

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { /* cron sends {} */ }
  const dryRun = !!body.dryRun;
  const retention = Number(body.retentionDays) || RETENTION_DAYS;

  const get = async (url: string) => {
    const res = await zohoFetchWithRetry(supabase, (t) =>
      fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${t}` } }));
    if (!res.ok) throw new Error(`Zoho ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  };

  const readRow = async (table: string, id: string) =>
    (await supabase.from(table).select("payload").eq("id", id).maybeSingle()).data?.payload ?? null;
  const writeRow = async (table: string, id: string, payload: unknown) => {
    if (!dryRun) await supabase.from(table).upsert({ id, payload });
  };
  const setStatus = (extra: Record<string, unknown>) =>
    writeRow("params", "invoiceSyncStatus", { ...extra, at: new Date().toISOString(), dryRun });

  const expand = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };

  try {
    const raw = await readRow("params", "invoiceSyncCursor");
    // Tolerate the pre-2026-07-29 cursor shape, which was just { pending: [...] }.
    let cursor: Cursor = {
      pending: raw?.pending ?? [],
      current: raw?.current ?? null,
      done: raw?.done ?? [],
      plan: raw?.plan ?? [],
      degradedDates: raw?.degradedDates ?? [],
    };
    const draining = !!cursor.current || cursor.pending.length > 0;

    // ── Fresh night: decide the plan.
    if (!draining) {
      let plan: string[] = body.from && body.to
        ? expand(body.from, body.to)
        : planNightDates(Date.now(), VOID_RECHECK_DAYS_BACK);

      // Nothing before the org migration exists in this Zoho; asking yields an empty
      // pull, which assessCoverage correctly calls a failure.
      const skipped = plan.filter((d) => d < ORG_FIRST_DATE);
      plan = plan.filter((d) => d >= ORG_FIRST_DATE);
      if (skipped.length) console.log(`sync-invoices: skipping ${skipped.length} pre-migration date(s)`);
      if (!plan.length) return json({ ok: true, done: true, note: "nothing to do", skipped });

      const status = await readRow("params", "invoiceSyncStatus");

      // Eight slots fire per night; without this the ones after a successful publish
      // would re-pull the same dates from scratch.
      const sameAsPublished = status?.publishedPlan?.length === plan.length &&
        status.publishedPlan.every((d: string, i: number) => d === plan[i]);
      const publishedRecently = status?.publishedAt &&
        Date.now() - Date.parse(status.publishedAt) < REPUBLISH_GUARD_MS;
      if (sameAsPublished && publishedRecently && !body.force && !body.from) {
        console.log("sync-invoices: plan already published tonight, nothing to do");
        return json({ ok: true, skipped: true, reason: "already_published", plan });
      }

      // Guards the org against repeated manual invocations, never against a drain.
      // 2026-07-27: hand-testing pushed ~1,900 calls in 15 min and starved a stock cron.
      const gate = shouldRun({
        lastRunAt: status?.at ?? null,
        now: Date.now(),
        cooldownMs: COOLDOWN_MS,
        hasPending: false,
        force: !!body.force,
      });
      if (!gate.run) {
        console.log(`sync-invoices: skipped (${gate.reason}), ${gate.waitSec}s left`);
        return json({ ok: true, skipped: true, reason: gate.reason, waitSec: gate.waitSec });
      }

      cursor = { pending: plan, current: null, done: [], plan, degradedDates: [] };
      await writeRow("team_data", BUFFER_ROW, { chunks: {}, statusSeen: {}, startedAt: new Date().toISOString() });
      console.log(`sync-invoices: starting night, plan ${plan.join(", ")}`);
    }

    // ── Pick up (or begin) a date.
    if (!cursor.current) {
      const date = cursor.pending[0];
      cursor.pending = cursor.pending.slice(1);
      const ids: string[] = [];
      for (let page = 1; page <= 25; page++) {
        const d = await get(`${BASE}/invoices?organization_id=${ORG()}&date_start=${date}&date_end=${date}&per_page=200&page=${page}`);
        for (const inv of d.invoices || []) ids.push(inv.invoice_id);
        if (!d.page_context?.has_more_page) break;
      }
      cursor.current = { date, ids, total: ids.length, offset: 0, retryIds: [], round: 0 };
      // Persist before fetching so a crash doesn't re-list the whole day.
      await writeRow("params", "invoiceSyncCursor", cursor);
      console.log(`sync-invoices: ${date} listed ${ids.length} invoices`);
    }

    const cur = cursor.current;
    const chunkSize = Number(body.chunkSize) || CHUNK_INVOICES;
    const slice = sliceToFetch(cur, chunkSize);

    // ── Detail-fetch this chunk. Line items exist nowhere else.
    const results = await pool(slice, CONCURRENCY, async (id) => {
      try { return { id, inv: (await get(`${BASE}/invoices/${id}?organization_id=${ORG()}`)).invoice }; }
      catch (e) { console.error(`detail ${id}:`, e); return { id, inv: null }; }
    });
    const failedIds = results.filter((r) => !r.inv).map((r) => r.id);

    let rows: InvoiceRow[] = [];
    const statusSeen: Record<string, number> = {};
    for (const { inv } of results) {
      if (!inv) continue;
      // Diagnostic only. Recorded because the whole 2026-07-28 defect was an
      // unobserved status: partially_paid and sent were being discarded silently.
      const s = String(inv.status ?? "(none)");
      statusSeen[s] = (statusSeen[s] || 0) + 1;
      rows = rows.concat(mapInvoiceToRows(inv));
    }

    // ── Accumulate into the buffer. Never the target row.
    //
    // Keyed by date|round|offset rather than appended, so re-running the same chunk is
    // idempotent. That matters because the buffer is written before the cursor: if the
    // cursor write failed, the next slot would refetch this slice, and an append would
    // silently double-count those rows.
    const buf = (await readRow("team_data", BUFFER_ROW)) ?? { chunks: {}, statusSeen: {} };
    buf.chunks ??= {};
    buf.statusSeen ??= {};
    buf.chunks[`${cur.date}|${cur.round}|${cur.offset}`] = rows;
    for (const [s, n] of Object.entries(statusSeen)) {
      buf.statusSeen[s] = (buf.statusSeen[s] || 0) + (n as number);
    }
    const rowsForDate = (d: string) =>
      Object.entries(buf.chunks).filter(([k]) => k.startsWith(`${d}|`)).flatMap(([, v]) => v as InvoiceRow[]);
    await writeRow("team_data", BUFFER_ROW, buf);

    const step = advance(cur, slice.length, failedIds, MAX_RETRY_ROUNDS);
    const chunkStats = {
      date: cur.date, round: cur.round, offset: cur.offset,
      invoicesForDate: cur.total, fetched: slice.length, failed: failedIds.length,
      rowsThisChunk: rows.length, rowsForDate: rowsForDate(cur.date).length,
      statusSeen, elapsedSec: Math.round((Date.now() - started) / 1000),
    };

    // ── Date still in progress.
    if (step.status === "more") {
      cursor.current = step.progress;
      await writeRow("params", "invoiceSyncCursor", cursor);
      await setStatus({ ok: true, phase: "chunk", ...chunkStats, pending: cursor.pending, done: cursor.done });
      console.log(`sync-invoices: ${cur.date} chunk done — ${chunkStats.rowsForDate} rows so far, ${step.progress.retryIds.length} to retry`);
      return json({ ok: true, done: false, ...chunkStats });
    }

    // ── Retries exhausted. Tolerate a tiny loss, refuse a real one — but never
    //    silently, which is what the old code did.
    // Measured against the DAY's invoice count, never `cur.ids.length` — in a retry
    // round `ids` holds only the failures, so that would read 1-of-3 as 33% lost when
    // it is really 1 of 564 (0.18%) and abandon a good night.
    const lostPct = cur.total ? (step.progress.retryIds.length / cur.total) * 100 : 0;
    if (step.status === "exhausted" && lostPct > MAX_LOST_PCT) {
      await writeRow("params", "invoiceSyncCursor", { pending: [], current: null, done: [], plan: [], degradedDates: [] });
      await setStatus({
        ok: false, reason: "fetch_failures_exceeded", ...chunkStats,
        lostInvoices: step.progress.retryIds.length, lostPct: +lostPct.toFixed(2),
      });
      console.error(`sync-invoices: ${cur.date} lost ${step.progress.retryIds.length} invoices (${lostPct.toFixed(2)}%) — abandoning, target untouched`);
      return json({ ok: false, reason: "fetch_failures_exceeded", lostPct: +lostPct.toFixed(2), ...chunkStats }, 500);
    }

    const degraded = step.status === "exhausted";
    cursor.done = [...cursor.done, cur.date];
    if (degraded) cursor.degradedDates = [...cursor.degradedDates, cur.date];
    cursor.current = null;

    // ── More dates to go.
    if (cursor.pending.length) {
      await writeRow("params", "invoiceSyncCursor", cursor);
      await setStatus({ ok: true, phase: "date_complete", degraded, ...chunkStats, pending: cursor.pending, done: cursor.done });
      console.log(`sync-invoices: ${cur.date} complete${degraded ? " (degraded)" : ""} — ${cursor.pending.length} date(s) left`);
      return json({ ok: true, done: false, dateComplete: cur.date, degraded, ...chunkStats });
    }

    // ── Every planned date is pulled: guard, then publish in ONE write.
    const allRows: InvoiceRow[] = cursor.done.flatMap((d) => rowsForDate(d));

    const global = await readRow("team_data", "global");
    const known = new Set(Object.keys(global?.skuMaster || {}));
    const coverage = assessCoverage(allRows, known, UNKNOWN_SKU_LIMIT);

    const target = await readRow("team_data", TARGET_ROW);
    const existing: InvoiceRow[] = target?.invoiceData || [];
    const { rows: merged, report } = mergeInvoiceRows(existing, allRows, cursor.done, retention);

    const pinPct = allRows.length ? Math.round(allRows.filter((r) => r.pin).length / allRows.length * 100) : 0;
    const stats = {
      plan: cursor.plan, dates: cursor.done, degradedDates: cursor.degradedDates,
      rowsFetched: allRows.length,
      pinPct, coverage, merge: report, statusSeen: buf.statusSeen,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    };

    if (!coverage.ok || !report.safe) {
      const reason = !coverage.ok ? "coverage_check_failed" : "merge_unsafe";
      await writeRow("params", "invoiceSyncCursor", { pending: [], current: null, done: [], plan: [], degradedDates: [] });
      await setStatus({ ok: false, reason, ...stats });
      console.error(`sync-invoices: ${reason} — target untouched`, JSON.stringify({ coverage, report }));
      return json({ ok: false, reason, ...stats }, 500);
    }

    // The single, atomic publish. Before this line the target holds the previous
    // complete pull; after it, the new one. There is no in-between state for a
    // reader — which is what lets a 02:00 IST TO run be safe.
    await writeRow("team_data", TARGET_ROW, {
      invoiceData: merged, syncedAt: new Date().toISOString(), dates: cursor.done,
    });
    await writeRow("team_data", BUFFER_ROW, { chunks: {}, statusSeen: {} });
    await writeRow("params", "invoiceSyncCursor", { pending: [], current: null, done: [], plan: [], degradedDates: [] });
    await setStatus({
      ok: true, phase: "published", ...stats,
      publishedPlan: cursor.plan, publishedAt: new Date().toISOString(),
    });

    console.log(`sync-invoices: PUBLISHED ${cursor.done.join(", ")} to ${TARGET_ROW} — ${merged.length} rows, ${coverage.unknownPct}% unknown, ${stats.elapsedSec}s`);
    return json({ ok: true, done: true, published: true, target: TARGET_ROW, ...stats });
  } catch (e) {
    console.error("sync-invoices failed:", e);
    // Best-effort: if Supabase itself is the thing that broke, this write fails too,
    // and throwing here would replace the real error with a useless one.
    try { await setStatus({ ok: false, reason: "exception", error: String(e) }); } catch { /* noop */ }
    return json({ ok: false, error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) }, 500);
  }
});
