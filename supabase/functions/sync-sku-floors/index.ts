// sync-sku-floors — pulls the ops SKU-floor Google Sheet into
// `team_data/global.newSKUQty`, replacing the manual SKU-Floors CSV upload.
//
// DEPLOYED DORMANT: no cron exists yet. The house pattern (Stage 4 shipped
// shadow-only, Stage 7 shipped dormant) applied again.
//
// Cheap: ONE HTTP GET to Google and two Supabase reads. No Zoho, no token, no
// rate limit, no cursor, ~1s. It shares nothing with the five Zoho functions, so
// it cannot contribute to a 429 window or starve a stock cron.
//
// ⚠⚠ `dryRun` DEFAULTS TO **TRUE** HERE — a DELIBERATE DEVIATION from
// sync-catalogue/sync-invoices, which default to false. A real write needs an
// explicit `{"dryRun": false}`, so an accidental or exploratory invocation of a
// replace-entirely writer cannot change every floor in the network. When the cron
// is finally created its pg_net body MUST carry `{"dryRun": false}` or it will
// no-op forever while reporting ok. Revisit this default only if that trade stops
// being worth it.
//
// ⚠ WRITES team_data/global, which also holds skuMaster / stockData / poData /
// toData and the PO/TO caches. Read-merge-write from a FRESH read immediately
// before writing, assigning ONLY `newSKUQty` — never a bare PATCH, never a stale
// spread. Same discipline as sync-stock, sync-orders and sync-catalogue.
//
// ⚠ SUGGESTED SLOT WHEN THE CRON IS CREATED: `5 23 * * *` UTC = 04:35 IST.
// After the invoice window's last slot (22:20 UTC) and after sync-catalogue
// (<=18:25 UTC) so a SKU created in Zoho overnight already exists in `skuMaster`
// and its floor is not skipped for no reason. NOT :35/:38/:41/:44 (stock) and NOT
// :50 (orders-sync writes this same row). Free minutes: :00-:34 and :51-:59.
//
// ⚠ TWO WRITERS ON `newSKUQty`, BY DESIGN. The browser also writes it — the
// Upload Data floor CSV is the deliberate fallback for when the sheet is
// unreachable or unpublished. That is SAFE only because of `96a1bf4`:
// `saveTeamData` now writes only keys the caller passed, so a tab touches
// `newSKUQty` only when a human actually uploads floors, never as a side effect.
// (Before that fix, every unrelated save rewrote it from React state.) The sheet
// stays authoritative, so a manual upload is a temporary override that this sync
// re-asserts over on its next run — reported as `overrodeManualUpload` rather
// than silently reverted.
//
// Body: { dryRun?, force? }
//   dryRun  default TRUE  — assess and report, write nothing at all
//   force   bypasses the once-per-night gate, the burst cooldown AND the change
//           guard's threshold. It does NOT bypass parse validation: a malformed
//           sheet must never reach the row. force overrides POLICY, never
//           CORRECTNESS.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseFloorSheet, assessFloorChange } from "../_shared/skuFloorSheet.ts";
import { shouldRun, alreadyRanTonight } from "../_shared/syncCooldown.ts";

// Published-to-web CSV export. ⚠ This is the `pub?...&output=csv` path, NOT the
// `pubhtml` URL the sheet's share dialog offers — pubhtml returns a web page and
// would fail the header check on every run. Overridable by env so a re-publish
// (which mints a new URL) needs no redeploy.
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTT2_CBSySgwSk_DVQEziLMzrTxWxmuVDZ1npn6qb5jIeN2zBbNAQWPRZf-r3A7tb_mreZtAgNSJYFh/pub?gid=0&single=true&output=csv";
const SHEET_URL = () => Deno.env.get("SKU_FLOOR_SHEET_URL") ?? DEFAULT_SHEET_URL;

// ⚠ DUPLICATED FROM `src/engine/constants.js` and it must stay in step. The
// duplication is safe ONLY because an unrecognised DS column is a hard stop:
// when ops appends DS07, this sync fails loudly with `unknown_ds` until BOTH this
// list and the engine's gain DS07. Never "fix" that by skipping the column —
// writing floors for a store the engine ignores looks like a successful sync that
// silently did nothing. (Same known drift as the stale local copies in
// simWorker.js / BasketAnalysisTab.jsx.)
const DS_LIST = ["DS01", "DS02", "DS03", "DS04", "DS05", "DS06"];

