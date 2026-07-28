// sync-invoices — Stage 4 (SHADOW). Pulls invoice line items from Zoho Inventory
// and merges them into `team_data/invoice_data_shadow`.
//
// NOTHING READS THAT ROW. The live `team_data/invoice_data` stays manual-CSV until
// Stage 5, so this cannot affect Min/Max, Stock Health or the TO tool whatever it
// produces. Stage 5 is then a one-line change of target row — by which point the
// merge path will have run nightly for days.
//
// SCHEDULE — 16:00 UTC (21:30 IST), resume passes at :06 and :12.
//   Trading closes 20:00 IST and invoices are complete by ~20:30.
//   The team raises TOs at 14:30 and 20:30 IST — 21:30 is clear of both.
//   Hourly crons occupy :35-:50 UTC, so :00-:34 is free.
//
// ONE DATE PER INVOCATION. A day can be ~1,000 invoices and Zoho's speed varies
// 3.5x (measured 289ms/call during a quiet probe, ~1s/call under load), so a
// two-day window in one pass can exceed the 150s wall clock. Each invocation
// completes exactly one date and leaves the rest in a cursor; the resume crons
// drain it. Never writes a partially-fetched date.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoFetchWithRetry } from "../_shared/zohoClient.ts";
import { mapInvoiceToRows, assessCoverage, istDateRange, type InvoiceRow } from "../_shared/invoiceMap.ts";
import { mergeInvoiceRows } from "../_shared/invoiceMerge.ts";
import { shouldRun } from "../_shared/syncCooldown.ts";

const BASE = "https://www.zohoapis.in/inventory/v1";
const ORG = () => Deno.env.get("ZOHO_ORG_ID")!;
const SHADOW_ROW = "invoice_data_shadow";
const WINDOW_DAYS = 2;         // today + yesterday IST — one day of overlap
const RETENTION_DAYS = 90;     // matches the live store; drops to 45 when ops switch
const CONCURRENCY = 8;         // /invoices sustains 4+ calls/s; unrelated to
                               // inventorysummary's ~8-per-MINUTE ceiling
