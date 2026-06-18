# Plywood Brand Stocking Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate brand-level Plywood stocking logic into the Min/Max engine for 4 configured brands (Action Tesa, CenturyPly, ArchidPly, GreenPly), with DC sizing, brand transparency UI, and zero disruption to all other categories.

**Architecture:** A new pure pre-computation module `plywoodBrand.js` runs before the main `allSKUs.forEach` loop in `runEngine.js`. Each SKU in the forEach checks for a pre-computed plywood brand result; if found, it populates `res[skuId]` directly and returns early — bypassing all existing strategy dispatch, New DS Floor, and SKU Floor Override logic. Dead Stock cap still applies. Other categories and unconfigured plywood brands (e.g. Merino → PCT) are completely unaffected.

**Tech Stack:** React 19, Vite 7, JavaScript ESM, Supabase

---

## Confirmed facts (do not re-verify)

- Invoice row fields: `r.sku`, `r.ds`, `r.date`, `r.qty`
- Plywood category string: `"Plywood, MDF & HDHMR"` (from `PLYWOOD_CATEGORIES` const in `PlywoodNetworkTab.jsx`)
- Main loop is `allSKUs.forEach(skuId => { ... })` — use `return` not `continue` for early exit
- No automated test runner — verification is via `npm run dev` + browser inspection
- `percentile(sortedArr, pct)` is exported from `src/engine/utils.js`
- `DS_LIST = ["DS01","DS02","DS03","DS04","DS05"]` exported from `src/engine/constants.js`

## Brand stocking rules (encoded in config default)

| Brand | Stocking nodes | Node coverage (demand aggregation) | DC direct serves |
|---|---|---|---|
| Action Tesa | DS01, DS03 | DS01→[DS01,DS05] · DS03→[DS03,DS04,DS05] | DS02, DS04 |
| CenturyPly | DS01, DS03 | DS01→[DS01,DS05] · DS03→[DS03,DS04,DS05] | DS02, DS04 |
| ArchidPly | DS02, DS04, DS05 | DS02→[DS02,DS01] · DS04→[DS04,DS03] · DS05→[DS05,DS01,DS03] | — |
| GreenPly | DS02, DS04, DS05 | DS02→[DS02,DS01] · DS04→[DS04,DS03] · DS05→[DS05,DS01,DS03] | — |

Non-stocking DSes for each brand → Min = Max = 0.

## DS Min/Max formula

- **Min** = `P{minPercentile}` of non-zero aggregated daily demand across covered DSes (default P95)
- **Max** = `min(Min + P{maxBufferPercentile}(individual order qtys across covered DSes), maxCap)` (default P75 buffer, cap 20)

## DC formula

- **P95 component** (only if brand has a `DC` node in config): P95 of non-zero daily demand across DC's covered DSes
- **Multiplier component**: `Σ(DS_node_Max − DS_node_Min) across all DS stocking nodes × mult`
- `DC Min = P95_component + ceil(Σ_diff × dcMultMin)`
- `DC Max = max(P95_component + ceil(Σ_diff × dcMultMax), DC Min)`

---

## File map

| Action | Path | Responsibility |
|---|---|---|
| **Create** | `src/engine/strategies/plywoodBrand.js` | Pure pre-computation: demand aggregation, P95/Px, DC formula |
| **Modify** | `src/engine/constants.js` | Add `PLYWOOD_BRAND_CONFIG_DEFAULT`, merge into `DEFAULT_PARAMS` |
| **Modify** | `src/engine/runEngine.js` | Import + pre-compute hook + forEach early-return bypass |
| **Modify** | `src/engine/index.js` | Barrel export for `computePlywoodBrandResults` |
| **Modify** | `src/tabs/PlywoodNetworkTab.jsx` | Brand transparency panel |
| **Modify** | `src/App.jsx` | Logic Tweaker section for plywood brand params |

---

## Task 1: Add config default to constants.js

**Files:**
- Modify: `src/engine/constants.js`

- [ ] **Step 1: Add `PLYWOOD_BRAND_CONFIG_DEFAULT` constant**