const COOLDOWN_MS = 15 * 60_000;
const STATUS_ROW = "skuFloorSyncStatus";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: CORS });

const cap = <T,>(a: T[], n = 60) => (a.length <= n ? a : a.slice(0, n));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const started = Date.now();
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { /* cron may send {} */ }
  // ⚠ Note the `!== false`: absent, null or true all mean DRY. Only an explicit
  // `false` writes. `!!body.dryRun` (the sync-catalogue idiom) would invert this.
  const dryRun = body.dryRun !== false;
  const force = !!body.force;

  let night = "";
  let prevStatus: any = null;

  // Single writer for the status row, so `at` is always stamped and
  // `lastOkNight` is carried forward rather than clobbered — an upsert replaces
  // the whole payload, so a bare `{ok:false, at}` would erase the gate's state.
  // Every non-dry exit path goes through this: on 2026-07-29 sync-catalogue died
  // and wrote nothing, making total failure indistinguishable from "the cron
  // never fired".
  const setStatus = async (patch: Record<string, unknown>) => {
    await supabase.from("params").upsert({
      id: STATUS_ROW,
      payload: {
        lastOkNight: prevStatus?.lastOkNight ?? null,
        ...patch,
        at: new Date().toISOString(),
      },
    });
  };

  try {
    const status = await supabase.from("params").select("payload").eq("id", STATUS_ROW).maybeSingle();
    prevStatus = status.data?.payload ?? null;

    // ── Once-per-night gate. A SUCCESS closes the night; a FAILURE leaves it
    //    open so a later slot retries. Skips cost one Supabase read.
    const tonight = alreadyRanTonight({ lastOkNight: prevStatus?.lastOkNight ?? null, now: Date.now(), force });
    night = tonight.night;
    if (tonight.skip) {
      console.log(`sync-sku-floors: already ran tonight (${night}), nothing to do`);
      return json({ ok: true, skipped: true, reason: "already_ran_tonight", night });
    }

    // Secondary guard against a human hammering the endpoint. Distinct from the
    // per-night gate above.
    const gate = shouldRun({ lastRunAt: prevStatus?.at ?? null, now: Date.now(), cooldownMs: COOLDOWN_MS, hasPending: false, force });
    if (!gate.run) return json({ ok: true, skipped: true, reason: gate.reason, waitSec: gate.waitSec });

    // ── 1. Fetch the sheet ───────────────────────────────────────────────────
    const res = await fetch(SHEET_URL(), { redirect: "follow" });
    const csv = await res.text();
    if (!res.ok) {
      const stats = { reason: "sheet_fetch_failed", httpStatus: res.status, bytes: csv.length };
      if (!dryRun) await setStatus({ ...stats, ok: false });
      return json({ ok: false, ...stats }, 200);
    }

    // ── 2. Parse. Fails closed on anything not fully understood, leaving the
    //       previous complete set of floors in place.
    const p = parseFloorSheet(csv, DS_LIST);
    if (!p.ok) {
      const stats = {
        reason: p.reason, bytes: csv.length, skuCount: p.skuCount,
        unknownDs: p.unknownDs, duplicateSkus: cap(p.duplicateSkus), invalid: cap(p.invalid),
      };
      console.error(`sync-sku-floors: parse refused — ${p.reason}`);
      if (!dryRun) await setStatus({ ...stats, ok: false });
      return json({ ok: false, ...stats }, 200);
    }

    // ── 3. Live state ────────────────────────────────────────────────────────
    const gRow = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
    const live = gRow.data?.payload?.newSKUQty ?? {};
    const skuMaster = gRow.data?.payload?.skuMaster ?? {};

    // ── 4. Change guard, on BOTH dimensions. See skuFloorSheet.ts: a mass
    //       zeroing leaves the SKU key count flat, so key count alone is blind.
    const change = assessFloorChange({ parsed: p.floors, live, maxDropPct: force ? 100 : undefined });

    // Floors that can never take effect. Nothing to do with syncing, and the most
    // useful thing this function reports: ops maintains the sheet believing every
    // row is live. A floor on a SKU absent from skuMaster, or on one that is not
    // Active, is zeroed by the engine's active-only pass.
    const absentFromMaster: string[] = [];
    const notActive: string[] = [];
    for (const [sku, f] of Object.entries(p.floors)) {
      if (Object.keys(f).length === 0) continue;
      const meta = (skuMaster as any)[sku];
      if (!meta) { absentFromMaster.push(sku); continue; }
      if (String(meta.status ?? "Active").toLowerCase() !== "active") notActive.push(sku);
    }

    // Did a human override us since our last run? The sheet is authoritative so
    // we re-assert, but silently reverting someone's deliberate upload is how you
    // lose their trust in the tool. Report it.
    const prov = await supabase.from("params").select("payload").eq("id", "uploadProvenance").maybeSingle();
    const manualAt = prov.data?.payload?.newSKUQty?.at ?? null;
    const overrodeManualUpload =
      manualAt && prevStatus?.at && Date.parse(manualAt) > Date.parse(prevStatus.at)
        ? { manualAt, sinceLastSync: prevStatus.at }
        : null;

    const stats = {
      dryRun, force, night,
      bytes: csv.length,
      skuCount: p.skuCount,
      withFloors: change.parsedWithFloors,
      blankSkuRows: p.blankSkuRows,
      change: {
        safe: change.safe, reason: change.reason,
        dropPct: Number(change.dropPct.toFixed(2)),
        floorDropPct: Number(change.floorDropPct.toFixed(2)),
        liveCount: change.liveCount, parsedCount: change.parsedCount,
        liveWithFloors: change.liveWithFloors, parsedWithFloors: change.parsedWithFloors,
        added: cap(change.added), removed: cap(change.removed), changed: cap(change.changed),
        counts: { added: change.added.length, removed: change.removed.length, changed: change.changed.length },
      },
      ineffective: {
        total: absentFromMaster.length + notActive.length,
        absentFromMaster: cap(absentFromMaster), notActive: cap(notActive),
      },
      overrodeManualUpload,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    };

    if (!change.safe) {
      console.error(`sync-sku-floors: CHANGE GUARD FAILED (${change.reason}) — not writing`);
      // `at` is stamped (it feeds the burst cooldown) but `lastOkNight` carries
      // over unchanged: a guard rejection must leave tonight's slots open.
      if (!dryRun) await setStatus({ ...stats, ok: false, reason: change.reason });
      return json({ ok: false, reason: change.reason, ...stats }, 200);
    }

    if (!dryRun) {
      // FRESH read immediately before writing — the hourly stock/orders syncs
      // write this same row and a stale spread would drop their branch data.
      const fresh = await supabase.from("team_data").select("payload").eq("id", "global").maybeSingle();
      const payload = { ...(fresh.data?.payload || {}), newSKUQty: p.floors };
      await supabase.from("team_data").upsert({ id: "global", payload });
      // The ONLY place `lastOkNight` is set — closes tonight's gate.
      await setStatus({ ...stats, ok: true, lastOkNight: night });
    }

    console.log(
      `sync-sku-floors: ${dryRun ? "DRY RUN" : "ok"} — ${p.skuCount} SKUs, ` +
      `+${change.added.length}/-${change.removed.length}/~${change.changed.length}, ${stats.elapsedSec}s`,
    );
    return json({ ok: true, ...stats });
  } catch (e) {
    console.error("sync-sku-floors failed:", e);
    // Deliberately does NOT set `lastOkNight`, so a later slot retries.
    // Best-effort: if Supabase is what broke, this write fails too, and throwing
    // here would replace the real error with a useless one.
    if (!dryRun) {
      try {
        await setStatus({ ok: false, reason: "exception", error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) });
      } catch { /* noop */ }
    }
    return json({ ok: false, error: String(e), elapsedSec: Math.round((Date.now() - started) / 1000) }, 500);
  }
});
