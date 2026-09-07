// Refactored runEngine — strategy dispatcher with lead-time-aware DC logic

import {
  DS_LIST, MOVEMENT_TIERS_DEFAULT,
  DC_DEAD_MULT_DEFAULT,
  RECENCY_WT_DEFAULT,
} from "./constants.js";

import { getPriceTag, getMovTag, getSpikeTag, computeStats } from "./utils.js";
import { applyDSSeed } from "./dsSeed.js";
import { applyAttribution } from "./attribution.js";
import { applyCeilingToStores, capFor, clampToCeiling } from "./skuCeiling.js";
import { applyDeadStockToStores } from "./deadStock.js";
import { dispatchStrategy } from "./strategyDispatch.js";
import { policyOf } from "../skuPolicy.js";
import { computePlywoodNetworkResults } from "./strategies/plywoodNetwork.js";
import { computePlywoodNetworkV2Results } from "./strategies/plywoodV2/index.js";

/* ── DC movement tag (moved verbatim from App.jsx) ──────────────────────── */
export function getDCStats(inv, skuId, activeDSCount, intervals, op) {
  const nzd = Math.min(new Set(inv.filter(r => r.sku === skuId && r.qty > 0).map(r => r.date)).size, op);
  if (!nzd) return { mvTag: "Super Slow", nonZeroDays: 0 };
  const interval = op / nzd,
    dc = [...(intervals || MOVEMENT_TIERS_DEFAULT)].map(x => x / activeDSCount);
  let mvTag = "Super Slow";
  if (interval <= dc[0]) mvTag = "Super Fast";
  else if (interval <= dc[1]) mvTag = "Fast";
  else if (interval <= dc[2]) mvTag = "Moderate";
  else if (interval <= dc[3]) mvTag = "Slow";
  if (mvTag === "Fast") mvTag = "Super Fast";
  return { mvTag, nonZeroDays: nzd };
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Look up assigned strategy for a category; returns strategy key string. */
function resolveStrategy(category, categoryStrategies) {
  if (!categoryStrategies || typeof categoryStrategies !== "object") return "standard";
  return categoryStrategies[category] || "standard";
}

/** Collect individual order-line quantities for a SKU x DS from invoice rows. */
function collectOrderQtys(inv, skuId, dsId) {
  return inv.filter(r => r.sku === skuId && r.ds === dsId && r.qty > 0).map(r => r.qty);
}

/* ── Main engine ─────────────────────────────────────────────────────────── */

/**
 * @param ceilings  SKU x DS ceilings, `{[sku]: {[ds]: cap}}`. Defaults to `{}`,
 *   which is provably a NO-OP — that default is what let the engine ship ahead of
 *   any ceiling data, verified byte-identical against live `toTargets`.
 *   ⚠ A call site that forgets to pass it silently ignores every ceiling. That is
 *   the `loadParamConfigRows` trap, where 2 of 3 rebuild sites missed
 *   `pincodeConfig` and page loads silently reverted attribution for weeks. Every
 *   caller in `src/`, `api/` and `scripts/` was updated together; if you add one,
 *   pass it.
 */
export function runEngine(inv, skuM, mrq, pd, deadStockSet, nsq, p, ceilings = {}) {
  // Resolve which DS each sale is credited to BEFORE anything reads `inv`.
  // Doing it here rather than at CSV-parse time keeps the raw pincode in the
  // stored rows, so switching attribution is a re-run, not a re-upload.
  // Returns `inv` itself unless shippingCode mode is on — the off-path is a no-op.
  inv = applyAttribution(inv, p.pincodeConfig);

  const op = p.overallPeriod || 90,
    rw = Math.min(p.recencyWindow || 15, op - 1),
    recencyWt = p.recencyWt || RECENCY_WT_DEFAULT;
  const intervals = p.movIntervals || MOVEMENT_TIERS_DEFAULT,
    priceTiers = p.priceTiers || [3000, 1500, 400, 100];
  const topN = p.newDSFloorTopN || 150;

  const allDatesRaw = [...new Set(inv.map(r => r.date))].sort(),
    allDates = allDatesRaw.slice(-op);
  const total = allDates.length,
    split = Math.max(0, total - rw),
    dLong = allDates.slice(0, split),
    dRecent = allDates.slice(split);
  const invSliced = inv.filter(r => allDates.includes(r.date));

  const qMap = {}, oMap = {};
  // qAll/oAll — TOTAL demand per SKU across every location, for the DC-only branch.
  //
  // ⚠ NOT the sum of the per-DS series. Attribution only RELABELS rows, so summing
  // per-DS dailyAvg silently misses the DC-fulfilled rows whose pincode is not in the
  // map: those keep ds="DC01", and `tags90` only ever reads DS_LIST, so that demand
  // vanishes from every location's Min/Max. Summing every row sidesteps attribution
  // entirely — which is the CORRECT basis here, because attribution answers "which
  // DS's catchment", a question with no meaning when there is one selling location.
  //
  // Folded into this same pass rather than a second forEach: invSliced is ~95,000
  // rows and this loop is already the hottest thing in the engine.
  const qAll = {}, oAll = {};
  invSliced.forEach(r => {
    const k = `${r.sku}||${r.ds}`;
    if (!qMap[k]) qMap[k] = {};
    if (!oMap[k]) oMap[k] = {};
    qMap[k][r.date] = (qMap[k][r.date] || 0) + r.qty;
    oMap[k][r.date] = (oMap[k][r.date] || 0) + 1;
    if (!qAll[r.sku]) { qAll[r.sku] = {}; oAll[r.sku] = {}; }
    qAll[r.sku][r.date] = (qAll[r.sku][r.date] || 0) + r.qty;
    oAll[r.sku][r.date] = (oAll[r.sku][r.date] || 0) + 1;
  });

  const skuTotals = {};
  invSliced.forEach(r => { skuTotals[r.sku] = (skuTotals[r.sku] || 0) + r.qty; });
  const t150 = {};
  Object.entries(skuTotals).sort((a, b) => b[1] - a[1]).forEach(([s], i) => {
    t150[s] = i < 50 ? "T50" : i < 150 ? "T150" : i < 250 ? "T250" : "No";
  });
  Object.values(skuM).forEach(s => {
    if ((s.status || "").toLowerCase() === "active" && !skuTotals[s.sku]) t150[s.sku] = "Zero Sale";
  });

  const tags90 = {};
  [...new Set(invSliced.map(r => r.sku))].forEach(skuId => {
    DS_LIST.forEach(dsId => {
      const k = `${skuId}||${dsId}`, qm = qMap[k] || {}, om = oMap[k] || {};
      const q90 = allDates.map(d => qm[d] || 0), o90 = allDates.map(d => om[d] || 0);
      const s90 = computeStats(q90, o90, op, p.spikeMultiplier);
      tags90[k] = {
        mvTag: getMovTag(s90.nonZeroDays, op, intervals),
        spTag: getSpikeTag(s90.spikeDays, op, p.spikePctFrequent, p.spikePctOnce),
        dailyAvg: s90.dailyAvg, abq: s90.abq,
      };
    });
  });

  const allSKUs = [...new Set([...invSliced.map(r => r.sku), ...Object.keys(skuM)])],
    activeDSCount = p.activeDSCount || 4,
    res = {};

  // Network Design: only runs when explicitly selected in categoryStrategies.
  // Uses full inv (not invSliced) so lookbackDays is independent of overallPeriod.
  const plyMode = p.categoryStrategies?.["Plywood, MDF & HDHMR"];
  const plywoodNetworkResults =
    plyMode === "network_design" ? computePlywoodNetworkResults(inv, skuM, p)
    : plyMode === "network_design_v2" ? computePlywoodNetworkV2Results(inv, skuM, p)
    : {};

  allSKUs.forEach(skuId => {
    // ── NETWORK DESIGN BYPASS ────────────────────────────────────────────────
    // For covered plywood brand SKUs: use pre-computed results directly.
    // Bypasses strategy dispatch and New DS Floor.
    // SKU Floor Override applied post-network (e.g. for new SKUs with no sales history).
    // Dead Stock cap still applied. All other categories unaffected.
    const networkResult = plywoodNetworkResults[skuId];
    // ⚠ A DC-ONLY SKU MUST NOT TAKE THIS BYPASS. Network Design is entirely about
    // WHICH DS NODES stock a brand — meaningless when no DS stocks it at all, and its
    // DC term is `dcP95 + ceil(sum DS_Min x dcMult)`, which collapses to the P95 alone
    // once every store is zero. Falling through puts the SKU on the main path, where
    // `strategy` is reassigned to `plywoodNonNetworkStrategy` and the DC-only branch
    // runs THAT against total demand. A DC-only SKU absent from skuM is impossible:
    // policyOf(undefined) yields invAt "ds", so `move` is vacuous and forced true.
    const _dcOnlyBypass = (() => { const q = policyOf(skuM[skuId]); return q.invAt === "dc" && !q.move; })();
    if (networkResult && !_dcOnlyBypass) {
      // status "Unknown", not "Active" — see the note on the main path below.
      const _meta = skuM[skuId] || { sku: skuId, name: skuId, category: 'Plywood, MDF & HDHMR', brand: '', status: 'Unknown' };
      const _isDead = deadStockSet.has(skuId);
      const _prTag = getPriceTag(pd[skuId] || 0, priceTiers);
      const _t150Tag = t150[skuId] || 'No';
      const _stores = {};
      DS_LIST.forEach(dsId => {
        const { min, max, nonZeroCount = 0, covers = [], trimTag, originalMin, originalMax } = networkResult.storeResults[dsId] || { min: 0, max: 0, nonZeroCount: 0, covers: [] };
        let storeMin = min, storeMax = max, logicTag = 'Network Design';
        // Only apply SKU floor at stocking nodes (covers.length > 0).
        // Non-stocking DSes are intentionally 0 — floors there would be a data-entry error.
        if (covers.length > 0 && nsq && nsq[skuId] && nsq[skuId][dsId]) {
          const fl = nsq[skuId][dsId];
          const fMin = typeof fl === 'number' ? fl : (fl.min || 0);
          const fMax = typeof fl === 'number' ? fl : (fl.max || fMin);
          if (fMin > storeMin) {
            storeMin = fMin;
            storeMax = Math.max(storeMax, fMax);
            logicTag = 'SKU Floor';
          }
        }
        _stores[dsId] = {
          min: storeMin, max: storeMax,
          preFloorMin: min, preFloorMax: max,
          dailyAvg: 0, abq: 0, nonZeroDays: nonZeroCount,
          mvTag: 'N/A', spTag: 'N/A',
          logicTag, trimTag, originalMin, originalMax, strategyTag: 'network_design',
          strategyDetails: { brand: networkResult.brand },
          postBlendSteps: [],
        };
      });
      // Same clamp, same reason — this bypass builds its own `_stores` and would
      // otherwise ignore every ceiling on a plywood network-design SKU.
      applyCeilingToStores(_stores, ceilings, skuId, DS_LIST);
      // Dead Stock last — it outranks the strategy, the floor and the ceiling. Same
      // reason it lives here and not in the loop above: one rule, one application
      // site, so a branch added later cannot silently escape it. See deadStock.js.
      applyDeadStockToStores(_stores, _isDead, DS_LIST);

      // ── Re-derive the network DC from the (possibly capped) stores ──────────
      // ⚠ The plywood DC is `dcP95 + ceil(sumMin x dcMult)` computed inside
      // computePlywoodNetworkResults from UNCAPPED store mins, and the floored-SKU
      // calc below is a `Math.max` FLOOR on top of it — never a replacement. So
      // without this, a capped plywood SKU kept its full DC (measured 2026-08-15:
      // TJSTU 12/15 -> 2/2 at DS01 while its DC sat unchanged at 30/39).
      //
      // ⚠ `dcP95` is deliberately NOT re-derived: it is the DC's own direct-serve
      // demand, which a DS cap does not change.
      //
      // ⚠ Runs unconditionally, not only when a cap fired. With no ceilings the
      // recomputation reproduces `dcResult` exactly — verified across every plywood
      // network SKU — so making it conditional would only hide a formula drift.
      const _dc = networkResult.dcResult;
      // ⚠ `min(preFloorMin, min)`, NOT `min`. `_stores[ds].min` carries the SKU FLOOR
      // lift, while the network's own `sumMin` is the PRE-floor node basis — summing
      // the former inflated every plywood DC (measured: TJSTU 30 -> 39 with nothing
      // capped). A floor only ever raises, so the lower of the two is the node basis
      // when uncapped and the capped value when a ceiling has bitten. That makes this
      // reduce to `sumMin` exactly when no cap fires, which is the property below.
      const _ceilSumMin = DS_LIST.reduce((a, ds) => {
        const st = _stores[ds];
        if (!st) return a;
        return a + Math.min(st.preFloorMin ?? st.min ?? 0, st.min ?? 0);
      }, 0);
      const _reMin = typeof _dc.dcP95 === "number"
        ? _dc.dcP95 + Math.ceil(_ceilSumMin * networkResult.dcMultMin)
        : _dc.min;
      const _reMax = typeof _dc.dcP95 === "number"
        ? Math.max(_dc.dcP95 + Math.ceil(_ceilSumMin * networkResult.dcMultMax), _reMin)
        : _dc.max;

      let _dcMin = _isDead ? 0 : _reMin;
      let _dcMax = _isDead ? 0 : Math.max(_reMax, _reMin);
      const _isFlooredSKU = !!(nsq && nsq[skuId]);
      let _floorDcDetails = null;
      if (!_isDead && _isFlooredSKU) {
        const _flooredSumMin = DS_LIST.reduce((s, ds) => s + (_stores[ds]?.min ?? 0), 0);
        const _flooredSumMax = DS_LIST.reduce((s, ds) => s + (_stores[ds]?.max ?? 0), 0);
        const multMin = p.skuFloorDCMultMin ?? 0.2;
        const multMax = p.skuFloorDCMultMax ?? 0.3;
        _dcMin = Math.max(_dcMin, Math.round(_flooredSumMin * multMin));
        _dcMax = Math.max(_dcMax, Math.round(_flooredSumMax * multMax), _dcMin);
        _floorDcDetails = { multMin, multMax, sumMin: _flooredSumMin, sumMax: _flooredSumMax };
      }
      res[skuId] = {
        meta: { ..._meta, priceTag: _prTag, t150Tag: _t150Tag },
        stores: _stores,
        dc: {
          min: _dcMin, max: _dcMax,
          preFloorMin: _dc.min, preFloorMax: _dc.max,
          mvTag: 'N/A', nonZeroDays: 0,
          dcDetails: { strategy: 'network_design', brand: networkResult.brand, isDead: _isDead, isFlooredSKU: _isFlooredSKU, dcMultMin: networkResult.dcMultMin, dcMultMax: networkResult.dcMultMax, ..._floorDcDetails },
        },
      };
      return;
    }
    // ── END NETWORK DESIGN BYPASS ────────────────────────────────────────────

    // ⚠ status is "Unknown", NOT "Active". A SKU absent from the master is not
    // evidence of an active SKU — it is usually an orphaned pre-July code (Zoho
    // re-coded the catalogue ~2026-07-01). Claiming Active here is what used to make
    // the engine stock them; the normalization pass at the end zeroes anything not
    // active. The rest of the meta is still fabricated because consumers read
    // `r.meta` unconditionally and would crash on undefined.
    const meta = skuM[skuId] || { sku: skuId, name: skuId, category: "Unknown", brand: "", status: "Unknown", inventorisedAt: "DS" };
    const prTag = getPriceTag(pd[skuId] || 0, priceTiers),
      t150Tag = t150[skuId] || "No",
      isDead = deadStockSet.has(skuId);
    const dsDailyAvgs = [], stores = {};

    let strategy = resolveStrategy(meta.category, p.categoryStrategies);
    // network_design is handled via pre-computed results above; any SKU that reaches here
    // is a non-network brand (e.g. Merino) — use the configured fallback, not Standard.
    if (strategy === "network_design" || strategy === "network_design_v2") strategy = p.plywoodNonNetworkStrategy || "percentile_cover";

    DS_LIST.forEach(dsId => {
      const k = `${skuId}||${dsId}`, qm = qMap[k] || {}, om = oMap[k] || {};
      const qLong = dLong.map(d => qm[d] || 0), oLong = dLong.map(d => om[d] || 0);
      const qRecent = dRecent.map(d => qm[d] || 0), oRecent = dRecent.map(d => om[d] || 0);
      const q90 = allDates.map(d => qm[d] || 0), o90 = allDates.map(d => om[d] || 0);
      const hasData = q90.some(v => v > 0), isNewDS = (p.newDSList || []).includes(dsId);
      const isEligible = (() => { const rank = ["T50", "T150", "T250"].indexOf(t150Tag); if (rank === -1) return false; return [50, 150, 250][rank] <= topN; })();

      // ── NO DATA PATH ──────────────────────────────────────────────────────
      if (!hasData) {
        if (isNewDS) {
          let nm = isEligible ? (mrq[skuId] || 0) : 0, nx = isEligible ? nm : 0;
          let logicTag = "Base Logic";
          if (isEligible && nm > 0) logicTag = "New DS Floor";
          const preFloorMin = nm, preFloorMax = nx;
          if (nsq && nsq[skuId] && nsq[skuId][dsId]) {
            const fl = nsq[skuId][dsId];
            const fMin = typeof fl === "number" ? fl : (fl.min || 0);
            const fMax = typeof fl === "number" ? fl : (fl.max || fMin);
            if (fMin > 0) { nm = Math.max(nm, fMin); nx = Math.max(nx, fMax); logicTag = "SKU Floor"; }
          }
          stores[dsId] = { min: nm, max: nx, preFloorMin, preFloorMax, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag, strategyTag: "standard" };
          dsDailyAvgs.push(0);
        } else if (nsq && nsq[skuId]) {
          const fl = nsq[skuId][dsId];
          const fMin = !fl ? 0 : typeof fl === "number" ? fl : (fl.min || 0);
          const fMax = !fl ? 0 : typeof fl === "number" ? fl : (fl.max || fMin);
          const logicTag = fMin > 0 ? "SKU Floor" : "Base Logic";
          stores[dsId] = { min: fMin, max: Math.max(fMin, fMax), preFloorMin: 0, preFloorMax: 0, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag, strategyTag: "standard" };
          dsDailyAvgs.push(0);
        } else {
          stores[dsId] = { min: 0, max: 0, preFloorMin: 0, preFloorMax: 0, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag: "Base Logic", strategyTag: "standard" };
          dsDailyAvgs.push(0);
        }
        return;
      }

      // ── HAS DATA PATH ─────────────────────────────────────────────────────
      const s90 = computeStats(q90, o90, op, p.spikeMultiplier);
      const mvTag90 = tags90[k].mvTag;

      // Strategy dispatch — EXTRACTED to strategyDispatch.js so the DC-only branch
      // can run the SAME dispatch against total SKU demand rather than one store's.
      // ⚠ getOrderQtys stays LAZY: collecting order quantities is a full linear scan
      // of invSliced, and eager evaluation would run it ~15,000 times instead of a
      // few hundred.
      const dispatched = dispatchStrategy({
        strategy, s90, q90, qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p,
        getOrderQtys: () => collectOrderQtys(invSliced, skuId, dsId),
      });
      let minQty = dispatched.minQty, maxQty = dispatched.maxQty;
      const { strategyTag, strategyDetails } = dispatched;

      // ── Post-blend adjustments (strict order preserved) ────────────────
      const strategyMin = minQty, strategyMax = maxQty;
      const postBlendSteps = [];
      let logicTag = "Base Logic";

      // 1. New DS floor — per-field max: floor lifts Min when it exceeds the
      // blend; Max keeps the strategy's demand-informed headroom when higher.
      if (isNewDS && isEligible) {
        const floor = mrq[skuId] || 0;
        if (floor > minQty) {
          postBlendSteps.push({ rule: "New DS Floor", floor, beforeMin: minQty, beforeMax: maxQty });
          minQty = floor; maxQty = Math.max(maxQty, floor); logicTag = "New DS Floor";
        }
        else maxQty = Math.max(maxQty, minQty);
      }


      minQty = Math.ceil(minQty); maxQty = Math.ceil(Math.max(maxQty, minQty));

      // Capture pre-floor values for Overrides tab delta calculation
      const preFloorMin = Math.round(minQty), preFloorMax = Math.round(maxQty);

      // 3. SKU Floors — runs last, wins if floor Min OR floor Max exceeds engine values
      // Case-insensitive lookup — guards against casing differences between SKU Master and floor CSV
      const nsqKey = nsq && (nsq[skuId] ? skuId : Object.keys(nsq).find(k => k.toLowerCase() === skuId.toLowerCase()));
      if (nsqKey) {
        const fl = nsq[nsqKey][dsId];
        const fMin = !fl ? 0 : typeof fl === "number" ? fl : (fl.min || 0);
        const fMax = !fl ? 0 : typeof fl === "number" ? fl : (fl.max || fMin);
        if (fMin > minQty || fMax > maxQty) {
          postBlendSteps.push({ rule: "SKU Floor", floorMin: fMin, floorMax: fMax, beforeMin: minQty, beforeMax: maxQty });
          if (fMin > minQty) minQty = fMin;
          if (fMax > maxQty) maxQty = fMax;
          maxQty = Math.max(maxQty, minQty);
          logicTag = "SKU Floor";
        }
      }

      stores[dsId] = {
        min: Math.round(minQty), max: Math.round(maxQty),
        preFloorMin, preFloorMax,
        dailyAvg: s90.dailyAvg, abq: s90.abq,
        nonZeroDays: s90.nonZeroDays,
        mvTag: mvTag90, spTag: tags90[k].spTag,
        logicTag, strategyTag,
        strategyDetails, postBlendSteps,
      };
      dsDailyAvgs.push(s90.dailyAvg);
    });

    // ── SKU Ceiling ─────────────────────────────────────────────────────────
    // ⚠ HERE, not inside the loop above. `stores[dsId]` is written from FOUR places
    // — this loop's HAS-DATA branch, its three NO-DATA branches (which `return`
    // early), and the Network Design bypass — and the first implementation clamped
    // only the first, so a cap did nothing at any store with no sales in the window.
    // Applying it to the finished map is the only shape that cannot miss a branch.
    //
    // ⚠ BEFORE the sums below, which feed the floored DC branch
    // (`round(sumMin x 0.2)`). That ordering is what lets a DS cap reach the DC.
    applyCeilingToStores(stores, ceilings, skuId, DS_LIST);

    // ── Dead Stock ──────────────────────────────────────────────────────────
    // ⚠ HERE for the same reason as the ceiling above, and it was the SAME BUG:
    // this rule was applied inline in three of the four branches that build
    // `stores[dsId]`, and the NO-DATA-with-a-floor branch had no check at all. A
    // Dead Stock SKU with a floor and no sales at a store outside `newDSList`
    // therefore kept its floor — six SKUs, DS01 and DS02 only, found 2026-08-26.
    // See deadStock.js for the full case.
    //
    // ⚠ AFTER the ceiling: Dead Stock outranks a cap (0 <= any cap, so the order
    // is not load-bearing arithmetically, but it states the precedence).
    // ⚠ BEFORE the sums below, for the same reason the ceiling is.
    applyDeadStockToStores(stores, isDead, DS_LIST);

    // Derived from `stores` rather than the push-as-you-go arrays, which were filled
    // before the clamp — and which the third NO-DATA branch never pushed to at all.
    const sumMin = DS_LIST.reduce((a, ds) => a + (stores[ds]?.min ?? 0), 0),
      sumMax = DS_LIST.reduce((a, ds) => a + (stores[ds]?.max ?? 0), 0);
    // Pre-floor DS sums for DC "before" calculation
    const sumPreFloorMin = DS_LIST.reduce((s, ds) => s + (stores[ds]?.preFloorMin ?? stores[ds]?.min ?? 0), 0);
    const sumPreFloorMax = DS_LIST.reduce((s, ds) => s + (stores[ds]?.preFloorMax ?? stores[ds]?.max ?? 0), 0);
    const dcStats = getDCStats(invSliced, skuId, activeDSCount, intervals, op);
    // Lead-time-aware DC calculation
    const sumDailyAvg = dsDailyAvgs.reduce((a, b) => a + b, 0);
    const leadTime = (p.brandLeadTimeDays || {})[meta.brand] ?? (p.brandLeadTimeDays || {})._default ?? 2;

    let dcMin, dcMax, preFloorDcMin, preFloorDcMax;
    let dcDetails;
    const isFlooredSKU = !!(nsq && nsq[skuId]);
    const pol = policyOf(meta);
    // DC-only: bought at the DC and sold from the DC, never transferred to a store.
    const isDCOnly = pol.invAt === "dc" && !pol.move;

    if (isDead) {
      dcMin = 0; dcMax = 0;
      preFloorDcMin = 0; preFloorDcMax = 0;
      dcDetails = { isDead: true, sumDailyAvg, leadTime };
    } else if (isDCOnly) {
      // ⚠⚠ THIS BRANCH MUST PRECEDE `isFlooredSKU`, AND THAT IS NOT COSMETIC.
      // `isFlooredSKU` tests PRESENCE OF THE SKU KEY in nsq, not whether any location
      // carries a value — so the moment a DC-only SKU is given a DC floor it would
      // otherwise land on `round(sumMin x 0.2)`, i.e. 20% of that SKU's *DS* mins.
      // Worse, those mins are still un-zeroed here (the Move=No pass runs later, over
      // the finished `res`), so the number would look plausible and be meaningless.
      //
      // The DC is the single selling location, so it gets the SKU's own category
      // strategy — PCT / Fixed Unit Floor / Standard — rather than the rate formula.
      // The rate branch is a REPLENISHMENT BUFFER sized off store demand, and open
      // item #8 already records that it understocks erratic demand; a DC-only item has
      // no store to fall back on when it does.
      const qm = qAll[skuId] || {}, om = oAll[skuId] || {};
      const q90dc = allDates.map(d => qm[d] || 0), o90dc = allDates.map(d => om[d] || 0);
      if (q90dc.some(v => v > 0)) {
        const sAll = computeStats(q90dc, o90dc, op, p.spikeMultiplier);
        const d = dispatchStrategy({
          strategy,
          s90: sAll,
          q90: q90dc,
          qLong: dLong.map(x => qm[x] || 0), oLong: dLong.map(x => om[x] || 0),
          qRecent: dRecent.map(x => qm[x] || 0), oRecent: dRecent.map(x => om[x] || 0),
          prTag,
          mvTag90: getMovTag(sAll.nonZeroDays, op, intervals),
          params: p,
          // Every order line for this SKU at ANY location — one selling point, so the
          // whole order-size distribution belongs to it. Lazy: this is a full scan.
          getOrderQtys: () => invSliced.filter(r => r.sku === skuId && r.qty > 0).map(r => r.qty),
        });
        dcMin = Math.ceil(d.minQty);
        dcMax = Math.ceil(Math.max(d.maxQty, d.minQty));
        dcDetails = {
          isDead: false, dcOnly: true, strategyTag: d.strategyTag, strategyDetails: d.strategyDetails,
          nonZeroDays: sAll.nonZeroDays, dailyAvg: sAll.dailyAvg, sumDailyAvg, leadTime,
        };
      } else {
        // No demand anywhere in the window. 0/0, which a DC floor may then lift — the
        // reason a DC floor exists at all is a brand-new delicate item with no history.
        dcMin = 0; dcMax = 0;
        dcDetails = { isDead: false, dcOnly: true, noData: true, sumDailyAvg, leadTime };
      }
      preFloorDcMin = dcMin; preFloorDcMax = dcMax;
    } else if (isFlooredSKU) {
      // SKU has manual DS floors — use configurable multipliers instead of movement-based DC calc
      const multMin = p.skuFloorDCMultMin ?? 0.2;
      const multMax = p.skuFloorDCMultMax ?? 0.3;
      dcMin = Math.round(sumMin * multMin);
      dcMax = Math.round(sumMax * multMax);
      preFloorDcMin = Math.round(sumPreFloorMin * multMin);
      preFloorDcMax = Math.round(sumPreFloorMax * multMax);
      dcDetails = { isDead: false, isFlooredSKU: true, multMin, multMax, sumMin, sumMax, sumDailyAvg, leadTime };
    } else {
      dcMin = Math.ceil(sumDailyAvg * (leadTime + 1));
      dcMax = dcMin + Math.ceil(sumDailyAvg * 2);
      preFloorDcMin = Math.ceil(sumDailyAvg * (leadTime + 1));
      preFloorDcMax = preFloorDcMin + Math.ceil(sumDailyAvg * 2);
      dcDetails = { isDead: false, isFlooredSKU: false, sumMin, sumMax, sumDailyAvg, leadTime };
    }

    // ── DC Floor, then DC Cap ────────────────────────────────────────────────
    // Applies to EVERY SKU, not just DC-only ones: symmetric with the DS columns, and
    // a column whose meaning depends on another field is how things drift here.
    // Provably inert until ops fills it — `nsq[sku].DC` cannot exist until the floor
    // parser learns the column, and `capFor(..., "DC")` returns null while no ceiling
    // row carries a DC key.
    //
    // ⚠ ORDER IS LOAD-BEARING: the floor lifts, then the cap clamps, because "a cap a
    // floor can overrule is not a cap." Both are skipped for Dead Stock, which
    // outranks them. Purchase=No beats a stale DC floor for FREE, because the policy
    // pass is a single later pass over the finished `res` — the exact property the
    // Dead Stock post-mortem bought ("a rule that only ever REDUCES a value belongs in
    // ONE pass over the finished object, never inline in the branch that computed it").
    if (!isDead) {
      const dcFloor = nsq && nsq[skuId] ? nsq[skuId].DC : undefined;
      if (dcFloor) {
        const fMin = typeof dcFloor === "number" ? dcFloor : (dcFloor.min || 0);
        const fMax = typeof dcFloor === "number" ? dcFloor : (dcFloor.max || fMin);
        // Per-field max, matching the New DS Floor change of 2026-07-06: the floor
        // lifts Min, but Max keeps the strategy's demand-informed headroom when higher.
        if (fMin > dcMin || fMax > dcMax) {
          const beforeMin = dcMin, beforeMax = dcMax;
          if (fMin > dcMin) dcMin = fMin;
          if (fMax > dcMax) dcMax = fMax;
          dcMax = Math.max(dcMax, dcMin);
          dcDetails = { ...dcDetails, dcFloor: { fMin, fMax, beforeMin, beforeMax } };
        }
      }
      // capFor returns null (never undefined) for "no cap", so a legitimate cap of 0
      // can never be dropped by a falsy test — blank and 0 are OPPOSITES here.
      const dcCap = capFor(ceilings, skuId, "DC");
      if (dcCap !== null) {
        const c = clampToCeiling(dcMin, dcMax, dcCap);
        if (c.applied) dcDetails = { ...dcDetails, dcCap: { cap: dcCap, beforeMin: dcMin, beforeMax: dcMax } };
        dcMin = c.min; dcMax = c.max;
      }
    }

    res[skuId] = {
      meta: { ...meta, priceTag: prTag, t150Tag },
      stores,
      dc: { min: dcMin, max: dcMax, preFloorMin: preFloorDcMin, preFloorMax: preFloorDcMax, mvTag: dcStats.mvTag, nonZeroDays: dcStats.nonZeroDays, dcDetails },
    };
  });

  // ── DS Seed pass (e.g. DS06 = avg of DS02/DS04) — before normalization so
  // Supplier/DS-inv zeroing below still wins over seeded values ──────────────
  applyDSSeed(res, p);

  // ── Active-only normalization (final override) ──────────────────────────────
  // ONLY SKUs Active in the SKU Master get non-zero targets. Anything else is a
  // target nobody can act on: ops has marked it not-for-sale, or it is not in the
  // catalogue at all.
  //
  // ⚠ Measured 2026-07-30 before this existed: `status` gated Min/Max NOWHERE, so the
  // engine emitted targets for 9 such SKUs — 4 inactive in the master, 5 absent from
  // it (orphaned pre-July codes) — 6 of them carrying real quantities and ₹2.4L of Max
  // value. Every consumer was separately remembering to filter; `toTargets` only
  // escaped because it ALSO required inventorisedAt === "dc" and unknown SKUs happened
  // to be fabricated as "DS".
  //
  // An allowlist of exactly "active" is the only safe rule: Zoho's vocabulary already
  // includes `confirmation_pending` and can grow at any time. A MISSING status still
  // counts as active — `(status || "Active")` is the established convention for a
  // master row that omits the field, which is different from a SKU absent from the
  // master (fabricated as "Unknown" above).
  //
  // Same character and convention as Dead Stock / Supplier below: zero min/max, leave
  // preFloor* intact for audit, record a reason. The entry is KEPT, not dropped —
  // consumers iterate Object.keys(res), and the Upload tab's "SKUs in Invoice not
  // Active in SKU Master" warning needs these visible rather than silently gone.
  Object.values(res).forEach(r => {
    if (String(r.meta?.status ?? "Active").trim().toLowerCase() === "active") return;
    const reason = `Not active in SKU Master (status: ${r.meta?.status || "absent"})`;
    DS_LIST.forEach(ds => {
      if (!r.stores[ds]) return;
      r.stores[ds].min = 0; r.stores[ds].max = 0; r.stores[ds].logicTag = "Not Active";
    });
    if (r.dc) { r.dc.min = 0; r.dc.max = 0; if (r.dc.dcDetails) r.dc.dcDetails.zeroedReason = reason; }
  });

  // ── Purchase / Move policy pass ─────────────────────────────────────────────
  // Commercial policy, from two Zoho fields. Sits HERE — one pass over the finished
  // `res`, after every strategy, floor, cap, Dead Stock and DS Seed — which is what
  // makes it outrank all of them without a single inline check. Same shape as the
  // Active-only pass above and the Inventorised-At pass below.
  //
  //   Purchase = No  →  zero the INBOUND target: the DC for a DC-inventorised SKU,
  //                     the DS columns for a DS-inventorised one (its PO is raised at
  //                     the store, so the DS number IS the inbound target).
  //   Move     = No  →  zero all six DS. Only meaningful for DC-inventorised SKUs;
  //                     `policyOf` already forces `move` true elsewhere, so no caller
  //                     has to remember that.
  //
  // ⚠ TOPOLOGY OUTRANKS POLICY: Supplier ignores both flags and returns early. It is
  // already 0/0 everywhere via the Inventorised-At pass, and letting policy write a
  // reason string over it would replace the durable explanation with a transient one.
  //
  // ⚠ KNOWN AND ACCEPTED, 13 SKUs: for a DS-inventorised SKU, Purchase=No necessarily
  // also stops it selling, because the same DS number drives both the PO and the
  // shelf. "Sell till stock lasts" is therefore inexpressible there. A third `Sell`
  // flag would NOT have fixed it — same number, same conflict.
  //
  // ⚠ Touches min/max only. `preFloor*` is left intact for audit, matching Dead Stock,
  // Active-only and Inventorised-At.
  Object.values(res).forEach(r => {
    const q = policyOf(r.meta);
    if (q.invAt === "supplier") return;
    if (!q.purchase) {
      if (q.invAt === "dc") {
        if (r.dc) { r.dc.min = 0; r.dc.max = 0; if (r.dc.dcDetails) r.dc.dcDetails.zeroedReason = "Purchase = No"; }
      } else {
        DS_LIST.forEach(ds => {
          if (!r.stores[ds]) return;
          r.stores[ds].min = 0; r.stores[ds].max = 0; r.stores[ds].logicTag = "Purchase = No";
        });
      }
    }
    if (!q.move) {
      DS_LIST.forEach(ds => {
        if (!r.stores[ds]) return;
        r.stores[ds].min = 0; r.stores[ds].max = 0; r.stores[ds].logicTag = "Move = No";
      });
    }
  });

  // ── Inventorised-At normalization (final override, after all strategies & floors) ──
  // Structural location constraints — same character as the Dead Stock rule, applied last.
  // Matches the Dead Stock convention: zero min/max, leave preFloor* intact for audit.
  //  • Supplier — never stocked in our network → Min=Max=0 at every DS and the DC.
  //  • DS-inv   — replenished directly to the DS, bypasses the DC → DC Min=Max=0 (DS kept).
  //  • DC-inv   — flows through the DC → untouched.
  Object.values(res).forEach(r => {
    const invAt = (r.meta?.inventorisedAt || "DS").toLowerCase();
    if (invAt === "supplier") {
      DS_LIST.forEach(ds => {
        if (!r.stores[ds]) return;
        r.stores[ds].min = 0; r.stores[ds].max = 0; r.stores[ds].logicTag = "Supplier";
      });
      if (r.dc) { r.dc.min = 0; r.dc.max = 0; if (r.dc.dcDetails) r.dc.dcDetails.zeroedReason = "Supplier (not stocked in network)"; }
    } else if (invAt === "ds") {
      if (r.dc) { r.dc.min = 0; r.dc.max = 0; if (r.dc.dcDetails) r.dc.dcDetails.zeroedReason = "DS-inventorised (bypasses DC)"; }
    }
  });

  return res;
}
