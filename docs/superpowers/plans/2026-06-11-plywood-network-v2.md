# Plywood Network v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the capacity-first allocation engine (floors → greedy depth → drain-based DC), replay simulator with order-level service scoring, Keep Score report, and a v2 tab — per `docs/superpowers/specs/2026-06-11-plywood-network-v2-design.md`.

**Architecture:** New pure-function engine modules under `src/engine/strategies/plywoodV2/` (demand prep, allocator, replay, DC sizing, keep score), assembled by `computePlywoodNetworkV2Results()` which returns the same result shape `runEngine.js` already consumes for v1 network design. A node validation harness runs the engine against real data offline. UI is a new tab activated only when `categoryStrategies["Plywood, MDF & HDHMR"] === "network_design_v2"` — dormant in prod.

**Tech Stack:** React + Vite (existing), vitest (new dev dependency), plain ES modules for engine.

**Branch:** `feature/plywood-network-v2`. NEVER push or create PRs — local only until user sign-off.

---

## File map

| File | Responsibility |
|---|---|
| `src/engine/strategies/plywoodV2/demand.js` | Universe, order grouping, bulk classification, regular/bulk streams |
| `src/engine/strategies/plywoodV2/allocator.js` | Floors + greedy Min depth + Max buffer within DS capacity |
| `src/engine/strategies/plywoodV2/replay.js` | Day-by-day replay: orders, TOs, POs, OOS events, service levels, drain |
| `src/engine/strategies/plywoodV2/dc.js` | DC sizing from drain (P98) + bulk (P90) + cycle stock, capacity trim |
| `src/engine/strategies/plywoodV2/keepScore.js` | Rent/Service ratios, Keep Score |
| `src/engine/strategies/plywoodV2/index.js` | `computePlywoodNetworkV2Results()` assembly + DEFAULTS |
| `src/engine/strategies/plywoodV2/__tests__/*.test.js` | vitest unit tests per module |
| `scripts/validate-plywood-v2.mjs` | Offline harness: real data → CSVs + summary |
| `src/engine/runEngine.js` | Add `network_design_v2` dispatch branch |
| `src/engine/index.js` | Barrel export |
| `src/tabs/PlywoodNetworkV2Tab.jsx` | Tab shell + sub-panels |
| `src/App.jsx` | Tab registration, strategy option, config load/save (`params/plywoodNetworkV2Config`) |

Conventions used by all engine modules:
- Invoice row: `{ sku, ds, qty, date: 'YYYY-MM-DD', shopifyOrder }`.
- `cfg` = the v2 config object (see DEFAULTS in Task 7).
- All functions deterministic; no `Date.now()`, no randomness.

---

### Task 0: Branch + vitest setup

**Files:** Modify: `package.json`, `.gitignore`

- [ ] **Step 0.1:** Create branch: `git checkout -b feature/plywood-network-v2`
- [ ] **Step 0.2:** Install vitest: `npm install -D vitest`
- [ ] **Step 0.3:** Add script to `package.json` scripts block: `"test": "vitest run"`
- [ ] **Step 0.4:** Append to `.gitignore`:
```
.cache/
validation-out/
```
- [ ] **Step 0.5:** Run `npx vitest run` — expect "no test files found" (exit 1 is fine).
- [ ] **Step 0.6:** Commit: `git add -A && git commit -m "chore: vitest setup for plywood v2"`

---

### Task 1: Demand preparation module

**Files:**
- Create: `src/engine/strategies/plywoodV2/demand.js`
- Test: `src/engine/strategies/plywoodV2/__tests__/demand.test.js`

- [ ] **Step 1.1: Write failing tests**

```js
import { describe, it, expect } from 'vitest';
import { buildUniverse, prepareDemand, medianOrderQty } from '../demand.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'GreenPly 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-B': { sku: 'PLY-B', name: 'CenturyPly 6mm', brand: 'CenturyPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-M': { sku: 'PLY-M', name: 'Merino Lam', brand: 'Merino', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-X': { sku: 'PLY-X', name: 'Dead 12mm', brand: 'GreenPly', status: 'Inactive', category: 'Plywood, MDF & HDHMR' },
  'OTHER': { sku: 'OTHER', name: 'Cement', brand: 'ACC', status: 'Active', category: 'Cement' },
};
const CFG = { lookbackDays: 90, bulkOrderThreshold: 10, excludedBrands: ['Merino'] };

describe('buildUniverse', () => {
  it('includes active ply SKUs, excludes Merino / inactive / other categories', () => {
    const u = buildUniverse(SKUM, CFG);
    expect(Object.keys(u).sort()).toEqual(['PLY-A', 'PLY-B']);
  });
});

describe('medianOrderQty', () => {
  it('odd count', () => expect(medianOrderQty([3, 2, 2])).toBe(2));
  it('even count', () => expect(medianOrderQty([1, 3])).toBe(2));
  it('empty', () => expect(medianOrderQty([])).toBe(0));
});

describe('prepareDemand', () => {
  const u = buildUniverse(SKUM, CFG);
  const inv = [
    // regular order: single small line
    { sku: 'PLY-A', ds: 'DS01', qty: 3, date: '2026-06-01', shopifyOrder: 'O1' },
    // bulk order (mixed): 12 + 4 in one order → order is bulk
    { sku: 'PLY-A', ds: 'DS02', qty: 12, date: '2026-06-02', shopifyOrder: 'O2' },
    { sku: 'PLY-B', ds: 'DS02', qty: 4, date: '2026-06-02', shopifyOrder: 'O2' },
    // non-universe line ignored
    { sku: 'OTHER', ds: 'DS01', qty: 5, date: '2026-06-02', shopifyOrder: 'O3' },
  ];
  const d = prepareDemand(inv, u, CFG);

  it('classifies orders at order level', () => {
    const o2 = d.orders.find(o => o.id === 'O2');
    expect(o2.isBulk).toBe(true);
    expect(d.orders.find(o => o.id === 'O1').isBulk).toBe(false);
  });
  it('regular stream is line-level: small line inside bulk order still counts', () => {
    expect(d.regularDaily['PLY-B']['DS02']['2026-06-02']).toBe(4);
    expect(d.regularDaily['PLY-A']['DS01']['2026-06-01']).toBe(3);
    // bulk-sized line NOT in regular stream
    expect(d.regularDaily['PLY-A']?.['DS02']).toBeUndefined();
  });
  it('bulk stream is order-level: all lines of bulk orders, network-keyed', () => {
    expect(d.bulkDaily['PLY-A']['2026-06-02']).toBe(12);
    expect(d.bulkDaily['PLY-B']['2026-06-02']).toBe(4);   // small line rides with bulk order
    expect(d.bulkDaily['PLY-A']?.['2026-06-01']).toBeUndefined();
  });
  it('collects network regular order qtys', () => {
    expect(d.regOrderQtys['PLY-A']).toEqual([3]);
    expect(d.regOrderQtys['PLY-B']).toEqual([4]);
  });
});
```

- [ ] **Step 1.2:** Run `npx vitest run src/engine/strategies/plywoodV2` — expect FAIL (module missing).
- [ ] **Step 1.3: Implement `demand.js`**