Open `src/engine/constants.js`. After the `DEFAULT_BRAND_BUFFER` block (line 20), insert:

```javascript
export const PLYWOOD_BRAND_CONFIG_DEFAULT = {
  lookbackDays: 90,
  minPercentile: 95,
  maxBufferPercentile: 75,
  maxCap: 20,
  brands: {
    "Action Tesa": {
      nodes: {
        DS01: { covers: ["DS01", "DS05"] },
        DS03: { covers: ["DS03", "DS04", "DS05"] },
        DC:   { covers: ["DS02", "DS04"] },
      },
      dcMultMin: 0.8,
      dcMultMax: 1.5,
    },
    "CenturyPly": {
      nodes: {
        DS01: { covers: ["DS01", "DS05"] },
        DS03: { covers: ["DS03", "DS04", "DS05"] },
        DC:   { covers: ["DS02", "DS04"] },
      },
      dcMultMin: 0.8,
      dcMultMax: 1.5,
    },
    "ArchidPly": {
      nodes: {
        DS02: { covers: ["DS02", "DS01"] },
        DS04: { covers: ["DS04", "DS03"] },
        DS05: { covers: ["DS05", "DS01", "DS03"] },
      },
      dcMultMin: 0.8,
      dcMultMax: 1.5,
    },
    "GreenPly": {
      nodes: {
        DS02: { covers: ["DS02", "DS01"] },
        DS04: { covers: ["DS04", "DS03"] },
        DS05: { covers: ["DS05", "DS01", "DS03"] },
      },
      dcMultMin: 0.8,
      dcMultMax: 1.5,
    },
  },
};
```

- [ ] **Step 2: Add to `DEFAULT_PARAMS`**

Inside the `DEFAULT_PARAMS` object (after `skuFloorDCMultMax:0.3,`), add:

```javascript
  plywoodBrandStocking: PLYWOOD_BRAND_CONFIG_DEFAULT,
```

- [ ] **Step 3: Commit**

```bash
git add src/engine/constants.js
git commit -m "feat: add PLYWOOD_BRAND_CONFIG_DEFAULT to constants and DEFAULT_PARAMS"
```

---

## Task 2: Create plywoodBrand.js strategy module

**Files:**
- Create: `src/engine/strategies/plywoodBrand.js`

- [ ] **Step 1: Create the file with full implementation**

