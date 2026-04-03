# CLAUDE.md — HomeRun Inventory Management System

This file gives you complete context on the HomeRun IMS tool — what is already live, why we are building a new version, and what the new version needs to do. Read this fully before making any changes.

---

## 1. What Is This Tool

HomeRun is into quick commerce of construction materials operating 5 dark stores (DS01–DS05) and one distribution centre (DC). The IMS tool computes Min/Max inventory levels for every SKU at every store and at the DC, so the team knows how much stock to hold.

The tool currently lives at a Vercel URL, is built in React + Vite, syncs state via Supabase, and is the primary inventory decision support system for the operations team.

---

## 2. Current Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Hosting | Vercel (auto-deploy from GitHub on push) |
| Database | Supabase (PostgreSQL — three tables: `params`, `overrides`, `team_data`) |
| Source Control | GitHub (sandy-0079/homerun-ims) |
| Simulation | Web Worker (simWorker.js) for OOS simulation |

### Environment Variables (set in Vercel)

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | https://rgyupnrogkbugsadwlye.supabase.co |
| `VITE_SUPABASE_ANON_KEY` | eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc |
| `VITE_ADMIN_PASSWORD` | IMSAdmin123 |

### Supabase Tables

All three tables share this schema:
```sql
create table <table_name> (
  id text primary key,   -- always "global"
  payload jsonb,
  updated_at timestamptz
);
```

RLS is enabled. Public read + anon write policies on all three tables.

---

## 3. Current Live Tool — Complete Feature Reference

### 3.1 Access Model

| Feature | Admin | Public |
|---|---|---|
| Dashboard | ✅ | ✅ |
| SKU Order Behaviour (Insights) | ✅ | ✅ |
| OOS Simulation | ✅ | ✅ |
| Tool Output Download | ✅ | ✅ |
| Upload Data | ✅ | ❌ |
| Logic Tweaker | ✅ | ❌ |
| Manual Overrides | ✅ | ❌ |

Admin login via password modal (top right). Session stored in localStorage.

---

### 3.2 Data Inputs

#### Required CSVs

| File | Key Columns | Purpose |
|---|---|---|
| Invoice Dump | Invoice Date, SKU, Line Item Location Name, Quantity, Invoice Status | Core sales history. Only "Closed" / "Overdue" rows used. Rolling 90-day window kept. |
| SKU Master | Name, SKU, Category, Brand, Status, Inventorised At | Item metadata |

#### Optional CSVs

| File | Key Columns | Purpose |
|---|---|---|
| Average Purchase Price | sku, average_price | Price tagging + inventory value calculations |
| New DS Floor Qty | SKU, Qty | Min floor for new dark stores for top-N SKUs |
| SKU Floors | SKU, DS01 Min, DS01 Max, ..., DS05 Max | Per-store manual Min/Max floors for any SKU |
| Dead Stock List | Dead Stock (SKU) | Forces Max = Min for flagged SKUs |

#### Store Reference
DS01, DS02, DS03, DS04, DS05, DC. DS04 and DS05 are "New Dark Stores" by default.

---

### 3.3 Model Logic — Full Detail

#### Step 1: Data Preparation

- Invoice rows filtered to status "Closed" or "Overdue"
- Sorted by date; only most recent N unique sale dates kept (N = Overall Period from Logic Tweaker, default 90)
- Split into:
  - **Long period** = first (90 − recency window) dates. Default: 75 days
  - **Recent period** = last N dates. Default: 15 days
- Daily maps built per SKU × DS:
  - `qMap[sku||ds][date]` = total qty sold
  - `oMap[sku||ds][date]` = number of order lines

#### Step 2: T150 Ranking

Total qty sold per SKU across all DS over 90 days, ranked descending:

| Rank | Tag |
|---|---|
| 1–50 | T50 |
| 51–150 | T150 |
| 151–250 | T250 |
| 251+ | No |
| Active, zero sales | Zero Sale |

#### Step 3: Stats Computation (per period)

| Metric | Formula |
|---|---|
| Daily average | Total qty ÷ period length (zero days included in denominator) |
| ABQ | Total qty ÷ total order lines (0 if no orders) |
| Non-zero days | Count of days with qty > 0 |
| Spike days | Days where qty > spikeMultiplier × dailyAvg (default 5×) |
| Spike median | Median of spike day qtys. If no spike days: spike median = max single-day qty |

