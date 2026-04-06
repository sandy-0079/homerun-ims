# Overview & SKU Detail Tab Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dashboard with a category→brand→SKU Overview tab and replace SKU Order Behaviour with a detailed SKU Detail tab showing full computation breakdowns.

**Architecture:** Engine strategies return intermediate computation details alongside minQty/maxQty. runEngine.js stores these in results. Two new tab components (OverviewTab, SKUDetailTab) replace Dashboard and InsightsTab in App.jsx. Overview drills Category→Brand→SKU with period/store pickers. SKU Detail shows per-DS computation cards with full audit trail + two charts.

**Tech Stack:** React + Vite, inline styles (following existing patterns), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-06-overview-sku-detail-redesign.md`

---

## Task 1: Engine — Strategy Intermediates

Modify all three strategy files to return a `details` object alongside `minQty`/`maxQty`. This is the data that SKU Detail cards will render.

**Files:**
- Modify: `src/engine/strategies/standard.js`
- Modify: `src/engine/strategies/percentileCover.js`
- Modify: `src/engine/strategies/fixedUnitFloor.js`

- [ ] **Step 1: Modify standardStrategy to return details**

In `src/engine/strategies/standard.js`, replace lines 24–47 with:

```javascript
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

  return {
    minQty, maxQty,
    details: {
      longDays: op - rw,
      recentDays: rw,
      sLong: { dailyAvg: sLong.dailyAvg, spikeMedian: sLong.spikeMedian, nonZeroDays: sLong.nonZeroDays, abq: sLong.abq, spikeDays: sLong.spikeDays },
      sRecent: { dailyAvg: sRecent.dailyAvg, spikeMedian: sRecent.spikeMedian, nonZeroDays: sRecent.nonZeroDays, abq: sRecent.abq, spikeDays: sRecent.spikeDays },
      mvTagLong, spTagLong, mvTagRecent, spTagRecent,
      rLong: { minQty: rLong.minQty, maxQty: rLong.maxQty },
      rRecent: { minQty: rRecent.minQty, maxQty: rRecent.maxQty },
      wt,
      blendedMin: minQty,
      blendedMax: maxQty,
    },
  };
}
```

`calcPeriodMinMax` (lines 7–22) stays unchanged.

- [ ] **Step 2: Modify percentileCoverStrategy to return details**

In `src/engine/strategies/percentileCover.js`, replace lines 16–44 with:

```javascript
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

  const nonZeroQtys = q90.filter(q => q > 0).sort((a, b) => a - b);

  if (nonZeroQtys.length === 0) {
    return { minQty: 0, maxQty: 0, details: { pctUsed: pctValue, pctQty: 0, coverDays, dailyAvg: 0, buffer: p.maxDaysBuffer || 2, nonZeroCount: 0, periodDays: q90.length } };
  }

  const pctQty = percentile(nonZeroQtys, pctValue);
  const dailyAvg = q90.reduce((a, b) => a + b, 0) / q90.length;
  const buffer = p.maxDaysBuffer || 2;

  const minQty = Math.ceil(pctQty * coverDays);
  const maxQty = Math.ceil(minQty + dailyAvg * buffer);

  return {
    minQty, maxQty,
    details: {
      pctUsed: pctValue,
      pctQty,
      coverDays,
      dailyAvg,
      buffer,
      nonZeroCount: nonZeroQtys.length,
      periodDays: q90.length,
    },
  };
}
```

- [ ] **Step 3: Modify fixedUnitFloorStrategy to return details**

In `src/engine/strategies/fixedUnitFloor.js`, replace lines 14–31 with:

```javascript
export function fixedUnitFloorStrategy(opts) {
  const { orderQtys, params: p } = opts;
  const config = p.fixedUnitFloor || {};
  const pctile = config.orderQtyPercentile ?? 90;
  const maxMult = config.maxMultiplier ?? 1.5;
  const maxAdd = config.maxAdditive ?? 1;

  if (!orderQtys || orderQtys.length === 0) {
    return null;
  }

  const sorted = [...orderQtys].sort((a, b) => a - b);
  const pctQty = percentile(sorted, pctile);
  const minQty = Math.ceil(pctQty);
  const maxQty = Math.ceil(Math.max(minQty + maxAdd, minQty * maxMult));

  return {
    minQty, maxQty,
    details: {
      pctile,
      pctQty,
      orderCount: orderQtys.length,
      maxMult,
      maxAdd,
    },
  };
}
```

- [ ] **Step 4: Verify app still builds**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build`
Expected: Build succeeds — strategies return extra property (`details`) that existing destructuring `{ minQty, maxQty }` safely ignores.

- [ ] **Step 5: Commit**

```bash
git add src/engine/strategies/
git commit -m "feat(engine): add computation details to all strategy return values"
```

---

## Task 2: Engine — Store Intermediates in Results

Modify `runEngine.js` to capture strategy details and post-blend adjustment audit trail in the results object.

**Files:**
- Modify: `src/engine/runEngine.js`

- [ ] **Step 1: Capture strategy details at dispatch point**

In `src/engine/runEngine.js`, replace lines 150–168 (strategy dispatch block) with:

```javascript
      let minQty, maxQty, strategyDetails = {};
      let strategyTag = strategy;

      if (strategy === "percentile_cover") {
        const r = percentileCoverStrategy({ q90, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
      } else if (strategy === "fixed_unit_floor") {
        const result = fixedUnitFloorStrategy({ orderQtys: collectOrderQtys(invSliced, skuId, dsId), params: p });
        if (result) {
          ({ minQty, maxQty } = result);
          strategyDetails = result.details || {};
        } else {
          const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
          ({ minQty, maxQty } = r);
          strategyDetails = r.details || {};
          strategyTag = "standard";
        }
      } else {
        const r = standardStrategy({ qLong, oLong, qRecent, oRecent, prTag, mvTag90, params: p });
        ({ minQty, maxQty } = r);
        strategyDetails = r.details || {};
        strategyTag = "standard";
      }
```

- [ ] **Step 2: Build post-blend audit trail**

After the strategy dispatch and before the existing post-blend adjustments (line 170), add a variable to track adjustments. Then modify the post-blend block (lines 170–200) to record each adjustment:

```javascript
      // ── Post-blend adjustments (strict order preserved) ────────────────
      let logicTag = "Base Logic";
      const postBlendSteps = [];
      const strategyMin = minQty, strategyMax = maxQty; // pre-adjustment snapshot

      // 1. New DS floor
      if (isNewDS && isEligible) {
        const floor = mrq[skuId] || 0;
        if (floor > minQty) {
          postBlendSteps.push({ rule: "New DS Floor", floor, beforeMin: minQty, beforeMax: maxQty });
          minQty = floor; maxQty = floor; logicTag = "New DS Floor";
        } else {
          maxQty = Math.max(maxQty, minQty);
        }
      }

      // 2. Brand buffer
      if (hasBuf) {
        const dohMin = s90.dailyAvg > 0 ? minQty / s90.dailyAvg : 0;
        const newMin = Math.ceil((dohMin + bufDays) * s90.dailyAvg);
        postBlendSteps.push({ rule: "Brand Buffer", bufDays, dohMin, beforeMin: minQty, beforeMax: maxQty });
        minQty = newMin;
        maxQty = minQty;
        logicTag = "Brand Buffer";
      }

      minQty = Math.ceil(minQty); maxQty = Math.ceil(Math.max(maxQty, minQty));
      if (isDead) maxQty = minQty; maxQty = Math.max(maxQty, minQty); if (isDead) maxQty = minQty;

      const preFloorMin = Math.round(minQty), preFloorMax = Math.round(maxQty);

      // 3. SKU Floors
      if (nsq && nsq[skuId]) {
        const fl = nsq[skuId][dsId];
        const fMin = !fl ? 0 : typeof fl === "number" ? fl : (fl.min || 0);
        const fMax = !fl ? 0 : typeof fl === "number" ? fl : (fl.max || fMin);
        if (fMin > minQty) {
          postBlendSteps.push({ rule: "SKU Floor", floorMin: fMin, floorMax: fMax, beforeMin: minQty, beforeMax: maxQty });
          minQty = fMin; maxQty = Math.max(fMax, maxQty); logicTag = "SKU Floor";
        }
      }
```