```javascript
// Plywood brand-level stocking strategy
// Pre-computes Min/Max for all plywood brand SKUs before the main engine loop.
// Brands not in config fall through to the existing PCT strategy in runEngine.

import { percentile } from '../utils.js';
import { DS_LIST } from '../constants.js';

const PLYWOOD_CATEGORY = 'Plywood, MDF & HDHMR';

function isPlywoodBrandSKU(meta, brands) {
  return meta.category === PLYWOOD_CATEGORY && !!brands[meta.brand];
}

// Build daily-demand and order-qty maps for the plywood lookback window.
// Returns dailyDemand[sku][ds][date] = qty and orderQtys[sku][ds] = [qty,...]
function buildMaps(inv, cutoffStr) {
  const dailyDemand = {};
  const orderQtys = {};
  for (const r of inv) {
    if (r.date < cutoffStr) continue;
    const { sku, ds, date } = r;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;
    if (!dailyDemand[sku]) dailyDemand[sku] = {};
    if (!dailyDemand[sku][ds]) dailyDemand[sku][ds] = {};
    dailyDemand[sku][ds][date] = (dailyDemand[sku][ds][date] || 0) + qty;
    if (!orderQtys[sku]) orderQtys[sku] = {};
    if (!orderQtys[sku][ds]) orderQtys[sku][ds] = [];
    orderQtys[sku][ds].push(qty);
  }
  return { dailyDemand, orderQtys };
}

// Aggregate daily totals across a list of DSes for one SKU.
function aggregateDailyTotals(sku, coveredDSes, dailyDemand) {
  const totals = {};
  for (const ds of coveredDSes) {
    for (const [date, qty] of Object.entries(dailyDemand[sku]?.[ds] || {})) {
      totals[date] = (totals[date] || 0) + qty;
    }
  }
  return totals;
}

// P{pct} of non-zero daily aggregated demand → node Min.
function computeNodeMin(sku, coveredDSes, dailyDemand, minPct) {
  const totals = aggregateDailyTotals(sku, coveredDSes, dailyDemand);
  const nonZero = Object.values(totals).filter(q => q > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return { min: 0, nonZeroCount: 0 };
  return { min: Math.ceil(percentile(nonZero, minPct)), nonZeroCount: nonZero.length };
}

// P{pct} of individual order quantities across covered DSes → Max buffer.
function computeOrderBuffer(sku, coveredDSes, orderQtys, maxBufPct) {
  const all = [];
  for (const ds of coveredDSes) all.push(...(orderQtys[sku]?.[ds] || []));
  if (all.length === 0) return 0;
  all.sort((a, b) => a - b);
  return Math.ceil(percentile(all, maxBufPct));
}

/**
 * Pre-compute plywood brand stocking results for all covered SKUs.
 * Called once before the main allSKUs.forEach loop in runEngine.
 *
 * Returns { [skuId]: { brand, storeResults: { [dsId]: {min,max,nonZeroCount} }, dcResult: {min,max} } }
 * SKUs not in a covered brand are absent from the result → runEngine uses existing strategy.
 */
export function computePlywoodBrandResults(inv, skuM, params) {
  const cfg = params?.plywoodBrandStocking;
  if (!cfg?.brands) return {};

  const {
    lookbackDays = 90,
    minPercentile = 95,
    maxBufferPercentile = 75,
    maxCap = 20,
    brands,
  } = cfg;

  // Compute cutoff date string (lookbackDays before the latest invoice date)
  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return {};
  const latest = new Date(allDates[allDates.length - 1]);
  latest.setDate(latest.getDate() - lookbackDays);
  const cutoffStr = latest.toISOString().slice(0, 10);

  const { dailyDemand, orderQtys } = buildMaps(inv, cutoffStr);
  const results = {};

  for (const [skuId, meta] of Object.entries(skuM)) {
    if (!isPlywoodBrandSKU(meta, brands)) continue;
    const brandCfg = brands[meta.brand];
    const { nodes, dcMultMin, dcMultMax } = brandCfg;

    const storeResults = {};
    const nodeMinMax = {}; // DS stocking node results used in DC formula

    // Compute Min/Max for each DS stocking node
    for (const [nodeId, nodeCfg] of Object.entries(nodes)) {
      if (nodeId === 'DC') continue;
      const { min: minQty, nonZeroCount } = computeNodeMin(skuId, nodeCfg.covers, dailyDemand, minPercentile);
      const orderBuf = computeOrderBuffer(skuId, nodeCfg.covers, orderQtys, maxBufferPercentile);
      const maxQty = Math.min(Math.max(minQty + orderBuf, minQty), maxCap);
      nodeMinMax[nodeId] = { min: minQty, max: maxQty };
      storeResults[nodeId] = { min: minQty, max: maxQty, nonZeroCount };
    }

    // Non-stocking DSes → 0
    for (const ds of DS_LIST) {
      if (!storeResults[ds]) storeResults[ds] = { min: 0, max: 0, nonZeroCount: 0 };
    }

    // DC: P95 direct-serving component (if DC node defined) + multiplier component
    let dcP95 = 0;
    if (nodes.DC) {
      const { min } = computeNodeMin(skuId, nodes.DC.covers, dailyDemand, minPercentile);
      dcP95 = min;
    }

    const sumDiff = Object.values(nodeMinMax).reduce((acc, { min, max }) => acc + (max - min), 0);
    const dcMin = dcP95 + Math.ceil(sumDiff * dcMultMin);
    const dcMax = Math.max(dcP95 + Math.ceil(sumDiff * dcMultMax), dcMin);

    results[skuId] = {
      brand: meta.brand,
      storeResults,
      dcResult: { min: dcMin, max: dcMax },
    };
  }

  return results;
}
```

