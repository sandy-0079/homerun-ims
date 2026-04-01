# Category Strategy Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a category-assigned strategy engine that dispatches SKUs to different Min/Max calculation methods (Standard, Percentile Cover, Fixed Unit Floor, Manual) based on their category, with lead-time-aware DC logic.

**Architecture:** Extract the engine, strategies, and strategy config into separate modules out of App.jsx. The engine becomes a strategy dispatcher — it runs tagging as before, then routes each SKU to its assigned strategy's Min/Max formula. Post-blend adjustments apply on top. A new config section in Logic Tweaker lets admin assign strategies and tune strategy-specific params. Both old and new engines run side-by-side for comparison.

**Tech Stack:** React + Vite, Supabase (PostgreSQL), Web Workers, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-01-category-strategy-engine-design.md`

---

## File Structure

### New files to create:

| File | Responsibility |
|---|---|
| `src/engine/constants.js` | All default params, color maps, tier configs — extracted from App.jsx top |
| `src/engine/utils.js` | `parseCSV`, `getPriceTag`, `getMovTag`, `getSpikeTag`, `computeStats`, `getInvSlice`, `aggStats` — extracted from App.jsx |
| `src/engine/strategies/standard.js` | Standard strategy: `calcPeriodMinMax`, long/recent blend — extracted from current `runEngine` |
| `src/engine/strategies/percentileCover.js` | Percentile Cover strategy: new Min/Max logic |
| `src/engine/strategies/fixedUnitFloor.js` | Fixed Unit Floor strategy: new Min/Max logic |
| `src/engine/runEngine.js` | Refactored `runEngine` + `getDCStats` — strategy dispatcher, post-blend adjustments, lead-time DC |
| `src/engine/index.js` | Barrel export for engine modules |

### Files to modify:

| File | Changes |
|---|---|
| `src/App.jsx` | Remove extracted functions (~lines 1–227), import from engine modules, add strategy config UI to Logic Tweaker, add Strategy Tag display to dashboard |

---

## Task 1: Extract constants into `src/engine/constants.js`

**Files:**
- Create: `src/engine/constants.js`
- Modify: `src/App.jsx` (lines 1–56)

- [ ] **Step 1: Create constants module**

Create `src/engine/constants.js` with all constants currently at the top of App.jsx:

```js
export const ROLLING_DAYS = 90;
export const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];

export const MOVEMENT_TIERS_DEFAULT = [2,4,7,10];

export const DC_MULT_DEFAULT = {
  "Super Fast":{min:0.75,max:1.0},"Fast":{min:0.5,max:0.75},
  "Moderate":{min:0.5,max:0.75},"Slow":{min:0.25,max:0.5},"Super Slow":{min:0.25,max:0.5},
};
export const DC_DEAD_MULT_DEFAULT = {min:0.25,max:0.25};
export const RECENCY_WT_DEFAULT = {"Super Fast":2,"Fast":3,"Moderate":1.5,"Slow":1,"Super Slow":1};
export const BASE_MIN_DAYS_DEFAULT = {"Super Fast":6,"Fast":5,"Moderate":3,"Slow":3,"Super Slow":3};

export const DEFAULT_BRAND_BUFFER = {
  "Asian Paints":3,"VIP Extrusions":3,"MYK Laticrete":3,"Roff":3,
  "Supreme":3,"Saint-Gobain":2,"Alagar":3,"Legrand":1,"Archidply":1,
};

export const DEFAULT_PARAMS = {
  overallPeriod:90,recencyWindow:15,recencyWt:RECENCY_WT_DEFAULT,movIntervals:[2,4,7,10],
  priceTiers:[3000,1500,400,100],spikeMultiplier:5,spikePctFrequent:10,spikePctOnce:5,
  maxDaysBuffer:2,abqMaxMultiplier:1.5,baseMinDays:BASE_MIN_DAYS_DEFAULT,
  brandBuffer:DEFAULT_BRAND_BUFFER,newDSList:["DS04","DS05"],newDSFloorTopN:150,
  activeDSCount:4,dcMult:DC_MULT_DEFAULT,dcDeadMult:DC_DEAD_MULT_DEFAULT,
  // New strategy params
  categoryStrategies:{},
  percentileCover:{
    percentileByPrice:{"Low":95,"Super Low":95,"No Price":95,"Medium":90,"High":85,"Premium":85},
    coverDaysByMovement:{"Super Fast":2,"Fast":2,"Moderate":3,"Slow":2,"Super Slow":1},
  },
  fixedUnitFloor:{orderQtyPercentile:90,maxMultiplier:1.5,maxAdditive:1},
  brandLeadTimeDays:{_default:2},
};

// UI constants remain in App.jsx (HR, DS_COLORS, DC_COLOR, MOV_COLORS, etc.)
```

- [ ] **Step 2: Update App.jsx imports**

At the top of `src/App.jsx`, replace the constant definitions (lines 4–56) with:

```js
import {
  ROLLING_DAYS, DS_LIST, MOVEMENT_TIERS_DEFAULT,
  DC_MULT_DEFAULT, DC_DEAD_MULT_DEFAULT, RECENCY_WT_DEFAULT,
  BASE_MIN_DAYS_DEFAULT, DEFAULT_BRAND_BUFFER, DEFAULT_PARAMS,
} from "./engine/constants.js";
```

Keep all UI-only constants (`HR`, `DS_COLORS`, `DC_COLOR`, `MOV_COLORS`, `PRICE_TAG_COLORS`, `TOPN_TAG_COLORS`, `TOPN_DISPLAY`, `S`, column widths) in App.jsx — they are rendering concerns, not engine concerns.

- [ ] **Step 3: Verify the app still runs**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run dev`

Open in browser, confirm dashboard loads and model runs without errors. Check console for import issues.

- [ ] **Step 4: Commit**

```bash
git add src/engine/constants.js src/App.jsx
git commit -m "refactor: extract engine constants into src/engine/constants.js"
```

---

## Task 2: Extract utility functions into `src/engine/utils.js`

**Files:**
- Create: `src/engine/utils.js`
- Modify: `src/App.jsx` (lines 71–240)

- [ ] **Step 1: Create utils module**

