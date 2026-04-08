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
| Frontend | React + Vite + Recharts |
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
| Overview | ✅ | ✅ |
| SKU Detail | ✅ | ✅ |
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

### 3.5 Overview Tab (replaced Dashboard — April 2026)

Category-level inventory overview with drill-down to Brand and SKU levels.

- **KPI strip:** Active SKUs, SKUs Sold, Zero Sale SKUs, Inv Value Min, Inv Value Max
  - SKUs Sold and Zero Sale respect the period picker; Inv values are engine-based
- **Period picker:** Presets L90D, L60D, L45D, L30D, L15D, L7D + custom date range
  - Shows "Data: {earliest} → {latest}" from invoice data
  - "Showing: {date1} → {date2} (XD)" label below picker
  - Does NOT impact engine Min/Max — only affects sold value and coverage calculations
- **Store picker:** Dropdown — All Stores (DS01–DS05 aggregated), individual DS, or DC
- **Drill-down:** Category → Brand → SKU
  - Breadcrumb trail with prominent yellow Back button
  - Category/Brand level columns: Active SKUs, SKUs Sold, Zero Sale, Sold Val/Day, Inv Min, Inv Max, Coverage Days Min, Coverage Days Max
  - SKU level columns: Movement, Price Tag, Sold Val/Day, Inv Min, Inv Max, Coverage Days Min, Coverage Days Max
  - Click SKU row → navigates to SKU Detail tab with that SKU pre-loaded
- **Sortable columns:** Click any value column header to sort ascending/descending (▲/▼ indicators)
- **Sticky table headers** — stay visible when scrolling
- **Copy SKU ID:** Small copy icon next to SKU ID at SKU level
- All values center-aligned; currency formatted with ₹K/L/Cr tiers; commas on numbers

---

### 3.6 SKU Detail Tab (replaced SKU Order Behaviour — April 2026)

Deep-dive into individual SKU behaviour and Min/Max computation breakdown.

- **Entry points:** Direct SKU search (type ID or name, arrow-key navigation in dropdown), or jump from Overview SKU row
- **Search bar:** Auto-complete dropdown (up to 8 matches), arrow keys to navigate, Enter to select, clicking Search selects all text
- **Period picker:** L90D, L60D, L45D, L30D, L15D, L7D + custom date range. "Showing: {date1} → {date2}" label. Does NOT change engine Min/Max.
- **DS picker:** All, DS01–DS05 (no Compare mode). Both charts and cards follow this picker.
- **KPI strip:** Orders, Quantity Sold, Rate of Sale (qty sold on avg per day), ABQ (qty sold on avg per order), Active Days
- **Two charts side by side** (Recharts library, equal 1fr/1fr grid):
  - **Order Qty Frequency:** Bar chart (X = order qty, Y = count). When DS selected: vertical dashed Min/Max reference lines. Tooltip on hover.
  - **Daily Order Qty:** Bar chart (X = dates, Y = qty). When DS selected: horizontal dashed Min/Max reference lines. Min=Max shows single line labeled "Min=Max=X".
  - Shared DS label header above both charts
- **Per-DS computation cards** (all 5 in one row when "All" selected, single card when DS selected):
  - Narrative flow layout — values inline with labels, reads top-to-bottom
  - **Standard strategy:** Long period stats (avg, NZD, spike median) → Long Min/Max with formula (base days × avg, spike override) → Recent period → Recent Min/Max → Blending (weight, blended values)
  - **Percentile Cover:** Full period, NZD, Price→Percentile, Movement→Cover days, Pxx value, Min/Max formulas. DOC Cap shown if applied.
  - **Fixed Unit Floor:** Order count, P90 of order qtys, Min/Max formulas
  - Post-blend adjustments: New DS Floor, Brand Buffer, SKU Floor — each shows before/after values
  - Logic tag badge
- **DC card** (horizontal, full width): Movement, Min/Max, Sum DS values, lead time, multipliers, formulas
- **Copy SKU ID:** Copy icon next to SKU ID in header, toast "Copied to clipboard"

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
- **Col 2:** Base min days, movement boundaries, price boundaries, spike params, max days buffer, ABQ multiplier, brand buffer days, new DS logic, **Category Strategy Engine** (category→strategy assignment, percentile cover params, **PCT Guards** (min NZD threshold, DOC cap days, DOC cap price tags), fixed unit floor params, brand lead time days)
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
| PCT min NZD | 2 |
| PCT DOC cap | 30 days |
| PCT DOC cap price tags | High, Premium |

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