- [ ] **Step 2: Start dev server and confirm no import errors**

```bash
npm run dev
```

Open browser → check console for any import/syntax errors. The app should load normally (no plywood logic is wired into the engine yet).

- [ ] **Step 3: Commit**

```bash
git add src/engine/strategies/plywoodBrand.js
git commit -m "feat: add plywoodBrand strategy module — P95 demand aggregation and DC formula"
```

---

## Task 3: Integrate into runEngine.js

**Files:**
- Modify: `src/engine/runEngine.js`

- [ ] **Step 1: Add import**

At the top of `src/engine/runEngine.js`, after the existing strategy imports (line 12), add:

```javascript
import { computePlywoodBrandResults } from "./strategies/plywoodBrand.js";
```

Also add `DC_DEAD_MULT_DEFAULT` to the existing import from `./constants.js` if not already imported. The current import on line 4 is:
```javascript
import {
  DS_LIST, MOVEMENT_TIERS_DEFAULT,
  DC_DEAD_MULT_DEFAULT,
  RECENCY_WT_DEFAULT,
} from "./constants.js";
```
`DC_DEAD_MULT_DEFAULT` is already imported — no change needed.

- [ ] **Step 2: Add pre-computation hook before the forEach**

Find line 95 in `runEngine.js`:
```javascript
  const allSKUs = [...new Set([...invSliced.map(r => r.sku), ...Object.keys(skuM)])],
    activeDSCount = p.activeDSCount || 4,
    res = {};
```

Immediately after `res = {};` (end of that declaration), insert:

```javascript
  // Pre-compute plywood brand results using full inv (not invSliced) for independent lookback window
  const plywoodBrandResults = computePlywoodBrandResults(inv, skuM, p);
```

- [ ] **Step 3: Add early-return bypass inside the forEach**

Find line 97: `allSKUs.forEach(skuId => {`

Right after the opening brace of the forEach (before the existing `const meta = ...` line 98), insert:

```javascript
    // ── PLYWOOD BRAND STOCKING ─────────────────────────────────────────────
    const plywoodResult = plywoodBrandResults[skuId];
    if (plywoodResult) {
      const _meta = skuM[skuId] || { sku: skuId, name: skuId, category: 'Plywood, MDF & HDHMR', brand: '', status: 'Active' };
      const _isDead = deadStockSet.has(skuId);
      const _prTag = getPriceTag(pd[skuId] || 0, priceTiers);
      const _t150Tag = t150[skuId] || 'No';
      const _stores = {};

      DS_LIST.forEach(dsId => {
        const { min, max, nonZeroCount = 0 } = plywoodResult.storeResults[dsId] || { min: 0, max: 0, nonZeroCount: 0 };
        const finalMax = _isDead ? min : max;
        _stores[dsId] = {
          min, max: finalMax,
          preFloorMin: min, preFloorMax: max,
          dailyAvg: 0, abq: 0,
          nonZeroDays: nonZeroCount,
          mvTag: 'N/A', spTag: 'N/A',
          logicTag: 'Plywood Brand',
          strategyTag: 'plywood_brand',
          strategyDetails: { brand: plywoodResult.brand },
          postBlendSteps: [],
        };
      });

      const _dc = plywoodResult.dcResult;
      const _dcDeadMult = p.dcDeadMult || DC_DEAD_MULT_DEFAULT;
      const _dcMin = _isDead ? Math.round(_dc.min * _dcDeadMult.min) : _dc.min;
      const _dcMax = _isDead ? Math.round(_dc.max * _dcDeadMult.max) : Math.max(_dc.max, _dc.min);

      res[skuId] = {
        meta: { ..._meta, priceTag: _prTag, t150Tag: _t150Tag },
        stores: _stores,
        dc: {
          min: _dcMin, max: _dcMax,
          preFloorMin: _dc.min, preFloorMax: _dc.max,
          mvTag: 'N/A', nonZeroDays: 0,
          dcDetails: { strategy: 'plywood_brand', brand: plywoodResult.brand, isDead: _isDead },
        },
      };
      return; // skip remainder of forEach — all other strategy/floor logic bypassed
    }
    // ── END PLYWOOD BRAND STOCKING ─────────────────────────────────────────
```

