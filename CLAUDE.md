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
| QA Mode | ✅ | ❌ |

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
| New SKU Floor Qty | SKU, DS01–DS05 | Per-store manual floor for newly listed SKUs |
| Dead Stock List | Dead Stock (SKU) | Forces Max = Min for flagged SKUs |

#### Store Reference
DS01, DS02, DS03, DS04, DS05, DC. DS04 and DS05 are "New Dark Stores" by default.

---

### 3.3 Model Logic — Full Detail

#### Step 1: Data Preparation

- Invoice rows filtered to status "Closed" or "Overdue"
- Sorted by date; only most recent 90 unique sale dates kept
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
| Active, zero sales | Zero Sale L90D |

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
3. **NSQ Override** — if manual per-store floor exists and exceeds current Min: Min = NSQ, Max = Min. Tagged "New SKU Floor". Runs last — wins if it raises Min above everything else.
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

### 3.4 Dashboard Tab

- KPI strip: Active SKUs, SKUs Sold, Zero Sale, Dead Stock, Inv Value Min, Inv Value Max
- Filter bar: search, category, status, store, price tag, top-N, movement, logic tag
- Virtualised table (renders only visible rows) with frozen left columns: Item, Category, Status, Price Tag, Top N
- Per DS: Movement tag, Logic tag, Daily Avg, ABQ, Min, Max
- Per DC: Movement, Non-Zero Days, Min, Max
- Logic tags: Base Logic / New DS Floor / New SKU Floor / Brand Buffer / Manual Override

---

### 3.5 Insights Tab (SKU Order Behaviour)

- Period toggle: 90D / 75D / 15D / Custom (1–90 days)
- DS view: All / DS01–DS05 / Compare
- Stats strip: SKUs, Instances, Qty, ABQ
- Movement distribution bar
- Drilldown: Org → Category → Brand → SKU
- SKU level: per-DS cards, DC card, order qty frequency chart (X = order qty, Y = order count)

---

### 3.6 OOS Simulation Tab

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

### 3.7 Logic Tweaker Tab (Admin only)

3-column layout:
- **Col 1:** Analysis period, recency window, recency weights, DC multipliers, active DS count
- **Col 2:** Base min days, movement boundaries, price boundaries, spike params, max days buffer, ABQ multiplier, brand buffer days, new DS logic
- **Col 3:** Impact Preview — shadow model run, shows SKUs affected, ₹ delta by movement tag / store / category

Sticky bar when unsaved changes: Reset / Run Preview / Apply & Re-run. Navigation guard intercepts tab switches with unsaved changes.

On Apply & Re-run: params saved to Supabase, model reruns, results pushed to all users.

---

### 3.8 Manual Overrides Tab (Admin only)

- Shows all active core overrides (from OOS Simulation → Apply to Core)
- KPI cards: Tool vs Override inventory value delta
- Filter by search / category / store
- Remove any override to revert that SKU × DS to tool logic
- All changes sync to Supabase immediately

---

### 3.9 QA Mode (Admin only)

Paste a CSV from Google Sheet (columns: SKU, DS01 Min, DS01 Max ... DC Min, DC Max). Tool diffs every value against computed output, shows mismatches sorted by magnitude. Filterable by DS, movement, spike, price tag.

---

### 3.10 Default Parameters

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

## 4. Why We Are Building a New Version

The current model was built on the assumption that one weekly data refresh would be sufficient to keep stockouts under control. That assumption has broken down. Here is what we know:

### 4.1 Stockouts Not Under Control

Despite the existing model and manual overrides, stockout instances remain high — particularly for:
- **Moderate, Slow, Super Slow moving SKUs** priced at Medium, High, or Premium
- These SKUs are not covered adequately even when New SKU Floor and New DS Floor overrides are in place
- Also, the order behaviour for these SKUs is too erratic, order for an SKU comes after 45 days of previous order for example

This suggests the base Min/Max logic is underestimating required stock for low-velocity, higher-value items. The weekly batch model is not catching demand shifts fast enough for these SKUs.

### 4.2 Business Has Scaled

