// Stage 6 — headless engine run that keeps `params/toTargets` fresh without a
// human clicking "Apply & Re-run Model".
//
// WHY IT RUNS HERE AND NOT IN A SUPABASE EDGE FUNCTION: it imports `src/engine/`
// DIRECTLY, so there is exactly one engine implementation. A Deno port would be a
// second copy of ~2,900 lines, and the drift would surface as wrong transfer
// quantities found by ops. Verified headless-safe: the engine has no
// window/document/localStorage usage (the 20 hits for "window" are all the word
// "window" in prose).
//
// WHY A CLOCK AND NOT AN EVENT CHAIN: an earlier design chained this off each
// sync's success so `toTargets` could never be stale relative to its inputs. Once
// we decided to ALWAYS run and stamp freshness instead (because every input sync
// already fails closed atomically — there is no half-updated input), completion
// detection stopped being necessary. Running after the last input slot is enough,
// and it needs no edits to the five deployed Supabase functions.
//
//   catalogue ends 18:25 UTC · invoices 22:20 UTC · floors 23:55 UTC
//   -> this runs at 00:15 UTC = 05:45 IST, before ops POs at ~06:00 IST.
//
// Scheduled by pg_cron via pg_net, alongside the other jobs, so the whole schedule
// is visible in one place (`select jobname, schedule from cron.job`) and rollback
// is `select cron.unschedule('engine-run-nightly')`.
//
// ⚠ WRITES ONLY THE `params` TABLE — `toTargets_shadow` / `toTargets`, plus its own
// status row. It never touches `team_data`, exactly like `applyAndRun`. So it
// cannot disturb stockData, poData, toData or the catalogue.
//
// ⚠ MODE DEFAULTS TO "dry". A live write needs an explicit `{"mode":"live"}`, and
// the rollout order is dry -> shadow -> live. Same defaulting choice as
// sync-sku-floors, for the same reason: this replaces a row wholesale.
//
// Body: { mode?: "dry" | "shadow" | "live" }
// Header: x-engine-secret must match ENGINE_RUN_SECRET.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, ENGINE_RUN_SECRET.

import { runEngine } from "../src/engine/index.js";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";
import { mergeCoreOverrides, buildToTargets, assessTargetsChange, buildInputsStamp } from "../src/toTargets.js";
import { computeInvValue } from "../src/invValue.js";

const LIVE_ROW = "toTargets";
const SHADOW_ROW = "toTargets_shadow";
const STATUS_ROW = "engineRunStatus";

const env = (k) => process.env[k] || process.env[`VITE_${k}`] || "";