- [ ] **Step 4: Verify integration in browser**

```bash
npm run dev
```

Run "Apply & Re-run Model" in the app (or trigger engine run). Then check these SKUs in SKU Detail tab:

**Action Tesa SKU (any):**
- DS01: min > 0, max ≤ 20, logicTag = "Plywood Brand"
- DS03: min > 0, max ≤ 20, logicTag = "Plywood Brand"
- DS02: min = 0, max = 0
- DS04: min = 0, max = 0
- DS05: min = 0, max = 0

**ArchidPly SKU (any):**
- DS02: min > 0, max ≤ 20
- DS04: min > 0, max ≤ 20
- DS05: min > 0, max ≤ 20
- DS01: min = 0, max = 0
- DS03: min = 0, max = 0

**Merino SKU (laminate):**
- logicTag should NOT be "Plywood Brand" — should be "Base Logic" or PCT strategy tag

**Any Cement/Paint SKU:**
- Completely unchanged from previous run

- [ ] **Step 5: Commit**

```bash
git add src/engine/runEngine.js
git commit -m "feat: integrate plywood brand strategy into runEngine with pre-compute hook and early-return bypass"
```

---

## Task 4: Update engine index.js barrel export

**Files:**
- Modify: `src/engine/index.js`

- [ ] **Step 1: Read current index.js contents**

Read `src/engine/index.js` to see existing exports.

- [ ] **Step 2: Add export for new module**

Add to `src/engine/index.js`:

```javascript
export { computePlywoodBrandResults } from './strategies/plywoodBrand.js';
```

- [ ] **Step 3: Commit**

```bash
git add src/engine/index.js
git commit -m "chore: export computePlywoodBrandResults from engine index"
```

---

## Task 5: Add brand transparency panel to PlywoodNetworkTab.jsx

**Files:**
- Modify: `src/tabs/PlywoodNetworkTab.jsx`

- [ ] **Step 1: Add `plywoodBrandStocking` as a prop or read from params**

In `PlywoodNetworkTab`, find the component signature (line 454):
```javascript
export default function PlywoodNetworkTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin, networkConfigs, onSaveConfigs }) {
```

Add `params` to the prop list:
```javascript
export default function PlywoodNetworkTab({ invoiceData, skuMaster, invoiceDateRange, isAdmin, networkConfigs, onSaveConfigs, params }) {
```

- [ ] **Step 2: Derive brand lists from params**

Near the top of the component body (after existing state declarations), add:

```javascript
  const plywoodBrandCfg = params?.plywoodBrandStocking;
  const customBrands = Object.keys(plywoodBrandCfg?.brands || {});
```

- [ ] **Step 3: Add transparency panel to JSX**

Find the opening of the tab's return JSX (the outermost `<div>` of the tab content). Insert the panel as the first child, before the existing DS selector / config sections:

```jsx
      {/* Brand Strategy Transparency */}
      <div style={{ background: '#1a2a1a', border: '1px solid #2d4a2d', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', gap: 32, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, color: '#7aab7a', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Custom Brand Logic</div>
          {customBrands.length === 0
            ? <div style={{ fontSize: 12, color: '#666' }}>None configured</div>
            : customBrands.map(b => (
                <div key={b} style={{ fontSize: 12, color: '#c8e6c9', marginBottom: 2 }}>● {b}</div>
              ))}
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#ffe082', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>PCT Strategy (fallback)</div>
          <div style={{ fontSize: 12, color: '#ffe082', marginBottom: 2 }}>● Merino</div>
          <div style={{ fontSize: 12, color: '#888' }}>● All unrecognised plywood brands</div>
        </div>
      </div>
```

- [ ] **Step 4: Pass `params` prop from App.jsx**