Order volume has grown from ~220 orders/day to ~280 orders/day (~27% growth). The model's historical averages were calibrated at the lower volume. Min/Max levels computed on 90-day history may now be systematically too low.

### 4.3 Backward-Looking, Weekly Refresh Is Not Enough

The model only looks backward at historical sales. It has no forward signal. A weekly refresh means up to 7 days of demand shift go unaddressed. We need the person managing inventory to be able to act on real-time or near-real-time signals.

### 4.4 Category-Level Strategy May Be Needed

Not all categories behave the same way. A blanket model may be too blunt. We need to think about whether different categories need different inventory strategies — not just different parameters within the same formula.

### 4.5 The Role Has Changed

Earlier: one admin refreshes data once a week, model outputs are fed into procurement.

Now: one person sits on the tool daily (or continuously), monitors SKU-level inventory health, and makes active decisions. The tool needs to support that workflow — giving that person all the information they need to decide whether inventory at each SKU × DS × DC is at the right level right now.

### 4.6 Core Goals Remain the Same

- Minimise stockouts for all SKUs, irrespective of how erratic their order behaviour is
- Optimise total inventory value

---

## 5. What the New Version Needs to Do

### 5.1 Real-Time or Near-Real-Time Sales Visibility

The person sitting on the tool needs to see current sales as they happen (or as close to it as possible). This means:
- Sales data needs to flow in more frequently than once a week — ideally daily, ideally via an API or automated upload rather than a manual CSV export
- The tool should show how today's sales compare to the expected daily average for each SKU at each DS

### 5.2 Inventory Health Monitor (the core new view)

A live view — the primary working surface for the inventory manager — showing for each SKU × DS × DC:

- Current stock on hand (if this can be fed in)
- Current Min/Max from the model
- Days of cover remaining at current daily average
- Whether today's sales are tracking above or below the daily average
- A clear signal: is this SKU at risk, healthy, or overstocked?

This is the decision support layer. The person should be able to scan this view and immediately know where to act.

### 5.3 Percentile-Based Strategy (new logic to explore)

Current model uses: daily average × base min days as the starting point for Min.

**Proposed new approach to explore:** For each SKU at each DS, compute the **90th percentile of single-day order qty** over the lookback window. Stock Min = this 90th percentile value. This means:
- On 90% of days, opening stock covers the full day's demand without a restock trigger
- Max = some multiple of this (to be determined per category or movement tier)

This is simpler, more intuitive, and directly addresses stockouts for lumpy-demand SKUs (moderate/slow, higher price) where the current average-based approach fails.

We need to:
- Implement this as an alternative engine
- Run it alongside the current engine so outputs can be compared
- Evaluate which produces better coverage for the stockout-prone segments

This is just me brainstorming, want more suggestions on how we can re-think the model from a category lens

### 5.4 Category-Level Strategy Flags

Rather than applying one formula across all categories, allow the inventory manager to assign a strategy to each category. Initial strategies to define:

| Strategy | Logic |
|---|---|
| Standard | Current blend model (existing engine) |
| Percentile Cover | 90th percentile of daily demand as Min |
| ABQ Cover | CEILING(ABQ) as Min, with a Max multiplier |
| Manual | Min/Max set entirely by the operator |

Each category (or even individual SKU) should be assignable to a strategy. The model then uses the appropriate engine for that SKU.

### 5.5 Replenishment Lead Time Awareness

The DC replenishment logic needs to reflect reality:
- **Most brands:** DC gets replenished in 1–2 days (next-day or day-after delivery)
- **A few specific brands:** DC replenishment cycle is up to 5 days

The DC Min/Max calculation should factor in the replenishment lead time for each brand. Currently DC Min/Max is purely a multiplier of DS totals — it does not account for how long the DC will wait without a top-up.

A simple approach: DC Min = sum of DS daily averages × lead time days (by brand). DC Max = DC Min + safety buffer.

### 5.6 Smarter Alerts and Prioritisation

