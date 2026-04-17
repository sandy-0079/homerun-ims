# CLAUDE.md — HomeRun IMS

HomeRun operates 5 dark stores (DS01–DS05) + one DC. This tool computes Min/Max inventory levels for every SKU at every location so ops knows how much stock to hold.

---

## Stack & Credentials

| Layer | Detail |
|---|---|
| Frontend | React + Vite + Recharts, deployed on Vercel |
| Database | Supabase (tables: `params`, `overrides`, `team_data`) |
| Engine | `src/engine/` — modular strategy dispatcher + Web Worker |
| Supabase URL | https://rgyupnrogkbugsadwlye.supabase.co |
| Supabase Anon Key | eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc |
| Admin Password | IMSAdmin123 |

---

## Data Model & Key Decisions

### Invoice Data
- Uploaded as CSV (Zoho export). **Replaces entirely on upload — no merge, no rolling cap.** Engine uses whatever period admin sets in Logic Tweaker.
- All uploads auto-save to Supabase `team_data` immediately — no Publish step.

### Model Refresh Workflow (Admin, every 5-7 days)
1. Upload invoice CSV → tool auto-syncs SKU Master + Prices from Zoho (~11 API calls)
2. Readiness checklist shows ✅/⏳/⬜ for each input
3. "Apply & Re-run Model" button (yellow only when something changed) → confirmation modal
4. Engine runs, results pushed to Supabase — all users see new Min/Max

### Stock Health Workflow
- Admin exports Inventory Summary CSV from Zoho per location, uploads per-DS buttons in Stock Health tab
- Stock data saved to Supabase — all colleagues see same snapshot

---

## Category Strategy Engine

**Why:** 78.7% of SKU×DS combos are Slow/Super Slow. Averages produce near-zero Min for items selling once every 10+ days.

### Three Strategies

| Strategy | Categories | Key Logic |
|---|---|---|
| **Standard** | Cement, General Hardware, Painting, Fevicol, Water Proofing | Daily avg × base min days, long/recent blend |
| **Percentile Cover (PCT)** | Furniture & Arch HW, Tiling, CPVC, Plywood/MDF, Switches, Conduits, Lighting | Pxx of non-zero daily qty × cover days |
| **Fixed Unit Floor** | Wires/MCB, Sanitary & Bath, Overhead Tanks | P90 of individual order quantities |

### PCT Design Decisions
- **Percentile by price:** Low/Super Low/No Price=95, Medium=85, High=80, Premium=75. Cheap items stocked aggressively — hard to emergency-source.
- **Cover days:** Super Fast/Fast=2, Moderate/Slow/Super Slow=1. DC restocks daily so only 1 day needed for slow movers.
- **Note:** constants.js and percentileCover.js fallbacks must match these values exactly — they're the authoritative source if Supabase params predate the `percentileCover` key.
- **PCT Guards:** NZD<2 → fall back to Standard (1 observation = no distribution). DOC cap 30D on High/Premium only — prevents capital lock-up on expensive items. Low-priced items intentionally uncapped.
- **Max formula:** Min + dailyAvg × buffer (not a multiplier of Min).

### DC Calculation
Three paths depending on SKU type:

**Standard (no manual floors):**
`DC Min = ceil(sumDailyAvg × (brandLeadTimeDays + 1))` — lead time + 1 safety day. Default lead time 3 days; configurable per brand in Logic Tweaker.
`DC Max = DC Min + ceil(sumDailyAvg × 2)`
Movement-tag multipliers removed — lead time is the sole driver.

**Floored SKUs (SKU is in "SKU Floors - DS Level" CSV):**
`DC Min = Σ effective DS Mins × skuFloorDCMultMin (default 0.2)`
`DC Max = Σ effective DS Maxes × skuFloorDCMultMax (default 0.3)`
Demand erratic for these SKUs so DC stays lean. Configurable in Logic Tweaker.

**Dead Stock SKUs:**
`DC Min = Σ DS Mins × 0.25` / `DC Max = Σ DS Maxes × 0.25`

### Post-Blend Adjustment Order (strict)
New DS Floor → SKU Floor Override → Dead Stock cap → Final rounding

**Brand Buffer removed** — was compensating for supplier lead time at DS level, which is wrong. Lead time is now correctly modelled at DC via brandLeadTimeDays.

**SKU Floor Min and Max are checked independently** — if floor Min > engine Min, floor Min wins. If floor Max > engine Max, floor Max wins. Either can trigger without the other.

---

## Replenishment Logic (Critical for Simulation)

- Trading: 8 AM – 8 PM daily
- End of day: if closing stock ≤ Min → restock to Max overnight from DC
- ~Midnight: Transfer Orders raised DC → each DS; once marked "In Transit" stock leaves DC, not yet at DS
- ~Noon next day: TOs arrive at DS

**By 8 AM, only two valid states:** restocked to Max (prev day closed ≤ Min) OR same as prev close (prev day > Min, no restock needed).

### OOS Root Cause (Mode 2 Simulation)
| Root Cause | Detection |
|---|---|
| **Ops Failure** | Opening stock ≤ Min AND OOS occurs — DC failed to replenish |
| **Tool Failure** | Opening stock > Min AND OOS occurs — model undersized |
| **Unstocked** | Min=Max=0 — SKU not stocked here |
| **Could have been saved** | OOS AND physical + in_transit ≥ order qty — TO was close |