```js
// Demand preparation for Plywood Network v2 (spec §3–4).
// Universe = all active ply SKUs except excluded brands.
// Bulk = order-level label (any line ≥ threshold); regular stream = line-level.

import { DS_LIST } from '../../constants.js';

export const PLY_CATEGORY = 'Plywood, MDF & HDHMR';

export function buildUniverse(skuM, cfg) {
  const excluded = (cfg.excludedBrands || ['Merino']).map(b => b.toLowerCase());
  const universe = {};
  for (const [sku, m] of Object.entries(skuM)) {
    if (m.category !== PLY_CATEGORY) continue;
    if ((m.status || 'Active').toLowerCase() !== 'active') continue;
    if (excluded.includes((m.brand || '').toLowerCase())) continue;
    universe[sku] = m;
  }
  return universe;
}

export function medianOrderQty(qtys) {
  if (!qtys || qtys.length === 0) return 0;
  const s = [...qtys].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function prepareDemand(inv, universe, cfg) {
  const lookbackDays = cfg.lookbackDays || 90;
  const bulkTh = cfg.bulkOrderThreshold || 10;

  const allDates = [...new Set(inv.map(r => r.date))].sort();
  if (allDates.length === 0) return null;
  const latest = new Date(allDates[allDates.length - 1] + 'T00:00:00Z');
  latest.setUTCDate(latest.getUTCDate() - (lookbackDays - 1));
  const cutoff = latest.toISOString().slice(0, 10);
  const windowDates = [];
  for (let d = new Date(cutoff + 'T00:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = d.toISOString().slice(0, 10);
    if (s > allDates[allDates.length - 1]) break;
    windowDates.push(s);
  }

  // Group universe ply lines into orders
  const byId = {};
  for (const r of inv) {
    if (!universe[r.sku] || r.date < cutoff) continue;
    const qty = Number(r.qty) || 0;
    if (qty <= 0 || !DS_LIST.includes(r.ds)) continue;
    const oid = r.shopifyOrder || `_noid|${r.ds}|${r.date}|${r.sku}`;
    if (!byId[oid]) byId[oid] = { id: oid, ds: r.ds, date: r.date, lines: [] };
    byId[oid].lines.push({ sku: r.sku, qty });
  }
  const orders = Object.values(byId).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1);
  for (const o of orders) o.isBulk = o.lines.some(l => l.qty >= bulkTh);

  const regularDaily = {};   // sku → ds → date → qty   (line-level, DS sizing)
  const bulkDaily = {};      // sku → date → qty        (order-level, DC sizing)
  const regOrderQtys = {};   // sku → [qty]             (network, for median/floor)

  for (const o of orders) {
    for (const { sku, qty } of o.lines) {
      if (qty < bulkTh) {
        if (!regularDaily[sku]) regularDaily[sku] = {};
        if (!regularDaily[sku][o.ds]) regularDaily[sku][o.ds] = {};
        regularDaily[sku][o.ds][o.date] = (regularDaily[sku][o.ds][o.date] || 0) + qty;
        if (!regOrderQtys[sku]) regOrderQtys[sku] = [];
        regOrderQtys[sku].push(qty);
      }
      if (o.isBulk) {
        if (!bulkDaily[sku]) bulkDaily[sku] = {};
        bulkDaily[sku][o.date] = (bulkDaily[sku][o.date] || 0) + qty;
      }
    }
  }
  return { orders, regularDaily, bulkDaily, regOrderQtys, windowDates, cutoff };
}
```

- [ ] **Step 1.4:** Run tests — expect PASS.
- [ ] **Step 1.5:** Commit: `git commit -am "feat(plywood-v2): demand preparation module"`

---

### Task 2: Greedy allocator

**Files:**
- Create: `src/engine/strategies/plywoodV2/allocator.js`
- Test: `src/engine/strategies/plywoodV2/__tests__/allocator.test.js`

- [ ] **Step 2.1: Write failing tests**

```js
import { describe, it, expect } from 'vitest';
import { allocate, thicknessClass } from '../allocator.js';

// Helper: build demand object the allocator consumes
function demandOf({ regularDaily = {}, regOrderQtys = {}, windowDates }) {
  return { regularDaily, regOrderQtys, windowDates };
}
const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));

const U2 = {
  FAST: { sku: 'FAST', name: 'Fast 18mm', brand: 'GreenPly' },
  SLOW: { sku: 'SLOW', name: 'Slow 18mm', brand: 'GreenPly' },
};

describe('thicknessClass', () => {
  it('classifies by mm with boundary 9', () => {
    expect(thicknessClass('Ply 18mm', 9)).toBe('thick');
    expect(thicknessClass('Ply 6mm', 9)).toBe('thin');
    expect(thicknessClass('No mm here', 9)).toBe('thin'); // unknown → thin
  });
});

describe('allocate', () => {
  it('floors: zero-demand SKU gets Min=1/Max=2 at every DS', () => {
    const { plan } = allocate(U2, demandOf({ windowDates: DATES }), {
      dsCapacities: null, // unlimited
    });
    expect(plan['FAST']['DS01']).toEqual({ min: 1, max: 2, floor: 1 });
  });

  it('floor uses network median regular order', () => {
    const d = demandOf({ regOrderQtys: { FAST: [2, 2, 4] }, windowDates: DATES });
    const { plan } = allocate(U2, d, { dsCapacities: null });
    expect(plan['FAST']['DS01'].min).toBe(2);  // median 2
  });

  it('greedy depth goes to the SKU with higher marginal coverage', () => {
    // FAST sells 3/day on 30 days at DS01; SLOW sells 1 on 2 days.
    const rd = { FAST: { DS01: {} }, SLOW: { DS01: {} } };
    DATES.slice(0, 30).forEach(dt => { rd.FAST.DS01[dt] = 3; });
    DATES.slice(0, 2).forEach(dt => { rd.SLOW.DS01[dt] = 1; });
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [3], SLOW: [1] }, windowDates: DATES });
    // capacity: floors cost (3+1)+(1+1)=6 Max sheets; allow 2 extra sheets of depth
    const { plan } = allocate(U2, d, { dsCapacities: { DS01: { thick: 8, thin: 0 } } });
    // both extra sheets must land on FAST (needed 30/90 days vs 2/90)
    expect(plan['FAST']['DS01'].min).toBe(3 + 2 - 2);  // floor 3 → but see below
    expect(plan['SLOW']['DS01'].min).toBe(1);
  });

  it('never breaches capacity (ΣMax ≤ cap) and reports utilisation', () => {
    const rd = { FAST: { DS01: {} } };
    DATES.forEach(dt => { rd.FAST.DS01[dt] = 5; });
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [5] }, windowDates: DATES });
    const { plan, nodeReport } = allocate(U2, d, { dsCapacities: { DS01: { thick: 9, thin: 0 } } });
    const sumMax = plan['FAST']['DS01'].max + plan['SLOW']['DS01'].max;
    expect(sumMax).toBeLessThanOrEqual(9);
    expect(nodeReport['DS01'].thick.used).toBe(sumMax);
  });

  it('depth stops at the max observed demand day (P99 ceiling)', () => {
    const rd = { FAST: { DS01: { [DATES[0]]: 4 } } };
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [4] }, windowDates: DATES });
    const { plan } = allocate(U2, d, { dsCapacities: { DS01: { thick: 1000, thin: 0 } } });
    expect(plan['FAST']['DS01'].min).toBeLessThanOrEqual(4); // never beyond max day
  });

  it('is deterministic', () => {
    const rd = { FAST: { DS01: { [DATES[0]]: 2 } }, SLOW: { DS01: { [DATES[0]]: 2 } } };
    const d = demandOf({ regularDaily: rd, regOrderQtys: { FAST: [2], SLOW: [2] }, windowDates: DATES });
    const a = allocate(U2, d, { dsCapacities: { DS01: { thick: 7, thin: 0 } } });
    const b = allocate(U2, d, { dsCapacities: { DS01: { thick: 7, thin: 0 } } });
    expect(a).toEqual(b);
  });
});
```

Note on the third test's expectation: floor for FAST = median([3]) = 3 → floor min 3/max 4; SLOW floor 1/2. Floors use 4+2=6 of 8. The 2 spare sheets both go to FAST depth → min 3→5 would exceed... each depth sheet raises min AND max by 1 (max=min+1 invariant), so 2 sheets → FAST min 5, max 6, ΣMax = 6+2 = 8 = cap. But depth must not exceed max observed day (3)! FAST's max day is 3, floor min already 3 → NO depth is allocatable; spare budget goes to Max buffer (Priority 3): FAST max → min+median(3)=3+3 capped by budget → max 6? Buffer target = min + max(1, round(median)) = 3+3 = 6, raising max 4→6 costs 2 — exactly the spare. Final: FAST {min:3, max:6}, SLOW {min:1, max:2}. **Correct the test:**

```js
    expect(plan['FAST']['DS01']).toMatchObject({ min: 3, max: 6 });
    expect(plan['SLOW']['DS01']).toMatchObject({ min: 1, max: 2 });
```

- [ ] **Step 2.2:** Run tests — FAIL (module missing).
- [ ] **Step 2.3: Implement `allocator.js`**