#### Step 4: Tagging (always on full 90-day period)

**Movement Tag** — avg interval = 90 ÷ non-zero days:

| Avg interval | Tag |
|---|---|
| ≤ 2 days | Super Fast |
| ≤ 4 days | Fast |
| ≤ 7 days | Moderate |
| ≤ 10 days | Slow |
| > 10 days or zero sales | Super Slow |

**Spike Tag:**

| Condition | Tag |
|---|---|
| Spike days ≥ 10% of period | Frequent |
| Spike days ≥ 5% of period | Once in a while |
| Spike days > 0 | Rare |
| Spike days = 0 | No Spike |

**Price Tag:**

| Threshold | Tag |
|---|---|
| ≥ ₹3,000 | Premium |
| ≥ ₹1,500 | High |
| ≥ ₹400 | Medium |
| ≥ ₹100 | Low |
| > ₹0 | Super Low |
| = ₹0 or missing | No Price |

#### Step 5: Min/Max Per Period

Base min days (configurable):

| Movement | Default |
|---|---|
| Super Fast | 6 days |
| Fast | 5 days |
| Moderate / Slow / Super Slow | 3 days |

Spike ratio override applies when: Spike tag = Frequent OR No Spike, OR (Once in a while / Rare AND price is Low / Super Low / No Price).

- **With override:** Min = `CEILING(MAX(baseMinDays × dailyAvg, spikeMedian))`; Max = `CEILING(MAX((baseMinDays + buffer) × dailyAvg, spikeMedian + buffer × dailyAvg))`
- **Without override:** Min = `CEILING(baseMinDays × dailyAvg)`; Max = `CEILING((baseMinDays + buffer) × dailyAvg)`

ABQ floor: If movement is Slow/Super Slow AND price is Medium/Low/Super Low AND ABQ > 0, and CEILING(ABQ) ≥ current Min → Min = CEILING(ABQ), Max = CEILING(Min × abqMaxMultiplier, default 1.5×).

#### Step 6: Blending Long + Recent

Recency weights (configurable):

| Movement | Default weight |
|---|---|
| Super Fast | 2 |
| Fast | 3 |
| Moderate | 1.5 |
| Slow / Super Slow | 1 |

- Blended Min = `CEILING((longMin + recentMin × wt) ÷ (1 + wt))`
- Blended Max = `CEILING((longMax + recentMax × wt) ÷ (1 + wt))`

#### Step 7: Post-Blend Adjustments (strict order)

1. **New DS Floor** — if DS is flagged New DS and SKU is in top-N (default top 150): floor > blend → Min = Max = floor. Tagged "New DS Floor".
2. **Brand Buffer** — if brand has buffer days configured and dailyAvg > 0: Min = CEILING((DOC + bufferDays) × dailyAvg), Max = Min. Tagged "Brand Buffer".
3. **SKU Floor Override** — if manual per-store floor exists and exceeds current Min: Min = floor Min, Max = max(floor Max, engine Max). Tagged "SKU Floor". Runs last — wins if it raises Min above everything else. Supports separate Min and Max values per DS.
4. **Dead Stock cap** — Max = Min.
5. **Final rounding** — Math.round() on both values.

#### Step 8: DC Calculation

DC movement tag = avg interval of combined DS sales ÷ activeDSCount (default 4). Because non-zero days is capped at 90, minimum interval = 1.0, so Fast always merges to Super Fast.

DC Min = `ROUND(Σ DS Mins × min multiplier)`. DC Max = `ROUND(Σ DS Maxes × max multiplier)`.

Default DC multipliers:

| DC Movement | Min | Max |
|---|---|---|
| Super Fast | 0.75 | 1.00 |
| Fast | 0.50 | 0.75 |
| Moderate | 0.50 | 0.75 |
| Slow | 0.25 | 0.50 |
| Super Slow | 0.25 | 0.50 |
| Dead Stock | 0.25 | 0.25 |

---

### 3.4 Header Bar

