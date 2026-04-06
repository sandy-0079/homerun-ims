// Standard strategy — long/recent blended Min/Max
// Extracted from App.jsx runEngine

import { BASE_MIN_DAYS_DEFAULT } from "../constants.js";
import { computeStats, getMovTag, getSpikeTag } from "../utils.js";

export function calcPeriodMinMax(stats, prTag, spTag, mvTag, abqMaxMult, maxDaysBuffer, baseMinDays) {
  const bmd = baseMinDays || BASE_MIN_DAYS_DEFAULT;
  const isSlow = ["Slow", "Super Slow"].includes(mvTag);
  const lowPrice = ["Low", "Super Low", "No Price"].includes(prTag);
  const base = bmd[mvTag] ?? 3;
  const useRatio = spTag === "Frequent" || spTag === "No Spike" || (["Once in a while", "Rare"].includes(spTag) && lowPrice);
  const baseMinQty = stats.dailyAvg * base;
  const bufQty = maxDaysBuffer * stats.dailyAvg;
  let minQty = useRatio ? Math.ceil(Math.max(baseMinQty, stats.spikeMedian)) : Math.ceil(baseMinQty);
  let maxQty = useRatio ? Math.ceil(Math.max(baseMinQty + bufQty, stats.spikeMedian + bufQty)) : Math.ceil(baseMinQty + bufQty);
  let abqApplied = false;
  if (isSlow && ["Medium", "Low", "Super Low"].includes(prTag) && stats.abq > 0) {
    const abqCeil = Math.ceil(stats.abq);
    if (abqCeil >= minQty) { minQty = Math.ceil(abqCeil); maxQty = Math.ceil(minQty * abqMaxMult); abqApplied = true; }
  }
  minQty = Math.ceil(minQty);
  maxQty = Math.ceil(Math.max(maxQty, minQty));
  return {
    minQty, maxQty,
    explain: { base, baseMinQty, bufQty, useRatio, buffer: maxDaysBuffer, abqApplied, abq: stats.abq, abqMaxMult, mvTag, spTag },
  };
}

export function standardStrategy(opts) {
  const { qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p } = opts;
  const op = p.overallPeriod || 90;
  const rw = Math.min(p.recencyWindow || 15, op - 1);
  const intervals = p.movIntervals;
  const recencyWt = p.recencyWt;

  const sLong = computeStats(qLong, oLong, op - rw, p.spikeMultiplier);
  const sRecent = computeStats(qRecent, oRecent, rw, p.spikeMultiplier);

  const mvTagLong = getMovTag(sLong.nonZeroDays, op - rw, intervals);
  const spTagLong = getSpikeTag(sLong.spikeDays, op - rw, p.spikePctFrequent, p.spikePctOnce);
  const mvTagRecent = getMovTag(sRecent.nonZeroDays, rw, intervals);
  const spTagRecent = getSpikeTag(sRecent.spikeDays, rw, p.spikePctFrequent, p.spikePctOnce);

  const wt = recencyWt[mvTag90] || 1;
  const rLong = calcPeriodMinMax(sLong, prTag, spTagLong, mvTagLong, p.abqMaxMultiplier, p.maxDaysBuffer, p.baseMinDays);
  const rRecent = calcPeriodMinMax(sRecent, prTag, spTagRecent, mvTagRecent, p.abqMaxMultiplier, p.maxDaysBuffer, p.baseMinDays);

  const minQty = Math.ceil((rLong.minQty + rRecent.minQty * wt) / (1 + wt));
  const maxQty = Math.ceil((rLong.maxQty + rRecent.maxQty * wt) / (1 + wt));

  const details = {
    longDays: op - rw,
    recentDays: rw,
    sLong: {
      dailyAvg: sLong.dailyAvg,
      spikeMedian: sLong.spikeMedian,
      nonZeroDays: sLong.nonZeroDays,
      abq: sLong.abq,
      spikeDays: sLong.spikeDays,
    },
    sRecent: {
      dailyAvg: sRecent.dailyAvg,
      spikeMedian: sRecent.spikeMedian,
      nonZeroDays: sRecent.nonZeroDays,
      abq: sRecent.abq,
      spikeDays: sRecent.spikeDays,
    },
    mvTagLong,
    spTagLong,
    mvTagRecent,
    spTagRecent,
    rLong,
    rRecent,
    wt,
    blendedMin: minQty,
    blendedMax: maxQty,
  };

  return { minQty, maxQty, details };
}
