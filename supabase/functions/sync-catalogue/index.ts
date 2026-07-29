// sync-catalogue — Stage 7. Pulls SKU Master and Purchase Prices from Zoho and
// merges them into `team_data/global`, replacing two of the manual CSV uploads.
//
// Cheap compared with sync-invoices: both are list/report reads, ~30 calls total,
// seconds to run. No cursor, no per-date chunking, no 150s pressure.
//   items                      -> ~11 calls (2,074 SKUs at 200/page)
//   reports/purchasesbyitem    -> ~10-20 calls (12-month window)
//
// SCHEDULE 15:20 UTC (20:50 IST) — deliberately BEFORE sync-invoices at 16:00, so
// the invoice coverage guard checks against a fresh SKU master rather than
// yesterday's. Clear of the :35-:50 stock/orders window.
//
// ⚠ WRITES team_data/global, which also holds stockData / poData / toData and the
// PO/TO caches. Read-merge-write with a FRESH read immediately before writing —
// the same discipline sync-stock and sync-orders use. Never a bare PATCH.
//
// ⚠ INVENTORISED AT does not exist in Zoho yet. See catalogueMap.ts: Zoho wins
// only where it has a value, otherwise the stored value stands. Until the field
// is created and populated, this function preserves the existing classification
// exactly — verified against the live master (2,004 DC / 58 Supplier / 12 DS).
//
// Body: { dryRun?, force?, months? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoFetchWithRetry } from "../_shared/zohoClient.ts";
import { mapItemsToMaster, mapPricesReport, assessMasterChange, mergePrices } from "../_shared/catalogueMap.ts";
import { shouldRun } from "../_shared/syncCooldown.ts";

