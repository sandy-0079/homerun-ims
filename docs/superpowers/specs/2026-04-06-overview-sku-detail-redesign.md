# Overview & SKU Detail Tab Redesign — Design Spec

**Date:** 2026-04-06
**Status:** Draft

---

## Problem

The two most-used tabs (Dashboard and SKU Order Behaviour) serve a single workflow — "see Min/Max, understand why" — but require context-switching between tabs. The Dashboard shows SKU-level data without explanation; Insights forces a 4-level drilldown to reach one SKU. The redesign collapses this into a more natural flow.

---

## Changes Summary

| Current | New |
|---|---|
| Dashboard tab (SKU-level table) | **Overview tab** (Category → Brand → SKU drill-down) |
| SKU Order Behaviour tab (Insights) | **SKU Detail tab** (direct SKU search + jump from Overview) |

Other tabs (OOS Simulation, Upload Data, Tool Output, Logic Tweaker, Manual Overrides) remain unchanged.

---

## 1. Overview Tab

### 1.1 KPI Strip

5 cards (removing Dead Stock):
- **Active SKUs** — engine-based, does not change with period picker
- **SKUs Sold** — respects period picker
- **Zero Sale SKUs** — respects period picker
- **Inv Value Min** — engine-based
- **Inv Value Max** — engine-based

### 1.2 Period Picker

- Presets in order: **L90D, L60D, L45D, L30D, L15D, L7D**
- Date picker for custom range
- Label: "Data available: {earliest date} → {latest date}" derived from uploaded invoice data
- **Does NOT impact engine Min/Max calculations.** Only affects sold qty, sold value, and derived coverage metrics.
- Earliest selectable date = first invoice date in upload; latest = last invoice date

### 1.3 Store Picker

- Dropdown defaulting to **"All Stores"** (DS01–DS05 aggregated)
- Additional options: DS01, DS02, DS03, DS04, DS05, DC
- All columns slice to the selected store
- "All Stores" does NOT include DC (DC is a separate pool)

### 1.4 Drill-Down: Category → Brand → SKU

**Navigation:**
- Breadcrumb trail: `All Categories › Tiling › Kajaria`
- Explicit **Back button** alongside breadcrumb
- Click any breadcrumb segment to jump back

#### Category Level (default view)

| Column | Description |
|---|---|
| Category | Category name (clickable → drills to Brand) |
| Active SKUs | Count of active SKUs in category |
| SKUs Sold | SKUs with ≥1 sale in selected period |
| Zero Sale SKUs | SKUs with 0 sales in selected period |
| Sold Qty | Total units sold in selected period |
| Sold Value | Total ₹ value sold in selected period (requires avg purchase price) |
| Inv Value Min | ₹ value at engine Min levels |
| Inv Value Max | ₹ value at engine Max levels |
| Days Coverage Min | Inv Value Min ÷ daily sold value |
| Days Coverage Max | Inv Value Max ÷ daily sold value |

Default sort: Inv Value Max descending.
Column headers clickable for re-sorting.

#### Brand Level

Same columns as Category level, scoped to the selected category.
Click brand row → drills to SKU level.

#### SKU Level

| Column | Description |
|---|---|
| SKU | SKU name + ID |
| Movement | Movement tag |
| Price Tag | Price tag |
| Daily Avg | Daily average quantity |
| ABQ | Average basket quantity |
| Sold Qty | Units sold in selected period |
| Sold Value | ₹ value sold in selected period |
| Inv Value Min | ₹ value at engine Min |
| Inv Value Max | ₹ value at engine Max |
| Days Coverage Min | Inv Value Min ÷ daily sold value |
| Days Coverage Max | Inv Value Max ÷ daily sold value |

Plus: compact **per-store breakdown** row showing DS01–DS05 + DC Min/Max for each SKU.

SKU rows link to **SKU Detail tab** (pre-loaded with that SKU).

### 1.5 Edge Cases

- **Zero sales in selected period:** Days Coverage shows "No Sale"
- **No price data for SKU:** Sold Value, Inv Value, Days Coverage show "–"
- **Store picker = DC:** Shows DC Min/Max and DC-level sold data

---

## 2. SKU Detail Tab

### 2.1 Entry Points

1. **Direct search:** Text input at top of tab. User types SKU ID or name, hits Enter or clicks search button. Tab populates with that SKU's data.
2. **Jump from Overview:** Clicking an SKU row in Overview navigates to SKU Detail with that SKU pre-loaded.

