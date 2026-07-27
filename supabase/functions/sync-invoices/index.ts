// sync-invoices — Stage 4 (SHADOW). Pulls invoice line items from Zoho Inventory
// and writes them to `team_data/invoice_data_shadow`.
//
// NOTHING READS THAT ROW. The live `team_data/invoice_data` stays manual-CSV until
// Stage 5 cutover, so this function cannot affect Min/Max, Stock Health or the TO
// tool no matter what it produces.
//
// Cron: 15:00 UTC (20:30 IST) — after the 8pm trading close, and clear of the
// :35-:50 stock/orders window. It writes a different team_data row than the stock
// and orders syncs, so there is no statement-timeout contention on the big
// `global` row.
//
// Cost (measured 2026-07-27): list is header-level only, so line items need one
// detail call per invoice. At 4-concurrent and ~289ms/call, a 2-day window
// (~1,100 invoices) takes ~80s — inside the 150s wall clock, no chaining needed.
//
// Body (all optional):
//   { from, to }  explicit YYYY-MM-DD range (defaults to the last WINDOW_DAYS IST days)
//   { dryRun }    do everything except the Supabase write; returns stats + a sample
//   { days }      override the default window size

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoFetchWithRetry } from "../_shared/zohoClient.ts";
import { mapInvoiceToRows, assessCoverage, istDateRange, type InvoiceRow } from "../_shared/invoiceMap.ts";

const BASE = "https://www.zohoapis.in/inventory/v1";
const ORG = () => Deno.env.get("ZOHO_ORG_ID")!;
const WINDOW_DAYS = 2;        // today + yesterday IST: one day of overlap
const CONCURRENCY = 4;        // measured safe; 6+ trips the inventory rate limit
const UNKNOWN_SKU_LIMIT = 1;  // % — healthy runs measure 0.08-0.1%

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: CORS });

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
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: any = {};
  try { body = await req.json(); } catch { /* cron sends {} or nothing */ }

  const { from, to } = body.from && body.to
    ? { from: body.from, to: body.to }
    : istDateRange(Date.now(), Number(body.days) || WINDOW_DAYS);
  const dryRun = !!body.dryRun;

  const get = async (url: string) => {
    const res = await zohoFetchWithRetry(supabase, (token) =>
      fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } }));
    if (!res.ok) throw new Error(`Zoho ${res.status} on ${url.replace(ORG(), "<org>")}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  };

  try {
    console.log(`sync-invoices: window ${from} -> ${to}${dryRun ? " (dry run)" : ""}`);

    // ── 1. List invoice ids in the window. page_context has no total_count, so
    //       paginate until has_more_page is false.
    const ids: string[] = [];
    let quota = "";
    for (let page = 1; page <= 25; page++) {
      const d = await get(`${BASE}/invoices?organization_id=${ORG()}&date_start=${from}&date_end=${to}&per_page=200&page=${page}`);
      for (const inv of d.invoices || []) ids.push(inv.invoice_id);
      if (!d.page_context?.has_more_page) break;
    }
    console.log(`sync-invoices: ${ids.length} invoices listed`);

    // ── 2. Detail-fetch for line items (the only place they exist).
    const details = await pool(ids, CONCURRENCY, async (id) => {
      try { return (await get(`${BASE}/invoices/${id}?organization_id=${ORG()}`)).invoice; }
      catch (e) { console.error(`detail ${id} failed:`, e); return null; }
    });
    const failed = details.filter((d) => !d).length;

    // ── 3. Map to engine rows. Status/charge-line/pin handling lives in the
    //       tested pure module, not here.
    let rows: InvoiceRow[] = [];
    for (const inv of details) if (inv) rows = rows.concat(mapInvoiceToRows(inv));

    // ── 4. Guard: do the SKUs still match the master? This is what catches a
    //       catalogue re-code (2026-07-01 put 39.6% of rows on unknown codes).
    const teamData = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
    const known = new Set(Object.keys(teamData.data?.payload?.skuMaster || {}));
    const coverage = assessCoverage(rows, known, UNKNOWN_SKU_LIMIT);

    const stats = {
      window: { from, to },
      invoicesListed: ids.length,
      detailCallsFailed: failed,
      rows: rows.length,
      distinctSkus: new Set(rows.map((r) => r.sku)).size,
      withPin: rows.filter((r) => r.pin).length,
      pinPct: rows.length ? Math.round((rows.filter((r) => r.pin).length / rows.length) * 100) : 0,
      coverage,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      dryRun,
    };

    if (!coverage.ok) {
      // Refuse to write rather than persist a dataset we already know is wrong.
      // Shadow-only today, but this is the same guard Stage 5 relies on when the
      // live row is at stake, so it must fail closed from the start.
      console.error("sync-invoices: COVERAGE CHECK FAILED — not writing", JSON.stringify(coverage));
      await supabase.from("params").upsert({ id: "invoiceSyncStatus", payload: { ...stats, ok: false, at: new Date().toISOString() } });
      return json({ ok: false, reason: "coverage_check_failed", ...stats }, 200);
    }

    if (!dryRun) {
      await supabase.from("team_data").upsert({ id: "invoice_data_shadow", payload: { invoiceData: rows, syncedAt: new Date().toISOString(), window: { from, to } } });
      await supabase.from("params").upsert({ id: "invoiceSyncStatus", payload: { ...stats, ok: true, at: new Date().toISOString() } });
    }

    console.log(`sync-invoices: ok — ${rows.length} rows, ${coverage.unknownPct}% unknown SKUs, ${stats.elapsedSec}s`);
    return json({ ok: true, ...stats, sample: rows.slice(0, 3) });
  } catch (e) {
    console.error("sync-invoices failed:", e);
    return json({ ok: false, error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) }, 500);
  }
});