- Period display: "Period Considered: 15 Feb '26 → 31 Mar '26 (45D)" — positioned left of nav buttons, reflects the Overall Period setting from Logic Tweaker
- All period-dependent displays (date range, KPIs, Insights slicing) respect the selected overall period

### 3.5 Dashboard Tab

- KPI strip: Active SKUs, Active SKUs Sold, Zero Sale SKUs, Dead Stock, Inv Value Min, Inv Value Max — SKUs Sold and Zero Sale computed within the selected overall period
- Filter bar: search, category, status, store, price tag, top-N, movement, logic tag
- Virtualised table (renders only visible rows) with frozen left columns: Item, Category, Status, Price Tag, Top N
- Per DS: Movement tag, Logic tag, Daily Avg, ABQ, Min, Max
- Per DC: Movement, Non-Zero Days, Min, Max
- Logic tags: Base Logic / New DS Floor / SKU Floor / Brand Buffer / Manual Override

---

### 3.6 Insights Tab (SKU Order Behaviour)

- Period toggle: 90D / 75D / 15D / Custom (1–90 days)
- DS view: All / DS01–DS05 / Compare
- Stats strip: SKUs, Instances, Qty, ABQ
- Movement distribution bar
- Drilldown: Org → Category → Brand → SKU
- SKU level: per-DS cards, DC card, order qty frequency chart (X = order qty, Y = order count)

---

### 3.7 OOS Simulation Tab

Replays last N trading days (default 15, up to 90) of invoice data against model Min/Max. Processes every individual order line preserving intra-day sequence.

**Simulation per SKU × DS:**
- Stock opens at Max
- Per order: fulfilled = MIN(order qty, stock); OOS if short; stock decreases
- End of day: if closing stock ≤ Min → restock to Max (same-day procurement trigger)

**OOS Rate** = OOS instances ÷ total order instances.

- Drilldown: Org → Category → Brand → SKU table with per-DS sub-rows and order-by-order breakdown
- Day strip per DS: 🟩 all fulfilled / 🟨 mixed / 🟥 all OOS / ⬜ no orders
- Clean DS summary row: stores with orders but zero OOS

**What-If simulation:**
- Download OOS CSV → fill New Min / New Max → re-upload → side-by-side Tool vs Override
- Apply to Core: saves overrides to Supabase, reflected across all tabs, requires admin password confirmation

---

### 3.8 Upload Data Tab (Admin only)

- 6 upload cards: Invoice Dump, SKU Master, Average Purchase Price, New DS Floor Qty, SKU Floors - DS Level, Dead Stock List
- Each card has 4 buttons: Upload CSV, Template (blank), Data (download currently uploaded data), Clear
- SKU Floors CSV format: SKU, DS01 Min, DS01 Max, ..., DS05 Min, DS05 Max (backward-compatible with old single-column format)
- Upload replaces entire dataset (not incremental merge)

### 3.9 Tool Output Download Tab

- Two download buttons:
  - **Tool Output DS Level** (green): Item Name, SKU, Category, DS01-DS05 Min/Max — effective values with floors + overrides applied
  - **Tool Output DC** (blue): Item Name, SKU, Category, DC Min, DC Max
- **SKU Master CSV** (purple): enriched SKU master with computed tags

### 3.10 Logic Tweaker Tab (Admin only)

3-column layout:
- **Col 1:** Analysis period, recency window, recency weights, DC multipliers, active DS count
- **Col 2:** Base min days, movement boundaries, price boundaries, spike params, max days buffer, ABQ multiplier, brand buffer days, new DS logic, **Category Strategy Engine** (category→strategy assignment, percentile cover params, fixed unit floor params, brand lead time days)
- **Col 3:** Impact Preview — shadow model run, shows SKUs affected, ₹ delta by movement tag / store / category

Sticky bar when unsaved changes: Reset / Run Preview / Apply & Re-run. Navigation guard intercepts tab switches with unsaved changes.

On Apply & Re-run: params saved to Supabase, model reruns, results pushed to all users.

---

### 3.11 Manual Overrides Tab (Admin only)

Shows **one row per SKU** with all DS + DC columns for any SKU that has an OOS Simulation override or a SKU Floor entry.