The inventory manager should not need to scroll through 1,500 SKUs to find problems. The tool should surface:
- SKUs at risk of stockout within X days given current sales pace
- SKUs where today's sales are significantly above the daily average (demand spike in progress)
- SKUs that have been at zero stock for more than N days
- SKUs where current stock exceeds Max (overstock flag)

These should be filterable, sortable, and actionable — the manager should be able to click through to the SKU detail and immediately see what to do.

### 5.7 Manual Override Workflow — Simplified

Currently, overrides require: run OOS simulation → download CSV → edit → re-upload → apply to core. This is too heavy for daily use.

The new version should allow the inventory manager to directly edit Min/Max for any SKU × DS inline in the monitoring view, with a clear audit trail showing: who changed it, when, what the tool recommendation was, and what override was applied.

### 5.8 Retain Everything That Works

The following from the current tool are working well and must be retained:
- T150 ranking logic
- Price tagging
- Movement tagging
- Spike detection and spike median logic
- Brand buffer logic
- New DS floor logic
- OOS simulation (replay engine)
- Logic Tweaker with impact preview
- Supabase sync architecture
- Admin vs public access model
- QA diff mode

---

## 6. Replenishment Flow (unchanged)

- Each DS is replenished daily from the DC
- DS Min = reorder trigger; DS Max = restock-to level
- DC is replenished from suppliers:
  - Most brands: 1–2 day lead time
  - A few brands (to be listed): up to 5-day lead time
- DC Min must cover demand during the supplier lead time window
- Current DC Min/Max = multiplier of DS totals. This needs to become lead-time-aware in the new version.

---

## 7. Constraints and Non-Negotiables

- Must remain deployable on Vercel + Supabase (no infrastructure changes)
- React + Vite frontend — no framework changes
- Admin / public access model must be preserved
- All existing data input formats (CSVs) must continue to work — do not break the upload pipeline
- The existing model must continue to run and produce outputs — the new logic runs alongside it, not replacing it immediately. Outputs should be comparable side by side.
- Performance: the tool currently handles ~1,500 SKUs × 5 stores. Any new engine must not block the UI thread — use Web Workers for heavy computation.

---

## 8. Open Questions (to work through during build)

1. What is the right percentile to use? 90th? 85th? Should it vary by movement tag or category?
2. How do we handle SKUs with very few data points (e.g. 3 orders in 90 days) where a 90th percentile is statistically meaningless?
3. Which brands have a 5-day DC replenishment cycle? This list needs to be configured in the tool.
4. What is the right Max for the percentile strategy? 2× the 90th percentile? Or a fixed number of days of cover above it? Or the multiplying factor depends on the movement tag - Super Fast moving SKU: 5 times the 90th percentile?
5. Should the category-level strategy assignment live in the Logic Tweaker, or as a separate configuration screen?
6. Can we get a real-time or daily stock-on-hand feed? If not, how do we approximate days-of-cover?
7. What does the alert threshold look like — at what days-of-cover level do we flag a SKU as "at risk"?
8. We can choose to start from scratch and build a new tool altogether, and let the existing tool remain - can be deprecated later

---

## 9. File Structure Reference (current)

```
src/
  App.jsx              — main app, all tabs, model engine, all state
  supabase.js          — Supabase client, loadFromSupabase, saveToSupabase
  simWorker.js         — Web Worker for OOS simulation computation
public/
  team-data.json       — fallback data bundle (generated on Publish)
.env                   — VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ADMIN_PASSWORD
```

The entire model engine (`runEngine`), all tab components, and all state management currently live in `App.jsx`. As we add new engines and views, this file will need to be broken into modules.

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
| NSQ | New SKU Qty — manually set per-store floor for a newly listed SKU |
| Brand Buffer | Extra days of cover added for brands with longer replenishment or MOQ constraints |
| Core Override | A manual Min/Max override applied from OOS Simulation that bakes into the model output |
| OOS | Out of Stock — an order line that could not be fully fulfilled |
| OOS Rate | OOS instances ÷ total order instances (north-star simulation metric) |
| Logic Tag | Tag on each DS cell showing which rule determined the final Min/Max |