**PCT Guards (SHIPPED — April 2026):**

Analysis of 2,264 PCT SKU×DS combos revealed that PCT produces degenerate results (DOC > 60 days) when non-zero days is very low — 100% degenerate at NZD=1, 33% at NZD=2. Two configurable guards were added:

1. **Min NZD threshold** (default 2): PCT categories with NZD < threshold fall back to Standard strategy. With 1 observation there's no distribution to compute a percentile from.
2. **DOC Cap** (default 30 days, applies to High + Premium price tags only): Caps PCT Min at `ceil(dailyAvg × capDays)`. Prevents capital lock-up on expensive items with sparse/spiky demand. Low-priced items are intentionally uncapped — better to overstock cheap items than scramble.

Config stored in Supabase `params` table: `pctMinNZD`, `pctDocCap`, `pctDocCapPriceTags`. Editable in Logic Tweaker under "PCT Guards" section.

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
  3. PCT guard check: if strategy is PCT and NZD < pctMinNZD → fall back to Standard
  4. Dispatch to strategy's Min/Max formula
  5. PCT DOC cap: if strategy is PCT and price tag in pctDocCapPriceTags → cap Min at dailyAvg × pctDocCap
  6. Apply post-blend adjustments in strict order:
     a. New DS Floor (if applicable)
     b. Brand Buffer (if applicable)
     c. SKU Floor Override (if applicable)
     d. Dead Stock cap (if applicable)
     e. Final rounding
  7. Record Strategy Tag (PCT / FLOOR / standard)
  8. Record Logic Tag (which post-blend rule modified it)