- [ ] **Step 3: Add strategyDetails and postBlendSteps to stores object**

Replace lines 202–208 (stores assignment) with:

```javascript
      stores[dsId] = {
        min: Math.round(minQty), max: Math.round(maxQty),
        preFloorMin, preFloorMax,
        dailyAvg: s90.dailyAvg, abq: s90.abq,
        mvTag: mvTag90, spTag: tags90[k].spTag,
        logicTag, strategyTag,
        strategyDetails,
        postBlendSteps,
        nonZeroDays: s90.nonZeroDays,
      };
```

- [ ] **Step 4: Add DC computation details to results**

Replace lines 222–239 (DC calculation) to also capture details:

```javascript
    const sumDailyAvg = dsDailyAvgs.reduce((a, b) => a + b, 0);
    const leadTime = (p.brandLeadTimeDays || {})[meta.brand] ?? (p.brandLeadTimeDays || {})._default ?? 2;

    let dcMin, dcMax, preFloorDcMin, preFloorDcMax, dcDetails;
    if (isDead) {
      dcMin = Math.round(sumMin * dcDeadMult.min);
      dcMax = Math.round(sumMax * dcDeadMult.max);
      preFloorDcMin = Math.round(sumPreFloorMin * dcDeadMult.min);
      preFloorDcMax = Math.round(sumPreFloorMax * dcDeadMult.max);
      dcDetails = { isDead: true, multMin: dcDeadMult.min, multMax: dcDeadMult.max, sumMin, sumMax, sumDailyAvg, leadTime };
    } else {
      const dcM = (p.dcMult || DC_MULT_DEFAULT)[dcStats.mvTag] || DC_MULT_DEFAULT[dcStats.mvTag];
      const leadTimeMin = Math.ceil(sumDailyAvg * leadTime);
      dcMin = Math.round(Math.max(leadTimeMin, sumMin * dcM.min));
      dcMax = Math.round(Math.max(Math.ceil(dcMin * (dcM.max / dcM.min)), sumMax * dcM.max));
      const preFloorLeadTimeMin = Math.ceil(sumDailyAvg * leadTime);
      preFloorDcMin = Math.round(Math.max(preFloorLeadTimeMin, sumPreFloorMin * dcM.min));
      preFloorDcMax = Math.round(Math.max(Math.ceil(preFloorDcMin * (dcM.max / dcM.min)), sumPreFloorMax * dcM.max));
      dcDetails = { isDead: false, multMin: dcM.min, multMax: dcM.max, sumMin, sumMax, sumDailyAvg, leadTime, leadTimeMin };
    }
```

Replace line 244 (dc assignment) with:

```javascript
      dc: { min: dcMin, max: dcMax, preFloorMin: preFloorDcMin, preFloorMax: preFloorDcMax, mvTag: dcStats.mvTag, nonZeroDays: dcStats.nonZeroDays, dcDetails },
```