Create `src/engine/utils.js` with functions extracted from App.jsx:

```js
import { MOVEMENT_TIERS_DEFAULT } from "./constants.js";

export function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = []; let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; continue; }
      if (line[i] === ',' && !inQ) { vals.push(cur.trim()); cur = ""; continue; }
      cur += line[i];
    }
    vals.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });
}

export function getPriceTag(p, tiers) {
  const v = parseFloat(p) || 0;
  const [t1, t2, t3, t4] = tiers || [3000, 1500, 400, 100];
  if (v >= t1) return "Premium";
  if (v >= t2) return "High";
  if (v >= t3) return "Medium";
  if (v >= t4) return "Low";
  if (v > 0) return "Super Low";
  return "No Price";
}

export function getMovTag(nzd, total, intervals) {
  if (!nzd) return "Super Slow";
  const avg = total / nzd;
  const [i1, i2, i3, i4] = intervals || MOVEMENT_TIERS_DEFAULT;
  if (avg <= i1) return "Super Fast";
  if (avg <= i2) return "Fast";
  if (avg <= i3) return "Moderate";
  if (avg <= i4) return "Slow";
  return "Super Slow";
}

export function getSpikeTag(spikeDays, totalDays, pFreq, pOnce) {
  const pct = totalDays > 0 ? (spikeDays / totalDays) * 100 : 0;
  if (pct >= pFreq) return "Frequent";
  if (pct >= pOnce) return "Once in a while";
  if (spikeDays > 0) return "Rare";
  return "No Spike";
}

export function computeStats(qtys, ords, periodDays, spikeMult) {
  const totalQty = qtys.reduce((a, b) => a + b, 0);
  const totalOrders = ords.reduce((a, b) => a + b, 0);
  const nonZeroDays = qtys.filter(q => q > 0).length;
  const dailyAvg = totalQty / periodDays;
  const abq = totalOrders > 0 ? totalQty / totalOrders : 0;
  const maxDayQty = Math.max(...qtys);
  let spikeDays = 0, spikeVals = [];
  qtys.forEach(q => {
    if (q > spikeMult * dailyAvg) { spikeDays++; spikeVals.push(q); }
  });
  const sorted = [...spikeVals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const spikeMedian = sorted.length === 0 ? 0
    : sorted.length % 2 === 1 ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  const spikeRef = spikeDays === 0 ? maxDayQty : spikeMedian;
  return { totalQty, totalOrders, nonZeroDays, dailyAvg, abq, spikeDays, spikeRatio: dailyAvg > 0 ? spikeRef / dailyAvg : 0, spikeMedian: spikeRef };
}

/** Compute the Xth percentile from a sorted array of numbers */
export function percentile(sortedArr, pct) {
  if (sortedArr.length === 0) return 0;
  const idx = (pct / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

export function getInvSlice(invoiceData, period, recencyWindow) {
  const allDates = [...new Set(invoiceData.map(r => r.date))].sort();
  const full = allDates.slice(-90);
  if (period === "90D") return invoiceData.filter(r => full.includes(r.date));
  const rw = Math.min(recencyWindow || 15, full.length - 1);
  const split = full.length - rw;
  if (period === "15D") return invoiceData.filter(r => full.slice(split).includes(r.date));
  if (period === "75D") return invoiceData.filter(r => full.slice(0, split).includes(r.date));
  return invoiceData.filter(r => full.includes(r.date));
}

export function aggStats(rows) {
  const skus = new Set(rows.map(r => r.sku));
  const totalOrders = rows.length;
  const totalQty = rows.reduce((a, r) => a + r.qty, 0);
  const avgOrderQty = totalOrders > 0 ? totalQty / totalOrders : 0;
  return { skuCount: skus.size, totalOrders, totalQty, avgOrderQty };
}
```

Note: `percentile()` is a new utility function needed by the Percentile Cover and Fixed Unit Floor strategies.

- [ ] **Step 2: Update App.jsx imports**

Replace the function definitions in App.jsx (lines 71–240) with:

```js
import { parseCSV, getPriceTag, getMovTag, getSpikeTag, computeStats, percentile, getInvSlice, aggStats } from "./engine/utils.js";
```

Remove lines 71–240 from App.jsx (the `parseCSV`, `getPriceTag`, `getMovTag`, `getSpikeTag`, `computeStats`, `getInvSlice`, `aggStats` function definitions). Keep `calcPeriodMinMax`, `getDCStats`, and `runEngine` in App.jsx for now — they move in the next tasks.

- [ ] **Step 3: Verify the app still runs**

Run: `npm run dev`

Open browser, confirm full functionality — upload, model run, dashboard, insights, OOS sim. Check console for errors.

- [ ] **Step 4: Commit**

```bash
git add src/engine/utils.js src/App.jsx
git commit -m "refactor: extract utility functions into src/engine/utils.js"
```

---

## Task 3: Extract Standard strategy into `src/engine/strategies/standard.js`

**Files:**
- Create: `src/engine/strategies/standard.js`
- Modify: `src/App.jsx` (lines 100–109)

- [ ] **Step 1: Create Standard strategy module**

Create `src/engine/strategies/standard.js` — this is the existing `calcPeriodMinMax` + long/recent blend logic, extracted verbatim:

```js
import { BASE_MIN_DAYS_DEFAULT } from "../constants.js";
import { computeStats, getMovTag, getSpikeTag } from "../utils.js";

/**
 * Compute Min/Max for a single period using the standard average-based formula.
 * This is the existing logic extracted from App.jsx.
 */
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
  if (isSlow && ["Medium", "Low", "Super Low"].includes(prTag) && stats.abq > 0) {
    const abqCeil = Math.ceil(stats.abq);
    if (abqCeil >= minQty) { minQty = Math.ceil(abqCeil); maxQty = Math.ceil(minQty * abqMaxMult); }
  }
  minQty = Math.ceil(minQty);
  maxQty = Math.ceil(Math.max(maxQty, minQty));
  return { minQty, maxQty };
}

/**
 * Standard strategy: compute blended Min/Max using long + recent periods with recency weighting.
 *
 * @param {Object} opts
 * @param {number[]} opts.qLong - daily qtys for long period
 * @param {number[]} opts.oLong - daily order counts for long period
 * @param {number[]} opts.qRecent - daily qtys for recent period
 * @param {number[]} opts.oRecent - daily order counts for recent period
 * @param {number[]} opts.q90 - daily qtys for full 90-day period
 * @param {number[]} opts.o90 - daily order counts for full 90-day period
 * @param {string} opts.prTag - price tag
 * @param {string} opts.mvTag90 - movement tag from full 90-day period
 * @param {Object} opts.params - full params object
 * @returns {{ minQty: number, maxQty: number }}
 */
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

  return { minQty, maxQty };
}
```