```

### 4.6 Configuration

All strategy config is editable in Logic Tweaker (Column 2, "Category Strategy Engine" section):
- Category → Strategy dropdown
- Percentile Cover params (percentile by price, cover days by movement)
- Fixed Unit Floor params (order qty percentile, max multiplier, max additive)
- Brand Lead Time Days (per-brand, with default)

Config stored in Supabase `params` table under keys: `categoryStrategies`, `percentileCover`, `pctMinNZD`, `pctDocCap`, `pctDocCapPriceTags`, `fixedUnitFloor`, `brandLeadTimeDays`.

### 4.7 Validated Impact (April 2026)

| Metric | Before (all Standard) | After (strategy assigned) |
|---|---|---|
| OOS Rate (L15D) | 4.0% (300 instances) | 2.0% (~150 instances) |
| Inv Min | ₹256L | ₹302L |
| Inv Max | ₹336L | ₹418L |

50% reduction in stockout instances. Inventory increase concentrated in low-cost items.

---

## 5. Roadmap — What's Being Built Next

### 5.0 Analysis Completed — Parked Items (April 2026)

- **Demand Shaping v2 (CV-based tuning):** Analysis showed 96.3% of SKU×DS combos have CV > 2.0 (driven by sparsity, not order size variability). No meaningful segmentation possible. Parked — not worth building.
- **Movement-based periods:** Simulated variable overall periods by movement tag. Result: +8 OOS instances, +₹38.5L inventory. Strictly worse. Parked.
- **Base min days adjustment:** Simulated +1 day for Slow/Super Slow Standard SKUs. Only 0.1% OOS reduction. Not worth changing.
- **ROP (Re-Order Point):** Simulated mid-Max reorder trigger. Only 6 OOS instances saved (1.5%). Root cause: 86.5% of OOS is single order > Max, not restock timing. Parked.
- **Cluster-based cross-DS fulfillment:** Analysis showed 65% OOS reduction (134→46) by allowing DS01+DS05, DS02+DC, DS03+DS04 to share stock. Zero inventory increase. Strong operational lever — to be built into Stock Health Monitor as a visibility feature.

### 5.1 Phase 1: Zoho Inventory Integration (IN PROGRESS)

Connect to Zoho Inventory API to replace manual CSV uploads and enable live stock monitoring.

#### 5.1.1 Zoho API Details

| Endpoint | Data | Use |
|---|---|---|
| `GET /inventory/v1/items?per_page=200` | SKU list: sku, name, category, brand, status | SKU Master sync |
| `GET /inventory/v1/items/{id}` | Per-location stock: locations[].location_stock_on_hand, location_quantity_in_transit | Stock snapshot |
| `GET /inventory/v1/invoices?date_start=X&date_end=Y&status=paid` | Invoice list (paginated) | Invoice data |
| `GET /inventory/v1/invoices/{id}` | Line items: sku, quantity, location_name | Invoice line items |
| `GET /inventory/v1/reports/purchasesbyitem?from_date=X&to_date=Y` | average_price per SKU | Purchase prices (12-month window) |
| `GET /inventory/v1/reports/inventoryvaluation` | asset_value, quantity_available | Fallback price data |

- **Data centre:** .in (India) — base URL: https://www.zohoapis.in
- **OAuth:** refresh token flow via https://accounts.zoho.in/oauth/v2/token
- **Scopes:** ZohoInventory.invoices.READ, ZohoInventory.items.READ, ZohoInventory.settings.READ, ZohoInventory.reports.READ
- **Credentials:** stored as Supabase secrets (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID)

#### 5.1.2 Location Mapping

| Zoho location_name | Tool DS |
|---|---|
| DS01 Sarjapur | DS01 |
| DS02 Bileshivale | DS02 |
| DS03 Kengeri | DS03 |
| DS04 Chikkabanavara | DS04 |
| DS05 Basavanapura | DS05 |
| DC01 Rampura | DC |
| HomeRun Bangalore | (ignore — HQ) |

#### 5.1.3 Invoice Status Mapping

| Zoho Status | Engine (Min/Max computation) | OOS Simulation Mode 2 |
|---|---|---|
| paid | ✅ (= CSV "Closed") | ✅ |
| overdue | ✅ (= CSV "Overdue") | ✅ |
| sent | ❌ | ✅ (today's live orders) |
| void / draft | ❌ | ❌ |

#### 5.1.4 Stock Sync Architecture

**Daily full snapshot (7:45 AM, before 8 AM trading start):**
1. Pull all items via list endpoint (8 paginated calls → ~1500 item_ids)
2. Split into batches of 100, insert into `zoho_sync_queue` table
3. Process batches: fetch 100 item details each, write `location_stock_on_hand` + `location_quantity_in_transit` per DS to `stock_live`
4. At 7:55 AM: copy `stock_live` → `stock_snapshots` as today's 8 AM opening snapshot

**Hourly incremental (9 AM – 8 PM):**
1. Pull today's invoices (paid + sent + overdue) → extract unique SKUs with sales
2. Fetch item detail only for those SKUs (~50-200 per hour)
3. Update `stock_live` with Zoho's actual stock (no calculation — just mirror Zoho's truth)

**API call budget:** ~2100-3500 calls/day. Well within Zoho limits.

#### 5.1.5 Daily Operations Cycle

```
7:45 AM  — Full stock snapshot from Zoho (all SKUs × all locations)
7:55 AM  — Snapshot saved as today's 8 AM opening (for Mode 2 simulation)
8:00 AM  — Trading starts, orders deplete stock
           Throughout day: items inwarded at DC (sometimes directly at DS)
9 AM–8 PM — Hourly incremental sync (sales-active SKUs only)
8:00 PM  — Trading ends
~Midnight — Transfer Orders raised from DC → each DS
           Once TO marked "In Transit": stock leaves DC, not yet at DS
