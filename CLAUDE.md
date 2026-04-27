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
| **Percentile Cover (PCT)** | Furniture & Arch HW, Tiling, CPVC, Plywood/MDF, Switches, Conduits, Lighting, Sanitary & Bath | Pxx of non-zero daily qty × cover days |
| **Fixed Unit Floor** | Wires/MCB, Overhead Tanks | P90 of individual order quantities |

### PCT Design Decisions
- **Percentile by price:** Low/Super Low/No Price=95, Medium=85, High=80, Premium=75. Cheap items stocked aggressively — hard to emergency-source.
- **Cover days:** Super Fast/Fast=2, Moderate/Slow/Super Slow=1. DC restocks daily so only 1 day needed for slow movers.
- **Note:** constants.js and percentileCover.js fallbacks must match these values exactly — they're the authoritative source if Supabase params predate the `percentileCover` key.
- **PCT Guards (price-tag-aware):**
  - Premium/High: NZD < `pctMinNZD` (default 2) → fall back to Standard. DOC cap `pctDocCap` (default 30D) — prevents capital lock-up on expensive items.
  - Medium/Low/Super Low/No Price: NZD ≥ 1 always uses PCT (cheap items stocked aggressively). DOC cap `pctDocCapLow` (default 60D) — higher cap acceptable since cheap stock ties up less capital.
- **Max formula:** Min + dailyAvg × buffer (not a multiplier of Min).

### DC Calculation
Three paths depending on SKU type:

**Standard:** `DC Min = ceil(sumDailyAvg × (brandLeadTimeDays + 1))` · `DC Max = DC Min + ceil(sumDailyAvg × 2)`. Default lead time 3 days; configurable per brand.

**Floored SKUs:** `DC Min = Σ DS Mins × skuFloorDCMultMin (0.2)` · `DC Max = Σ DS Maxes × skuFloorDCMultMax (0.3)`. Erratic demand so DC stays lean.

**Dead Stock:** `DC Min = Σ DS Mins × 0.25` / `DC Max = Σ DS Maxes × 0.25`

### Post-Blend Adjustment Order (strict)
New DS Floor → SKU Floor Override → Dead Stock cap → Final rounding

**SKU Floor Min and Max are checked independently** — either can trigger without the other.

---

## Replenishment Logic

- Trading: 8 AM – 8 PM daily. End of day: closing stock ≤ Min → restock to Max overnight from DC.
- ~Midnight: TOs raised DC→DS. ~Noon next day: TOs arrive at DS.
- Clusters: DS01+DS05 (Cluster 1), DS02+DC/Rampura (Cluster 2), DS03+DS04 (Cluster 3).

---

## What's Parked (don't revisit without new data)

- **CV-based demand shaping:** 96.3% combos have CV>2.0 (sparsity-driven). No segmentation power.
- **Movement-based periods:** Simulated — worse (+8 OOS, +₹38.5L). Standard 45D flat is better.
- **Base min days adjustment (+1 for Slow/Super Slow):** Only 0.1% OOS reduction. Not worth it.
- **ROP:** 86.5% of OOS is single order > Max, not restock timing. Only 6 of 392 saved. Parked.

---

## To-Do (Active)

### 1. Category Network Analysis ✅ Shipped (2026-04-18)
Both tabs live in production. `src/tabs/BasketAnalysisTab.jsx` + `src/tabs/PlywoodNetworkTab.jsx`.
- **Baskets**: category selector (click-cycle), period L45D→L3D + custom, DS filter, 5 cards, donut, co-category bar, insight. Selections persist to localStorage, auto-runs on load. Also includes Brand Basket Analysis (below category basket): select category → brand selector with exclude/restore per brand → 5 cards, donut, co-brand bar + DS×Brand heat map table (relative per-row green→red gradient showing brand DS concentration).
- **Plywood**: per-DS Thick/Thin configs (Supabase), SKU table (Running/Fallback/Super Slow), capacity bar (3-state), per-SKU modal (histogram + timeline). Auto-computes on load. Recommendation only — does NOT write into Min/Max engine.

### 2. OOS Simulation Redesign ❌ Dropped (2026-04-21)
Dropped — existing simulation covers ops needs. Untested code discarded to avoid repeat of the params corruption incident. If Fresh CSV / Actual Stock root cause mode is needed in future, rebuild cleanly from scratch.

### 3. Polish Stock Health Tab
Make it more rich and actionable (specifics TBD).