```js
// Greedy capacity-first allocator (spec §5).
// Priority 1: floors (breadth, sacred). Priority 2: Min depth by marginal coverage.
// Priority 3: Max buffer toward Min + median order. Budget = ΣMax per (DS × class).

import { DS_LIST } from '../../constants.js';
import { inferThickness } from '../../utils.js';
import { medianOrderQty } from './demand.js';

export function thicknessClass(name, boundaryMm = 9) {
  const mm = inferThickness(name);
  return mm !== null && mm > boundaryMm ? 'thick' : 'thin';
}

export function allocate(universe, demand, cfg) {
  const { regularDaily, regOrderQtys, windowDates } = demand;
  const W = windowDates.length;
  const stopPct = cfg.minDepthStopPercentile ?? 99;
  const boundary = cfg.thickBoundaryMm ?? 9;
  const caps = cfg.dsCapacities || null;

  const skus = Object.keys(universe).sort();
  const floor = {};
  const tclass = {};
  for (const sku of skus) {
    floor[sku] = Math.max(1, Math.round(medianOrderQty(regOrderQtys[sku])) || 1);
    tclass[sku] = thicknessClass(universe[sku].name, boundary);
  }

  // Plan init = floors everywhere
  const plan = {};
  for (const sku of skus) {
    plan[sku] = {};
    for (const ds of DS_LIST) plan[sku][ds] = { min: floor[sku], max: floor[sku] + 1, floor: floor[sku] };
  }

  // Pre-compute per sku×ds: sorted daily totals + total qty + nzd (regular)
  const dayQtys = {}; // `${sku}|${ds}` → number[] (non-zero day totals, desc not needed)
  const totQty = {};
  for (const sku of skus) {
    for (const ds of DS_LIST) {
      const m = regularDaily[sku]?.[ds] || {};
      const vals = Object.values(m);
      dayQtys[`${sku}|${ds}`] = vals;
      totQty[`${sku}|${ds}`] = vals.reduce((a, b) => a + b, 0);
    }
  }
  const daysGE = (sku, ds, k) => {
    let c = 0;
    for (const q of dayQtys[`${sku}|${ds}`]) if (q >= k) c++;
    return c;
  };
  // Depth ceiling: stop raising Min once exceedance prob ≤ (1 − stopPct/100).
  // With 90-day windows and stopPct=99 this means: raise while ≥1 day needed the next sheet.
  const exceedFloor = W * (1 - stopPct / 100); // e.g. 0.9 days for 99/90d

  const nodeReport = {};
  for (const ds of DS_LIST) {
    nodeReport[ds] = {};
    for (const tc of ['thick', 'thin']) {
      const group = skus.filter(s => tclass[s] === tc);
      const cap = caps?.[ds]?.[tc];
      const budget = cap == null ? Infinity : cap;
      let used = group.reduce((a, s) => a + plan[s][ds].max, 0);
      const floorUsed = used;

      // ── Priority 2: Min depth, one sheet at a time ──
      // candidates: raising min m→m+1 (max follows, staying min+1) costs 1 budget.
      if (budget > used) {
        while (used < budget) {
          let best = null, bestKey = null;
          for (const sku of group) {
            const m = plan[sku][ds].min;
            const need = daysGE(sku, ds, m + 1);
            if (need <= exceedFloor) continue; // beyond P99 ceiling
            const key = [need, totQty[`${sku}|${ds}`], sku];
            if (!best || key[0] > best[0] || (key[0] === best[0] && (key[1] > best[1] || (key[1] === best[1] && key[2] < best[2])))) {
              best = key; bestKey = sku;
            }
          }
          if (!bestKey) break;
          plan[bestKey][ds].min += 1;
          plan[bestKey][ds].max += 1; // invariant max = min+1 during depth phase
          used += 1;
        }
      }

      // ── Priority 3: Max buffer toward min + median order ──
      if (used < budget) {
        // order by selling frequency (regular NZD desc), then total qty, then sku
        const byFreq = [...group].sort((a, b) =>
          (dayQtys[`${b}|${ds}`].length - dayQtys[`${a}|${ds}`].length) ||
          (totQty[`${b}|${ds}`] - totQty[`${a}|${ds}`]) || (a < b ? -1 : 1));
        for (const sku of byFreq) {
          if (used >= budget) break;
          const p = plan[sku][ds];
          const target = p.min + Math.max(1, Math.round(medianOrderQty(regOrderQtys[sku])) || 1);
          while (p.max < target && used < budget) { p.max += 1; used += 1; }
        }
      }

      nodeReport[ds][tc] = {
        capacity: cap ?? null, floorUsed, used,
        overCapacity: cap != null && floorUsed > cap,
      };
    }
  }
  return { plan, nodeReport, floor, tclass };
}
```

- [ ] **Step 2.4:** Run tests — PASS (fix any expectation arithmetic, the test comments above show the worked example).
- [ ] **Step 2.5:** Commit: `git commit -am "feat(plywood-v2): greedy capacity-first allocator"`

---

### Task 3: Replay simulator

**Files:**
- Create: `src/engine/strategies/plywoodV2/replay.js`
- Test: `src/engine/strategies/plywoodV2/__tests__/replay.test.js`

Timing model (documented simplification): arrivals (TO at DS, PO at DC) are applied at
the START of day; the day's orders then draw stock; replenishment triggers are evaluated
on CLOSING stock. TO raised on day D arrives start of D+1. PO raised on day D arrives
start of D + leadDays. Initial stock = Max everywhere.

- [ ] **Step 3.1: Write failing tests**

```js
import { describe, it, expect } from 'vitest';
import { replay } from '../replay.js';

const DATES = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06'];
const mkOrder = (id, ds, date, lines, isBulk) => ({ id, ds, date, lines, isBulk });

const PLAN = { A: { DS01: { min: 2, max: 4 } } };
const CFG = { leadDays: 3, infiniteDC: false };

describe('replay', () => {
  it('TO raised when closing ≤ min, arrives next day, refills to max', () => {
    const orders = [mkOrder('O1', 'DS01', '2026-06-01', [{ sku: 'A', qty: 3 }], false)];
    const r = replay(PLAN, { A: { min: 100, max: 100 } }, { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    // day1: stock 4→1 ≤ min → TO 3 raised; day2 starts with 1+3=4
    expect(r.toDrain['A']['2026-06-02']).toBe(3);
    expect(r.serviceLevels.regular.overall).toBe(1); // no OOS
  });

  it('order-level OOS: one short line fails the whole order', () => {
    const plan = { A: { DS01: { min: 1, max: 2 } }, B: { DS01: { min: 1, max: 2 } } };
    const orders = [
      mkOrder('O1', 'DS01', '2026-06-01', [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 5 }], false), // B short (2 < 5)
    ];
    const r = replay(plan, { A: { min: 0, max: 0 }, B: { min: 0, max: 0 } },
      { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    expect(r.serviceLevels.regular.overall).toBe(0);   // 1 of 1 orders OOS
    expect(r.oosEvents).toHaveLength(1);
    expect(r.oosEvents[0]).toMatchObject({ orderId: 'O1', sku: 'B', short: 3, type: 'regular' });
  });

  it('bulk orders draw DC stock, scored separately', () => {
    const orders = [mkOrder('O2', 'DS01', '2026-06-01', [{ sku: 'A', qty: 12 }], true)];
    const dcPlan = { A: { min: 5, max: 20 } };
    const r = replay(PLAN, dcPlan, { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    expect(r.serviceLevels.bulk.overall).toBe(1);      // 20 ≥ 12
    expect(r.serviceLevels.regular.overall).toBe(1);   // unaffected
  });

  it('DC PO arrives after leadDays', () => {
    // drain DC below min on day1 via bulk, check refill on day 1+3
    const orders = [mkOrder('O2', 'DS01', '2026-06-01', [{ sku: 'A', qty: 16 }], true)];
    const dcPlan = { A: { min: 5, max: 20 } };
    const r = replay(PLAN, dcPlan, { orders, windowDates: DATES, bulkDaily: {} }, CFG);
    // day1 close: 20-16=4 ≤ 5 → PO 16 raised, arrives start of day4
    expect(r.dcStockByDate['A']['2026-06-03']).toBe(4);
    expect(r.dcStockByDate['A']['2026-06-04']).toBe(20);
  });

  it('infiniteDC mode never shorts TOs and still records drain', () => {
    const orders = [mkOrder('O1', 'DS01', '2026-06-01', [{ sku: 'A', qty: 3 }], false)];
    const r = replay(PLAN, null, { orders, windowDates: DATES, bulkDaily: {} }, { ...CFG, infiniteDC: true });
    expect(r.toDrain['A']['2026-06-02']).toBe(3);
  });
});
```