- **KPI cards:** 2 cards — Inventory Value (Min) and Inventory Value (Max), each showing Before → After → Delta (includes DC impact)
- **Before** values use pre-floor engine output; **After** uses effective values with floors + overrides applied
- **Per-DS columns:** Tool Min, Tool Max, Override Min, Override Max (4 sub-columns per DS)
- **DC columns:** Tool Min, Tool Max, Override Min, Override Max (override shows effective DC values when floors push DS values up)
- **Source column:** "OOS Sim" (blue pill) or "SKU Floor" (purple pill), or both
- **Actions:** Remove button for OOS Simulation overrides only; SKU Floor entries managed via re-upload
- **Filters:** Search, category, source (All / OOS Simulation / SKU Floor)
- OOS Simulation overrides sync to Supabase immediately

---

### 3.12 Default Parameters

| Parameter | Default |
|---|---|
| Overall period | 90 days |
| Recency window | 15 days |
| Spike multiplier | 5× |
| Spike pct frequent | 10% |
| Spike pct once | 5% |
| Max days buffer | 2 days |
| ABQ max multiplier | 1.5× |
| Active DS count | 4 |
| New DS floor top-N | 150 |
| New DS list | DS04, DS05 |
| Movement intervals | ≤2 / ≤4 / ≤7 / ≤10 days |
| Price tiers | ₹3,000 / ₹1,500 / ₹400 / ₹100 |

---

## 4. Category Strategy Engine (SHIPPED — April 2026)

The original model used a single average-based formula for all SKUs. This failed for slow-moving SKUs with erratic demand — 78.7% of all SKU×DS combos are Slow or Super Slow, and averages are near-zero for items that sell once every 10+ days.

### 4.1 What Was Built

A **strategy dispatcher** that routes each SKU to a different Min/Max calculation method based on its category. The engine sits in `src/engine/` as a modular set of files (extracted from the original monolithic App.jsx).

### 4.2 The Three Strategies

#### Standard (existing engine, unchanged)
- Uses daily average × base min days, with long/recent blending and recency weights
- Works well for categories with regular, frequent sales
- All existing params (spike, ABQ floor, recency weights) continue to apply

#### Percentile Cover (new)
Instead of averages, stocks based on the **Xth percentile of non-zero daily quantities**.

- **Percentile selected by price tag** — cheap items stocked more aggressively (hard to emergency-source), premium items leaner (easy to source on demand):

| Price Tag | Percentile |
|---|---|
| Low / Super Low / No Price | 95th |
| Medium | 85th |
| High | 80th |
| Premium | 75th |

- **Cover days selected by movement tag:**

| Movement | Cover Days |
|---|---|
| Super Fast / Fast | 2 |
| Moderate / Slow / Super Slow | 1 |

- **Formula:** Min = CEILING(Pxx of non-zero daily qty × cover days), Max = CEILING(Min + daily avg × maxDaysBuffer)

#### Fixed Unit Floor (new)
For categories where order timing is erratic but order size is predictable (e.g., Wires — always 1-2 qty).

- **Formula:** Min = CEILING(P90 of individual order quantities), Max = CEILING(MAX(Min + 1, Min × 1.5))
- Falls back to Standard if no orders exist in the period

### 4.3 Current Category Assignments

| Strategy | Categories |
|---|---|
| **Standard** | Cement, General Hardware, Painting, Fevicol, Water Proofing |
| **Percentile Cover** | Furniture & Architectural Hardware, Tiling, CPVC Pipes & Fittings, Plywood/MDF & HDHMR, Switches & Sockets, Conduits & GI Boxes, Lighting |
| **Fixed Unit Floor** | Wires/MCB & Distribution Boards, Sanitary & Bath Fittings, Overhead Tanks |

### 4.4 DC Calculation — Lead-Time-Aware

DC Min now accounts for brand-specific supplier lead times:
```
DC Min = MAX(sumDailyAvg × brandLeadTimeDays, sumDSMin × dcMultiplier.min)
DC Max = MAX(CEILING(dcMin × dcMultiplier.max/min), sumDSMax × dcMultiplier.max)
```
- Lead time is configurable per brand (default 2 days)
- Strategy-agnostic — DC doesn't care how DS Min was calculated