const BASE = "https://www.zohoapis.in/inventory/v1";
const ORG = () => Deno.env.get("ZOHO_ORG_ID")!;
const COOLDOWN_MS = 15 * 60_000;
const CHANGE_LIMIT_PCT = 5;   // inventorisedAt mix / master size drift
const PRICE_MONTHS = 12;      // window for average_price, matches the old zoho-prices

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { /* cron sends {} */ }
  const dryRun = !!body.dryRun;

  const get = async (url: string) => {
    const res = await zohoFetchWithRetry(supabase, (t) =>
      fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${t}` } }));
    if (!res.ok) throw new Error(`Zoho ${res.status} on ${url.replace(ORG(), "<org>")}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  };

  try {
    const status = await supabase.from("params").select("payload").eq("id", "catalogueSyncStatus").maybeSingle();
    const gate = shouldRun({
      lastRunAt: status.data?.payload?.at ?? null, now: Date.now(),
      cooldownMs: COOLDOWN_MS, hasPending: false, force: !!body.force,
    });
    if (!gate.run) return json({ ok: true, skipped: true, reason: gate.reason, waitSec: gate.waitSec });

    // ── Items ────────────────────────────────────────────────────────────────
    const items: any[] = [];
    let itemFieldSample: string[] = [];
    for (let page = 1; page <= 40; page++) {
      const d = await get(`${BASE}/items?organization_id=${ORG()}&per_page=200&page=${page}`);
      const batch = d.items || [];
      if (page === 1 && batch[0]) itemFieldSample = Object.keys(batch[0]).sort();
      items.push(...batch);
      if (!d.page_context?.has_more_page) break;
    }

    // ── Prices ───────────────────────────────────────────────────────────────
    const ist = new Date(Date.now() + 5.5 * 3600_000);
    const toDate = ist.toISOString().slice(0, 10);
    const from = new Date(ist); from.setUTCMonth(from.getUTCMonth() - PRICE_MONTHS);
    const fromDate = from.toISOString().slice(0, 10);

    const pricePages: any[] = [];
    let priceError: string | null = null;
    try {
      for (let page = 1; page <= 40; page++) {
        const d = await get(`${BASE}/reports/purchasesbyitem?organization_id=${ORG()}&from_date=${fromDate}&to_date=${toDate}&per_page=200&page=${page}`);
        pricePages.push(d);
        if (!d.page_context?.has_more_page) break;
      }
    } catch (e) {
      // The report endpoint is Books-era; it may not exist on /inventory/v1. Fail
      // soft so a missing prices report can't block the SKU master half.
      priceError = String(e);
      console.error("sync-catalogue: prices report failed (continuing):", e);
    }

    // ── Map + guard ──────────────────────────────────────────────────────────
    const gRow = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
    const currentMaster = gRow.data?.payload?.skuMaster || {};
    const currentPrices = gRow.data?.payload?.priceData || {};

    const { master, report: itemReport } = mapItemsToMaster(items, currentMaster);
    const { prices: zohoPrices, report: priceReport } = mapPricesReport(pricePages);
    // MERGE, never replace — purchasesbyitem only sees this org's purchases
    // (since 2026-07-01), so a replace would drop ~345 stored prices. See
    // catalogueMap.ts mergePrices.
    const { prices, report: mergeReport } = mergePrices(currentPrices, zohoPrices);
    const change = assessMasterChange(currentMaster, master, CHANGE_LIMIT_PCT);

    // Status is now the field that decides whether a SKU is stocked at all (Zoho owns
    // it, 2026-07-29), so make every status move visible rather than inferable. This
    // is what tells you whether Zoho calls the 5 parked SKUs active.
    const statusMix = (m: Record<string, any>) =>
      Object.values(m || {}).reduce((d: Record<string, number>, v: any) => {
        const k = (v?.status ?? "").toString().trim() || "(blank)";
        d[k] = (d[k] || 0) + 1;
        return d;
      }, {});
    // Case-insensitive: the CSV path writes "Active" and Zoho writes "active", so a
    // literal comparison reports all ~2,092 SKUs as changed and buries the handful
    // that MEANINGFULLY changed. Downstream filters all lowercase anyway.
    const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
    const statusChanged = Object.keys(master)
      .filter((s) => currentMaster[s] && norm(currentMaster[s].status) !== norm(master[s].status))
      .map((s) => ({ sku: s, from: currentMaster[s].status, to: master[s].status }));

    const stats = {
      itemsFetched: items.length,
      itemFieldSample,
      master: itemReport,
      statusMix: { before: statusMix(currentMaster), after: statusMix(master) },
      statusChanged: { count: statusChanged.length, sample: statusChanged.slice(0, 25) },
      prices: { fromZoho: priceReport, merged: mergeReport, window: { fromDate, toDate }, error: priceError },
      change,
      currentCounts: { master: Object.keys(currentMaster).length, prices: Object.keys(currentPrices).length },
      elapsedSec: Math.round((Date.now() - started) / 1000),
      dryRun,
    };

    if (!change.safe) {
      console.error("sync-catalogue: CHANGE GUARD FAILED — not writing", JSON.stringify(change));
      if (!dryRun) await supabase.from("params").upsert({ id: "catalogueSyncStatus", payload: { ...stats, ok: false, at: new Date().toISOString() } });
      return json({ ok: false, reason: "change_guard_failed", ...stats });
    }

    if (!dryRun) {
      // FRESH read immediately before writing — the hourly stock/orders syncs also
      // write this row, and a stale spread would silently drop their branch data.
      const fresh = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
      const payload = { ...(fresh.data?.payload || {}), skuMaster: master };
      // `prices` is already a merge over the stored set, so it can only grow or
      // update — never lose a SKU. Safe to assign unconditionally.
      if (Object.keys(prices).length) payload.priceData = prices;
      await supabase.from("team_data").upsert({ id: "global", payload });
      await supabase.from("params").upsert({ id: "catalogueSyncStatus", payload: { ...stats, ok: true, at: new Date().toISOString() } });
    }

    console.log(`sync-catalogue: ok — ${Object.keys(master).length} SKUs, ${Object.keys(prices).length} priced, ${stats.elapsedSec}s`);
    return json({ ok: true, ...stats });
  } catch (e) {
    console.error("sync-catalogue failed:", e);
    return json({ ok: false, error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) }, 500);
  }
});