- [ ] **Step 3.2:** Run — FAIL.
- [ ] **Step 3.3: Implement `replay.js`**

```js
// Deterministic day-by-day replay (spec §7). One engine, two consumers:
// DC sizing (drain series, infiniteDC) and the Simulation panel (service levels).

export function replay(plan, dcPlan, demand, cfg) {
  const { orders, windowDates } = demand;
  const leadDays = cfg.leadDays ?? 3;
  const infiniteDC = !!cfg.infiniteDC;

  const skus = Object.keys(plan);
  const dsStock = {};            // sku → ds → qty
  const dcStock = {};            // sku → qty
  const dcOnOrder = {};          // sku → qty already on PO
  for (const sku of skus) {
    dsStock[sku] = {};
    for (const ds of Object.keys(plan[sku])) dsStock[sku][ds] = plan[sku][ds].max;
    dcStock[sku] = infiniteDC ? Infinity : (dcPlan?.[sku]?.max ?? 0);
    dcOnOrder[sku] = 0;
  }

  const ordersByDate = {};
  for (const o of orders) (ordersByDate[o.date] ??= []).push(o);

  const pendingTO = {};          // arriveDate → [{sku, ds, qty}]
  const pendingPO = {};          // arriveDate → [{sku, qty}]
  const toDrain = {};            // sku → date → requested qty (shipped from DC view)
  const oosEvents = [];
  const counts = { regular: { total: 0, oos: 0, perDS: {} }, bulk: { total: 0, oos: 0 } };
  const dcStockByDate = {};      // sku → date → closing qty (for tests/UI)
  const opsLoad = { toLines: 0, poLines: 0 };

  const nextDate = (i) => windowDates[i + 1];

  windowDates.forEach((date, i) => {
    // 1) Arrivals
    for (const t of pendingTO[date] || []) {
      const ship = infiniteDC ? t.qty : Math.min(t.qty, dcStock[t.sku]);
      if (!infiniteDC) dcStock[t.sku] -= ship;
      dsStock[t.sku][t.ds] += ship;
      (toDrain[t.sku] ??= {})[date] = ((toDrain[t.sku] ?? {})[date] || 0) + t.qty;
    }
    for (const p of pendingPO[date] || []) {
      dcStock[p.sku] += p.qty;
      dcOnOrder[p.sku] -= p.qty;
    }

    // 2) Demand
    for (const o of ordersByDate[date] || []) {
      let short = false;
      for (const { sku, qty } of o.lines) {
        if (!plan[sku]) continue; // not in plan (shouldn't happen for universe orders)
        if (o.isBulk) {
          const avail = dcStock[sku];
          if (avail < qty) { short = true; oosEvents.push({ type: 'bulk', orderId: o.id, date, ds: o.ds, sku, short: qty - Math.max(0, avail) }); }
          if (!infiniteDC) dcStock[sku] = Math.max(0, avail - qty);
        } else {
          const avail = dsStock[sku][o.ds] ?? 0;
          if (avail < qty) { short = true; oosEvents.push({ type: 'regular', orderId: o.id, date, ds: o.ds, sku, short: qty - avail }); }
          dsStock[sku][o.ds] = Math.max(0, avail - qty);
        }
      }
      if (o.isBulk) { counts.bulk.total += 1; if (short) counts.bulk.oos += 1; }
      else {
        counts.regular.total += 1;
        const d = (counts.regular.perDS[o.ds] ??= { total: 0, oos: 0 });
        d.total += 1;
        if (short) { counts.regular.oos += 1; d.oos += 1; }
      }
    }

    // 3) Closing: DS → TO, DC → PO
    const nd = nextDate(i);
    for (const sku of skus) {
      for (const [ds, p] of Object.entries(plan[sku])) {
        const s = dsStock[sku][ds];
        if (s <= p.min && p.max > s && nd) {
          (pendingTO[nd] ??= []).push({ sku, ds, qty: p.max - s });
          opsLoad.toLines += 1;
        }
      }
      if (!infiniteDC && dcPlan?.[sku]) {
        const { min, max } = dcPlan[sku];
        const position = dcStock[sku] + dcOnOrder[sku];
        if (position <= min && max > position) {
          const qty = max - position;
          const arrive = windowDates[i + leadDays];
          if (arrive) {
            (pendingPO[arrive] ??= []).push({ sku, qty });
            dcOnOrder[sku] += qty;
            opsLoad.poLines += 1;
          }
        }
      }
      (dcStockByDate[sku] ??= {})[date] = infiniteDC ? Infinity : dcStock[sku];
    }
  });

  const sl = {
    regular: {
      overall: counts.regular.total ? 1 - counts.regular.oos / counts.regular.total : 1,
      perDS: Object.fromEntries(Object.entries(counts.regular.perDS).map(([ds, c]) =>
        [ds, { total: c.total, oos: c.oos, service: c.total ? 1 - c.oos / c.total : 1 }])),
      total: counts.regular.total, oos: counts.regular.oos,
    },
    bulk: {
      overall: counts.bulk.total ? 1 - counts.bulk.oos / counts.bulk.total : 1,
      total: counts.bulk.total, oos: counts.bulk.oos,
    },
  };
  return { toDrain, oosEvents, serviceLevels: sl, opsLoad, dcStockByDate };
}
```

- [ ] **Step 3.4:** Run tests — PASS. (Walk the PO test by hand: day1 close 4 ≤ 5 → PO 16, position 4+16=20; arrives start of day 1+3 = index 3 = '2026-06-04'. Day2/3 closing position 20 → no re-order. ✓)
- [ ] **Step 3.5:** Commit: `git commit -am "feat(plywood-v2): replay simulator with order-level OOS scoring"`

---

### Task 4: DC sizing

**Files:**
- Create: `src/engine/strategies/plywoodV2/dc.js`
- Test: `src/engine/strategies/plywoodV2/__tests__/dc.test.js`

- [ ] **Step 4.1: Write failing tests**

```js
import { describe, it, expect } from 'vitest';
import { rollingSums, sizeDC } from '../dc.js';

const DATES = Array.from({ length: 10 }, (_, i) =>
  new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10));

describe('rollingSums', () => {
  it('computes L-day rolling sums including zero days', () => {
    const series = { [DATES[0]]: 2, [DATES[1]]: 2 };
    // window 3 over 10 dates → 8 windows: [2+2+0, 2+0+0, 0,0,0,0,0,0]
    expect(rollingSums(series, DATES, 3)).toEqual([4, 2, 0, 0, 0, 0, 0, 0]);
  });
});

describe('sizeDC', () => {
  it('repl component = P98 of rolling (L+1)-day drain sums; bulk additive; cycle stock on top', () => {
    // constant drain 2/day for all 10 days, L=3 → all 4-day sums = 8 → P98 = 8
    const toDrain = { A: Object.fromEntries(DATES.map(d => [d, 2])) };
    const bulkDaily = { A: { [DATES[2]]: 10 } }; // one bulk day: rolling 4-day sums max 10 → P90 of [0,0,10,10,10,10,0]≈...
    const { dcPlan, detail } = sizeDC(toDrain, bulkDaily, DATES, {
      leadDays: 3, dcReplPercentile: 98, dcBulkPercentile: 90, dcCoverDays: 2, bulkDcServedShare: 1.0,
    });
    expect(detail['A'].repl).toBe(8);
    expect(detail['A'].bulk).toBeGreaterThanOrEqual(8); // P90 of the bulk window sums
    expect(dcPlan['A'].min).toBe(detail['A'].repl + detail['A'].bulk);
    expect(dcPlan['A'].max).toBe(dcPlan['A'].min + detail['A'].cycle);
    expect(detail['A'].cycle).toBe(Math.ceil(2 * 2)); // mean drain 2/day × coverDays 2
  });

  it('share scales the bulk component', () => {
    const toDrain = { A: {} };
    const bulkDaily = { A: { [DATES[2]]: 10 } };
    const a = sizeDC(toDrain, bulkDaily, DATES, { leadDays: 3, dcBulkPercentile: 90, dcCoverDays: 0, bulkDcServedShare: 1.0 });
    const b = sizeDC(toDrain, bulkDaily, DATES, { leadDays: 3, dcBulkPercentile: 90, dcCoverDays: 0, bulkDcServedShare: 0.5 });
    expect(b.detail['A'].bulk).toBeLessThan(a.detail['A'].bulk);
  });
});
```

