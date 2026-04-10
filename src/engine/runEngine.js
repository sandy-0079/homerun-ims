// Refactored runEngine — strategy dispatcher with lead-time-aware DC logic

import {
  DS_LIST, MOVEMENT_TIERS_DEFAULT,
  DC_MULT_DEFAULT, DC_DEAD_MULT_DEFAULT,
  RECENCY_WT_DEFAULT, DEFAULT_BRAND_BUFFER,
} from "./constants.js";

import { getPriceTag, getMovTag, getSpikeTag, computeStats } from "./utils.js";
import { standardStrategy } from "./strategies/standard.js";
import { percentileCoverStrategy } from "./strategies/percentileCover.js";
import { fixedUnitFloorStrategy } from "./strategies/fixedUnitFloor.js";

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

export function runEngine(inv, skuM, mrq, pd, deadStockSet, nsq, p) {
  const op = p.overallPeriod || 90,
    rw = Math.min(p.recencyWindow || 15, op - 1),
    recencyWt = p.recencyWt || RECENCY_WT_DEFAULT;
  const intervals = p.movIntervals || MOVEMENT_TIERS_DEFAULT,
    priceTiers = p.priceTiers || [3000, 1500, 400, 100];
  const brandBuffer = p.brandBuffer || DEFAULT_BRAND_BUFFER,
    topN = p.newDSFloorTopN || 150;

  const allDatesRaw = [...new Set(inv.map(r => r.date))].sort(),
    allDates = allDatesRaw.slice(-op);
  const total = allDates.length,
    split = Math.max(0, total - rw),
    dLong = allDates.slice(0, split),
    dRecent = allDates.slice(split);
  const invSliced = inv.filter(r => allDates.includes(r.date));

  const qMap = {}, oMap = {};
  invSliced.forEach(r => {
    const k = `${r.sku}||${r.ds}`;
    if (!qMap[k]) qMap[k] = {};
    if (!oMap[k]) oMap[k] = {};
    qMap[k][r.date] = (qMap[k][r.date] || 0) + r.qty;
    oMap[k][r.date] = (oMap[k][r.date] || 0) + 1;
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

  allSKUs.forEach(skuId => {
    const meta = skuM[skuId] || { sku: skuId, name: skuId, category: "Unknown", brand: "", status: "Active", inventorisedAt: "DS" };
    const prTag = getPriceTag(pd[skuId] || 0, priceTiers),
      t150Tag = t150[skuId] || "No",
      isDead = deadStockSet.has(skuId);
    const bufDays = brandBuffer[meta.brand] || 0, hasBuf = bufDays > 0;
    const dsMinArr = [], dsMaxArr = [], dsDailyAvgs = [], stores = {};

    const strategy = resolveStrategy(meta.category, p.categoryStrategies);

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
          if (isDead) nx = nm;
          stores[dsId] = { min: nm, max: nx, preFloorMin, preFloorMax, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag, strategyTag: "standard" };
          dsMinArr.push(nm); dsMaxArr.push(nx); dsDailyAvgs.push(0);
        } else if (nsq && nsq[skuId]) {
          const fl = nsq[skuId][dsId];
          const fMin = !fl ? 0 : typeof fl === "number" ? fl : (fl.min || 0);
          const fMax = !fl ? 0 : typeof fl === "number" ? fl : (fl.max || fMin);
          const logicTag = fMin > 0 ? "SKU Floor" : "Base Logic";
          stores[dsId] = { min: fMin, max: Math.max(fMin, fMax), preFloorMin: 0, preFloorMax: 0, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag, strategyTag: "standard" };
          dsMinArr.push(fMin); dsMaxArr.push(Math.max(fMin, fMax)); dsDailyAvgs.push(0);
        } else {
          stores[dsId] = { min: 0, max: 0, preFloorMin: 0, preFloorMax: 0, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag: "Base Logic", strategyTag: "standard" };
          dsDailyAvgs.push(0);
        }
        return;
      }

      // ── HAS DATA PATH ─────────────────────────────────────────────────────
      const s90 = computeStats(q90, o90, op, p.spikeMultiplier);
      const mvTag90 = tags90[k].mvTag;

      let minQty, maxQty;
      let strategyTag = strategy;
      let strategyDetails = {};

      if (strategy === "percentile_cover" && s90.nonZeroDays >= (p.pctMinNZD || 2)) {
        const r = percentileCoverStrategy({ q90, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        // DOC cap for configured price tags
        const capDays = p.pctDocCap || 0;
        const capTags = p.pctDocCapPriceTags || [];
        if (capDays > 0 && capTags.includes(prTag) && s90.dailyAvg > 0) {
          const capMin = Math.ceil(s90.dailyAvg * capDays);
          if (minQty > capMin) {
            const uncappedMin = minQty, uncappedMax = maxQty;
            minQty = capMin;
            maxQty = Math.ceil(capMin + s90.dailyAvg * (p.maxDaysBuffer || 2));
            strategyDetails.docCap = { applied: true, capDays, priceTag: prTag, uncappedMin, uncappedMax, cappedMin: minQty, cappedMax: maxQty };
          } else {
            strategyDetails.docCap = { applied: false, capDays, priceTag: prTag };
          }
        }
      } else if (strategy === "percentile_cover" && s90.nonZeroDays < (p.pctMinNZD || 2)) {
        // PCT assigned but NZD too low — fall back to standard
        const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        strategyDetails.pctFallback = { reason: "NZD", nzd: s90.nonZeroDays, threshold: p.pctMinNZD || 2 };
        strategyTag = "standard";
      } else if (strategy === "fixed_unit_floor") {
        const result = fixedUnitFloorStrategy({ orderQtys: collectOrderQtys(invSliced, skuId, dsId), params: p });
        if (result) {
          ({ minQty, maxQty } = result);
          strategyDetails = result.details || {};
        } else {
          // Null — fall back to standard
          const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
          ({ minQty, maxQty } = r);
          strategyDetails = r.details || {};
          strategyTag = "standard";
        }
      } else {
        // "standard", "manual", or unknown — use standard blend
        const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        strategyTag = "standard";
      }

      // ── Post-blend adjustments (strict order preserved) ────────────────
      const strategyMin = minQty, strategyMax = maxQty;
      const postBlendSteps = [];
      let logicTag = "Base Logic";

      // 1. New DS floor — only wins if floor actually exceeds the blend
      if (isNewDS && isEligible) {
        const floor = mrq[skuId] || 0;
        if (floor > minQty) {
          postBlendSteps.push({ rule: "New DS Floor", floor, beforeMin: minQty, beforeMax: maxQty });
          minQty = floor; maxQty = floor; logicTag = "New DS Floor";
        }
        else maxQty = Math.max(maxQty, minQty);
      }

      // 2. Brand buffer — skip for SKUs with manual DS floors (floor already encodes brand knowledge)
      const hasManualFloor = !!(nsq && nsq[skuId]);
      if (hasBuf && !hasManualFloor) {
        const dohMin = s90.dailyAvg > 0 ? minQty / s90.dailyAvg : 0;
        postBlendSteps.push({ rule: "Brand Buffer", bufDays, dohMin, beforeMin: minQty, beforeMax: maxQty });
        minQty = Math.ceil((dohMin + bufDays) * s90.dailyAvg);
        maxQty = minQty;
        logicTag = "Brand Buffer";
      }

      minQty = Math.ceil(minQty); maxQty = Math.ceil(Math.max(maxQty, minQty));
      if (isDead) maxQty = minQty; maxQty = Math.max(maxQty, minQty); if (isDead) maxQty = minQty;

      // Capture pre-floor values for Overrides tab delta calculation
      const preFloorMin = Math.round(minQty), preFloorMax = Math.round(maxQty);

      // 3. SKU Floors — runs last, wins if floor Min exceeds engine Min
      if (nsq && nsq[skuId]) {
        const fl = nsq[skuId][dsId];
        const fMin = !fl ? 0 : typeof fl === "number" ? fl : (fl.min || 0);
        const fMax = !fl ? 0 : typeof fl === "number" ? fl : (fl.max || fMin);
        if (fMin > minQty) {
          postBlendSteps.push({ rule: "SKU Floor", floorMin: fMin, floorMax: fMax, beforeMin: minQty, beforeMax: maxQty });
          minQty = fMin; maxQty = Math.max(fMax, maxQty); logicTag = "SKU Floor";
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
      dsMinArr.push(Math.round(minQty)); dsMaxArr.push(Math.round(maxQty));
      dsDailyAvgs.push(s90.dailyAvg);
    });

    const sumMin = dsMinArr.reduce((a, b) => a + b, 0),
      sumMax = dsMaxArr.reduce((a, b) => a + b, 0);
    // Pre-floor DS sums for DC "before" calculation
    const sumPreFloorMin = DS_LIST.reduce((s, ds) => s + (stores[ds]?.preFloorMin ?? stores[ds]?.min ?? 0), 0);
    const sumPreFloorMax = DS_LIST.reduce((s, ds) => s + (stores[ds]?.preFloorMax ?? stores[ds]?.max ?? 0), 0);
    const dcStats = getDCStats(invSliced, skuId, activeDSCount, intervals, op);
    const dcDeadMult = p.dcDeadMult || DC_DEAD_MULT_DEFAULT;

    // Lead-time-aware DC calculation
    const sumDailyAvg = dsDailyAvgs.reduce((a, b) => a + b, 0);
    const leadTime = (p.brandLeadTimeDays || {})[meta.brand] ?? (p.brandLeadTimeDays || {})._default ?? 2;

    let dcMin, dcMax, preFloorDcMin, preFloorDcMax;
    let dcDetails;
    const isFlooredSKU = !!(nsq && nsq[skuId]);

    if (isDead) {
      const multMin = dcDeadMult.min, multMax = dcDeadMult.max;
      dcMin = Math.round(sumMin * multMin);
      dcMax = Math.round(sumMax * multMax);
      preFloorDcMin = Math.round(sumPreFloorMin * multMin);
      preFloorDcMax = Math.round(sumPreFloorMax * multMax);
      dcDetails = { isDead: true, multMin, multMax, sumMin, sumMax, sumDailyAvg, leadTime };
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
      const dcM = (p.dcMult || DC_MULT_DEFAULT)[dcStats.mvTag] || DC_MULT_DEFAULT[dcStats.mvTag];
      const multMin = dcM.min, multMax = dcM.max;
      const leadTimeMin = Math.ceil(sumDailyAvg * leadTime);
      dcMin = Math.round(Math.max(leadTimeMin, sumMin * multMin));
      dcMax = Math.round(Math.max(Math.ceil(dcMin * (multMax / multMin)), sumMax * multMax));
      const preFloorLeadTimeMin = Math.ceil(sumDailyAvg * leadTime);
      preFloorDcMin = Math.round(Math.max(preFloorLeadTimeMin, sumPreFloorMin * multMin));
      preFloorDcMax = Math.round(Math.max(Math.ceil(preFloorDcMin * (multMax / multMin)), sumPreFloorMax * multMax));
      dcDetails = { isDead: false, isFlooredSKU: false, multMin, multMax, sumMin, sumMax, sumDailyAvg, leadTime, leadTimeMin };
    }

    res[skuId] = {
      meta: { ...meta, priceTag: prTag, t150Tag },
      stores,
      dc: { min: dcMin, max: dcMax, preFloorMin: preFloorDcMin, preFloorMax: preFloorDcMax, mvTag: dcStats.mvTag, nonZeroDays: dcStats.nonZeroDays, dcDetails },
    };
  });

  return res;
}