### Cluster Geography (for fulfillment analysis)
| Cluster | Stores |
|---|---|
| 1 | DS01 (Sarjapur) + DS05 (Basavanapura) |
| 2 | DS02 (Bileshivale) + DC (Rampura) |
| 3 | DS03 (Kengeri) + DS04 (Chikkabanavara) |
Cluster analysis: 65% OOS reduction (134→46) via cross-DS fulfillment. Cluster 2 (DS02+DC) achieved 95.6% due to DC buffer.

---

## What's Parked (don't revisit without new data)

- **CV-based demand shaping:** 96.3% combos have CV>2.0 (sparsity-driven, not order variability). No segmentation power.
- **Movement-based periods:** Simulated — worse (+8 OOS, +₹38.5L). Standard 45D flat is better.
- **Base min days adjustment (+1 for Slow/Super Slow):** Only 0.1% OOS reduction. Not worth it.
- **ROP:** 86.5% of OOS is single order > Max, not restock timing. Only 6 of 392 saved. Parked.

---

## To-Do (Active)

### 1. Category Network Analysis — 2 New Tabs in IMS Tool
Build "Basket Analysis" and "Category Stocking" as new tabs in the existing IMS tool (not the standalone HTML). Eliminates sharing friction — invoice + SKU Master already in tool, all colleagues access immediately.

**Context:** Full design decisions documented in `analysis/CONTEXT.md`. Read that file first.

**Phase 1 — Parser change (5 min):**
- Add `shopifyOrder: r["Shopify Order"] || ""` to `handleInvoice` in App.jsx
- Existing Supabase data won't have it until re-upload — handle gracefully in basket analysis

**Data source — both tabs use data already in the tool (no separate uploads):**
- Invoice data: from `invoiceData` state (uploaded via Upload Data tab)
- SKU Master: from `skuMaster` state (uploaded via Upload Data tab)
- No new file uploads needed on these tabs — colleagues see analysis immediately on load

**Phase 2 — Basket Analysis tab (~1 hr):**
- Generic: user selects primary + secondary categories from existing skuMaster
- Period (L45D→L3D + custom) + DS filter
- Basket composition: 5 summary cards, donut chart (Primary Only / +Secondary / +Others), co-category bar chart, insight
- Requires shopifyOrder for order grouping — show prompt if not present
- Charts: use Recharts (already in app), not Chart.js

**Phase 3 — Category Stocking tab (~1.5 hr):**
- Generic: user selects category — defaults to Plywood/MDF & HDHMR
- Per-DS Thick/Thin configs (NZD thresholds, cover days, buffer %, capacity) stored in new Supabase key `networkConfigs`
- Admin-only for editing configs; all users can view recommendations
- SKU tables: Thick + Thin separately, sorted Running → Fallback → Super Slow
- 4 summary cards with Thick/Thin breakdown + % of active
- Per-SKU click → modal with order histogram + daily consumption chart (Min/Max dotted lines)
- Recommendation only — does NOT write into the Min/Max engine (scope for later)
- Laminate detection: SKU ID contains "LAM" OR mm ≤ laminate threshold

**Until these tabs are live:** continue running analysis in `analysis/plywood-network.html` (standalone HTML tool)

**Estimated build time for Claude: ~2.5–3 hours**

### 2. OOS Simulation Redesign ⚠️ Built — pending full local test before push
**Built but not fully tested.** Local commits exist, not pushed. Test before pushing:
- Loaded Data mode: preset bar (L45D→L3D), custom date picker, drill-down navigation
- Fresh CSV / Ideal Restock: upload invoice CSV, run, drill into category/brand, breadcrumbs
- Fresh CSV / Actual Stock: upload invoice + 5 DS CSVs, pick date, run, root cause strip + filter

Original spec:
- Replace "Last N days" slider with preset bar + date picker on existing Loaded Data mode
- Fresh CSV mode (temporary, doesn't replace loaded data): Ideal Restock (any date range, OOS breakdown) and Actual Stock (single day, 5 DS stock CSVs, root cause classification: Ops Failure / Tool Failure / Unstocked / Could Have Been Saved)

### 3. Polish Stock Health Tab
Make it more rich and actionable (specifics TBD).

### 4. Rethink Tool Output Tab
Decide whether a dedicated Tool Output tab is needed, or whether the 3 key download buttons can live directly in the Upload Data tab (to be renamed "Data"). If folded in, remove the Tool Output tab entirely.

### 5. Full UI Polish Pass — All Tabs
Revisit entire UI across all tabs: Overview, SKU Detail, OOS Simulation, Stock Health, Tool Output, Logic Tweaker, Manual Overrides, Upload Data. Make each tab sharper and more actionable.

## Deferred
- Category Stocking → IMS engine integration (write Min/Max back for Plywood category — needs broader scoping including DC implications)
- Cluster fulfillment — build into tool or ops process?
- Stock Health — actionables design (TBD)

---

## Key Vocabulary

| Term | Meaning |
|---|---|
| DS / DC | Dark Store (DS01–DS05) / Distribution Centre |
| Min / Max | Reorder trigger / Target stock level |
| NZD | Non-Zero Days — days with at least one sale |
| ABQ | Average Basket Qty — avg qty per order line |
| DOC | Days of Cover — stock ÷ daily average |
| TO | Transfer Order — stock movement DC→DS |
| In Transit | Dispatched but not yet received |
| Dead Stock | SKU with Max forced = Min |
| Brand Buffer | Extra buffer days for brands with long lead times |
| Core Override | OOS Simulation override baked into model output |
| Logic Tag | Which post-blend rule modified final Min/Max |
| PCT Fallback | PCT SKU with NZD < threshold → uses Standard |
| Ops Failure | OOS because DC didn't restock when it should have |
| Tool Failure | OOS because Min/Max was too low for order size |