- [ ] **Step 4.2:** Run — FAIL.
- [ ] **Step 4.3: Implement `dc.js`**

```js
// DC sizing (spec §6): repl P98 of rolling (L+1)-day TO drain + bulk P90 (additive)
// + cycle stock (mean drain × coverDays). Optional thick/thin capacity trim.

import { percentile } from '../../utils.js';

export function rollingSums(series, windowDates, span) {
  const vals = windowDates.map(d => series?.[d] || 0);
  const out = [];
  for (let i = 0; i + span <= vals.length; i++) {
    let s = 0;
    for (let j = i; j < i + span; j++) s += vals[j];
    out.push(s);
  }
  return out;
}

export function sizeDC(toDrain, bulkDaily, windowDates, cfg) {
  const L = (cfg.leadDays ?? 3) + 1;
  const replP = cfg.dcReplPercentile ?? 98;
  const bulkP = cfg.dcBulkPercentile ?? 90;
  const cover = cfg.dcCoverDays ?? 2;
  const share = cfg.bulkDcServedShare ?? 1.0;

  const skus = [...new Set([...Object.keys(toDrain), ...Object.keys(bulkDaily)])].sort();
  const dcPlan = {}, detail = {};
  for (const sku of skus) {
    const drainSums = rollingSums(toDrain[sku], windowDates, L).sort((a, b) => a - b);
    const repl = Math.ceil(percentile(drainSums, replP) || 0);

    const scaled = {};
    for (const [d, q] of Object.entries(bulkDaily[sku] || {})) scaled[d] = q * share;
    const bulkSums = rollingSums(scaled, windowDates, L).sort((a, b) => a - b);
    const bulk = Math.ceil(percentile(bulkSums, bulkP) || 0);

    const totalDrain = windowDates.reduce((a, d) => a + (toDrain[sku]?.[d] || 0), 0);
    const meanDrain = windowDates.length ? totalDrain / windowDates.length : 0;
    const cycle = Math.ceil(meanDrain * cover);

    const min = repl + bulk;
    dcPlan[sku] = { min, max: min + cycle };
    detail[sku] = { repl, bulk, cycle };
  }
  return { dcPlan, detail };
}

// Capacity trim (spec §6): (1) drop cycle stock, (2) lower bulk percentile 90→85→80.
// Returns trimmed copies + report. Never touches the repl component.
export function trimDCToCapacity(dcPlan, detail, toDrain, bulkDaily, windowDates, cfg, dcCapacity, tclassOf) {
  if (!dcCapacity) return { dcPlan, detail, trimReport: null };
  const over = (p) => {
    const sums = { thick: 0, thin: 0 };
    for (const [sku, v] of Object.entries(p)) sums[tclassOf(sku)] += v.max;
    return { thick: sums.thick - (dcCapacity.thick ?? Infinity), thin: sums.thin - (dcCapacity.thin ?? Infinity), sums };
  };
  let cur = { dcPlan, detail }, o = over(cur.dcPlan);
  const steps = [];
  if (o.thick <= 0 && o.thin <= 0) return { ...cur, trimReport: { steps, final: o.sums } };

  // Step 1: drop cycle stock
  cur = sizeDC(toDrain, bulkDaily, windowDates, { ...cfg, dcCoverDays: 0 });
  steps.push('cycle stock removed');
  o = over(cur.dcPlan);
  // Step 2: lower bulk percentile
  for (const p of [85, 80]) {
    if (o.thick <= 0 && o.thin <= 0) break;
    cur = sizeDC(toDrain, bulkDaily, windowDates, { ...cfg, dcCoverDays: 0, dcBulkPercentile: p });
    steps.push(`bulk percentile → ${p}`);
    o = over(cur.dcPlan);
  }
  return { ...cur, trimReport: { steps, final: o.sums, stillOver: o.thick > 0 || o.thin > 0 } };
}
```

- [ ] **Step 4.4:** Run tests — PASS.
- [ ] **Step 4.5:** Commit: `git commit -am "feat(plywood-v2): drain-based DC sizing with additive bulk component"`

---

### Task 5: Keep Score

**Files:**
- Create: `src/engine/strategies/plywoodV2/keepScore.js`
- Test: `src/engine/strategies/plywoodV2/__tests__/keepScore.test.js`

Note: invoice rows carry qty only (no sales value), so sales basis = window qty ×
purchase price (cost basis ≈ sale value at 6% margin; immaterial for the ratio).

- [ ] **Step 5.1: Write failing tests**

```js
import { describe, it, expect } from 'vitest';
import { computeKeepScores } from '../keepScore.js';

describe('computeKeepScores', () => {
  const plan = { A: { DS01: { min: 2, max: 4 } } };       // avg position 3
  const dcPlan = { A: { min: 4, max: 6 } };                // avg position 5
  const cfg = { grossMarginPct: 0.06, carryRateQuarterly: 0.05, opsBuffer: 1.5, serviceNZDThreshold: 5 };

  it('computes rent and service ratios', () => {
    // holding value = (3 + 5) × PP 1000 = 8000; carrying = 8000×0.05×1.5 = 600
    // sales qty 100 × PP 1000 × 6% = 6000 margin → rent = 10
    const rows = computeKeepScores({ plan, dcPlan, priceData: { A: 1000 },
      windowQty: { A: 100 }, networkNZD: { A: 10 }, regularNZD: { A: 10 } }, cfg);
    const a = rows.find(r => r.sku === 'A');
    expect(a.rentRatio).toBeCloseTo(10, 5);
    expect(a.serviceRatio).toBeCloseTo(2, 5);
    expect(a.keepScore).toBeCloseTo(10, 5);
    expect(a.flag).toBe('Keep');
  });

  it('rent ratio gated to 0 when regular NZD < 2 (single fluke rule)', () => {
    const rows = computeKeepScores({ plan, dcPlan, priceData: { A: 1000 },
      windowQty: { A: 100 }, networkNZD: { A: 1 }, regularNZD: { A: 1 } }, cfg);
    const a = rows.find(r => r.sku === 'A');
    expect(a.rentRatio).toBe(0);
    expect(a.keepScore).toBeCloseTo(0.2, 5);  // service 1/5
    expect(a.flag).toBe('Cut');
  });

  it('watchlist band 1.0–1.3', () => {
    const rows = computeKeepScores({ plan, dcPlan, priceData: { A: 1000 },
      windowQty: { A: 0 }, networkNZD: { A: 6 }, regularNZD: { A: 6 } }, cfg);
    expect(rows[0].keepScore).toBeCloseTo(1.2, 5);
    expect(rows[0].flag).toBe('Watch');
  });
});
```

- [ ] **Step 5.2:** Run — FAIL.
- [ ] **Step 5.3: Implement `keepScore.js`**

```js
// Keep Score (spec §8): KeepScore = max(RentRatio [gated NZD≥2], ServiceRatio).
// Sales basis = window qty × purchase price (invoice rows carry no sale value).

export function computeKeepScores(inputs, cfg) {
  const { plan, dcPlan, priceData, windowQty, networkNZD, regularNZD } = inputs;
  const gm = cfg.grossMarginPct ?? 0.06;
  const carry = cfg.carryRateQuarterly ?? 0.05;
  const buffer = cfg.opsBuffer ?? 1.5;
  const svcTh = cfg.serviceNZDThreshold ?? 5;

  return Object.keys(plan).sort().map(sku => {
    const pp = priceData?.[sku] || 0;
    let avgPosition = 0;
    for (const p of Object.values(plan[sku])) avgPosition += (p.min + p.max) / 2;
    if (dcPlan?.[sku]) avgPosition += (dcPlan[sku].min + dcPlan[sku].max) / 2;
    const holdingValue = avgPosition * pp;
    const margin = (windowQty?.[sku] || 0) * pp * gm;
    const rentRaw = holdingValue > 0 ? margin / (holdingValue * carry * buffer) : 0;
    const rentRatio = (regularNZD?.[sku] || 0) >= 2 ? rentRaw : 0;
    const serviceRatio = (networkNZD?.[sku] || 0) / svcTh;
    const keepScore = Math.max(rentRatio, serviceRatio);
    const flag = keepScore < 1 ? 'Cut' : keepScore < 1.3 ? 'Watch' : 'Keep';
    return { sku, pp, avgPosition, holdingValue, rentRatio, serviceRatio, keepScore, flag };
  });
}
```

