// sync-catalogue — Stage 7. Pulls SKU Master and Purchase Prices from Zoho and
// merges them into `team_data/global`, replacing two of the manual CSV uploads.
//
// Cheap compared with sync-invoices: both are list/report reads, ~30 calls total,
// seconds to run. No cursor, no per-date chunking, no 150s pressure.
//   items                      -> ~11 calls (2,074 SKUs at 200/page)
//   reports/purchasesbyitem    -> ~10-20 calls (12-month window)
//
// SCHEDULE — FIVE attempts, 21:55 to 23:55 IST, first success wins. Two crons:
// `catalogue-sync-earlier` ('25,55 16,17 * * *', migration 20260730000001) and
// `catalogue-sync-nightly` ('25 18 * * *', migration 20260729000002, untouched).
// All BEFORE `invoices-sync-window` (19:05-22:20 UTC) so the invoice coverage guard
// checks a fresh SKU master: a SKU newly created in Zoho would otherwise have its
// invoice rows counted as unknown, and above 1% that guard refuses to write at all.
// The last slot leaves a 40-minute buffer before the invoice window opens.
//
// ⚠ FIVE SLOTS, ONE PULL. `alreadyRanTonight` gates on `lastOkNight`: the first
// SUCCESS closes the night and later slots return `already_ran_tonight` after one
// Supabase read and zero Zoho calls. A FAILURE leaves the gate open — which is why
// the extra slots exist. They were added because the first real run, 2026-07-29,
// died on an org-wide Zoho 429 window and the catalogue went 24h stale with no
// retry. `sync-invoices` survived the same event only because it had eight slots.
//
// ⚠ No slot crosses midnight IST, which is what keeps the night key simple. Adding
// one later without reading syncNightKey would silently skip a whole night.
//
// ⚠ NOT :50 — `orders-sync-hourly` runs at :50 of EVERY hour and writes this same
// team_data/global row. Free minutes are :00-:34 and :51-:59; the slots use :25/:55.
//
// ⚠ UNLIKE sync-invoices, THIS WRITES PRODUCTION. skuMaster and priceData both feed
// the engine, which IMS recomputes client-side on every page load — so a run here
// moves Min/Max. status decides whether a SKU is stocked at all; price drives
// getPriceTag, which selects the PCT percentile, the Fixed Unit Floor gate and the DOC
// caps. `priceTags` in the report counts how many SKUs actually re-tier.
//
// ⚠ WRITES team_data/global, which also holds stockData / poData / toData and the
// PO/TO caches. Read-merge-write with a FRESH read immediately before writing —
// the same discipline sync-stock and sync-orders use. Never a bare PATCH.
//
// ⚠ INVENTORISED AT NOW EXISTS AND IS POPULATED IN ZOHO (verified 2026-07-29 —
// superseding the earlier note here that it did not). Dry run measured
// `invAtFromZoho` 2,092 / `invAtFromStored` 0 with ZERO per-SKU reclassification:
// Zoho's values match the hand-maintained master exactly. See catalogueMap.ts —
// Zoho wins where it has a value, else the stored value, else DC.
//
// ⚠ So Zoho now owns the highest-consequence field in the master (Supplier =>
// Min=Max=0 everywhere; DS => DC zeroed) and the stored value is no longer a
// safety net. assessMasterChange guards a >5% shift in the mix, which catches a
// mass change but NOT a handful — ~20 SKUs flipped to Supplier is ~1% and passes.
// The real nightly check is `invAtChanged` in params/catalogueSyncStatus, which
// lists every SKU becoming Supplier in full.
//
// Body: { dryRun?, force?, months? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { zohoFetchWithRetry } from "../_shared/zohoClient.ts";
import { mapItemsToMaster, mapPricesReport, assessMasterChange, mergePrices, assessPriceTagChanges } from "../_shared/catalogueMap.ts";
import { shouldRun, alreadyRanTonight } from "../_shared/syncCooldown.ts";

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

  // Set only on a SUCCESSFUL publish, so the retry slots stay open after a failure.
  // Declared out here because the catch block must be able to preserve it.
  let night = "";
  let prevStatus: any = null;

  // Single writer for the status row. Every path goes through this so `at` is
  // always stamped and `lastOkNight` is always carried forward rather than
  // clobbered — an upsert replaces the whole payload, so a bare
  // `{ ok:false, at }` would silently erase the gate's own state.
  const setStatus = async (patch: Record<string, unknown>) => {
    await supabase.from("params").upsert({
      id: "catalogueSyncStatus",
      payload: {
        lastOkNight: prevStatus?.lastOkNight ?? null,
        ...patch,
        at: new Date().toISOString(),
      },
    });
  };

  try {
    const status = await supabase.from("params").select("payload").eq("id", "catalogueSyncStatus").maybeSingle();
    prevStatus = status.data?.payload ?? null;

    // ── Once-per-night gate. The five slots exist to survive a transient Zoho
    // 429 window (2026-07-29); this stops them re-pulling once one has won.
    const tonight = alreadyRanTonight({
      lastOkNight: status.data?.payload?.lastOkNight ?? null,
      now: Date.now(), force: !!body.force,
    });
    night = tonight.night;
    if (tonight.skip) {
      console.log(`sync-catalogue: already ran tonight (${night}), nothing to do`);
      return json({ ok: true, skipped: true, reason: "already_ran_tonight", night });
    }

    // Secondary guard: stops a human hammering the endpoint inside 15 minutes.
    // Distinct from the gate above — that one is per-night, this one is per-burst.
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

    // Price tiers come from the live params, not a hardcoded default: an admin can
    // change them in the Logic Tweaker, and re-tiering must be measured against the
    // boundaries the engine will actually use.
    const pRow = await supabase.from("params").select("payload").eq("id", "global").maybeSingle();
    const priceTiers: number[] = pRow.data?.payload?.priceTiers || [3000, 1500, 400, 100];

    const stats = {
      itemsFetched: items.length,
      priceTiers,
      itemFieldSample,
      master: itemReport,
      statusMix: { before: statusMix(currentMaster), after: statusMix(master) },
      // Price feeds getPriceTag -> PCT percentile / FUF gate / DOC caps, so a refresh
      // moves Min/Max on unchanged demand. This counts the SKUs that actually re-tier.
      priceTags: assessPriceTagChanges(currentPrices, prices, priceTiers),
      // ⚠⚠ THE FULL LIST, NOT A 25-ROW SAMPLE (changed 2026-08-29). On 2026-08-28 a
      // 349-change night stored 25 and the other 324 were UNRECOVERABLE by morning:
      // ops had already reverted the flip in Zoho, so no later pull could name them
      // and the identities existed nowhere else. The guard told us how big the change
      // was and refused to say what it was — the one fact needed to act on it.
      // Cost measured: 47 bytes an entry, +16 KB for that night, ~118 KB if every SKU
      // flipped, on a row written 1-5x a NIGHT. Not worth sampling to save.
      // Same principle as `invAtChanged.toSupplier` below, which was already in full.
      statusChanged: {
        count: statusChanged.length,
        byTransition: statusChanged.reduce((d: Record<string, number>, c) => {
          const k = `${norm(c.from)} -> ${norm(c.to)}`;
          d[k] = (d[k] || 0) + 1;
          return d;
        }, {}),
        // Broken out because it is the consequential direction: anything leaving
        // `active` gets Min=Max=0 everywhere from the engine's active-only pass.
        toInactive: statusChanged.filter((c) => norm(c.from) === "active" && norm(c.to) !== "active")
          .map((c) => c.sku),
        all: statusChanged,
      },
      // inventorisedAt is the highest-consequence field in the master: Supplier zeroes
      // Min/Max at EVERY location, DS zeroes the DC. The distribution alone can hide a
      // swap (58 SKUs leaving Supplier while 58 others join it nets to zero), so report
      // the actual per-SKU transitions.
      invAtChanged: (() => {
        const ch = Object.keys(master)
          .filter((sku) => currentMaster[sku] &&
            norm(currentMaster[sku].inventorisedAt) !== norm(master[sku].inventorisedAt))
          .map((sku) => ({ sku, from: currentMaster[sku].inventorisedAt, to: master[sku].inventorisedAt }));
        return {
          count: ch.length,
          byTransition: ch.reduce((d: Record<string, number>, c) => {
            const k = `${c.from} -> ${c.to}`;
            d[k] = (d[k] || 0) + 1;
            return d;
          }, {}),
          // Anything becoming Supplier stops being stocked anywhere — list those in full.
          toSupplier: ch.filter((c) => norm(c.to) === "supplier").map((c) => c.sku),
          sample: ch.slice(0, 25),
        };
      })(),
      prices: { fromZoho: priceReport, merged: mergeReport, window: { fromDate, toDate }, error: priceError },
      change,
      currentCounts: { master: Object.keys(currentMaster).length, prices: Object.keys(currentPrices).length },
      elapsedSec: Math.round((Date.now() - started) / 1000),
      dryRun,
    };

    if (!change.safe) {
      console.error("sync-catalogue: CHANGE GUARD FAILED — not writing master", JSON.stringify(change));
      // ⚠ PRICES ARE STILL WRITTEN. They do not share the master's failure mode:
      // `mergePrices` merges over the STORED set and only takes average_price > 0, so
      // it can add or update but never lose a SKU — a short or broken pull degrades to
      // "no change", not to data loss. Coupling them cost real work on 2026-08-28,
      // when a master rejection silently discarded 253 price updates and 11 price-tag
      // moves, 10 of them `No Price -> priced`. `No Price` sits at the 95th percentile
      // in PCT, so each of those was over-stocking a SKU for as long as it was held.
      //
      // ⚠ `lastOkNight` is deliberately NOT set here, so the remaining slots retry the
      // master — which means prices may be written up to 5x on a rejection night. The
      // merge is idempotent so that is harmless, and the catalogue slots (:25/:55) do
      // not collide with the stock (:35-:44) or orders (:50) writers of this row.
      let pricesWritten = false;
      if (!dryRun && Object.keys(prices).length) {
        // FRESH read immediately before writing — same rule as the success path.
        const fresh = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
        await supabase.from("team_data").upsert({
          id: "global",
          payload: { ...(fresh.data?.payload || {}), priceData: prices },
        });
        pricesWritten = true;
        console.log(`sync-catalogue: master refused, prices written anyway — ${Object.keys(prices).length} priced`);
      }
      // `at` is written (it feeds the 15-min burst cooldown) but `lastOkNight` is
      // carried over UNCHANGED from the previous success — a guard rejection must
      // leave tonight's retry slots open, and must not erase when we last won.
      if (!dryRun) await setStatus({ ...stats, ok: false, reason: "change_guard_failed", pricesWritten });
      return json({ ok: false, reason: "change_guard_failed", pricesWritten, ...stats });
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
      // The ONLY place `lastOkNight` is set. Closes tonight's gate so the
      // remaining slots no-op instead of re-pulling and re-writing global.
      await setStatus({ ...stats, ok: true, lastOkNight: night });
    }

    console.log(`sync-catalogue: ok — ${Object.keys(master).length} SKUs, ${Object.keys(prices).length} priced, ${stats.elapsedSec}s`);
    return json({ ok: true, night, ...stats });
  } catch (e) {
    console.error("sync-catalogue failed:", e);
    // ⚠ WHY THIS WRITE EXISTS: on 2026-07-29 this function died on an org-wide
    // Zoho 429 and wrote NOTHING. `params/catalogueSyncStatus` simply did not
    // exist, so a total failure was indistinguishable from "the cron never
    // fired" — it was only caught because skuMaster was still 2,092. sync-invoices
    // has always recorded its exceptions; this now matches it.
    //
    // Deliberately does NOT set `lastOkNight`, so the later slots retry.
    // Best-effort: if Supabase is what broke, this write fails too, and throwing
    // here would replace the real error with a useless one.
    if (!dryRun) {
      try {
        await setStatus({
          ok: false, reason: "exception", error: String(e),
          elapsedSec: Math.round((Date.now() - started) / 1000),
        });
      } catch { /* noop */ }
    }
    return json({ ok: false, error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) }, 500);
  }
});