- [ ] **Step 5: Verify app still builds**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build`
Expected: Build succeeds. Existing code reads `min`, `max`, `mvTag` etc. — new properties are additive.

- [ ] **Step 6: Commit**

```bash
git add src/engine/runEngine.js
git commit -m "feat(engine): expose strategy details and post-blend audit trail in results"
```

---

## Task 3: UI — Tab Definitions and State Management

Update tab names, add new state for Overview and SKU Detail, remove old Dashboard/Insights state.

**Files:**
- Modify: `src/App.jsx` (lines 2518-2553 for state, lines 2934-2936 for tab defs)

- [ ] **Step 1: Update tab definitions**

In `src/App.jsx`, replace the ADMIN_TABS and PUBLIC_TABS definitions (lines 2934-2936) with:

```javascript
const ADMIN_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["simulation","OOS Simulation"],["output","Tool Output Download"],["upload","Upload Data"],["logic","Logic Tweaker"],["overrides","Manual Overrides"]];
const PUBLIC_TABS=[["overview","Overview"],["skuDetail","SKU Detail"],["simulation","OOS Simulation"],["output","Tool Output Download"]];
const NAV_TABS=isAdmin?ADMIN_TABS:PUBLIC_TABS;
```

- [ ] **Step 2: Update default tab state and add Overview state**

Change the tab default (line 2518) from `"dashboard"` to `"overview"`:

```javascript
const [tab,setTab]=useState("overview"),[pendingTab,setPending]=useState(null);
```

Add new Overview state near lines 2524-2531 (after existing filter state):

```javascript
// Overview tab state
const [ovPeriod, setOvPeriod] = useState("L90D");
const [ovDateFrom, setOvDateFrom] = useState("");
const [ovDateTo, setOvDateTo] = useState("");
const [ovStore, setOvStore] = useState("All");
const [ovDrill, setOvDrill] = useState(null); // null | {type:"category"|"brand"|"sku", value, category?, brand?}
```

- [ ] **Step 3: Add SKU Detail state**

Add near the Insights state (lines 2548-2553), replacing or alongside:

```javascript
// SKU Detail tab state
const [sdSku, setSdSku] = useState(""); // currently loaded SKU ID
const [sdSearch, setSdSearch] = useState(""); // search input
const [sdPeriod, setSdPeriod] = useState("L90D");
const [sdDateFrom, setSdDateFrom] = useState("");
const [sdDateTo, setSdDateTo] = useState("");
const [sdDsView, setSdDsView] = useState("All");
```

- [ ] **Step 4: Add helper to compute date range from invoice data**

Add a useMemo near the other data hooks (around line 2560):

```javascript
const invoiceDateRange = useMemo(() => {
  if (!invoiceData || !invoiceData.length) return { min: "", max: "", dates: [] };
  const dates = [...new Set(invoiceData.map(r => r.date))].sort();
  return { min: dates[0], max: dates[dates.length - 1], dates };
}, [invoiceData]);
```

- [ ] **Step 5: Update triggerModel to set tab to "overview"**

In triggerModel (around line 2671-2694), change any `setTab("dashboard")` to `setTab("overview")`.

- [ ] **Step 6: Verify app still builds**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build`
Expected: Build succeeds. Tab content rendering will show nothing for "overview" and "skuDetail" yet (tabs exist but content isn't rendered), while old "dashboard"/"insights" content is now unreachable.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat(ui): update tab definitions and state for Overview + SKU Detail"
```

---

## Task 4: UI — Overview Tab

Build the Overview tab with KPI strip, period/store pickers, and Category→Brand→SKU drill-down.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Add Overview helper functions**

Add these helper functions before the main App component (near other helpers around line 756):

```javascript
/* ── Overview helpers ──────────────────────────────────────────────────── */
const OV_PERIODS = [
  { key: "L90D", label: "L90D", days: 90 },
  { key: "L60D", label: "L60D", days: 60 },
  { key: "L45D", label: "L45D", days: 45 },
  { key: "L30D", label: "L30D", days: 30 },
  { key: "L15D", label: "L15D", days: 15 },
  { key: "L7D",  label: "L7D",  days: 7 },
  { key: "CUSTOM", label: "Custom" },
];

function filterInvoiceByPeriod(invoiceData, periodKey, dateFrom, dateTo, invoiceDateRange) {
  if (!invoiceData || !invoiceData.length) return [];
  const allDates = invoiceDateRange.dates;
  if (periodKey === "CUSTOM" && dateFrom && dateTo) {
    return invoiceData.filter(r => r.date >= dateFrom && r.date <= dateTo);
  }
  const preset = OV_PERIODS.find(p => p.key === periodKey);
  if (preset && preset.days) {
    const last = allDates.slice(-preset.days);
    return invoiceData.filter(r => last.includes(r.date));
  }
  return invoiceData;
}

function computeOverviewAgg(filteredInv, results, priceData, storeFilter) {
  // Returns: Map<groupKey, { activeSKUs, skusSold, zeroSale, soldQty, soldValue, invMin, invMax, covMin, covMax }>
  const groups = {};
  const allSKUs = Object.keys(results);
  const periodDays = new Set(filteredInv.map(r => r.date)).size || 1;

  allSKUs.forEach(skuId => {
    const r = results[skuId];
    if (!r || !r.meta) return;
    const cat = r.meta.category || "Unknown";
    const brand = r.meta.brand || "Unknown";
    const price = parseFloat(priceData[skuId]) || 0;
    const key = cat; // caller can change grouping

    if (!groups[key]) groups[key] = { activeSKUs: 0, skusSold: 0, zeroSale: 0, soldQty: 0, soldValue: 0, invMin: 0, invMax: 0, dailySoldValue: 0 };
    const g = groups[key];

    if ((r.meta.status || "").toLowerCase() === "active") g.activeSKUs++;

    // Sold qty for this SKU in filtered period, optionally filtered by store
    const skuInv = storeFilter === "All"
      ? filteredInv.filter(row => row.sku === skuId)
      : filteredInv.filter(row => row.sku === skuId && row.ds === storeFilter);
    const qty = skuInv.reduce((a, row) => a + row.qty, 0);
    if (qty > 0) g.skusSold++;
    else if ((r.meta.status || "").toLowerCase() === "active") g.zeroSale++;
    g.soldQty += qty;
    g.soldValue += qty * price;

    // Inventory value
    if (storeFilter === "All") {
      DS_LIST.forEach(ds => {
        const st = r.stores[ds];
        if (st) { g.invMin += (st.min || 0) * price; g.invMax += (st.max || 0) * price; }
      });
    } else if (storeFilter === "DC") {
      g.invMin += (r.dc.min || 0) * price;
      g.invMax += (r.dc.max || 0) * price;
    } else {
      const st = r.stores[storeFilter];
      if (st) { g.invMin += (st.min || 0) * price; g.invMax += (st.max || 0) * price; }
    }
  });

  // Compute days coverage
  Object.values(groups).forEach(g => {
    const dailySold = g.soldValue / periodDays;
    g.covMin = dailySold > 0 ? g.invMin / dailySold : null;
    g.covMax = dailySold > 0 ? g.invMax / dailySold : null;
  });

  return groups;
}

function fmtVal(v) {
  if (v == null || isNaN(v)) return "–";
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1) + "L";
  if (v >= 1000) return "₹" + (v / 1000).toFixed(1) + "K";
  return "₹" + Math.round(v);
}