- [ ] **Step 5.4:** Run tests — PASS.
- [ ] **Step 5.5:** Commit: `git commit -am "feat(plywood-v2): keep score module"`

---

### Task 6: Assembly — `computePlywoodNetworkV2Results`

**Files:**
- Create: `src/engine/strategies/plywoodV2/index.js`
- Test: `src/engine/strategies/plywoodV2/__tests__/integration.test.js`
- Modify: `src/engine/index.js` (barrel)

Result shape MUST match what `runEngine.js:109-167` consumes from v1:
`{ [sku]: { brand, storeResults: { [ds]: { min, max, nonZeroCount, covers } }, dcResult: { min, max } } }`
— with `covers: [ds]` for every DS (all stocking nodes in v2), plus v2 extras under
`storeResults[ds].v2` and a top-level `v2` payload for the tab.

- [ ] **Step 6.1: Write failing test**

```js
import { describe, it, expect } from 'vitest';
import { computePlywoodNetworkV2Results, V2_DEFAULTS } from '../index.js';
import { DS_LIST } from '../../../constants.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'GreenPly 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
  'PLY-B': { sku: 'PLY-B', name: 'CenturyPly 6mm', brand: 'CenturyPly', status: 'Active', category: 'Plywood, MDF & HDHMR' },
};
const DATES = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 2, 11 + i)).toISOString().slice(0, 10));
const inv = [];
DATES.slice(0, 40).forEach((d, i) => inv.push({ sku: 'PLY-A', ds: 'DS01', qty: 2, date: d, shopifyOrder: `R${i}` }));
inv.push({ sku: 'PLY-A', ds: 'DS02', qty: 15, date: DATES[5], shopifyOrder: 'BULK1' });

describe('computePlywoodNetworkV2Results', () => {
  const params = { plywoodNetworkV2Config: { ...V2_DEFAULTS, dsCapacities: { DS01: { thick: 50, thin: 50 }, DS02: { thick: 50, thin: 50 }, DS03: { thick: 50, thin: 50 }, DS04: { thick: 50, thin: 50 }, DS05: { thick: 50, thin: 50 } } } };
  const res = computePlywoodNetworkV2Results(inv, SKUM, params);

  it('returns runEngine-compatible shape for every universe SKU at every DS', () => {
    for (const sku of ['PLY-A', 'PLY-B']) {
      expect(res[sku].brand).toBeTruthy();
      for (const ds of DS_LIST) {
        const sr = res[sku].storeResults[ds];
        expect(sr.min).toBeGreaterThanOrEqual(1);    // floors everywhere
        expect(sr.max).toBeGreaterThan(sr.min - 1);
        expect(sr.covers).toEqual([ds]);
      }
      expect(res[sku].dcResult.min).toBeGreaterThanOrEqual(0);
      expect(res[sku].dcResult.max).toBeGreaterThanOrEqual(res[sku].dcResult.min);
    }
  });

  it('respects capacity: ΣMax per ds×class ≤ cap', () => {
    const v2 = res['PLY-A'].v2;
    for (const ds of DS_LIST) for (const tc of ['thick', 'thin']) {
      const node = v2.nodeReport[ds][tc];
      if (node.capacity != null) expect(node.used).toBeLessThanOrEqual(node.capacity);
    }
  });

  it('returns empty when config missing', () => {
    expect(computePlywoodNetworkV2Results(inv, SKUM, {})).toEqual({});
  });
});
```

- [ ] **Step 6.2:** Run — FAIL.
- [ ] **Step 6.3: Implement `plywoodV2/index.js`**

```js
// Plywood Network v2 — assembly (spec §5–6, §10).
// Returns the same result shape runEngine's network bypass consumes.

import { DS_LIST } from '../../constants.js';
import { buildUniverse, prepareDemand } from './demand.js';
import { allocate } from './allocator.js';
import { replay } from './replay.js';
import { sizeDC, trimDCToCapacity } from './dc.js';

export const V2_DEFAULTS = {
  lookbackDays: 90,
  bulkOrderThreshold: 10,
  bulkDcServedShare: 1.0,
  minDepthStopPercentile: 99,
  dcReplPercentile: 98,
  dcBulkPercentile: 90,
  dcCoverDays: 2,
  thickBoundaryMm: 9,
  excludedBrands: ['Merino'],
  leadDays: 3,
  dsCapacities: {
    DS01: { thick: 360, thin: 150 }, DS02: { thick: 360, thin: 150 },
    DS03: { thick: 360, thin: 150 }, DS04: { thick: 225, thin: 150 },
    DS05: { thick: 200, thin: 150 },
  },
  dcCapacity: { thick: 1000, thin: 500 },
  keepScore: { grossMarginPct: 0.06, carryRateQuarterly: 0.05, opsBuffer: 1.5, serviceNZDThreshold: 5 },
};

export function computePlywoodNetworkV2Results(inv, skuM, params) {
  const cfg = params?.plywoodNetworkV2Config;
  if (!cfg) return {};
  const c = { ...V2_DEFAULTS, ...cfg };

  const universe = buildUniverse(skuM, c);
  if (Object.keys(universe).length === 0) return {};
  const demand = prepareDemand(inv, universe, c);
  if (!demand) return {};

  // DS plans
  const { plan, nodeReport, floor, tclass } = allocate(universe, demand, c);

  // DC: drain pass (infinite DC) → size → capacity trim
  const drainPass = replay(plan, null, demand, { ...c, infiniteDC: true });
  const sized = sizeDC(drainPass.toDrain, demand.bulkDaily, demand.windowDates, c);
  const { dcPlan, detail: dcDetail, trimReport } = trimDCToCapacity(
    sized.dcPlan, sized.detail, drainPass.toDrain, demand.bulkDaily,
    demand.windowDates, c, c.dcCapacity, (sku) => tclass[sku]);

  // Assemble runEngine-compatible results
  const results = {};
  for (const [sku, meta] of Object.entries(universe)) {
    const storeResults = {};
    for (const ds of DS_LIST) {
      const p = plan[sku][ds];
      const nzd = Object.keys(demand.regularDaily[sku]?.[ds] || {}).length;
      storeResults[ds] = {
        min: p.min, max: p.max, nonZeroCount: nzd, covers: [ds],
        v2: { floor: p.floor, depth: p.min - p.floor, tclass: tclass[sku] },
      };
    }
    const dc = dcPlan[sku] || { min: 0, max: 0 };
    results[sku] = {
      brand: meta.brand,
      storeResults,
      dcResult: { min: dc.min, max: dc.max },
      v2: { nodeReport, dcDetail: dcDetail[sku] || null, dcTrimReport: trimReport, floor: floor[sku] },
    };
  }
  return results;
}

// Re-exports for tab / harness use
export { buildUniverse, prepareDemand, medianOrderQty } from './demand.js';
export { allocate, thicknessClass } from './allocator.js';
export { replay } from './replay.js';
export { sizeDC, trimDCToCapacity, rollingSums } from './dc.js';
export { computeKeepScores } from './keepScore.js';
```

- [ ] **Step 6.4:** Add to `src/engine/index.js` barrel:

```js
export { computePlywoodNetworkV2Results, V2_DEFAULTS } from "./strategies/plywoodV2/index.js";
```

- [ ] **Step 6.5:** Run all tests: `npx vitest run` — all PASS.
- [ ] **Step 6.6:** Commit: `git commit -am "feat(plywood-v2): result assembly, runEngine-compatible shape"`

---

### Task 7: runEngine dispatch

**Files:**
- Modify: `src/engine/runEngine.js` (imports + lines ~100-101)
- Test: `src/engine/strategies/plywoodV2/__tests__/runEngine.test.js`