const UNKNOWN_SKU_LIMIT = 1;   // % — healthy runs measure 0.08-0.1%
const ORG_FIRST_DATE = "2026-07-01"; // org migrated; nothing before this exists
const COOLDOWN_MS = 15 * 60_000;     // mirrors sync-stock. See syncCooldown.ts:
                                     // repeated manual runs starved a stock cron
                                     // of Zoho quota on 2026-07-27.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: CORS });

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

  const expand = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };

  try {
    // ── Pick the date to process: cursor first (a drain must always proceed),
    //    then an explicit body range, else a fresh IST window.
    const cur = await supabase.from("params").select("payload").eq("id", "invoiceSyncCursor").maybeSingle();
    const saved: string[] = cur.data?.payload?.pending || [];
    let pending: string[];
    if (saved.length) pending = saved;
    else if (body.from && body.to) pending = expand(body.from, body.to);
    else {
      const { from, to } = istDateRange(Date.now(), Number(body.days) || WINDOW_DAYS);
      pending = expand(from, to);
    }

    // ── Cooldown. Guards the org against repeated invocations, not against the
    //    nightly cron (~1,000 calls once is fine). Draining a cursor is always
    //    allowed — the resume crons fire 6 and 12 min after the first.
    const status = await supabase.from("params").select("payload").eq("id", "invoiceSyncStatus").maybeSingle();
    const gate = shouldRun({
      lastRunAt: status.data?.payload?.at ?? null,
      now: Date.now(),
      cooldownMs: COOLDOWN_MS,
      hasPending: saved.length > 0,
      force: !!body.force,
    });
    if (!gate.run) {
      console.log(`sync-invoices: skipped (${gate.reason}), ${gate.waitSec}s left`);
      return json({ ok: true, skipped: true, reason: gate.reason, waitSec: gate.waitSec });
    }

    // Nothing before the org migration exists in this Zoho — asking for it yields
    // an empty pull, which the coverage guard would (correctly) call a failure.
    const skipped = pending.filter((d) => d < ORG_FIRST_DATE);
    pending = pending.filter((d) => d >= ORG_FIRST_DATE);
    if (skipped.length) console.log(`sync-invoices: skipping ${skipped.length} pre-migration date(s)`);

    if (!pending.length) {
      if (!dryRun) await supabase.from("params").upsert({ id: "invoiceSyncCursor", payload: { pending: [] } });
      return json({ ok: true, done: true, note: "nothing to do", skipped });
    }

    const date = pending[0];
    const rest = pending.slice(1);
    console.log(`sync-invoices: date ${date} (${rest.length} more queued)${dryRun ? " [dry run]" : ""}`);

    // ── List ids for that one date. page_context has no total_count; paginate.
    const ids: string[] = [];
    for (let page = 1; page <= 25; page++) {
      const d = await get(`${BASE}/invoices?organization_id=${ORG()}&date_start=${date}&date_end=${date}&per_page=200&page=${page}`);
      for (const inv of d.invoices || []) ids.push(inv.invoice_id);
      if (!d.page_context?.has_more_page) break;
    }

    // ── Detail-fetch: the only place line items exist.
    const details = await pool(ids, CONCURRENCY, async (id) => {
      try { return (await get(`${BASE}/invoices/${id}?organization_id=${ORG()}`)).invoice; }
      catch (e) { console.error(`detail ${id}:`, e); return null; }
    });
    const failed = details.filter((d) => !d).length;

    let rows: InvoiceRow[] = [];
    for (const inv of details) if (inv) rows = rows.concat(mapInvoiceToRows(inv));

    // ── Guard 1: do the SKUs still match the master? Catches a catalogue change.
    const td = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
    const known = new Set(Object.keys(td.data?.payload?.skuMaster || {}));
    const coverage = assessCoverage(rows, known, UNKNOWN_SKU_LIMIT);

    // ── Guard 2: would the merge lose history? Pre-2026-07-01 rows exist only here.
    const shadow = await supabase.from("team_data").select("payload").eq("id", SHADOW_ROW).maybeSingle();
    const existing: InvoiceRow[] = shadow.data?.payload?.invoiceData || [];
    const { rows: merged, report } = mergeInvoiceRows(existing, rows, [date], retention);

    const stats = {
      date, queued: rest.length, invoicesListed: ids.length, detailCallsFailed: failed,
      rowsFetched: rows.length, pinPct: rows.length ? Math.round(rows.filter((r) => r.pin).length / rows.length * 100) : 0,
      coverage, merge: report, elapsedSec: Math.round((Date.now() - started) / 1000), dryRun,
    };

    if (!coverage.ok || !report.safe) {
      const reason = !coverage.ok ? "coverage_check_failed" : "merge_unsafe";
      console.error(`sync-invoices: ${reason} — not writing`, JSON.stringify({ coverage, report }));
      if (!dryRun) await supabase.from("params").upsert({ id: "invoiceSyncStatus", payload: { ...stats, ok: false, reason, at: new Date().toISOString() } });
      return json({ ok: false, reason, ...stats });
    }

    if (!dryRun) {
      await supabase.from("team_data").upsert({ id: SHADOW_ROW, payload: { invoiceData: merged, syncedAt: new Date().toISOString(), lastDate: date } });
      await supabase.from("params").upsert({ id: "invoiceSyncCursor", payload: { pending: rest } });
      await supabase.from("params").upsert({ id: "invoiceSyncStatus", payload: { ...stats, ok: true, at: new Date().toISOString() } });
    }

    console.log(`sync-invoices: ${date} ok — ${rows.length} rows, ${coverage.unknownPct}% unknown, ${stats.elapsedSec}s, ${rest.length} queued`);
    return json({ ok: true, done: rest.length === 0, ...stats, sample: rows.slice(0, 3) });
  } catch (e) {
    console.error("sync-invoices failed:", e);
    return json({ ok: false, error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) }, 500);
  }
});