~Noon next day — TOs arrive at DS, stock credited
```

#### 5.1.6 Implementation Tasks

**Backend (Supabase Edge Functions + Tables) — ALL SHIPPED:**

| # | Task | Status |
|---|---|---|
| B1 | Supabase tables: `stock_live`, `stock_snapshots`, `zoho_sync_queue` | ✅ Done |
| B2 | Token refresh helper (`_shared/zoho.ts`) | ✅ Done |
| B3 | `zoho-items-list` — pull all items, queue batches of 100 | ✅ Done |
| B4 | `zoho-batch-stock` — process one queue batch: 100 item details → stock_live | ✅ Done |
| B5 | `zoho-snapshot` — copy stock_live → stock_snapshots at 7:55 AM | ✅ Done |
| B6 | `zoho-incremental` — today's invoices → unique SKUs → update stock_live | ✅ Done |
| B7 | `zoho-invoices` — pull invoice line items for date range (model refresh) | ✅ Done |
| B8 | `zoho-prices` — pull Purchases by Item report, 12-month window | ✅ Done |
| B8b | `zoho-skumaster` — pull all items as SKU master snapshot | ✅ Done |
| B9 | pg_cron: 7:45→B3, every min 2:15-2:25 UTC→B4, 7:55→B5, hourly 9AM-8PM→B6 | ✅ Done |

**Frontend — ALL SHIPPED:**

| # | Task | Status |
|---|---|---|
| F1 | Upload tab — two-column layout: Zoho sync panel (left) + manual CSVs (right) | ✅ Done |
| F2 | "Sync Stock Now" button in Stock Health tab, last synced timestamp | ✅ Done |
| F3 | Read stock_live from Supabase REST API, pivoted to {sku: {DS: {...}}} | ✅ Done |
| F4 | stock_snapshots read path prepared (for Phase 3) | ⬜ Pending |
| F5 | Data transformers: Zoho invoice/SKU master/prices → tool state format | ✅ Done |

**Active SKU filtering:**
- `zoho-items-list` and `zoho-batch-stock`: filter `status=active` — stock monitoring only for active SKUs (~1,417 vs 1,949 total)
- `zoho-skumaster`: no filter — pulls all SKUs (complete catalogue including inactive/confirmation-pending)
- `zoho-incremental`: naturally active-only — only fetches items that had orders today

**Known issues / Pending testing:**
- Zoho daily API call limit (7,500/day) was exhausted during development testing. Resets at midnight IST. **Production cron uses ~2,000 calls/day — well within limit.**
- CORS headers added to all Edge Functions after browser-fetch failures.
- "Sync Stock Now" in Stock Health tab does full snapshot (items-list + all batches). **Needs testing with real data after limit resets tomorrow morning.**
- **Stock Health tab needs thorough end-to-end testing** once stock_live is populated with real data from tomorrow's 7:45 AM cron.

#### 5.1.7 Model Refresh vs Live Stock

- **Min/Max values** do NOT change with Zoho syncs. They only change when Admin explicitly refreshes the model (every 5-7 days).
- **Model refresh:** Admin pulls fresh invoice data from Zoho → sets overall period → clicks Apply & Re-run → Min/Max recomputed.
- **Zoho stock sync:** Hourly mirror of live stock levels for monitoring and simulation. Completely independent of Min/Max.

### 5.2 Phase 2: Stock Health Monitor Tab (SHIPPED — needs thorough testing)

New tab showing live stock status for all SKU×DS combos. Primary working surface for inventory manager.

**⚠ Needs thorough testing:** Stock data was not populated during build due to Zoho API rate limit exhaustion. Test after midnight IST when limit resets — click "Sync Stock Now" to populate stock_live, then verify colour coding, filters, DOC sort, and DS card counts.

**Layout:**
- 6 sticky summary cards at top (DS01–DS05 + DC): Red/Amber/Green/Blue counts per DS
- DS01 selected by default; click any card to switch DS
- Filters between cards and table: search (SKU ID/name), health status, category, brand
- SKU-level table: Physical, In Transit, Effective, Min, Max, DOC, Status

**Colour coding:**

| Stock Level | Colour | Meaning |
|---|---|---|
| Stock ≤ Min | 🔴 Red | At or below reorder point — needs replenishment now |
| Stock between Min and Max, bottom 30% of range | 🟡 Amber | Approaching reorder — watch |
| Stock between Min and Max, healthy | 🟢 Green | Healthy |
| Stock > Max | 🔵 Blue | Overstocked |

**Sort:** Default Red → Amber → Green → Blue, then by DOC ascending within each group. DOC column header is clickable for manual sort. DOC = "—" for zero-sale SKUs (dailyAvg = 0).

**Columns per SKU×DS:** Physical Stock, In Transit, Effective Stock (Physical + In Transit), Min, Max, Days of Cover, Health Status.

### 5.3 Phase 3: Actual Stock OOS Simulation

Two simulation modes in OOS Simulation tab:

**Mode 1 ("Perfect Restock" — existing):** Stock starts at Max every day. Tests Min/Max adequacy. Supports both "Last X days" and custom date range. For custom date range: uses already-loaded invoice data where available, fetches missing dates from Zoho on demand (zoho-invoices edge function).

**Mode 2 ("Actual Stock" — new):** Stock starts at 8 AM Zoho snapshot from `stock_snapshots` table. Shows what actually happened on the ground. Requires at least one daily snapshot (available from the day after the first 7:45 AM cron runs). Custom date range also supported.

**Replenishment logic (critical for root cause classification):**
- End-of-day trigger: if closing stock ≤ Min → restock to Max overnight from DC
- If closing stock > Min → no restock triggered, next day opens with same stock
- Therefore, by 8 AM there are only two valid opening states:
  1. Restocked to Max (previous day closed ≤ Min — correct ops)
  2. Same as previous day close (previous day closed > Min — no restock needed)

**OOS Root Cause Categories (Mode 2):**

| Root Cause | Detection Logic | Meaning |
|---|---|---|
| **Ops Failure** | Opening stock ≤ Min (restock should have happened but didn't) AND OOS occurs | Previous day closed ≤ Min, trigger fired, but DC didn't replenish. Ops process broke down. |
| **Tool Failure** | Opening stock > Min (no restock needed) AND OOS occurs | Min/Max was set correctly per rules, but order exceeded available stock. Model is undersized for this demand. |
| **Unstocked** | Min=Max=0 for this SKU×DS | Zero sale in engine period — SKU not stocked at this location at all. |

**Key rule:** The question for classification is "should a restock have been triggered the previous night?" — not "was Max sufficient for this order?"
- If opening stock ≤ Min → ops should have restocked → Ops Failure if OOS occurs
- If opening stock > Min → ops correctly did not restock → Tool Failure if OOS occurs

**"Could have been saved" flag:** If OOS occurs AND `physical_stock + in_transit_qty >= order_qty`, flag as "would have been saved if TO arrived before 8 AM." Only flag when combined stock is sufficient to fully cover the order.

**UI changes for Phase 3:**
- Simulation period picker: "Last X days" (existing) OR "Custom date range" (new)
- Mode toggle: Mode 1 (Perfect Restock) / Mode 2 (Actual Stock)
- On-demand data fetch: if custom range extends beyond loaded invoice data, fetch from Zoho with "Fetching from Zoho…" status message
- Mode 2 KPI cards: OOS Rate | Ops Failure count | Tool Failure count | Unstocked | Could Have Been Saved
- Mode 2 available only for dates with stock_snapshots (validated before running)

**Implementation tasks:**
| # | Task | Dependency |
|---|---|---|
| S1 | Custom date range period picker | None — build now |
| S2 | On-demand invoice data fetch (zoho-invoices) + merge with loaded data | None — build now |
| S3 | Loading state: "Fetching from Zoho…" | None — build now |
| S4 | Mode 1 with custom dates — pass merged data to simWorker | S1, S2 |
| S5 | Mode 2 simulation — fetch snapshots, replay with actual opening stock | Needs stock_snapshots (from tomorrow's 7:45 AM cron) |
| S6 | Mode 2 root cause classification per order line | S5 |
| S7 | Mode 2 KPI cards — Ops/Tool/Unstocked/Could Have Been Saved | S5, S6 |

S1–S4 can be built immediately. S5–S7 require at least one day of stock_snapshots.

### 5.4 Phase 4: Alerts + Real-Time Sales

- SKUs below Min across locations (breach visibility)
- Demand spike detection (today's sales > X× daily average)
- Days-of-cover alerts (approaching 0)
- Overstock flags

### 5.5 Manual Override Workflow — Simplified (Future)

Inline Min/Max editing from monitoring view with audit trail.

---

## 6. Replenishment Flow

- Each DS is replenished daily from the DC
- DS Min = reorder trigger; DS Max = restock-to level
- DC is replenished from suppliers with brand-specific lead times (configurable in Logic Tweaker, default 2 days)
- DC Min/Max is now lead-time-aware — see section 4.4

### 6.1 Daily Operations Cycle

```
7:45 AM  — Zoho stock snapshot captured (all SKUs × all locations)
8:00 AM  — Trading starts (deliveries 8 AM – 8 PM)
           Throughout day: items inwarded at DC (sometimes directly at DS)