- [ ] **Step 7.1: Write failing test**

```js
import { describe, it, expect } from 'vitest';
import { runEngine } from '../../../runEngine.js';
import { V2_DEFAULTS } from '../index.js';

const SKUM = {
  'PLY-A': { sku: 'PLY-A', name: 'GreenPly 18mm', brand: 'GreenPly', status: 'Active', category: 'Plywood, MDF & HDHMR', inventorisedAt: 'DC' },
};
const inv = [{ sku: 'PLY-A', ds: 'DS01', qty: 2, date: '2026-06-01', shopifyOrder: 'O1' }];

describe('runEngine network_design_v2 dispatch', () => {
  it('routes ply SKUs through v2 when strategy selected', () => {
    const p = {
      overallPeriod: 45,
      categoryStrategies: { 'Plywood, MDF & HDHMR': 'network_design_v2' },
      plywoodNetworkV2Config: { ...V2_DEFAULTS },
    };
    const res = runEngine(inv, SKUM, {}, {}, new Set(), {}, p);
    expect(res['PLY-A'].stores.DS01.strategyTag).toBe('network_design');
    expect(res['PLY-A'].stores.DS01.min).toBeGreaterThanOrEqual(1);
  });
  it('does NOT run v2 when strategy is network_design (v1)', () => {
    const p = { overallPeriod: 45, categoryStrategies: { 'Plywood, MDF & HDHMR': 'network_design' } };
    const res = runEngine(inv, SKUM, {}, {}, new Set(), {}, p);
    // v1 with no plywoodNetworkConfig.brands → falls through to non-network path
    expect(res['PLY-A'].stores.DS01.strategyTag).not.toBe('network_design');
  });
});
```

- [ ] **Step 7.2:** Run — FAIL.
- [ ] **Step 7.3:** In `src/engine/runEngine.js` add import below the v1 import:

```js
import { computePlywoodNetworkV2Results } from "./strategies/plywoodV2/index.js";
```

Replace lines 100-101 (`const isNetworkDesign = ...` / `const plywoodNetworkResults = ...`) with:

```js
  const plyMode = p.categoryStrategies?.["Plywood, MDF & HDHMR"];
  const plywoodNetworkResults =
    plyMode === "network_design"    ? computePlywoodNetworkResults(inv, skuM, p)
    : plyMode === "network_design_v2" ? computePlywoodNetworkV2Results(inv, skuM, p)
    : {};
```

And in the fallthrough at line ~180, change the condition to cover both modes:

```js
    if (strategy === "network_design" || strategy === "network_design_v2") strategy = p.plywoodNonNetworkStrategy || "percentile_cover";
```

- [ ] **Step 7.4:** Run all tests — PASS. Also `npm run lint` clean on changed files.
- [ ] **Step 7.5:** Commit: `git commit -am "feat(plywood-v2): runEngine dispatch for network_design_v2"`

---

### Task 8: Validation harness (CHECKPOINT — review with user)

**Files:**
- Create: `scripts/validate-plywood-v2.mjs`

The harness downloads real data once into `.cache/` (gitignored), runs the full v2
compute + replay + keep score, and writes CSVs to `validation-out/`:
`plan.csv` (SKU×DS Min/Max + floor/depth), `capacity.csv`, `dc.csv` (component
breakdown), `service.csv` + `oos-events.csv`, `keepscore.csv`, and prints a summary.

- [ ] **Step 8.1: Implement the script**

```js
#!/usr/bin/env node
// Offline validation: real Supabase data → v2 plan + simulated service + keep score.
// READ-ONLY against Supabase. Writes only to .cache/ and validation-out/.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

const URL = 'https://rgyupnrogkbugsadwlye.supabase.co';
const KEY = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc';

async function fetchRow(table, id) {
  const path = `.cache/${table}-${id}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const r = await fetch(`${URL}/rest/v1/${table}?select=payload&id=eq.${id}`, { headers: { apikey: KEY } });
  const j = (await r.json())[0]?.payload ?? null;
  mkdirSync('.cache', { recursive: true });
  writeFileSync(path, JSON.stringify(j));
  return j;
}

const { computePlywoodNetworkV2Results, V2_DEFAULTS, buildUniverse, prepareDemand, replay, computeKeepScores } =
  await import('../src/engine/strategies/plywoodV2/index.js');
const { DS_LIST } = await import('../src/engine/constants.js');

const global_ = await fetchRow('team_data', 'global');
const invRow = await fetchRow('team_data', 'invoice_data');
const inv = invRow.invoiceData ?? invRow;
const skuM = global_.skuMaster, priceData = global_.priceData;

const cfg = { ...V2_DEFAULTS };           // tweak here between iterations
const params = { plywoodNetworkV2Config: cfg };

const res = computePlywoodNetworkV2Results(inv, skuM, params);
const universe = buildUniverse(skuM, cfg);
const demand = prepareDemand(inv, universe, cfg);

// Re-derive plan/dcPlan from results for the replay
const plan = {}, dcPlan = {};
for (const [sku, r] of Object.entries(res)) {
  plan[sku] = {};
  for (const ds of DS_LIST) plan[sku][ds] = { min: r.storeResults[ds].min, max: r.storeResults[ds].max };
  dcPlan[sku] = { ...r.dcResult };
}
const sim = replay(plan, dcPlan, demand, cfg);

// Keep score inputs
const windowQty = {}, networkNZD = {}, regularNZD = {};
for (const sku of Object.keys(universe)) {
  const dates = new Set();
  let q = 0;
  for (const o of demand.orders) for (const l of o.lines) if (l.sku === sku) { q += l.qty; dates.add(o.date); }
  windowQty[sku] = q; networkNZD[sku] = dates.size;
  const rd = new Set();
  for (const ds of DS_LIST) for (const d of Object.keys(demand.regularDaily[sku]?.[ds] || {})) rd.add(d);
  regularNZD[sku] = rd.size;
}
const scores = computeKeepScores({ plan, dcPlan, priceData, windowQty, networkNZD, regularNZD }, cfg.keepScore);

// ── CSVs ──
mkdirSync('validation-out', { recursive: true });
const csv = (rows) => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

const planRows = [['SKU', 'Name', 'Brand', 'Class', 'Floor', ...DS_LIST.flatMap(ds => [`${ds} Min`, `${ds} Max`]), 'DC Min', 'DC Max', 'DC Repl', 'DC Bulk', 'DC Cycle']];
for (const [sku, r] of Object.entries(res)) {
  planRows.push([sku, skuM[sku].name, r.brand, r.storeResults.DS01.v2.tclass, r.v2.floor,
    ...DS_LIST.flatMap(ds => [r.storeResults[ds].min, r.storeResults[ds].max]),
    r.dcResult.min, r.dcResult.max, r.v2.dcDetail?.repl ?? '', r.v2.dcDetail?.bulk ?? '', r.v2.dcDetail?.cycle ?? '']);
}
writeFileSync('validation-out/plan.csv', csv(planRows));

const anySku = Object.keys(res)[0];
const capRows = [['DS', 'Class', 'Capacity', 'Floor Used', 'Used', 'Util %', 'Over']];
for (const ds of DS_LIST) for (const tc of ['thick', 'thin']) {
  const n = res[anySku].v2.nodeReport[ds][tc];
  capRows.push([ds, tc, n.capacity, n.floorUsed, n.used, n.capacity ? Math.round(n.used / n.capacity * 100) : '', n.overCapacity ? 'FLOORS OVER CAP' : '']);
}
writeFileSync('validation-out/capacity.csv', csv(capRows));

const svc = sim.serviceLevels;
const svcRows = [['Scope', 'Total Orders', 'OOS', 'Service %']];
svcRows.push(['Regular (network)', svc.regular.total, svc.regular.oos, (svc.regular.overall * 100).toFixed(2)]);
for (const [ds, c] of Object.entries(svc.regular.perDS)) svcRows.push([`Regular ${ds}`, c.total, c.oos, (c.service * 100).toFixed(2)]);
svcRows.push(['Bulk (DC)', svc.bulk.total, svc.bulk.oos, (svc.bulk.overall * 100).toFixed(2)]);
writeFileSync('validation-out/service.csv', csv(svcRows));