### 4. Rethink Tool Output Tab
Decide whether a dedicated Tool Output tab is needed, or whether the 3 key download buttons can live directly in the Upload Data tab (to be renamed "Data"). If folded in, remove the Tool Output tab entirely.

### 5. Full UI Polish Pass — All Tabs
Revisit entire UI across all tabs: Overview, SKU Detail, OOS Simulation, Stock Health, Tool Output, Logic Tweaker, Manual Overrides, Upload Data. Make each tab sharper and more actionable.

### 6. Plywood IMS Engine Integration ⏳ Brainstorm in progress — NOT ready to implement
Integrate Plywood Network recommendations into the Min/Max engine. Brainstorm started 2026-04-21. **Do not implement until explicitly asked.**

**Aligned so far:**

**DS logic (Plywood SKUs at each DS):**
- Use same median-based algorithm as Plywood Network tab (median of ALL daily totals, unfiltered — median is robust to large outlier orders)
- Tier classification (Running / Fallback / Super Slow) per DS using per-thickness NZD thresholds from networkConfigs
- Running SKU → DS Min/Max computed; Fallback + Super Slow → DS Min = Max = 0
- Fallback threshold (P75 of individual order qtys) retained for routing logic
- New per-thickness config fields in networkConfigs: `fallbackType: "DC"|"Supplier"` and `superSlowType: "DC"|"Supplier"` — added inside each ConfigPanel (Thick/Thin) — determines whether DC or external supplier serves that tier for each DS×thickness combination

**DC logic (Plywood SKUs at DC):**
- DC demand formula base: `Σ DS Mins × multMin`, `Σ DS Maxes × multMax` (same as floored SKU approach, NOT daily avg — daily avg understates DC need for erratic/lumpy demand)
- Which DSes contribute to DC demand per SKU: Running SKUs always contribute; Fallback SKUs contribute only if `fallbackType = "DC"`; Super Slow SKUs contribute only if `superSlowType = "DC"`
- Multipliers configurable in Logic Tweaker (separate from existing `skuFloorDCMultMin/Max`)

**Still to align before proceeding:**
- Full scenario walkthrough (4 scenarios raised, not yet validated — Running with threshold, Fallback→DC, SuperSlow→DC, mixed tiers across DSes)
- DC multiplier values for Plywood specifically
- Archidply brand exception: deferred (resolved if supplier changes)
- How this integrates with the existing `isFlooredSKU` DC override (likely bypassed for Plywood)
- Spec and implementation plan

### 7. DC Calculation Fix for PCT + Fixed Unit Floor Categories
Current engine uses `sumDailyAvg × (leadTime+1)` for ALL non-Standard categories at DC, which understocks for erratic demand. Aligned fix:
- **Standard**: keep `sumDailyAvg × (leadTime+1)` — smooth demand, daily avg works
- **PCT + Fixed Unit Floor**: switch to `Σ DS Mins × multMin` / `Σ DS Maxes × multMax` — same approach as floored SKUs
- Multipliers configurable in Logic Tweaker (can reuse `skuFloorDCMultMin/Max` or add separate ones)
- Pick up after Plywood engine integration is complete

## Deferred
- Cluster fulfillment — build into tool or ops process?
- Stock Health — actionables design (TBD)

---

## Key Non-Obvious Terms

| Term | Meaning |
|---|---|
| NZD | Non-Zero Days — days with at least one sale |
| DOC | Days of Cover — stock ÷ daily average |
| TO | Transfer Order — stock movement DC→DS |
| Dead Stock | SKU with Max forced = Min |
| PCT Fallback | PCT SKU with NZD < threshold → uses Standard strategy |

---

## Logic Tweaker Params Backup

**Last saved:** 2026-04-20T12:09 IST. Full backup auto-saved to Supabase `params/paramsBackup` on every "Apply & Re-run Model" click — restore from there if `params/global` is corrupted.

Key non-default values: `overallPeriod=45`, `newDSFloorTopN=250`, `newDSList=["DS04","DS05","DS03"]`, `recencyWt={SuperFast:5,Fast:5,Moderate:4,Slow:4,SuperSlow:4}`, `brandLeadTimeDays={_default:3,AsianPaints:4}`, `pctDocCap=30`, `pctDocCapLow=60`, `pctMinNZD=2`. Category strategies: 8 PCT + 2 Fixed Unit Floor (see Supabase for full list).