### 4.5 Strategy Dispatch Flow

```
For each SKU × DS:
  1. Run all tagging (Movement, Spike, Price, T150) — same as before
  2. Look up SKU's category → assigned strategy
  3. Dispatch to strategy's Min/Max formula
  4. Apply post-blend adjustments in strict order:
     a. New DS Floor (if applicable)
     b. Brand Buffer (if applicable)
     c. SKU Floor Override (if applicable)
     d. Dead Stock cap (if applicable)
     e. Final rounding
  5. Record Strategy Tag (PCT / FLOOR / standard)
  6. Record Logic Tag (which post-blend rule modified it)
```

### 4.6 Configuration

All strategy config is editable in Logic Tweaker (Column 2, "Category Strategy Engine" section):
- Category → Strategy dropdown
- Percentile Cover params (percentile by price, cover days by movement)
- Fixed Unit Floor params (order qty percentile, max multiplier, max additive)
- Brand Lead Time Days (per-brand, with default)

Config stored in Supabase `params` table under keys: `categoryStrategies`, `percentileCover`, `fixedUnitFloor`, `brandLeadTimeDays`.

### 4.7 Validated Impact (April 2026)

| Metric | Before (all Standard) | After (strategy assigned) |
|---|---|---|
| OOS Rate (L15D) | 4.0% (300 instances) | 2.0% (~150 instances) |
| Inv Min | ₹256L | ₹302L |
| Inv Max | ₹336L | ₹418L |

50% reduction in stockout instances. Inventory increase concentrated in low-cost items.

---

## 5. What Still Needs to Be Built

### 5.1 Demand Shaping Within Categories (v2 — next)

Currently each category gets one strategy with fixed params. v2 will auto-tune strategy params based on each SKU's **coefficient of variation (CV)** — high CV SKUs get more aggressive percentiles, low CV SKUs get tighter ones. This is Approach C from the design spec.

### 5.2 Real-Time or Near-Real-Time Sales Visibility

The person sitting on the tool needs to see current sales as they happen (or as close to it as possible). This means:
- Sales data needs to flow in more frequently than once a week — ideally daily, ideally via an API or automated upload rather than a manual CSV export
- The tool should show how today's sales compare to the expected daily average for each SKU at each DS

### 5.3 Inventory Health Monitor (the core new view)

A live view — the primary working surface for the inventory manager — showing for each SKU × DS × DC:

- Current stock on hand (if this can be fed in)
- Current Min/Max from the model
- Days of cover remaining at current daily average
- Whether today's sales are tracking above or below the daily average
- A clear signal: is this SKU at risk, healthy, or overstocked?

This is the decision support layer. The person should be able to scan this view and immediately know where to act.

### 5.4 Smarter Alerts and Prioritisation

The inventory manager should not need to scroll through 1,500 SKUs to find problems. The tool should surface:
- SKUs at risk of stockout within X days given current sales pace
- SKUs where today's sales are significantly above the daily average (demand spike in progress)
- SKUs that have been at zero stock for more than N days
- SKUs where current stock exceeds Max (overstock flag)

These should be filterable, sortable, and actionable — the manager should be able to click through to the SKU detail and immediately see what to do.

### 5.5 Manual Override Workflow — Simplified

Currently, overrides require: run OOS simulation → download CSV → edit → re-upload → apply to core. This is too heavy for daily use.

The new version should allow the inventory manager to directly edit Min/Max for any SKU × DS inline in the monitoring view, with a clear audit trail showing: who changed it, when, what the tool recommendation was, and what override was applied.

---

## 6. Replenishment Flow

- Each DS is replenished daily from the DC
- DS Min = reorder trigger; DS Max = restock-to level
- DC is replenished from suppliers with brand-specific lead times (configurable in Logic Tweaker, default 2 days)
- DC Min/Max is now lead-time-aware — see section 4.4

---

## 7. Constraints and Non-Negotiables

- Must remain deployable on Vercel + Supabase (no infrastructure changes)
- React + Vite frontend — no framework changes
- Admin / public access model must be preserved
- All existing data input formats (CSVs) must continue to work — do not break the upload pipeline
- The existing Standard model continues to run for categories assigned to it. New strategies (Percentile Cover, Fixed Unit Floor) run for their assigned categories.
- Performance: the tool currently handles ~1,500 SKUs × 5 stores. Any new engine must not block the UI thread — use Web Workers for heavy computation.