- [ ] **Step 2: Update App.jsx to import standardStrategy**

Remove `calcPeriodMinMax` from App.jsx (lines 100–109). Add import:

```js
import { calcPeriodMinMax, standardStrategy } from "./engine/strategies/standard.js";
```

Note: `calcPeriodMinMax` is still re-exported because the Impact Preview in Logic Tweaker may reference it directly. If not, drop the named import — but keep it for safety during refactor.

- [ ] **Step 3: Verify the app still runs**

Run: `npm run dev` — confirm dashboard, model run, Logic Tweaker all work.

- [ ] **Step 4: Commit**

```bash
git add src/engine/strategies/standard.js src/App.jsx
git commit -m "refactor: extract Standard strategy into src/engine/strategies/standard.js"
```

---

## Task 4: Implement Percentile Cover strategy

**Files:**
- Create: `src/engine/strategies/percentileCover.js`

- [ ] **Step 1: Create Percentile Cover strategy module**

```js
import { percentile } from "../utils.js";

/**
 * Percentile Cover strategy: Min/Max based on the Xth percentile of non-zero daily qty.
 *
 * Percentile is selected by price tag (cheap = stock aggressively, expensive = lean).
 * Cover days are selected by movement tag.
 *
 * @param {Object} opts
 * @param {number[]} opts.q90 - daily qtys for full 90-day period
 * @param {string} opts.prTag - price tag
 * @param {string} opts.mvTag90 - movement tag from 90-day period
 * @param {Object} opts.params - full params object
 * @returns {{ minQty: number, maxQty: number }}
 */
export function percentileCoverStrategy(opts) {
  const { q90, prTag, mvTag90, params: p } = opts;
  const config = p.percentileCover || {};
  const percentileByPrice = config.percentileByPrice || {
    "Low": 95, "Super Low": 95, "No Price": 95, "Medium": 90, "High": 85, "Premium": 85,
  };
  const coverDaysByMovement = config.coverDaysByMovement || {
    "Super Fast": 2, "Fast": 2, "Moderate": 3, "Slow": 2, "Super Slow": 1,
  };

  const pctValue = percentileByPrice[prTag] ?? 90;
  const coverDays = coverDaysByMovement[mvTag90] ?? 2;

  // Use only non-zero days for percentile calculation
  const nonZeroQtys = q90.filter(q => q > 0).sort((a, b) => a - b);

  if (nonZeroQtys.length === 0) {
    return { minQty: 0, maxQty: 0 };
  }

  const pctQty = percentile(nonZeroQtys, pctValue);
  const dailyAvg = q90.reduce((a, b) => a + b, 0) / q90.length;
  const buffer = p.maxDaysBuffer || 2;

  const minQty = Math.ceil(pctQty * coverDays);
  const maxQty = Math.ceil(minQty + dailyAvg * buffer);

  return { minQty, maxQty };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/engine/strategies/percentileCover.js
git commit -m "feat: implement Percentile Cover strategy"
```

---

## Task 5: Implement Fixed Unit Floor strategy

**Files:**
- Create: `src/engine/strategies/fixedUnitFloor.js`

- [ ] **Step 1: Create Fixed Unit Floor strategy module**

```js
import { percentile } from "../utils.js";

/**
 * Fixed Unit Floor strategy: Min based on P90 of individual order quantities.
 *
 * For categories where order timing is erratic but order size is predictable (e.g., Wires).
 * Falls back to null (signalling caller should use Standard) if no orders exist.
 *
 * @param {Object} opts
 * @param {number[]} opts.orderQtys - array of individual order line quantities for this SKU x DS in 90-day window
 * @param {Object} opts.params - full params object
 * @returns {{ minQty: number, maxQty: number } | null} - null means "fall back to Standard"
 */
export function fixedUnitFloorStrategy(opts) {
  const { orderQtys, params: p } = opts;
  const config = p.fixedUnitFloor || {};
  const pctile = config.orderQtyPercentile ?? 90;
  const maxMult = config.maxMultiplier ?? 1.5;
  const maxAdd = config.maxAdditive ?? 1;

  if (!orderQtys || orderQtys.length === 0) {
    return null; // No orders — caller should fall back to Standard
  }

  const sorted = [...orderQtys].sort((a, b) => a - b);
  const pctQty = percentile(sorted, pctile);
  const minQty = Math.ceil(pctQty);
  const maxQty = Math.ceil(Math.max(minQty + maxAdd, minQty * maxMult));

  return { minQty, maxQty };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/engine/strategies/fixedUnitFloor.js
git commit -m "feat: implement Fixed Unit Floor strategy"
```

---

## Task 6: Refactor `runEngine` into strategy dispatcher (`src/engine/runEngine.js`)

This is the largest task. The new `runEngine` extracts from App.jsx lines 110–227, adds strategy dispatch, and makes DC lead-time-aware.

**Files:**
- Create: `src/engine/runEngine.js`
- Create: `src/engine/index.js`
- Modify: `src/App.jsx`

- [ ] **Step 1: Create `src/engine/runEngine.js`**