8:00 PM  — Trading ends
~Midnight — Transfer Orders raised from DC → each DS
           Once TO marked "In Transit": stock leaves DC, not yet at DS
~Noon next day — TOs typically arrive at DS (varies by location and day)
```

### 6.2 Cluster Geography

| Cluster | Stores | Rationale |
|---|---|---|
| Cluster 1 | DS01 (Sarjapur) + DS05 (Basavanapura) | Geographically close |
| Cluster 2 | DS02 (Bileshivale) + DC (Rampura) | Geographically close |
| Cluster 3 | DS03 (Kengeri) + DS04 (Chikkabanavara) | Geographically close |

Cluster analysis showed 65% OOS reduction via cross-DS fulfillment (134→46 instances). Cluster 2 (DS02+DC) achieved 95.6% reduction due to DC's large buffer stock.

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

1. What does the alert threshold look like — at what days-of-cover level do we flag a SKU as "at risk"?
2. Which brands have a 5-day DC replenishment cycle? (Configurable in Logic Tweaker now, but list needs to be populated)
3. Cluster-based cross-DS fulfillment — build into tool or implement as ops process?

### Resolved Questions
- **Percentile by price:** Premium=75, High=80, Medium=85, Low/Super Low=95 (cheap items stock aggressively — hard to emergency-source)
- **Cover days:** 1 day for Moderate/Slow/Super Slow (daily DC restock), 2 for Fast/Super Fast
- **Max formula:** Min + daily avg × buffer days (not a multiplier of Min)
- **Strategy assignment:** Lives in Logic Tweaker, Column 2
- **Category assignments:** Determined from 90-day demand analysis — see section 4.3
- **PCT outlier handling:** DOC cap at 30D for High/Premium items + NZD≥2 threshold. Analysis showed 100% of NZD=1 combos were degenerate (DOC=90). DOC cap alone insufficient for NZD=1 (still produces 30 units for once-in-90-days sellers). Combined approach eliminates 97%+ of degenerate cases.
- **Dashboard → Overview redesign:** Category→Brand→SKU drill-down replaces flat SKU table. Period picker for sold value/coverage analysis (independent of engine). Store picker slices all metrics.
- **Insights → SKU Detail redesign:** Direct SKU search replaces 4-level drilldown. Computation cards show full formula breakdown per DS. Recharts-based charts with Min/Max reference lines.
- **Stock-on-hand feed:** Resolved — Zoho Inventory API provides per-location stock via item detail endpoint. Hourly sync + daily 8 AM snapshot.
- **Demand shaping v2:** Parked — CV analysis showed no segmentation power (96.3% of combos > CV 2.0). Not worth building.
- **Variable periods by movement:** Parked — simulation showed worse results (+8 OOS, +₹38.5L inventory) vs flat 45D period.
- **ROP (Re-Order Point):** Parked — 86.5% of OOS is single order > Max, not restock timing. ROP only saves 6 of 392 instances.

---

## 9. File Structure Reference

```
src/
  App.jsx                              — UI: all tabs, state, components (~4,200 lines)
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
supabase/
  functions/                             — Supabase Edge Functions (SHIPPED)
    _shared/zoho.ts                      — Shared: token refresh, zohoGet(), LOCATION_MAP, CORS helpers
    zoho-items-list/                     — Queue all 1949 items in batches of 100 for stock sync
    zoho-batch-stock/                    — Process one queue batch: 100 item details → stock_live
    zoho-snapshot/                       — Copy stock_live → stock_snapshots (7:55 AM daily)
    zoho-incremental/                    — Hourly: today's sales SKUs → update stock_live
    zoho-invoices/                       — Pull invoice line items for date range (model refresh)
    zoho-prices/                         — Pull avg purchase prices, last 12 months
    zoho-skumaster/                      — Pull all items as SKU master snapshot
  migrations/
    20260408000001_zoho_tables.sql       — stock_live, stock_snapshots, zoho_sync_queue tables + RLS
    20260408000002_zoho_queue_policy.sql — Fix service_role read policy on queue
    20260408000003_zoho_cron.sql         — pg_cron schedules for all sync jobs
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
| DOC Cap | Days-of-cover cap for PCT strategy — limits Min to dailyAvg × capDays for configured price tags |
| PCT Fallback | When PCT category SKU has NZD < threshold, falls back to Standard strategy |
| Rate of Sale | Average quantity sold per day across all days in selected period |
| TO | Transfer Order — stock movement from DC to DS (or DS to DS) |
| In Transit | Stock that has been dispatched (TO marked) but not yet received at destination |
| Ops Failure | OOS caused by stock not being replenished to Max (restocking process failure) |
| Tool Failure | OOS caused by Min/Max being too low (single order exceeds Max) |
| Stock Health | Colour-coded status: 🔴 ≤ Min, 🟡 near Min, 🟢 healthy, 🔵 > Max |