Search App.jsx for where `PlywoodNetworkTab` is rendered (grep for `PlywoodNetworkTab`). Add the `params` prop:

```jsx
<PlywoodNetworkTab
  ...existing props...
  params={params}
/>
```

Where `params` is the current active params object available in App.jsx (the same one passed to runEngine).

- [ ] **Step 5: Verify in browser**

Navigate to the Plywood tab. Confirm the transparency panel appears at the top showing:
- Custom Brand Logic: Action Tesa, CenturyPly, ArchidPly, GreenPly
- PCT Strategy: Merino + all unrecognised plywood brands

- [ ] **Step 6: Commit**

```bash
git add src/tabs/PlywoodNetworkTab.jsx src/App.jsx
git commit -m "feat: add brand strategy transparency panel to Plywood tab"
```

---

## Task 6: Add plywood brand stocking params to Logic Tweaker

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Find the Logic Tweaker param section**

```bash
grep -n "pctDocCap\|Logic Tweaker\|skuFloorDCMult" src/App.jsx | head -20
```

This will show the line numbers where existing plywood-adjacent params are edited. The new section goes nearby.

- [ ] **Step 2: Find the param change tracking**

```bash
grep -n "setParamsChanged\|paramsChanged\|hasChanges" src/App.jsx | head -20
```

Identify how param changes are flagged as dirty (triggering the yellow "Apply & Re-run Model" button).

- [ ] **Step 3: Add handler functions**

Find where other param handler functions are defined (near the change-tracking grep results). Add these two handlers:

```javascript
function handlePlywoodGlobalParam(key, value) {
  setLocalParams(prev => ({
    ...prev,
    plywoodBrandStocking: { ...prev.plywoodBrandStocking, [key]: value },
  }));
  setParamsChanged(true); // use whatever dirty-flag setter exists in App.jsx
}

function handlePlywoodBrandParam(brand, key, value) {
  setLocalParams(prev => ({
    ...prev,
    plywoodBrandStocking: {
      ...prev.plywoodBrandStocking,
      brands: {
        ...prev.plywoodBrandStocking?.brands,
        [brand]: { ...prev.plywoodBrandStocking?.brands?.[brand], [key]: value },
      },
    },
  }));
  setParamsChanged(true);
}
```

Note: replace `setParamsChanged(true)` with whatever the actual dirty-flag call is in App.jsx (found in Step 2).

- [ ] **Step 4: Add the Logic Tweaker UI section**

Find the closing of the existing Logic Tweaker param area (near `pctDocCap` or `skuFloorDCMultMax` inputs). Add a new section after those inputs:

```jsx
{/* ── Plywood Brand Stocking ─────────────────────────── */}
<div style={{ /* match existing section-header style in App.jsx */ }}>
  Plywood Brand Stocking
</div>

{/* Global knobs */}
<div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
  {[
    { label: 'Lookback Days', key: 'lookbackDays', min: 30, max: 365, step: 1 },
    { label: 'Min Percentile', key: 'minPercentile', min: 50, max: 99, step: 1 },
    { label: 'Max Buffer Pct', key: 'maxBufferPercentile', min: 50, max: 99, step: 1 },
    { label: 'Max Cap / Location', key: 'maxCap', min: 1, max: 100, step: 1 },
  ].map(({ label, key, min, max, step }) => (
    <label key={key} style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label}
      <input
        type="number" min={min} max={max} step={step}
        value={localParams.plywoodBrandStocking?.[key] ?? ''}
        onChange={e => handlePlywoodGlobalParam(key, Number(e.target.value))}
        style={{ width: 80 }} /* match existing input style */
      />
    </label>
  ))}
</div>

{/* Per-brand DC multipliers */}
<div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>DC Multipliers per Brand</div>
{Object.entries(localParams.plywoodBrandStocking?.brands || {}).map(([brand, cfg]) => (
  <div key={brand} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
    <span style={{ width: 110, fontSize: 12 }}>{brand}</span>
    {[
      { label: 'DC Mult Min', key: 'dcMultMin' },
      { label: 'DC Mult Max', key: 'dcMultMax' },
    ].map(({ label, key }) => (
      <label key={key} style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {label}
        <input
          type="number" min={0.1} max={5} step={0.1}
          value={cfg[key] ?? ''}
          onChange={e => handlePlywoodBrandParam(brand, key, Number(e.target.value))}
          style={{ width: 60 }} /* match existing input style */
        />
      </label>
    ))}
  </div>
))}
```