```js
import { DS_LIST, MOVEMENT_TIERS_DEFAULT, DC_MULT_DEFAULT, DC_DEAD_MULT_DEFAULT, DEFAULT_PARAMS } from "./constants.js";
import { getPriceTag, getMovTag, getSpikeTag, computeStats } from "./utils.js";
import { standardStrategy } from "./strategies/standard.js";
import { percentileCoverStrategy } from "./strategies/percentileCover.js";
import { fixedUnitFloorStrategy } from "./strategies/fixedUnitFloor.js";

function getDCStats(inv, skuId, activeDSCount, intervals, op) {
  const nzd = Math.min(new Set(inv.filter(r => r.sku === skuId && r.qty > 0).map(r => r.date)).size, op);
  if (!nzd) return { mvTag: "Super Slow", nonZeroDays: 0 };
  const interval = op / nzd;
  const dc = [...(intervals || MOVEMENT_TIERS_DEFAULT)].map(x => x / activeDSCount);
  let mvTag = "Super Slow";
  if (interval <= dc[0]) mvTag = "Super Fast";
  else if (interval <= dc[1]) mvTag = "Fast";
  else if (interval <= dc[2]) mvTag = "Moderate";
  else if (interval <= dc[3]) mvTag = "Slow";
  if (mvTag === "Fast") mvTag = "Super Fast";
  return { mvTag, nonZeroDays: nzd };
}

/**
 * Resolve which strategy to use for a given SKU.
 * Looks up category -> strategy mapping. Defaults to "standard".
 */
function resolveStrategy(category, categoryStrategies) {
  return (categoryStrategies || {})[category] || "standard";
}

/**
 * Collect individual order qtys for a SKU x DS from the invoice data.
 * Needed by Fixed Unit Floor strategy.
 */
function collectOrderQtys(inv, skuId, dsId) {
  return inv.filter(r => r.sku === skuId && r.ds === dsId).map(r => r.qty);
}

/**
 * Run the Min/Max engine with strategy dispatch.
 *
 * @param {Object[]} inv - invoice data rows ({ sku, ds, date, qty })
 * @param {Object} skuM - SKU master keyed by SKU id
 * @param {Object} mrq - min required qty (new DS floor) keyed by SKU id
 * @param {Object} pd - price data keyed by SKU id
 * @param {Set} deadStockSet - set of dead stock SKU ids
 * @param {Object|null} nsq - new SKU qty overrides { [sku]: { [ds]: qty } }
 * @param {Object} p - params object
 * @returns {Object} results keyed by SKU id
 */
export function runEngine(inv, skuM, mrq, pd, deadStockSet, nsq, p) {
  const op = p.overallPeriod || 90;
  const rw = Math.min(p.recencyWindow || 15, op - 1);
  const recencyWt = p.recencyWt || DEFAULT_PARAMS.recencyWt;
  const intervals = p.movIntervals || MOVEMENT_TIERS_DEFAULT;
  const priceTiers = p.priceTiers || [3000, 1500, 400, 100];
  const brandBuffer = p.brandBuffer || DEFAULT_PARAMS.brandBuffer;
  const topN = p.newDSFloorTopN || 150;
  const categoryStrategies = p.categoryStrategies || {};
  const brandLeadTimeDays = p.brandLeadTimeDays || { _default: 2 };

  const allDatesRaw = [...new Set(inv.map(r => r.date))].sort();
  const allDates = allDatesRaw.slice(-op);
  const total = allDates.length;
  const split = Math.max(0, total - rw);
  const dLong = allDates.slice(0, split);
  const dRecent = allDates.slice(split);
  const invSliced = inv.filter(r => allDates.includes(r.date));

  // Build qty and order maps
  const qMap = {}, oMap = {};
  invSliced.forEach(r => {
    const k = `${r.sku}||${r.ds}`;
    if (!qMap[k]) qMap[k] = {};
    if (!oMap[k]) oMap[k] = {};
    qMap[k][r.date] = (qMap[k][r.date] || 0) + r.qty;
    oMap[k][r.date] = (oMap[k][r.date] || 0) + 1;
  });

  // T150 ranking
  const skuTotals = {};
  invSliced.forEach(r => { skuTotals[r.sku] = (skuTotals[r.sku] || 0) + r.qty; });
  const t150 = {};
  Object.entries(skuTotals).sort((a, b) => b[1] - a[1]).forEach(([s], i) => {
    t150[s] = i < 50 ? "T50" : i < 150 ? "T150" : i < 250 ? "T250" : "No";
  });
  Object.values(skuM).forEach(s => {
    if ((s.status || "").toLowerCase() === "active" && !skuTotals[s.sku]) t150[s.sku] = "Zero Sale L90D";
  });

  // 90-day tags (used for movement tag on full period)
  const tags90 = {};
  [...new Set(invSliced.map(r => r.sku))].forEach(skuId => {
    DS_LIST.forEach(dsId => {
      const k = `${skuId}||${dsId}`, qm = qMap[k] || {}, om = oMap[k] || {};
      const q90 = allDates.map(d => qm[d] || 0), o90 = allDates.map(d => om[d] || 0);
      const s90 = computeStats(q90, o90, op, p.spikeMultiplier);
      tags90[k] = {
        mvTag: getMovTag(s90.nonZeroDays, op, intervals),
        spTag: getSpikeTag(s90.spikeDays, op, p.spikePctFrequent, p.spikePctOnce),
        dailyAvg: s90.dailyAvg,
        abq: s90.abq,
      };
    });
  });

  // Main loop
  const allSKUs = [...new Set([...invSliced.map(r => r.sku), ...Object.keys(skuM)])];
  const activeDSCount = p.activeDSCount || 4;
  const res = {};

  allSKUs.forEach(skuId => {
    const meta = skuM[skuId] || { sku: skuId, name: skuId, category: "Unknown", brand: "", status: "Active", inventorisedAt: "DS" };
    const prTag = getPriceTag(pd[skuId] || 0, priceTiers);
    const t150Tag = t150[skuId] || "No";
    const isDead = deadStockSet.has(skuId);
    const bufDays = brandBuffer[meta.brand] || 0;
    const hasBuf = bufDays > 0;
    const strategy = resolveStrategy(meta.category, categoryStrategies);
    const dsMinArr = [], dsMaxArr = [], dsDailyAvgs = [], stores = {};

    DS_LIST.forEach(dsId => {
      const k = `${skuId}||${dsId}`, qm = qMap[k] || {}, om = oMap[k] || {};
      const qLong = dLong.map(d => qm[d] || 0), oLong = dLong.map(d => om[d] || 0);
      const qRecent = dRecent.map(d => qm[d] || 0), oRecent = dRecent.map(d => om[d] || 0);
      const q90 = allDates.map(d => qm[d] || 0), o90 = allDates.map(d => om[d] || 0);
      const hasData = q90.some(v => v > 0);
      const isNewDS = (p.newDSList || []).includes(dsId);
      const isEligible = (() => {
        const rank = ["T50", "T150", "T250"].indexOf(t150Tag);
        if (rank === -1) return false;
        return [50, 150, 250][rank] <= topN;
      })();
      const s90 = computeStats(q90, o90, op, p.spikeMultiplier);
      const mvTag90 = tags90[k]?.mvTag || "Super Slow";

      // ── NO DATA PATH ──
      if (!hasData) {
        if (isNewDS) {
          let nm = isEligible ? (mrq[skuId] || 0) : 0, nx = isEligible ? nm : 0;
          let logicTag = "Base Logic", strategyTag = "N/A";
          if (isEligible && nm > 0) logicTag = "New DS Floor";
          if (nsq && nsq[skuId]) {
            const q = nsq[skuId][dsId] || 0;
            if (q > 0) { nm = Math.max(nm, q); nx = nm; logicTag = "New SKU Floor"; }
          }
          if (isDead) nx = nm;
          stores[dsId] = { min: nm, max: nx, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag, strategyTag };
          dsMinArr.push(nm); dsMaxArr.push(nx); dsDailyAvgs.push(0);
        } else if (nsq && nsq[skuId]) {
          const q = nsq[skuId][dsId] || 0;
          const logicTag = q > 0 ? "New SKU Floor" : "Base Logic";
          stores[dsId] = { min: q, max: q, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag, strategyTag: "N/A" };
          dsMinArr.push(q); dsMaxArr.push(q); dsDailyAvgs.push(0);
        } else {
          stores[dsId] = { min: 0, max: 0, dailyAvg: 0, abq: 0, mvTag: "Super Slow", spTag: "No Spike", logicTag: "Base Logic", strategyTag: "N/A" };
          dsDailyAvgs.push(0);
        }
        return;
      }

      // ── HAS DATA PATH — Strategy dispatch ──
      let minQty, maxQty;
      let strategyTag = strategy;

      if (strategy === "manual") {
        // Manual strategy: use standard as base, overrides are applied later by coreOverrides
        const stdResult = standardStrategy({ qLong, oLong, qRecent, oRecent, q90, o90, prTag, mvTag90, params: p });
        minQty = stdResult.minQty;
        maxQty = stdResult.maxQty;
        strategyTag = "manual";
      } else if (strategy === "percentile_cover") {
        const result = percentileCoverStrategy({ q90, prTag, mvTag90, params: p });
        minQty = result.minQty;
        maxQty = result.maxQty;
      } else if (strategy === "fixed_unit_floor") {
        const orderQtys = collectOrderQtys(invSliced, skuId, dsId);
        const result = fixedUnitFloorStrategy({ orderQtys, params: p });
        if (result === null) {
          // Fall back to standard
          const stdResult = standardStrategy({ qLong, oLong, qRecent, oRecent, q90, o90, prTag, mvTag90, params: p });
          minQty = stdResult.minQty;
          maxQty = stdResult.maxQty;
          strategyTag = "standard (fallback)";
        } else {
          minQty = result.minQty;
          maxQty = result.maxQty;
        }
      } else {
        // Default: standard
        const stdResult = standardStrategy({ qLong, oLong, qRecent, oRecent, q90, o90, prTag, mvTag90, params: p });
        minQty = stdResult.minQty;
        maxQty = stdResult.maxQty;
        strategyTag = "standard";
      }

      // ── Post-blend adjustments (same order as before) ──
      let logicTag = "Base Logic";

      // New DS floor
      if (isNewDS && isEligible) {
        const floor = mrq[skuId] || 0;
        if (floor > minQty) { minQty = floor; maxQty = floor; logicTag = "New DS Floor"; }
        else maxQty = Math.max(maxQty, minQty);
      }

      // Brand buffer
      if (hasBuf) {
        const dohMin = s90.dailyAvg > 0 ? minQty / s90.dailyAvg : 0;
        minQty = Math.ceil((dohMin + bufDays) * s90.dailyAvg);
        maxQty = minQty;
        logicTag = "Brand Buffer";
      }

      minQty = Math.ceil(minQty);
      maxQty = Math.ceil(Math.max(maxQty, minQty));
      if (isDead) maxQty = minQty;
      maxQty = Math.max(maxQty, minQty);
      if (isDead) maxQty = minQty;

      // NSQ — runs last
      if (nsq && nsq[skuId]) {
        const q = nsq[skuId][dsId] || 0;
        if (q > minQty) { minQty = q; maxQty = minQty; logicTag = "New SKU Floor"; }
      }

      stores[dsId] = {
        min: Math.round(minQty), max: Math.round(maxQty),
        dailyAvg: s90.dailyAvg, abq: s90.abq,
        mvTag: mvTag90, spTag: tags90[k].spTag,
        logicTag, strategyTag,
      };
      dsMinArr.push(Math.round(minQty));
      dsMaxArr.push(Math.round(maxQty));
      dsDailyAvgs.push(s90.dailyAvg);
    });

    // ── DC Calculation (lead-time-aware) ──
    const sumMin = dsMinArr.reduce((a, b) => a + b, 0);
    const sumMax = dsMaxArr.reduce((a, b) => a + b, 0);
    const sumDailyAvg = dsDailyAvgs.reduce((a, b) => a + b, 0);
    const dcStats = getDCStats(invSliced, skuId, activeDSCount, intervals, op);
    const leadTime = brandLeadTimeDays[meta.brand] ?? brandLeadTimeDays._default ?? 2;

    let dcMin, dcMax;
    if (isDead) {
      const dcDeadMult = p.dcDeadMult || DC_DEAD_MULT_DEFAULT;
      dcMin = Math.round(sumMin * dcDeadMult.min);
      dcMax = Math.round(sumMax * dcDeadMult.max);
    } else {
      // Lead-time-aware: DC Min = sum of DS daily avgs x lead time
      const dcM = (p.dcMult || DC_MULT_DEFAULT)[dcStats.mvTag] || DC_MULT_DEFAULT[dcStats.mvTag];
      const leadTimeMin = Math.ceil(sumDailyAvg * leadTime);
      // Use the greater of lead-time-based or multiplier-based
      dcMin = Math.round(Math.max(leadTimeMin, sumMin * dcM.min));
      dcMax = Math.round(Math.max(Math.ceil(dcMin * (dcM.max / dcM.min)), sumMax * dcM.max));
    }

    res[skuId] = {
      meta: { ...meta, priceTag: prTag, t150Tag },
      stores,
      dc: { min: dcMin, max: dcMax, mvTag: dcStats.mvTag, nonZeroDays: dcStats.nonZeroDays },
    };
  });

  return res;
}
```