export default async function handler(req, res) {
  const started = Date.now();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  // ⚠ A Vercel route is a PUBLIC URL, unlike a Supabase edge function which
  // verifies the anon JWT for us. Without this, anyone could trigger a toTargets
  // write. Constant-time comparison is overkill for a cron secret, but the check
  // itself is not optional.
  const secret = env("ENGINE_RUN_SECRET");
  if (!secret || req.headers["x-engine-secret"] !== secret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_ANON_KEY");
  if (!url || !key) return res.status(500).json({ ok: false, error: "SUPABASE_URL / SUPABASE_ANON_KEY not configured" });

  const B = `${url.replace(/\/$/, "")}/rest/v1`;
  const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  const load = async (table, id) => {
    const r = await fetch(`${B}/${table}?select=payload&id=eq.${id}`, { headers: H });
    if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
    return (await r.json())[0]?.payload ?? null;
  };
  const save = async (table, id, payload) => {
    const r = await fetch(`${B}/${table}`, {
      method: "POST",
      headers: { ...H, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id, payload }),
    });
    if (!r.ok) throw new Error(`write ${table}/${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };

  const mode = ["dry", "shadow", "live"].includes(req.body?.mode) ? req.body.mode : "dry";
  const engineCommit = process.env.VERCEL_GIT_COMMIT_SHA || "local";
  let status = null;

  try {
    // ── Load exactly what the browser loads ──────────────────────────────────
    const tLoad = Date.now();
    const [sbParams, team, invRow, liveTo, sbOverrides, invStat, catStat, floorStat] = await Promise.all([
      load("params", "global"),
      load("team_data", "global"),
      load("team_data", "invoice_data"),
      load("params", LIVE_ROW),
      load("overrides", "global"),
      load("params", "invoiceSyncStatus"),
      load("params", "catalogueSyncStatus"),
      load("params", "skuFloorSyncStatus"),
    ]);

    // SHALLOW merge over DEFAULT_PARAMS, as App.jsx does. Then re-attach the
    // own-row configs through the SHARED helper — hand-rolling this is what
    // silently reverted attribution to "location" on every page load when two of
    // three call sites forgot `pincodeConfig`.
    const params = sbParams ? { ...DEFAULT_PARAMS, ...sbParams } : { ...DEFAULT_PARAMS };
    const cfg = await loadParamConfigRows((id) => load("params", id), DS_LIST);
    Object.assign(params, cfg.extra);

    const invoiceData = invRow?.invoiceData ?? [];
    const skuMaster = team?.skuMaster ?? {};
    if (!invoiceData.length || !Object.keys(skuMaster).length) {
      throw new Error(`refusing to run: invoiceData ${invoiceData.length} rows, skuMaster ${Object.keys(skuMaster).length} SKUs`);
    }
    const loadMs = Date.now() - tLoad;

    // ── Run ──────────────────────────────────────────────────────────────────
    const tEngine = Date.now();
    const raw = runEngine(
      invoiceData, skuMaster,
      team?.minReqQty ?? {}, team?.priceData ?? {},
      new Set(team?.deadStock ?? []), team?.newSKUQty ?? {},
      params,
      // ⚠ 8th arg. Absent = no ceilings = a no-op; a nightly run that silently
      // dropped this would publish UNCAPPED transfer targets while IMS showed
      // capped ones. Same class as the pincodeConfig omission.
      team?.skuCeiling ?? {},
    );
    const built = buildToTargets(mergeCoreOverrides(raw, sbOverrides), DS_LIST);
    const engineMs = Date.now() - tEngine;

    // Network inventory value, for the nightly digest's directional line.
    //
    // ⚠ NON-FATAL BY CONSTRUCTION. This is a reporting nicety riding along on the row
    // that feeds transfer orders; it must never be able to stop the write. Same
    // pattern as create-to's toSnapshots. A null here degrades the email to "no value
    // line", which is the correct failure direction.
    //
    // ⚠ Computed from `raw`, NOT from `built`. Two reasons: `built` is the DS-only,
    // DC-inventorised-Active slice (measured 33.3% below the card), and `raw` is the
    // exact basis App.jsx's `kpis` uses, so the email and the Overview card agree.
    // Overrides are empty today so raw and merged coincide; matching the card is the
    // tie-breaker if they ever diverge.
    let invValue = null;
    try {
      invValue = computeInvValue(raw, team?.priceData ?? {}, DS_LIST);
    } catch (e) {
      console.error("run-engine: invValue failed (non-fatal):", e);
    }

    // Baseline is ALWAYS the live row, even on a shadow run — that is what makes a
    // shadow run informative: it reports what a live write would have done.
    const change = assessTargetsChange({ built, live: liveTo?.targets ?? {} });

    // ── Freshness: DERIVED FROM THE DATA, not from a report that a job ran ────
    // Shared with applyAndRun via src/toTargets.js so both writers leave this row
    // in ONE shape — the browser used to write only {targets, refreshedAt} and so
    // erased these fields on every Apply.
    const inputs = buildInputsStamp({
      invoiceData, skuMaster,
      priceData: team?.priceData, newSKUQty: team?.newSKUQty,
      minReqQty: team?.minReqQty, deadStock: team?.deadStock,
      skuCeiling: team?.skuCeiling,
      coreOverrides: sbOverrides, params,
      lastSyncs: {
        invoices: invStat?.publishedAt ?? invStat?.at ?? null,
        catalogue: catStat?.lastOkNight ?? null,
        floors: floorStat?.lastOkNight ?? null,
      },
    });

    status = {
      ok: change.safe, mode, engineCommit,
      reason: change.safe ? "ok" : change.reason,
      targets: change.builtCount,
      change: {
        reason: change.reason, dropPct: Number(change.dropPct.toFixed(2)),
        liveCount: change.liveCount, builtCount: change.builtCount,
        added: change.added.slice(0, 60), removed: change.removed.slice(0, 60),
        counts: { added: change.added.length, removed: change.removed.length },
      },
      inputs,
      invValue,
      timing: { loadMs, engineMs, totalMs: Date.now() - started },
      wroteTo: null,
    };

    if (!change.safe) {
      if (mode !== "dry") await save("params", STATUS_ROW, { ...status, at: new Date().toISOString() });
      return res.status(200).json(status);
    }

    if (mode !== "dry") {
      const row = mode === "live" ? LIVE_ROW : SHADOW_ROW;
      // `invValue` is a new TOP-LEVEL key alongside targets/inputs/refreshedAt.
      // Safe by inspection: SKUs live nested under `targets`, so it cannot shadow one,
      // and assessTargetsChange counts `liveTo?.targets` — never top-level keys.
      await save("params", row, { targets: built, refreshedAt: new Date().toISOString(), engineCommit, inputs, invValue });
      status.wroteTo = row;
      await save("params", STATUS_ROW, { ...status, at: new Date().toISOString() });
    }

    return res.status(200).json(status);
  } catch (e) {
    // Every non-dry exit path records itself. On 2026-07-29 sync-catalogue died and
    // wrote nothing, making a total failure indistinguishable from "the cron never
    // fired"; best-effort here for the same reason.
    const fail = { ok: false, mode, engineCommit, reason: "exception", error: String(e), timing: { totalMs: Date.now() - started } };
    if (mode !== "dry") {
      try { await save("params", STATUS_ROW, { ...fail, at: new Date().toISOString() }); } catch { /* noop */ }
    }
    return res.status(500).json(fail);
  }
}