- [ ] **Step 5: Verify in browser**

Open Logic Tweaker. Scroll to the new "Plywood Brand Stocking" section. Confirm:
- 4 global inputs render with correct default values (90, 95, 75, 20)
- 4 brand rows each with dcMultMin and dcMultMax inputs
- Changing any value makes the "Apply & Re-run Model" button turn yellow
- Clicking Apply → engine re-runs → Supabase `params/global` payload contains `plywoodBrandStocking` key with updated values

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "feat: add plywood brand stocking param controls to Logic Tweaker"
```

---

## Self-Review

### Spec coverage check

| Requirement | Covered by |
|---|---|
| Brand-level stocking assignments, 4 brands | Task 1 — `PLYWOOD_BRAND_CONFIG_DEFAULT` |
| Min = P95 of non-zero aggregated daily demand | Task 2 — `computeNodeMin` |
| Max = Min + Px(individual order qtys), cap 20 | Task 2 — `computeOrderBuffer` + `maxCap` |
| Non-stocking DSes = Min=Max=0 | Task 2 — fills all DS_LIST, absent nodes → 0 |
| Lookback days configurable | Task 1 defaults + Task 6 Logic Tweaker |
| minPercentile, maxBufferPercentile, maxCap configurable | Task 1 defaults + Task 6 Logic Tweaker |
| DC = P95 direct-serving + multiplier component | Task 2 — DC section |
| dcMultMin, dcMultMax configurable per brand | Task 1 defaults + Task 6 Logic Tweaker |
| Merino + unknown brands → PCT fallback | Task 2 — `isPlywoodBrandSKU` returns false → runEngine uses existing strategy |
| Dead Stock cap still applied | Task 3 — `_isDead` applied in bypass block |
| New DS Floor bypassed for covered brands | Task 3 — early `return` before lines 211-218 |
| SKU Floor Override bypassed for covered brands | Task 3 — early `return` before lines 227-241 |
| Final rounding still applied | Task 3 — `min` and `max` are already `Math.ceil`/`Math.round` in plywoodBrand.js |
| Brand transparency UI | Task 5 — transparency panel in Plywood tab |
| Config stored in Supabase | Automatic — `plywoodBrandStocking` is part of `localParams` → saved to `params/global` on Apply |
| Other categories untouched | Task 3 — only SKUs with `plywoodBrandResults[skuId]` hit the bypass |

### Placeholder scan

No TBD, TODO, or "similar to" references. All code blocks are complete.

### Type consistency

- `computePlywoodBrandResults` defined in Task 2, imported in Task 3 ✅
- `plywoodResult.storeResults[dsId]` shape defined in Task 2 (`{min,max,nonZeroCount}`), consumed in Task 3 ✅
- `plywoodResult.dcResult` shape defined in Task 2 (`{min,max}`), consumed in Task 3 ✅
- `plywoodResult.brand` defined in Task 2, consumed in Task 3 ✅
- `handlePlywoodGlobalParam` and `handlePlywoodBrandParam` defined in Task 6 Step 3, used in Task 6 Step 4 ✅
- `PLYWOOD_BRAND_CONFIG_DEFAULT` exported in Task 1, referenced in `DEFAULT_PARAMS` in Task 1 ✅

### One risk to watch

`computePlywoodBrandResults` receives the full unsliced `inv` (not `invSliced`). This is intentional — the plywood lookback window may differ from `overallPeriod`. Confirm this is what's passed in Task 3 Step 2 (`computePlywoodBrandResults(inv, skuM, p)` not `invSliced`).