function fmtCov(v) {
  if (v == null) return "No Sale";
  return v.toFixed(1) + "D";
}
```

- [ ] **Step 2: Build the OverviewTab component**

Add this component after the helpers (before the App component). This is the full component with KPI strip, pickers, and drill-down:

```javascript
function OverviewTab({ invoiceData, results, priceData, params, invoiceDateRange,
  period, setPeriod, dateFrom, setDateFrom, dateTo, setDateTo,
  store, setStore, drill, setDrill, onNavigateToSKU }) {

  const filteredInv = useMemo(() =>
    filterInvoiceByPeriod(invoiceData, period, dateFrom, dateTo, invoiceDateRange),
    [invoiceData, period, dateFrom, dateTo, invoiceDateRange]);

  const periodDays = useMemo(() => new Set(filteredInv.map(r => r.date)).size, [filteredInv]);

  // KPI-level totals (always org-wide for Active SKUs, Inv; period-filtered for Sold/Zero)
  const kpis = useMemo(() => {
    let activeSKUs = 0, skusSold = 0, zeroSale = 0, invMin = 0, invMax = 0;
    Object.entries(results).forEach(([skuId, r]) => {
      if (!r || !r.meta) return;
      const isActive = (r.meta.status || "").toLowerCase() === "active";
      if (isActive) activeSKUs++;
      const price = parseFloat(priceData[skuId]) || 0;
      const qty = filteredInv.filter(row => row.sku === skuId).reduce((a, row) => a + row.qty, 0);
      if (qty > 0) skusSold++;
      else if (isActive) zeroSale++;
      DS_LIST.forEach(ds => {
        const st = r.stores[ds];
        if (st) { invMin += (st.min || 0) * price; invMax += (st.max || 0) * price; }
      });
    });
    return { activeSKUs, skusSold, zeroSale, invMin, invMax };
  }, [results, filteredInv, priceData]);

  // Aggregated data based on drill level
  const tableData = useMemo(() => {
    const allSKUs = Object.keys(results);
    const rows = [];
    const pDays = periodDays || 1;

    if (!drill) {
      // Category level
      const catMap = {};
      allSKUs.forEach(skuId => {
        const r = results[skuId];
        if (!r || !r.meta) return;
        const cat = r.meta.category || "Unknown";
        if (!catMap[cat]) catMap[cat] = { key: cat, activeSKUs: 0, skusSold: 0, zeroSale: 0, soldQty: 0, soldValue: 0, invMin: 0, invMax: 0 };
        const g = catMap[cat];
        const isActive = (r.meta.status || "").toLowerCase() === "active";
        if (isActive) g.activeSKUs++;
        const price = parseFloat(priceData[skuId]) || 0;
        const skuInv = store === "All" ? filteredInv.filter(row => row.sku === skuId) : filteredInv.filter(row => row.sku === skuId && row.ds === store);
        const qty = skuInv.reduce((a, row) => a + row.qty, 0);
        if (qty > 0) g.skusSold++; else if (isActive) g.zeroSale++;
        g.soldQty += qty;
        g.soldValue += qty * price;
        if (store === "All") {
          DS_LIST.forEach(ds => { const st = r.stores[ds]; if (st) { g.invMin += (st.min || 0) * price; g.invMax += (st.max || 0) * price; } });
        } else if (store === "DC") {
          g.invMin += (r.dc.min || 0) * price; g.invMax += (r.dc.max || 0) * price;
        } else {
          const st = r.stores[store]; if (st) { g.invMin += (st.min || 0) * price; g.invMax += (st.max || 0) * price; }
        }
      });
      Object.values(catMap).forEach(g => {
        const ds = g.soldValue / pDays;
        g.covMin = ds > 0 ? g.invMin / ds : null;
        g.covMax = ds > 0 ? g.invMax / ds : null;
        rows.push(g);
      });
    } else if (drill.type === "category") {
      // Brand level within category
      const brandMap = {};
      allSKUs.forEach(skuId => {
        const r = results[skuId];
        if (!r || !r.meta || r.meta.category !== drill.value) return;
        const brand = r.meta.brand || "Unknown";
        if (!brandMap[brand]) brandMap[brand] = { key: brand, activeSKUs: 0, skusSold: 0, zeroSale: 0, soldQty: 0, soldValue: 0, invMin: 0, invMax: 0 };
        const g = brandMap[brand];
        const isActive = (r.meta.status || "").toLowerCase() === "active";
        if (isActive) g.activeSKUs++;
        const price = parseFloat(priceData[skuId]) || 0;
        const skuInv = store === "All" ? filteredInv.filter(row => row.sku === skuId) : filteredInv.filter(row => row.sku === skuId && row.ds === store);
        const qty = skuInv.reduce((a, row) => a + row.qty, 0);
        if (qty > 0) g.skusSold++; else if (isActive) g.zeroSale++;
        g.soldQty += qty;
        g.soldValue += qty * price;
        if (store === "All") {
          DS_LIST.forEach(ds => { const st = r.stores[ds]; if (st) { g.invMin += (st.min || 0) * price; g.invMax += (st.max || 0) * price; } });
        } else if (store === "DC") {
          g.invMin += (r.dc.min || 0) * price; g.invMax += (r.dc.max || 0) * price;
        } else {
          const st = r.stores[store]; if (st) { g.invMin += (st.min || 0) * price; g.invMax += (st.max || 0) * price; }
        }
      });
      Object.values(brandMap).forEach(g => {
        const ds = g.soldValue / pDays;
        g.covMin = ds > 0 ? g.invMin / ds : null;
        g.covMax = ds > 0 ? g.invMax / ds : null;
        rows.push(g);
      });
    } else if (drill.type === "brand") {
      // SKU level within brand
      allSKUs.forEach(skuId => {
        const r = results[skuId];
        if (!r || !r.meta || r.meta.category !== drill.category || r.meta.brand !== drill.value) return;
        const price = parseFloat(priceData[skuId]) || 0;
        const skuInv = store === "All" ? filteredInv.filter(row => row.sku === skuId) : filteredInv.filter(row => row.sku === skuId && row.ds === store);
        const qty = skuInv.reduce((a, row) => a + row.qty, 0);
        const soldValue = qty * price;
        let invMin = 0, invMax = 0;
        if (store === "All") {
          DS_LIST.forEach(ds => { const st = r.stores[ds]; if (st) { invMin += (st.min || 0) * price; invMax += (st.max || 0) * price; } });
        } else if (store === "DC") {
          invMin = (r.dc.min || 0) * price; invMax = (r.dc.max || 0) * price;
        } else {
          const st = r.stores[store]; if (st) { invMin = (st.min || 0) * price; invMax = (st.max || 0) * price; }
        }
        const ds2 = soldValue / pDays;
        // Per-store breakdown
        const perStore = {};
        DS_LIST.forEach(ds => { const st = r.stores[ds]; perStore[ds] = st ? { min: st.min, max: st.max } : { min: 0, max: 0 }; });
        perStore.DC = { min: r.dc.min || 0, max: r.dc.max || 0 };
        rows.push({
          key: skuId, name: r.meta.name, sku: skuId,
          mvTag: store === "All" ? (r.stores.DS01 || {}).mvTag : store === "DC" ? r.dc.mvTag : (r.stores[store] || {}).mvTag,
          priceTag: r.meta.priceTag,
          dailyAvg: store === "All"
            ? DS_LIST.reduce((s, ds) => s + ((r.stores[ds] || {}).dailyAvg || 0), 0)
            : store === "DC" ? null : ((r.stores[store] || {}).dailyAvg || 0),
          abq: store === "All"
            ? DS_LIST.reduce((s, ds) => s + ((r.stores[ds] || {}).abq || 0), 0) / DS_LIST.length
            : store === "DC" ? null : ((r.stores[store] || {}).abq || 0),
          soldQty: qty, soldValue, invMin, invMax,
          covMin: ds2 > 0 ? invMin / ds2 : null,
          covMax: ds2 > 0 ? invMax / ds2 : null,
          perStore,
        });
      });
    }

    rows.sort((a, b) => (b.invMax || 0) - (a.invMax || 0));
    return rows;
  }, [results, priceData, filteredInv, store, drill, periodDays]);

  const isSKULevel = drill && drill.type === "brand";
  const breadcrumb = [];
  if (drill) {
    breadcrumb.push({ label: "All Categories", action: () => setDrill(null) });
    if (drill.type === "category") breadcrumb.push({ label: drill.value, action: null });
    if (drill.type === "brand") {
      breadcrumb.push({ label: drill.category, action: () => setDrill({ type: "category", value: drill.category }) });
      breadcrumb.push({ label: drill.value, action: null });
    }
  }

  const handleRowClick = (row) => {
    if (!drill) setDrill({ type: "category", value: row.key });
    else if (drill.type === "category") setDrill({ type: "brand", value: row.key, category: drill.value });
    else if (drill.type === "brand" && onNavigateToSKU) onNavigateToSKU(row.sku);
  };

  const handleBack = () => {
    if (!drill) return;
    if (drill.type === "category") setDrill(null);
    if (drill.type === "brand") setDrill({ type: "category", value: drill.category });
  };

  return (
    <div>
      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Active SKUs", value: kpis.activeSKUs, color: HR.yellowDark },
          { label: "SKUs Sold", value: kpis.skusSold, color: HR.green },
          { label: "Zero Sale SKUs", value: kpis.zeroSale, color: "#C0392B" },
          { label: "Inv Value Min", value: fmtVal(kpis.invMin), color: HR.yellowDark },
          { label: "Inv Value Max", value: fmtVal(kpis.invMax), color: HR.yellowDark },
        ].map(c => (
          <div key={c.label} style={{ background: HR.surface, borderRadius: 8, padding: "12px 14px", border: `1px solid ${HR.border}` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 11, color: HR.muted, marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Period picker + Store picker */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {OV_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)} style={S.btn(period === p.key)}>{p.label}</button>
        ))}
        <span style={{ fontSize: 10, color: HR.muted, margin: "0 4px" }}>|</span>
        <input type="date" value={dateFrom} min={invoiceDateRange.min} max={invoiceDateRange.max}
          onChange={e => { setDateFrom(e.target.value); setPeriod("CUSTOM"); }}
          style={{ ...S.input, fontSize: 10, padding: "3px 6px" }} />
        <span style={{ fontSize: 10, color: HR.muted }}>→</span>
        <input type="date" value={dateTo} min={invoiceDateRange.min} max={invoiceDateRange.max}
          onChange={e => { setDateTo(e.target.value); setPeriod("CUSTOM"); }}
          style={{ ...S.input, fontSize: 10, padding: "3px 6px" }} />
        <span style={{ fontSize: 10, color: HR.muted, marginLeft: 4 }}>
          Data: {invoiceDateRange.min ? new Date(invoiceDateRange.min).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }) : "–"} → {invoiceDateRange.max ? new Date(invoiceDateRange.max).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }) : "–"}
        </span>
        <span style={{ fontSize: 10, color: HR.muted, margin: "0 4px" }}>|</span>
        <select value={store} onChange={e => setStore(e.target.value)}
          style={{ ...S.input, fontSize: 11, padding: "4px 8px" }}>
          <option value="All">All Stores</option>
          {DS_LIST.map(ds => <option key={ds} value={ds}>{ds}</option>)}
          <option value="DC">DC</option>
        </select>
        {periodDays > 0 && <span style={{ fontSize: 10, color: HR.muted }}>({periodDays} days)</span>}
      </div>

      {/* Breadcrumb + Back */}
      {drill && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <button onClick={handleBack} style={{ ...S.btn(false), display: "flex", alignItems: "center", gap: 4 }}>
            ← Back
          </button>
          {breadcrumb.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: HR.muted, fontSize: 11 }}>›</span>}
              {b.action
                ? <span onClick={b.action} style={{ fontSize: 12, color: HR.yellowDark, cursor: "pointer", fontWeight: 600 }}>{b.label}</span>
                : <span style={{ fontSize: 12, color: HR.text, fontWeight: 700 }}>{b.label}</span>}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* Table */}
      <div style={{ ...S.card, padding: 0, overflow: "auto" }}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>{!drill ? "Category" : drill.type === "category" ? "Brand" : "SKU"}</th>
              {isSKULevel && <><th style={S.th}>Movement</th><th style={S.th}>Price</th><th style={S.th}>Daily Avg</th><th style={S.th}>ABQ</th></>}
              {!isSKULevel && <><th style={S.th}>Active SKUs</th><th style={S.th}>SKUs Sold</th><th style={S.th}>Zero Sale</th></>}
              <th style={{ ...S.th, textAlign: "right" }}>Sold Qty</th>
              <th style={{ ...S.th, textAlign: "right" }}>Sold Value</th>
              <th style={{ ...S.th, textAlign: "right" }}>Inv Min</th>
              <th style={{ ...S.th, textAlign: "right" }}>Inv Max</th>
              <th style={{ ...S.th, textAlign: "right" }}>Cov Min</th>
              <th style={{ ...S.th, textAlign: "right" }}>Cov Max</th>
            </tr>
          </thead>
          <tbody>
            {tableData.map(row => (
              <React.Fragment key={row.key}>
                <tr onClick={() => handleRowClick(row)}
                  style={{ cursor: "pointer", transition: "background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
                  onMouseLeave={e => e.currentTarget.style.background = ""}>
                  <td style={S.td}>
                    {isSKULevel ? <><div style={{ fontWeight: 600, fontSize: 11 }}>{row.name}</div><div style={{ fontSize: 9, color: HR.muted }}>{row.sku}</div></> : <span style={{ fontWeight: 600 }}>{row.key}</span>}
                  </td>
                  {isSKULevel && <>
                    <td style={S.td}><MovTag value={row.mvTag} /></td>
                    <td style={S.td}><TagPill value={row.priceTag} colorMap={PRICE_TAG_COLORS} /></td>
                    <td style={{ ...S.td, textAlign: "right", fontSize: 10 }}>{row.dailyAvg != null ? row.dailyAvg.toFixed(2) : "–"}</td>
                    <td style={{ ...S.td, textAlign: "right", fontSize: 10 }}>{row.abq != null ? row.abq.toFixed(2) : "–"}</td>
                  </>}
                  {!isSKULevel && <>
                    <td style={{ ...S.td, textAlign: "right" }}>{row.activeSKUs}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{row.skusSold}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>{row.zeroSale}</td>
                  </>}
                  <td style={{ ...S.td, textAlign: "right" }}>{row.soldQty.toLocaleString()}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{fmtVal(row.soldValue)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{fmtVal(row.invMin)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{fmtVal(row.invMax)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{fmtCov(row.covMin)}</td>
                  <td style={{ ...S.td, textAlign: "right" }}>{fmtCov(row.covMax)}</td>
                </tr>
                {/* Per-store breakdown at SKU level */}
                {isSKULevel && row.perStore && (
                  <tr>
                    <td colSpan={10} style={{ ...S.td, padding: "4px 8px 8px 24px", background: HR.surfaceLight }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {DS_LIST.map((ds, i) => (
                          <span key={ds} style={{ fontSize: 9, color: DS_COLORS[i].text, background: DS_COLORS[i].bg, padding: "2px 6px", borderRadius: 4 }}>
                            {ds}: {row.perStore[ds].min}/{row.perStore[ds].max}
                          </span>
                        ))}
                        <span style={{ fontSize: 9, color: DC_COLOR.text, background: DC_COLOR.bg, padding: "2px 6px", borderRadius: 4 }}>
                          DC: {row.perStore.DC.min}/{row.perStore.DC.max}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {tableData.length === 0 && (
              <tr><td colSpan={10} style={{ ...S.td, textAlign: "center", color: HR.muted, padding: 24 }}>No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire OverviewTab into tab rendering**

In the tab content rendering section (around line 3200), add the Overview tab rendering. Find where `{tab==="dashboard"&&(` begins and add before it:

```javascript
{tab==="overview"&&(
  <OverviewTab
    invoiceData={invoiceData} results={results} priceData={priceData} params={params}
    invoiceDateRange={invoiceDateRange}
    period={ovPeriod} setPeriod={setOvPeriod}
    dateFrom={ovDateFrom} setDateFrom={setOvDateFrom}
    dateTo={ovDateTo} setDateTo={setOvDateTo}
    store={ovStore} setStore={setOvStore}
    drill={ovDrill} setDrill={setOvDrill}
    onNavigateToSKU={(skuId) => { setSdSku(skuId); setSdSearch(skuId); setTab("skuDetail"); }}
  />
)}
```

- [ ] **Step 4: Test locally**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run dev`
Expected: Open browser, see "Overview" tab. KPI strip shows. Period presets work. Store picker works. Category rows render with correct aggregated data. Click category → brand level. Click brand → SKU level with per-store breakdown. Click SKU → navigates to SKU Detail (empty for now).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat(ui): add Overview tab with category→brand→SKU drill-down"
```

---

## Task 5: UI — SKU Detail Tab (Search + Controls + Computation Cards)

Build the SKU Detail tab with search, period/DS pickers, and detailed per-DS computation cards.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Add SKU Detail period constants**

Add near the OV_PERIODS definition:

```javascript
const SD_PERIODS = [
  { key: "L90D", label: "L90D", days: 90 },
  { key: "L60D", label: "L60D", days: 60 },
  { key: "L45D", label: "L45D", days: 45 },
  { key: "L30D", label: "L30D", days: 30 },
  { key: "L15D", label: "L15D", days: 15 },
  { key: "L7D",  label: "L7D",  days: 7 },
  { key: "CUSTOM", label: "Custom" },
];
const SD_DS_OPTS = ["All", "DS01", "DS02", "DS03", "DS04", "DS05"];
```

- [ ] **Step 2: Add the StrategyCard helper component**

This renders the per-DS detailed computation card. Add after the OV helpers:

```javascript
function StrategyCard({ dsId, dsIndex, storeData, meta, params }) {
  if (!storeData) return null;
  const { min, max, mvTag, spTag, dailyAvg, abq, strategyTag, strategyDetails: d, postBlendSteps, logicTag, nonZeroDays } = storeData;
  const dsColor = dsIndex != null ? DS_COLORS[dsIndex] : DC_COLOR;
  const op = params.overallPeriod || 90;

  return (
    <div style={{ background: dsColor.bg, borderRadius: 10, border: `1.5px solid ${dsColor.header}33`, padding: 16, minWidth: 220 }}>
      {/* Header */}
      <div style={{ fontWeight: 800, fontSize: 14, color: dsColor.header, marginBottom: 8 }}>{dsId}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <MovTag value={mvTag} />
        <TagPill value={meta.priceTag} colorMap={PRICE_TAG_COLORS} />
        {spTag && spTag !== "No Spike" && <span style={{ ...TAG_STYLE, background: "#FEF3C7", color: "#92400E", border: "1px solid #FDE68A" }}>{spTag}</span>}
      </div>

      {/* Final Min/Max prominent */}
      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <div><div style={{ fontSize: 9, color: dsColor.text, opacity: 0.7 }}>Final Min</div><div style={{ fontSize: 22, fontWeight: 800, color: dsColor.header }}>{min}</div></div>
        <div><div style={{ fontSize: 9, color: dsColor.text, opacity: 0.7 }}>Final Max</div><div style={{ fontSize: 22, fontWeight: 800, color: dsColor.header }}>{max}</div></div>
      </div>

      {/* Strategy computation breakdown */}
      <div style={{ fontSize: 10, color: dsColor.text, lineHeight: 1.6 }}>
        {strategyTag === "standard" && d && d.sLong && <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Standard Strategy</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>Long Period ({d.longDays}D)</div>
          <div>Daily Avg: {d.sLong.dailyAvg.toFixed(2)} · NZD: {d.sLong.nonZeroDays} · Spike Med: {d.sLong.spikeMedian.toFixed(1)}</div>
          <div>Min: {d.rLong.minQty} · Max: {d.rLong.maxQty}</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>Recent Period ({d.recentDays}D)</div>
          <div>Daily Avg: {d.sRecent.dailyAvg.toFixed(2)} · NZD: {d.sRecent.nonZeroDays} · Spike Med: {d.sRecent.spikeMedian.toFixed(1)}</div>
          <div>Min: {d.rRecent.minQty} · Max: {d.rRecent.maxQty}</div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>Blending</div>
          <div>Recency Weight ({mvTag}): {d.wt}×</div>
          <div>Blended: Min {d.blendedMin} · Max {d.blendedMax}</div>
        </>}

        {strategyTag === "percentile_cover" && d && <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Percentile Cover Strategy</div>
          <div>Full Period: {d.periodDays}D · Non-Zero Days: {d.nonZeroCount}</div>
          <div>Price ({meta.priceTag}) → P{d.pctUsed}</div>
          <div>P{d.pctUsed} of non-zero daily qty: {d.pctQty.toFixed(2)}</div>
          <div>Movement ({mvTag}) → Cover: {d.coverDays}D</div>
          <div>Min = ⌈{d.pctQty.toFixed(2)} × {d.coverDays}⌉ = {Math.ceil(d.pctQty * d.coverDays)}</div>
          <div>Max = ⌈Min + {d.dailyAvg.toFixed(2)} avg × {d.buffer} buffer⌉ = {Math.ceil(Math.ceil(d.pctQty * d.coverDays) + d.dailyAvg * d.buffer)}</div>
        </>}

        {strategyTag === "fixed_unit_floor" && d && <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Fixed Unit Floor Strategy</div>
          <div>Orders in period: {d.orderCount}</div>
          <div>P{d.pctile} of order quantities: {d.pctQty.toFixed(2)}</div>
          <div>Min = ⌈{d.pctQty.toFixed(2)}⌉ = {Math.ceil(d.pctQty)}</div>
          <div>Max = ⌈max({Math.ceil(d.pctQty)}+{d.maxAdd}, {Math.ceil(d.pctQty)}×{d.maxMult})⌉ = {Math.ceil(Math.max(Math.ceil(d.pctQty) + d.maxAdd, Math.ceil(d.pctQty) * d.maxMult))}</div>
        </>}

        {/* Post-blend adjustments */}
        {postBlendSteps && postBlendSteps.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${dsColor.header}22` }}>
            <div style={{ fontWeight: 600 }}>Adjustments Applied</div>
            {postBlendSteps.map((step, i) => (
              <div key={i} style={{ marginTop: 2 }}>
                {step.rule === "New DS Floor" && <span>New DS Floor: floor {step.floor} {">"} computed {step.beforeMin} → Min=Max={step.floor}</span>}
                {step.rule === "Brand Buffer" && <span>Brand Buffer: +{step.bufDays}D (DOH {step.dohMin.toFixed(1)}D + {step.bufDays}D) × avg → Min=Max={min}</span>}
                {step.rule === "SKU Floor" && <span>SKU Floor: floor Min {step.floorMin}/Max {step.floorMax} {">"} computed {step.beforeMin}/{step.beforeMax}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Logic tag */}
        {logicTag && logicTag !== "Base Logic" && (
          <div style={{ marginTop: 6 }}>
            <span style={{ ...TAG_STYLE, ...(LOGIC_TAG_STYLES[logicTag] || {}), background: (LOGIC_TAG_STYLES[logicTag] || {}).bg, color: (LOGIC_TAG_STYLES[logicTag] || {}).color, border: `1px solid ${(LOGIC_TAG_STYLES[logicTag] || {}).border}` }}>{logicTag}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DCCard({ dcData, meta, params }) {
  if (!dcData) return null;
  const { min, max, mvTag, nonZeroDays, dcDetails: d } = dcData;

  return (
    <div style={{ background: DC_COLOR.bg, borderRadius: 10, border: `1.5px solid ${DC_COLOR.header}33`, padding: 16, minWidth: 220 }}>
      <div style={{ fontWeight: 800, fontSize: 14, color: DC_COLOR.header, marginBottom: 8 }}>DC</div>
      <div style={{ marginBottom: 10 }}><MovTag value={mvTag} /></div>

      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
        <div><div style={{ fontSize: 9, color: DC_COLOR.text, opacity: 0.7 }}>Final Min</div><div style={{ fontSize: 22, fontWeight: 800, color: DC_COLOR.header }}>{min}</div></div>
        <div><div style={{ fontSize: 9, color: DC_COLOR.text, opacity: 0.7 }}>Final Max</div><div style={{ fontSize: 22, fontWeight: 800, color: DC_COLOR.header }}>{max}</div></div>
      </div>

      {d && (
        <div style={{ fontSize: 10, color: DC_COLOR.text, lineHeight: 1.6 }}>
          <div>Non-Zero Days: {nonZeroDays}</div>
          <div>Sum DS Mins: {d.sumMin} · Sum DS Maxes: {d.sumMax}</div>
          <div>Sum Daily Avg: {d.sumDailyAvg.toFixed(2)}</div>
          <div>Brand Lead Time: {d.leadTime}D</div>
          {d.isDead ? (
            <div>Dead Stock Mult: {d.multMin}/{d.multMax}</div>
          ) : (<>
            <div>DC Mult ({mvTag}): {d.multMin}/{d.multMax}</div>
            <div>Lead Time Min = ⌈{d.sumDailyAvg.toFixed(2)} × {d.leadTime}⌉ = {d.leadTimeMin}</div>
            <div>DC Min = max(leadTimeMin {d.leadTimeMin}, sumDSMin {d.sumMin} × {d.multMin}) = {min}</div>
            <div>DC Max = max(⌈{min} × {(d.multMax / d.multMin).toFixed(2)}⌉, {d.sumMax} × {d.multMax}) = {max}</div>
          </>)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build the SKUDetailTab component**

```javascript
function SKUDetailTab({ invoiceData, skuMaster, results, params, invoiceDateRange,
  skuId, setSkuId, searchVal, setSearchVal,
  period, setPeriod, dateFrom, setDateFrom, dateTo, setDateTo,
  dsView, setDsView }) {

  const [searchResults, setSearchResults] = useState([]);
  const searchRef = useRef(null);

  const handleSearch = (val) => {
    setSearchVal(val);
    if (!val || val.length < 2) { setSearchResults([]); return; }
    const lower = val.toLowerCase();
    const matches = Object.values(skuMaster).filter(s =>
      s.sku.toLowerCase().includes(lower) || (s.name || "").toLowerCase().includes(lower)
    ).slice(0, 8);
    setSearchResults(matches);
  };

  const selectSKU = (sku) => {
    setSkuId(sku);
    setSearchVal(sku);
    setSearchResults([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && searchVal) {
      // Try exact match first, then partial
      const exact = Object.values(skuMaster).find(s => s.sku === searchVal);
      if (exact) { selectSKU(exact.sku); return; }
      const partial = Object.values(skuMaster).find(s =>
        s.sku.toLowerCase().includes(searchVal.toLowerCase()) || (s.name || "").toLowerCase().includes(searchVal.toLowerCase())
      );
      if (partial) selectSKU(partial.sku);
    }
  };

  const r = skuId ? results[skuId] : null;

  // Filter invoice data by period for charts
  const chartInv = useMemo(() => {
    if (!invoiceData || !invoiceData.length) return [];
    return filterInvoiceByPeriod(invoiceData, period, dateFrom, dateTo, invoiceDateRange);
  }, [invoiceData, period, dateFrom, dateTo, invoiceDateRange]);

  // Frequency data for selected SKU
  const freqData = useMemo(() => {
    if (!skuId) return {};
    const freq = {};
    const rows = dsView === "All"
      ? chartInv.filter(row => row.sku === skuId)
      : chartInv.filter(row => row.sku === skuId && row.ds === dsView);
    rows.forEach(row => { freq[row.qty] = (freq[row.qty] || 0) + 1; });
    return freq;
  }, [chartInv, skuId, dsView]);

  // Date-level data for selected SKU
  const dateData = useMemo(() => {
    if (!skuId) return [];
    const rows = dsView === "All"
      ? chartInv.filter(row => row.sku === skuId)
      : chartInv.filter(row => row.sku === skuId && row.ds === dsView);
    const byDate = {};
    rows.forEach(row => { byDate[row.date] = (byDate[row.date] || 0) + row.qty; });
    const allDates = [...new Set(chartInv.map(row => row.date))].sort();
    return allDates.map(d => ({ date: d, qty: byDate[d] || 0 }));
  }, [chartInv, skuId, dsView]);

  // Stats for header
  const stats = useMemo(() => {
    if (!skuId) return null;
    const rows = dsView === "All"
      ? chartInv.filter(row => row.sku === skuId)
      : chartInv.filter(row => row.sku === skuId && row.ds === dsView);
    return aggStats(rows);
  }, [chartInv, skuId, dsView]);

  return (
    <div>
      {/* Search bar */}
      <div style={{ position: "relative", maxWidth: 500, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={searchRef}
            value={searchVal} onChange={e => handleSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter SKU ID or name..."
            style={{ ...S.input, flex: 1, fontSize: 13 }}
          />
          <button onClick={() => { if (searchVal) handleKeyDown({ key: "Enter" }); }}
            style={S.btn(true)}>Search</button>
        </div>
        {searchResults.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: HR.white,
            border: `1px solid ${HR.border}`, borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: 20, marginTop: 2 }}>
            {searchResults.map(s => (
              <div key={s.sku} onClick={() => selectSKU(s.sku)}
                style={{ padding: "8px 12px", cursor: "pointer", fontSize: 11, borderBottom: `1px solid ${HR.border}` }}
                onMouseEnter={e => e.currentTarget.style.background = HR.surfaceLight}
                onMouseLeave={e => e.currentTarget.style.background = ""}>
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div style={{ fontSize: 9, color: HR.muted }}>{s.sku}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!r && skuId && <div style={{ color: HR.muted, textAlign: "center", padding: 40 }}>SKU not found in results</div>}
      {!skuId && <div style={{ color: HR.muted, textAlign: "center", padding: 40 }}>Enter a SKU ID or name to see details</div>}

      {r && (<>
        {/* SKU header */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: HR.text }}>{r.meta.name}</div>
          <div style={{ fontSize: 11, color: HR.muted }}>{r.meta.sku} · {r.meta.category} · {r.meta.brand}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <TagPill value={r.meta.priceTag} colorMap={PRICE_TAG_COLORS} />
            <TagPill value={r.meta.t150Tag} colorMap={TOPN_TAG_COLORS} />
          </div>
        </div>

        {/* Period + DS pickers */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
          {SD_PERIODS.filter(p => p.key !== "CUSTOM").map(p => (
            <button key={p.key} onClick={() => setPeriod(p.key)} style={S.btn(period === p.key)}>{p.label}</button>
          ))}
          <span style={{ fontSize: 10, color: HR.muted }}>|</span>
          <input type="date" value={dateFrom} min={invoiceDateRange.min} max={invoiceDateRange.max}
            onChange={e => { setDateFrom(e.target.value); setPeriod("CUSTOM"); }}
            style={{ ...S.input, fontSize: 10, padding: "3px 6px" }} />
          <span style={{ fontSize: 10, color: HR.muted }}>→</span>
          <input type="date" value={dateTo} min={invoiceDateRange.min} max={invoiceDateRange.max}
            onChange={e => { setDateTo(e.target.value); setPeriod("CUSTOM"); }}
            style={{ ...S.input, fontSize: 10, padding: "3px 6px" }} />
          <span style={{ fontSize: 10, color: HR.muted }}>|</span>
          {SD_DS_OPTS.map(ds => (
            <button key={ds} onClick={() => setDsView(ds)} style={S.btn(dsView === ds)}>{ds}</button>
          ))}
        </div>

        {/* Stats strip */}
        {stats && (
          <StatStrip items={[
            { label: "Instances", value: stats.totalOrders },
            { label: "Qty Sold", value: stats.totalQty },
            { label: "Avg Order Qty", value: stats.avgOrderQty.toFixed(2) },
            { label: "Unique SKUs", value: stats.skuCount },
          ]} />
        )}

        {/* DS Computation Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
          {dsView === "All"
            ? DS_LIST.map((ds, i) => <StrategyCard key={ds} dsId={ds} dsIndex={i} storeData={r.stores[ds]} meta={r.meta} params={params} />)
            : <StrategyCard dsId={dsView} dsIndex={DS_LIST.indexOf(dsView)} storeData={r.stores[dsView]} meta={r.meta} params={params} />
          }
          <DCCard dcData={r.dc} meta={r.meta} params={params} />
        </div>

        {/* Two charts side by side */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          {/* Chart 1: Order Qty Frequency */}
          <div style={{ ...S.card }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8, color: HR.text }}>Order Qty Frequency</div>
            <SingleFreqChart freq={freqData} ds={dsView === "All" ? "All" : dsView} />
          </div>
          {/* Chart 2: Date-Level Orders */}
          <div style={{ ...S.card }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8, color: HR.text }}>Daily Order Qty</div>
            <DateOrderChart data={dateData} dsView={dsView} />
          </div>
        </div>
      </>)}
    </div>
  );
}
```

- [ ] **Step 4: Add the DateOrderChart component**

Add near the SingleFreqChart component (around line 226):

```javascript
const DateOrderChart = ({ data, dsView }) => {
  if (!data || data.length === 0) return <div style={{ color: HR.muted, fontSize: 10, textAlign: "center", padding: 20 }}>No data</div>;
  const maxQty = Math.max(...data.map(d => d.qty), 1);
  const W = 500, H = 160, PAD_L = 35, PAD_B = 30, PAD_T = 10, PAD_R = 10;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const barW = Math.max(2, Math.min(12, (plotW - data.length) / data.length));
  const dsIdx = DS_LIST.indexOf(dsView);
  const barColor = dsIdx >= 0 ? DS_COLORS[dsIdx].header : HR.yellowDark;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
      {/* Y-axis labels */}
      {[0, 0.5, 1].map(f => {
        const val = Math.round(maxQty * f);
        const y = PAD_T + plotH * (1 - f);
        return <g key={f}>
          <text x={PAD_L - 4} y={y + 3} textAnchor="end" fontSize="8" fill={HR.muted}>{val}</text>
          <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke={HR.border} strokeWidth="0.5" />
        </g>;
      })}
      {/* Bars */}
      {data.map((d, i) => {
        const x = PAD_L + (plotW / data.length) * i + (plotW / data.length - barW) / 2;
        const h = d.qty > 0 ? Math.max(1, (d.qty / maxQty) * plotH) : 0;
        const y = PAD_T + plotH - h;
        return <g key={i}>
          <rect x={x} y={y} width={barW} height={h} fill={barColor} rx={1} opacity={0.85} />
          {data.length <= 30 && (
            <text x={x + barW / 2} y={H - PAD_B + 10} textAnchor="middle" fontSize="6" fill={HR.muted}
              transform={`rotate(-45, ${x + barW / 2}, ${H - PAD_B + 10})`}>
              {d.date.slice(5)}
            </text>
          )}
        </g>;
      })}
      {data.length > 30 && (
        <>
          <text x={PAD_L} y={H - 4} fontSize="7" fill={HR.muted}>{data[0].date.slice(5)}</text>
          <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="7" fill={HR.muted}>{data[data.length - 1].date.slice(5)}</text>
        </>
      )}
    </svg>
  );
};
```

- [ ] **Step 5: Wire SKUDetailTab into tab rendering**

In the tab content rendering section, add:

```javascript
{tab==="skuDetail"&&(
  <SKUDetailTab
    invoiceData={invoiceData} skuMaster={skuMaster} results={results} params={params}
    invoiceDateRange={invoiceDateRange}
    skuId={sdSku} setSkuId={setSdSku}
    searchVal={sdSearch} setSearchVal={setSdSearch}
    period={sdPeriod} setPeriod={setSdPeriod}
    dateFrom={sdDateFrom} setDateFrom={setSdDateFrom}
    dateTo={sdDateTo} setDateTo={setSdDateTo}
    dsView={sdDsView} setDsView={setSdDsView}
  />
)}
```

- [ ] **Step 6: Verify app builds**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build`
Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat(ui): add SKU Detail tab with computation cards and charts"
```

---

## Task 6: Cleanup — Remove Old Dashboard and Insights Code

Remove the old Dashboard tab rendering and InsightsTab component, plus unused state.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Remove old Dashboard tab rendering**

Delete the entire `{tab==="dashboard"&&(` block (lines ~3200-3384) including:
- KPI strip
- Filter bar
- Virtualised table
- DSCols helper usage for dashboard

- [ ] **Step 2: Remove old InsightsTab component and sub-components**

Delete the `InsightsTab` function definition (lines ~263-491) and its sub-components:
- `OrgLevel` (lines ~493-557)
- `CategoryLevel` (lines ~559-611)
- `BrandLevel` (lines ~613-690)
- `SKULevel` (lines ~692-749)

Also delete the `PERIOD_OPTS` and `DS_VIEW_OPTS` constants (lines ~260-261).

- [ ] **Step 3: Remove old Insights tab rendering**

Delete the `{tab==="insights"&&(` block that renders InsightsTab.

- [ ] **Step 4: Remove unused state variables**

Remove the old Dashboard filter state that's no longer needed:

```javascript
// Remove these if no longer referenced by other tabs:
// filterDS, filterCat, filterMov, filterPriceTag, filterTopN, filterLogic, filterStatus, search
// insightsPeriod, insightsCustomD, insightsDsView, insightsDrill, insightsCatFilter, insightsSearch
```

**Important:** Before removing, search for any references from other tabs (OOS Simulation, Manual Overrides may reference `filterDS` etc.). Only remove state that is exclusively used by Dashboard/Insights.

- [ ] **Step 5: Remove unused helper components**

Check if `SKUFreqChart` (lines ~254-258) is used only by old Insights. If so, remove it. `SingleFreqChart` is reused by SKU Detail, so keep it.

Remove `DSCols` if it was only used by the old Dashboard table. Check for references in OOS Simulation or other tabs before removing.

- [ ] **Step 6: Verify app builds and all remaining tabs work**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build`
Expected: Build succeeds. No references to removed code.

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run dev`
Expected: All tabs render correctly. Overview works. SKU Detail works. OOS Simulation, Upload, Logic Tweaker, Manual Overrides, Tool Output all still function.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "refactor: remove old Dashboard and Insights tab code"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Full smoke test**

Run dev server. Verify all of the following:
1. Overview tab: KPI strip shows correct numbers
2. Overview tab: All 6 period presets work (L90D through L7D)
3. Overview tab: Custom date picker works
4. Overview tab: Store picker filters correctly (All, each DS, DC)
5. Overview tab: Category → Brand → SKU drill-down works
6. Overview tab: Back button and breadcrumb navigation work
7. Overview tab: SKU level shows per-store breakdown
8. Overview tab: Clicking SKU row navigates to SKU Detail with SKU pre-loaded
9. SKU Detail: Direct search by SKU ID works
10. SKU Detail: Direct search by SKU name works
11. SKU Detail: Period picker works for charts
12. SKU Detail: DS picker filters cards and charts
13. SKU Detail: Standard strategy cards show long/recent/blend breakdown
14. SKU Detail: Percentile Cover cards show percentile/cover day breakdown
15. SKU Detail: Fixed Unit Floor cards show P90/order count breakdown
16. SKU Detail: Post-blend adjustments render when applicable
17. SKU Detail: DC card shows full computation
18. SKU Detail: Frequency chart renders correctly
19. SKU Detail: Date-level chart renders correctly
20. All other tabs (OOS Sim, Upload, Output, Logic Tweaker, Overrides) work unchanged

- [ ] **Step 2: Build check**

Run: `cd /Users/sandy/Documents/GitHub/homerun-ims && npm run build`
Expected: Clean build, no warnings related to our changes.

- [ ] **Step 3: Commit any fixes from smoke test**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```

(Only if fixes were needed.)