- [ ] **Step 2: Create barrel export `src/engine/index.js`**

```js
export { runEngine } from "./runEngine.js";
export { standardStrategy, calcPeriodMinMax } from "./strategies/standard.js";
export { percentileCoverStrategy } from "./strategies/percentileCover.js";
export { fixedUnitFloorStrategy } from "./strategies/fixedUnitFloor.js";
export { parseCSV, getPriceTag, getMovTag, getSpikeTag, computeStats, percentile, getInvSlice, aggStats } from "./utils.js";
export * from "./constants.js";
```

- [ ] **Step 3: Update App.jsx to use new engine**

Replace the `runEngine`, `getDCStats`, and `calcPeriodMinMax` function definitions in App.jsx (lines 100–227) with a single import:

```js
import { runEngine, calcPeriodMinMax } from "./engine/index.js";
```

Update the existing imports at the top (from Tasks 1-3) to import from the barrel instead:

```js
import {
  ROLLING_DAYS, DS_LIST, MOVEMENT_TIERS_DEFAULT,
  DC_MULT_DEFAULT, DC_DEAD_MULT_DEFAULT, RECENCY_WT_DEFAULT,
  BASE_MIN_DAYS_DEFAULT, DEFAULT_BRAND_BUFFER, DEFAULT_PARAMS,
  runEngine, calcPeriodMinMax,
  parseCSV, getPriceTag, getMovTag, getSpikeTag, computeStats, getInvSlice, aggStats,
} from "./engine/index.js";
```