### 2.2 Controls

**DS Picker:** All, DS01, DS02, DS03, DS04, DS05 (no Compare mode). Both charts and cards follow this picker.

**Period Picker:** Presets: **L90D, L60D, L45D, L30D, L15D, L7D** + date picker. Controls the charts and order behaviour stats. Does NOT change the engine Min/Max (those always use Logic Tweaker's overallPeriod).

### 2.3 Per-DS Cards (Large, Detailed)

One card per DS (DS01–DS05), each showing the **full computation breakdown** for how the tool arrived at Min/Max for that SKU at that store. Card content varies by strategy:

#### Standard Strategy Card

- **Tags:** Movement, Price, Spike
- **Long period** ({actualLongDays}D): daily avg, spike median, non-zero days, Min, Max
- **Recent period** ({actualRecentDays}D): daily avg, spike median, non-zero days, Min, Max
- **Recency weight:** movement → weight value (e.g., "Fast → 3×")
- **Blended:** Min, Max
- **Post-blend adjustments** (if any): which rule, what it changed (e.g., "SKU Floor: floor Min 5 > computed 3 → Min = 5")
- **Final Min, Max**

#### Percentile Cover Strategy Card

- **Tags:** Movement, Price
- **Period:** Full {overallPeriod}D (no long/recent split)
- **Price → Percentile:** e.g., "Low → P95"
- **Pxx value** of non-zero daily quantities
- **Movement → Cover days:** e.g., "Moderate → 1 day"
- **Daily avg, buffer days**
- **Computed Min, Max**
- **Post-blend adjustments** (if any)
- **Final Min, Max**

#### Fixed Unit Floor Strategy Card

- **Tags:** Movement, Price
- **Period:** Full {overallPeriod}D
- **P90 of individual order quantities**
- **Max formula:** max(Min + additive, Min × multiplier)
- **Computed Min, Max**
- **Post-blend adjustments** (if any)
- **Final Min, Max**

### 2.4 DC Card (Detailed)

- **DC Movement tag**
- **Sum of DS Mins, Sum of DS Maxes**
- **Brand lead time** (e.g., "2 days")
- **DC multipliers applied** (e.g., "Super Fast → 0.75 min, 1.0 max")
- **Lead-time formula result** (sumDailyAvg × leadTimeDays)
- **Final DC Min, Max**

### 2.5 Two Charts Side by Side

Both charts sit below the DS + DC cards. Both follow the DS picker and period picker.

#### Chart 1: Order Qty Frequency (existing)
- X-axis: order quantity values
- Y-axis: count of orders at that quantity
- Shows demand shape / distribution

#### Chart 2: Date-Level Orders (new)
- X-axis: dates in selected period
- Y-axis: quantity ordered on that date
- Shows demand over time — trends, spikes, gaps
- Zero-order dates show as 0

### 2.6 DS Picker Behaviour

- **Single DS (e.g., DS03):** Cards highlight that DS, charts show only that DS's data
- **All:** Cards show all DS, charts show merged/aggregated data

---

## 3. What's NOT Changing

- OOS Simulation tab — unchanged
- Upload Data tab — unchanged
- Tool Output tab — unchanged
- Logic Tweaker tab — unchanged
- Manual Overrides tab — unchanged
- Engine logic — no computation changes
- Admin/public access model — unchanged
- All data input formats (CSVs) — unchanged

---

## 4. Data Dependencies

- **Sold Value** requires Average Purchase Price upload (optional CSV). SKUs without price → "–"
- **Inv Value** requires Average Purchase Price. SKUs without price → "–"
- **Days Coverage** requires both Inv Value and Sold Value. If either missing → "No Sale" or "–"
- **Per-DS card computation details** require intermediate engine values (daily avg, percentile values, spike median, etc.) to be surfaced from the engine. Currently some intermediate values are not returned in results — engine will need to expose them.

---

## 5. Technical Notes

- All UI lives in `src/App.jsx` (~3,800 lines). New tabs replace existing Dashboard and Insights code.
- Engine intermediate values need to be added to the results object in `src/engine/runEngine.js`.
- No new dependencies required. Charts use existing inline SVG/canvas patterns.
- Virtualised rendering should be maintained for SKU-level tables in Overview (can be 1,500+ rows at brand level for large categories).