writeFileSync('validation-out/oos-events.csv', csv([
  ['Type', 'Order', 'Date', 'DS', 'SKU', 'Short'],
  ...sim.oosEvents.map(e => [e.type, e.orderId, e.date, e.ds, e.sku, e.short]),
]));

writeFileSync('validation-out/keepscore.csv', csv([
  ['SKU', 'Name', 'PP', 'Avg Position', 'Holding Val', 'Rent Ratio', 'Service Ratio', 'Keep Score', 'Flag'],
  ...scores.map(s => [s.sku, skuM[s.sku]?.name, s.pp, s.avgPosition.toFixed(1), Math.round(s.holdingValue),
    s.rentRatio.toFixed(2), s.serviceRatio.toFixed(2), s.keepScore.toFixed(2), s.flag]),
]));

console.log(`Universe: ${Object.keys(universe).length} SKUs`);
console.log(`Regular service: ${(svc.regular.overall * 100).toFixed(2)}% (${svc.regular.oos}/${svc.regular.total} OOS)`);
console.log(`Bulk service:    ${(svc.bulk.overall * 100).toFixed(2)}% (${svc.bulk.oos}/${svc.bulk.total} OOS)`);
console.log(`TO lines: ${sim.opsLoad.toLines}, PO lines: ${sim.opsLoad.poLines} over ${demand.windowDates.length} days`);
console.log(`Keep flags: ${['Keep', 'Watch', 'Cut'].map(f => `${f}=${scores.filter(s => s.flag === f).length}`).join(' ')}`);
console.log('CSVs written to validation-out/');
```

- [ ] **Step 8.2:** Run: `node scripts/validate-plywood-v2.mjs`. Expect: summary printed, 5 CSVs in `validation-out/`, no capacity overruns (or floors-over-cap flags to investigate).
- [ ] **Step 8.3:** Sanity-check outputs: regular service should be high (target ≥99%); capacity util ≤100% everywhere; DC totals plausible vs dcCapacity. Investigate anomalies before proceeding.
- [ ] **Step 8.4:** Commit: `git commit -am "feat(plywood-v2): offline validation harness"`
- [ ] **Step 8.5: CHECKPOINT — present the summary + CSVs to the user for review before building UI.**

---

### Task 9: App config plumbing + strategy option

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 9.1:** Load v2 config alongside v1 (pattern at `App.jsx:2946-2950`, also the auto/bundle loaders at `:3063` and `:3094` — grep `plywoodNetworkConfig` and mirror each site):

```js
      const sbPnc2 = await loadFromSupabase("params", "plywoodNetworkV2Config");
      if (sbPnc2) {
        setParams(prev => ({ ...prev, plywoodNetworkV2Config: sbPnc2 }));
        setSaved(prev => ({ ...prev, plywoodNetworkV2Config: sbPnc2 }));
      }
```

- [ ] **Step 9.2:** Strip v2 config from `params/global` saves (pattern at `App.jsx:3272-3273`):

```js
    const { plywoodNetworkConfig: _pnc, plywoodNetworkV2Config: _pnc2, ...saveableParams } = np;
```

- [ ] **Step 9.3:** Add save handler near the v1 one (`App.jsx:2991-2995`), saving to `params/plywoodNetworkV2Config` and re-running the model (same shape as v1 handler).
- [ ] **Step 9.4:** Add the strategy option in the Logic Tweaker dropdown (`App.jsx:4114`):

```jsx
                              <option value="network_design_v2">Network Design v2</option>
```

(Only for the Plywood category — same conditional as the existing `network_design` option.)
- [ ] **Step 9.5:** `npm run lint` + `npm run build` — clean. Manually verify in dev that selecting v2 in Logic Tweaker (WITHOUT clicking Apply) shows no errors.
- [ ] **Step 9.6:** Commit: `git commit -am "feat(plywood-v2): config plumbing + strategy option"`

---

### Task 10: UI tab

**Files:**
- Create: `src/tabs/PlywoodNetworkV2Tab.jsx`
- Modify: `src/App.jsx` (import, tab registration next to PlywoodNetworkTab at `:3789`, tab list entry — grep how `"Plywood Network"` is added to the tab name list and mirror with `"Plywood Network v2"`)

The tab computes everything client-side from props (`invoiceData`, `skuMaster`,
`priceData`, `params`) using the engine exports — no Supabase writes except the
admin Save Config button. Four panels (sub-components in the same file, matching the
existing single-file tab pattern):

1. **Allocation** — DS selector; table: SKU, Name, Brand, Class, Floor, Depth, Min,
   Max, regular NZD; capacity bars per class (`used/capacity`, red when ≥100%).
2. **DC** — table: SKU, Repl, Bulk, Cycle, DC Min, DC Max; trim report banner if any.
3. **Simulation** — date-range inputs (default: full lookback window) + "Run
   Simulation" button → service cards (Regular overall + per DS, Bulk) + OOS events
   table (sortable by date/DS/SKU) + ops load line. Runs `replay()` synchronously.
4. **Keep Score** — table from `computeKeepScores` + Flag filter + "Export CSV"
   button (client-side blob download).
5. **Config** (admin) — numeric inputs for every `V2_DEFAULTS` key, capacities
   matrix (5 DS × thick/thin + DC), Save button (admin only) → save handler from
   Task 9.

- [ ] **Step 10.1:** Build the tab shell with panel nav + Allocation panel. Recompute via `useMemo` on `[invoiceData, skuMaster, cfgDraft]`:

```jsx
const v2res = useMemo(() => {
  if (!invoiceData?.length || !Object.keys(skuMaster).length) return null;
  return computePlywoodNetworkV2Results(invoiceData, skuMaster, { plywoodNetworkV2Config: cfgDraft });
}, [invoiceData, skuMaster, cfgDraft]);
```

- [ ] **Step 10.2:** DC panel.
- [ ] **Step 10.3:** Simulation panel — window slice: `inv.filter(r => r.date >= from && r.date <= to)` re-fed through `prepareDemand`, then `replay(plan, dcPlan, demand, cfg)` where plan/dcPlan derive from `v2res` (same re-derivation as the harness).
- [ ] **Step 10.4:** Keep Score panel.
- [ ] **Step 10.5:** Config panel with local draft state; Save button hidden for non-admins (mirror PlywoodNetworkTab's admin pattern — grep `isAdmin` in that file).
- [ ] **Step 10.6:** Register tab in App.jsx; verify it renders for non-admins read-only.
- [ ] **Step 10.7:** `npm run lint && npm run build && npx vitest run` — all clean/pass.
- [ ] **Step 10.8:** Commit: `git commit -am "feat(plywood-v2): tab UI — allocation, DC, simulation, keep score, config"`

---

### Task 11: Final verification + handoff

- [ ] **Step 11.1:** Full test suite: `npx vitest run` — all pass.
- [ ] **Step 11.2:** `npm run build` — clean.
- [ ] **Step 11.3:** `npm run dev` → verify on localhost: tab renders with real data; capacity bars ≤100%; simulation runs and matches harness numbers (same window → same service %); config edits recompute live; **no Supabase write occurs** (check network panel: only GETs; do NOT click Apply & Re-run / Save Config against prod).
- [ ] **Step 11.4:** Re-run harness, diff service numbers vs tab.
- [ ] **Step 11.5:** Hand off to user with: branch name, `npm run dev` instructions, summary of validation numbers, list of config knobs to play with.

---

## Self-review notes

- **Spec coverage:** §3 universe (Task 1), §4 demand/bulk (Task 1), §5 allocator (Task 2), §6 DC (Task 4), §7 simulator (Task 3 + panel in 10), §8 keep score (Task 5), §9 config (Tasks 6/9/10), §10 integration (Tasks 7/9/10), §11 safety (branch, read-only harness, dormant strategy, checkpoint at Task 8).
- **Known simplifications (documented):** TO/PO arrivals at start-of-day; partial-fulfilment decrements stock for short lines; keep score uses cost-basis sales.
- **Type consistency check:** `plan[sku][ds] = {min, max, floor}`; `dcPlan[sku] = {min, max}`; demand object `{orders, regularDaily, bulkDaily, regOrderQtys, windowDates, cutoff}` — consistent across allocator/replay/dc/keepScore/harness/tab.