Remove the separate imports from Tasks 1-3 (now consolidated).

- [ ] **Step 4: Verify the app still runs with standard strategy (no categories assigned)**

Run: `npm run dev`

Since `categoryStrategies` defaults to `{}`, every SKU routes to Standard — this should produce **identical output** to the old engine. Load data, run model, compare a few SKU Min/Max values to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add src/engine/runEngine.js src/engine/index.js src/App.jsx
git commit -m "feat: refactor runEngine as strategy dispatcher with lead-time DC logic"
```

---

## Task 7: Add `strategyTag` display to Dashboard

**Files:**
- Modify: `src/App.jsx` (DSCols component, ~line 297)

- [ ] **Step 1: Update DSCols to show strategyTag**

Find the `DSCols` component (around line 297 after refactoring — search for `const DSCols`). Update the logic tag display to show both strategy and logic tag:

Currently the logicTag rendering looks like:
```jsx
const logicTag = coreOverrides?.[r.meta?.sku]?.[ds] ? "Manual Override" : (s.logicTag || "Base Logic");
```

Update the `DSCols` component to also read `s.strategyTag` and render it. Find the `<LogicTag value={logicTag}/>` line and add the strategy tag before it:

```jsx
const strategyTag = s.strategyTag || "standard";
const logicTag = coreOverrides?.[r.meta?.sku]?.[ds] ? "Manual Override" : (s.logicTag || "Base Logic");
```

And in the render, show strategy tag as a small label above the logic tag:

```jsx
{strategyTag && strategyTag !== "N/A" && strategyTag !== "standard" && (
  <div style={{fontSize:7,color:"#6366F1",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.5px"}}>
    {strategyTag === "percentile_cover" ? "PCT" : strategyTag === "fixed_unit_floor" ? "FLOOR" : strategyTag.toUpperCase()}
  </div>
)}
<LogicTag value={logicTag}/>
```

This means: Standard strategy SKUs look identical to today (no extra label). Only Percentile Cover and Fixed Unit Floor SKUs get a small "PCT" or "FLOOR" indicator above the logic tag.

- [ ] **Step 2: Verify in browser**

Run `npm run dev`, load data, and confirm:
- Standard strategy SKUs show only the logic tag (same as before)
- Once we assign categories in the next task, PCT/FLOOR labels will appear

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "feat: show strategy tag in dashboard for non-standard strategies"
```

---

## Task 8: Add Strategy Config UI to Logic Tweaker

**Files:**
- Modify: `src/App.jsx` (Logic Tweaker tab, ~lines 3590-3952)

This task adds three new config sections to the Logic Tweaker:
1. Category -> Strategy assignment
2. Percentile Cover params (percentile by price, cover days by movement)
3. Fixed Unit Floor params
4. Brand Lead Time Days

- [ ] **Step 1: Add Category Strategy Assignment section**

In the Logic Tweaker's 3-column grid, add a new section at the top of **Column 3**. Find the column 3 `<div>` in the grid (after the column 2 closing `</div>`).

Add this section which shows a dropdown per category:

```jsx
{/* Category Strategy Assignment */}
<div>
  <div style={{
    background:"#F3E8FF",border:"1px solid #D8B4FE",borderRadius:8,
    padding:"12px 16px",marginBottom:4,
    display:"flex",alignItems:"center",gap:10,
  }}>
    <span style={{fontSize:20}}>🎯</span>
    <span style={{fontWeight:800,fontSize:16,color:"#7C3AED",letterSpacing:"-0.3px"}}>
      Category Strategies
    </span>
  </div>
  <Section title="Strategy per Category" icon="" accent="#7C3AED"
    summary={`${Object.values(params.categoryStrategies||{}).filter(v=>v!=="standard").length} non-standard`}>
    <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>
      Categories not listed default to Standard.
    </div>
    <table style={S.table}>
      <thead><tr style={{background:HR.surfaceLight}}>
        <th style={S.th}>Category</th>
        <th style={{...S.th,textAlign:"center"}}>Strategy</th>
      </tr></thead>
      <tbody>
        {[...new Set(Object.values(skuMaster).map(s=>s.category||"Unknown"))].sort().map((cat,i)=>{
          const cs = params.categoryStrategies || {};
          const val = cs[cat] || "standard";
          return <tr key={cat} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
            <td style={{...S.td,fontSize:11,fontWeight:600}}>{cat}</td>
            <td style={{...S.td,textAlign:"center"}}>
              <select value={val} onChange={e=>{
                const next = {...(params.categoryStrategies||{}), [cat]:e.target.value};
                if(e.target.value==="standard") delete next[cat];
                saveParams({...params, categoryStrategies:next});
              }} style={{...S.input,fontSize:11,padding:"2px 6px",cursor:"pointer"}}>
                <option value="standard">Standard</option>
                <option value="percentile_cover">Percentile Cover</option>
                <option value="fixed_unit_floor">Fixed Unit Floor</option>
                <option value="manual">Manual</option>
              </select>
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </Section>
</div>
```

Note: `skuMaster` is the state variable holding SKU master data. Verify the actual variable name used in App.jsx state (it may be `skuMaster` or `sku` — check the state declarations around line 2600).

- [ ] **Step 2: Add Percentile Cover params section**

Below the category assignment section, add:

```jsx
<Section title="Percentile Cover Params" icon="" accent="#7C3AED"
  summary={`Price→Pct, Movement→Days`}>
  <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>
    Percentile by Price Tag (higher = more stock)
  </div>
  <table style={S.table}>
    <thead><tr style={{background:HR.surfaceLight}}>
      <th style={S.th}>Price Tag</th>
      <th style={{...S.th,textAlign:"center"}}>Percentile</th>
    </tr></thead>
    <tbody>
      {["Premium","High","Medium","Low","Super Low","No Price"].map((pt,i)=>{
        const pc = params.percentileCover || DEFAULT_PARAMS.percentileCover;
        const val = (pc.percentileByPrice||{})[pt] ?? 90;
        return <tr key={pt} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
          <td style={S.td}><TagPill value={pt} colorMap={PRICE_TAG_COLORS}/></td>
          <td style={{...S.td,textAlign:"center"}}>
            <NumInput value={val} min={50} max={99} step={1}
              onChange={v=>{
                const pc2={...(params.percentileCover||DEFAULT_PARAMS.percentileCover)};
                pc2.percentileByPrice={...pc2.percentileByPrice,[pt]:v};
                saveParams({...params,percentileCover:pc2});
              }}
              style={{width:60,fontWeight:700}}/>
          </td>
        </tr>;
      })}
    </tbody>
  </table>
  <div style={{fontSize:10,color:HR.muted,marginBottom:8,marginTop:12}}>
    Cover Days by Movement Tag
  </div>
  <table style={S.table}>
    <thead><tr style={{background:HR.surfaceLight}}>
      <th style={S.th}>Movement</th>
      <th style={{...S.th,textAlign:"center"}}>Days</th>
    </tr></thead>
    <tbody>
      {["Super Fast","Fast","Moderate","Slow","Super Slow"].map((mv,i)=>{
        const pc = params.percentileCover || DEFAULT_PARAMS.percentileCover;
        const val = (pc.coverDaysByMovement||{})[mv] ?? 2;
        return <tr key={mv} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
          <td style={S.td}><MovTag value={mv}/></td>
          <td style={{...S.td,textAlign:"center"}}>
            <NumInput value={val} min={1} max={7} step={1}
              onChange={v=>{
                const pc2={...(params.percentileCover||DEFAULT_PARAMS.percentileCover)};
                pc2.coverDaysByMovement={...pc2.coverDaysByMovement,[mv]:v};
                saveParams({...params,percentileCover:pc2});
              }}
              style={{width:60,fontWeight:700}}/>
          </td>
        </tr>;
      })}
    </tbody>
  </table>
</Section>
```

- [ ] **Step 3: Add Fixed Unit Floor params section**

```jsx
<Section title="Fixed Unit Floor Params" icon="" accent="#7C3AED"
  summary={`P${(params.fixedUnitFloor||DEFAULT_PARAMS.fixedUnitFloor).orderQtyPercentile} · ${(params.fixedUnitFloor||DEFAULT_PARAMS.fixedUnitFloor).maxMultiplier}x`}>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
    {[
      {label:"Order Qty Percentile",key:"orderQtyPercentile",min:50,max:99,step:1},
      {label:"Max Multiplier",key:"maxMultiplier",min:1,max:3,step:0.1},
      {label:"Max Additive",key:"maxAdditive",min:0,max:5,step:1},
    ].map(({label,key,min,max,step})=>{
      const fuf = params.fixedUnitFloor || DEFAULT_PARAMS.fixedUnitFloor;
      return <div key={key}>
        <div style={{fontSize:10,color:HR.muted,marginBottom:4}}>{label}</div>
        <NumInput value={fuf[key]} min={min} max={max} step={step}
          onChange={v=>saveParams({...params,fixedUnitFloor:{...fuf,[key]:v}})}
          style={{width:"100%",boxSizing:"border-box",fontWeight:700}}/>
      </div>;
    })}
  </div>
</Section>
```

- [ ] **Step 4: Add Brand Lead Time Days section**

```jsx
<Section title="Brand Lead Time (DC)" icon="" accent="#7C3AED"
  summary={`Default: ${(params.brandLeadTimeDays||{})._default||2}d`}>
  <div style={{fontSize:10,color:HR.muted,marginBottom:8}}>
    Days until DC is replenished by supplier. Default applies to unlisted brands.
  </div>
  <div style={{marginBottom:8}}>
    <span style={{fontSize:11,fontWeight:600}}>Default: </span>
    <NumInput value={(params.brandLeadTimeDays||{})._default||2} min={1} max={10} step={1}
      onChange={v=>saveParams({...params,brandLeadTimeDays:{...(params.brandLeadTimeDays||{_default:2}),_default:v}})}
      style={{width:60,fontWeight:700}}/>
    <span style={{fontSize:10,color:HR.muted}}> days</span>
  </div>
  <table style={S.table}>
    <thead><tr style={{background:HR.surfaceLight}}>
      <th style={S.th}>Brand</th>
      <th style={{...S.th,textAlign:"center"}}>Lead Time (days)</th>
      <th style={{...S.th,textAlign:"center",width:30}}></th>
    </tr></thead>
    <tbody>
      {Object.entries(params.brandLeadTimeDays||{}).filter(([k])=>k!=="_default").map(([brand,days],i)=>(
        <tr key={brand} style={{background:i%2===0?HR.white:HR.surfaceLight}}>
          <td style={{...S.td,fontSize:11}}>{brand}</td>
          <td style={{...S.td,textAlign:"center"}}>
            <NumInput value={days} min={1} max={10} step={1}
              onChange={v=>{
                const next={...(params.brandLeadTimeDays||{_default:2}),[brand]:v};
                saveParams({...params,brandLeadTimeDays:next});
              }}
              style={{width:60,fontWeight:700}}/>
          </td>
          <td style={{...S.td,textAlign:"center"}}>
            <button onClick={()=>{
              const next={...(params.brandLeadTimeDays||{_default:2})};
              delete next[brand];
              saveParams({...params,brandLeadTimeDays:next});
            }} style={{background:"none",border:"none",cursor:"pointer",color:"#EF4444",fontSize:14}}>x</button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
  <div style={{marginTop:8,display:"flex",gap:8,alignItems:"center"}}>
    <select id="newLeadBrand" style={{...S.input,fontSize:11,flex:1}}>
      {[...new Set(Object.values(skuMaster).map(s=>s.brand).filter(Boolean))].sort()
        .filter(b=>!(params.brandLeadTimeDays||{})[b])
        .map(b=><option key={b} value={b}>{b}</option>)}
    </select>
    <button onClick={()=>{
      const sel=document.getElementById("newLeadBrand");
      if(!sel?.value)return;
      const next={...(params.brandLeadTimeDays||{_default:2}),[sel.value]:5};
      saveParams({...params,brandLeadTimeDays:next});
    }} style={{...S.btn(true),padding:"4px 12px",fontSize:11}}>Add</button>
  </div>
</Section>
```

- [ ] **Step 5: Update the `changedCount` calculation**

Find the `changedCount` calculation (around line 2684). Add checks for the new param keys:

```js
JSON.stringify(params.categoryStrategies)!==JSON.stringify(savedParams.categoryStrategies),
JSON.stringify(params.percentileCover)!==JSON.stringify(savedParams.percentileCover),
JSON.stringify(params.fixedUnitFloor)!==JSON.stringify(savedParams.fixedUnitFloor),
JSON.stringify(params.brandLeadTimeDays)!==JSON.stringify(savedParams.brandLeadTimeDays),
```

Append these to the existing array inside the `changedCount` calculation.

- [ ] **Step 6: Verify Logic Tweaker renders correctly**

Run: `npm run dev`

Log in as admin, go to Logic Tweaker. Confirm:
- Category Strategies section shows all categories with dropdowns
- Percentile Cover params show price/movement tables
- Fixed Unit Floor params show 3 inputs
- Brand Lead Time shows default + add-brand UI
- Changing any value increments the unsaved changes count
- Apply & Re-run saves to Supabase and reruns engine

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat: add strategy config UI to Logic Tweaker (category assignment, percentile, floor, lead time)"
```

---

## Task 9: End-to-end validation

**Files:** No changes — this is a testing/validation task.

- [ ] **Step 1: Test Standard strategy (default — no categories assigned)**

1. Run `npm run dev`, upload invoice data + SKU master
2. Run model with default params (all categories = Standard)
3. Verify output matches expected behavior — Min/Max values should be identical to the old engine
4. Check OOS Simulation still works

- [ ] **Step 2: Test Percentile Cover strategy**

1. In Logic Tweaker, assign one category (e.g., Plywood) to "Percentile Cover"
2. Apply & Re-run
3. Inspect dashboard — SKUs in that category should show "PCT" strategy tag
4. Verify Min/Max values are different from Standard and make sense:
   - Min should be higher for volatile SKUs (reflecting percentile of non-zero qty)
   - Max = Min + daily avg x buffer

- [ ] **Step 3: Test Fixed Unit Floor strategy**

1. Assign another category (e.g., Wires) to "Fixed Unit Floor"
2. Apply & Re-run
3. Inspect dashboard — SKUs in that category should show "FLOOR" strategy tag
4. Verify Min values reflect P90 of order qty (should be small, stable numbers like 1-2 for Wires)

- [ ] **Step 4: Test DC lead-time logic**

1. In Brand Lead Time section, set a brand to 5 days
2. Apply & Re-run
3. Check DC Min for SKUs of that brand — should be noticeably higher than before (reflecting 5-day lead time)

- [ ] **Step 5: Test post-blend adjustments still work**

1. Verify Brand Buffer still overrides when applicable
2. Verify New DS Floor still applies for new stores
3. Verify Dead Stock cap still forces Max = Min
4. Verify Core Overrides (from Manual Overrides tab) still apply on top

- [ ] **Step 6: Test Logic Tweaker param persistence**

1. Change some strategy params, Apply & Re-run
2. Refresh browser — params should reload from Supabase
3. Open in a different browser/incognito — params should sync

- [ ] **Step 7: Commit any fixes found during validation**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end validation"
```

---

## Summary

| Task | What it does | Files |
|---|---|---|
| 1 | Extract constants | Create `src/engine/constants.js`, modify `App.jsx` |
| 2 | Extract utils | Create `src/engine/utils.js`, modify `App.jsx` |
| 3 | Extract Standard strategy | Create `src/engine/strategies/standard.js`, modify `App.jsx` |
| 4 | Implement Percentile Cover | Create `src/engine/strategies/percentileCover.js` |
| 5 | Implement Fixed Unit Floor | Create `src/engine/strategies/fixedUnitFloor.js` |
| 6 | Strategy dispatcher + DC logic | Create `src/engine/runEngine.js`, `src/engine/index.js`, modify `App.jsx` |
| 7 | Dashboard strategy tag display | Modify `App.jsx` |
| 8 | Logic Tweaker config UI | Modify `App.jsx` |
| 9 | End-to-end validation | No file changes (testing) |