---

## 8. Open Questions (remaining)

1. Can we get a real-time or daily stock-on-hand feed? If not, how do we approximate days-of-cover?
2. What does the alert threshold look like — at what days-of-cover level do we flag a SKU as "at risk"?
3. Which brands have a 5-day DC replenishment cycle? (Configurable in Logic Tweaker now, but list needs to be populated)
4. How should demand shaping (v2) auto-tune percentiles — by CV thresholds, or continuously scaled?

### Resolved Questions
- **Percentile by price:** Premium=75, High=80, Medium=85, Low/Super Low=95 (cheap items stock aggressively — hard to emergency-source)
- **Cover days:** 1 day for Moderate/Slow/Super Slow (daily DC restock), 2 for Fast/Super Fast
- **Max formula:** Min + daily avg × buffer days (not a multiplier of Min)
- **Strategy assignment:** Lives in Logic Tweaker, Column 2
- **Category assignments:** Determined from 90-day demand analysis — see section 4.3

---

## 9. File Structure Reference

```
src/
  App.jsx                              — UI: all tabs, state, components (~3,800 lines)
  supabase.js                          — Supabase client, loadFromSupabase, saveToSupabase
  simWorker.js                         — Web Worker for OOS simulation
  engine/
    constants.js                       — all default params, tier configs, DS_LIST
    utils.js                           — parseCSV, getPriceTag, getMovTag, getSpikeTag, computeStats, percentile
    runEngine.js                       — strategy dispatcher, getDCStats, post-blend adjustments, lead-time DC
    index.js                           — barrel export
    strategies/
      standard.js                      — Standard strategy (calcPeriodMinMax + long/recent blend)
      percentileCover.js               — Percentile Cover strategy
      fixedUnitFloor.js                — Fixed Unit Floor strategy
public/
  team-data.json                       — fallback data bundle (generated on Publish)
docs/
  superpowers/specs/                   — design specs
  superpowers/plans/                   — implementation plans
  category-analysis.md                 — demand analysis by category (from 90-day invoice data)
.env                                   — VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ADMIN_PASSWORD
```

Engine logic lives in `src/engine/`. UI, state management, and tab components remain in `App.jsx`.

---

## 10. Vocabulary Reference

| Term | Meaning |
|---|---|
| DS | Dark Store (DS01–DS05) |
| DC | Distribution Centre (the mothership) |
| Min | Reorder trigger point — when stock hits this, replenish to Max |
| Max | Target stock level after replenishment |
| ABQ | Average Basket Qty — average qty per order line |
| DOC | Days of Cover — current stock ÷ daily average |
| T50/T150/T250 | Top 50/150/250 SKUs by total qty sold in 90 days |
| NZD | Non-Zero Days — days with at least one sale |
| Dead Stock | SKU flagged as unsellable or to be discontinued — Max forced = Min |
| New DS | A newly opened dark store — gets a Min floor for top-N SKUs |
| SKU Floors | Per-store manual Min/Max floors uploaded via CSV; the engine uses floor Min/Max if they exceed computed values. Supports separate Min and Max per DS. |
| Brand Buffer | Extra days of cover added for brands with longer replenishment or MOQ constraints |
| Core Override | A manual Min/Max override applied from OOS Simulation that bakes into the model output |
| OOS | Out of Stock — an order line that could not be fully fulfilled |
| OOS Rate | OOS instances ÷ total order instances (north-star simulation metric) |
| Logic Tag | Tag on each DS cell showing which post-blend rule modified the final Min/Max |
| Strategy Tag | Tag showing which strategy computed the base Min/Max (PCT / FLOOR / standard) |
| Percentile Cover | Strategy using Xth percentile of non-zero daily qty × cover days as Min |
| Fixed Unit Floor | Strategy using P90 of individual order quantities as Min |
| CV | Coefficient of Variation — std(demand) / mean(demand), measures demand lumpiness |
| Lead Time | Days for DC to receive supplier replenishment (default 2, configurable per brand) |