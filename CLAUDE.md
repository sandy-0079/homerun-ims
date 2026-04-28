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

- Invoice CSV (Zoho export) replaces entirely on upload — no merge. Engine uses whatever period admin sets.
- All uploads auto-save to Supabase `team_data` immediately.
- Model refresh: upload → Apply & Re-run Model → results pushed to Supabase → all users see new Min/Max.
- Stock Health: admin exports Inventory Summary CSV per DS, uploads via per-DS buttons. Saved to Supabase.

---

## Category Strategy Engine

**Why:** 78.7% of SKU×DS combos are Slow/Super Slow. Averages produce near-zero Min for items selling once every 10+ days.

| Strategy | Categories | Key Logic |
|---|---|---|
| **Standard** | Cement, General Hardware, Painting, Fevicol, Water Proofing | Daily avg × base min days, long/recent blend |
| **Percentile Cover (PCT)** | Furniture & Arch HW, Tiling, CPVC, Plywood/MDF, Switches, Conduits, Lighting, Sanitary & Bath | Pxx of non-zero daily qty × cover days |
| **Fixed Unit Floor** | Wires/MCB, Overhead Tanks | P90 of individual order quantities |
| **Network Design** | Plywood/MDF (opt-in) | Brand-level stocking — see below |

PCT key decisions: percentile by price (Premium=75, High=80, Medium=85, Low/Super Low/No Price=95); cover days by movement (Super Fast/Fast=2, others=1); DOC cap guards (pctDocCap=30D Premium/High, pctDocCapLow=60D others).

### DC Calculation (non-Network-Design)
- **Standard:** `DC Min = ceil(sumDailyAvg × (leadTime+1))` · `DC Max = DC Min + ceil(sumDailyAvg × 2)`
- **Floored SKUs:** `Σ DS Mins × 0.2` / `Σ DS Maxes × 0.3`
- **Dead Stock:** `Σ DS Mins × 0.25` / `Σ DS Maxes × 0.25`

Post-blend order (strict): New DS Floor → SKU Floor Override → Dead Stock cap → Rounding

---

## Network Design — Plywood Stocking

**Activated via:** Logic Tweaker → Category Strategy Map → "Plywood, MDF & HDHMR" → "Network Design". Off by default; PCT runs unchanged when inactive.

**Concept:** Brand-level assignments — each brand is stocked at specific DS nodes which aggregate demand from multiple DSes. Non-stocking DSes get Min=Max=0 (fulfilled from stocking node or DC).

**Current brand assignments:**
- Action Tesa, CenturyPly: stocked at DS01 (covers DS01+DS05) + DS03 (covers DS03+DS04+DS05). DC directly serves DS02+DS04.
- ArchidPly, GreenPly: stocked at DS02 (DS02+DS01) + DS04 (DS04+DS03) + DS05 (DS05+DS01+DS03). DC replenishment only.
- Merino: excluded from this tab, uses PCT.

**3-zone stocking per SKU (NZD = non-zero demand days in lookback):**
- **Rare** (NZD < minNZD=2): Min=Max=0, not stocked
- **Sparse** (2 ≤ NZD < sparseNZD=5): Min=ceil(ABQ), Max=ceil(Min×abqMult) ≥ Min+1. ABQ = total qty ÷ orders.
- **Frequent** (NZD ≥ 5): Min=P95 of winsorised aggregated daily demand, Max=Min+P75(orders), capped at maxCap=20.

Winsorising: daily demand capped at median×spikeCapMult before P95 to handle outlier days.

**DC formula:** `DC = P95(direct-serving DSes) + ceil(Σ DS_Min × dcMult)`. Uses Σ DS_Min (not Σ(Max-Min)) so fast-movers get proportional DC buffer.

**Config:** Plywood tab → ⚙ Network Design Configuration (admin). Stored in `params/plywoodNetworkConfig` (separate from `params/global`). Saving auto-reruns engine. Key params: lookbackDays=90, minPercentile=95, maxBufferPercentile=75, maxCap=20, spikeCapMult=3, minNZD=2, sparseNZD=5, abqMult=1.5, dcCapacity={thick:400,thin:400}, per-brand dcMultMin/dcMultMax (tuned to 0.3/0.5).

Brand-DS assignments editable in config matrix (brand×DS checkboxes + covers). Brand matching is case-insensitive.

---

## Replenishment Logic

- Trading: 8 AM–8 PM. End of day: closing stock ≤ Min → restock to Max overnight from DC.
- ~Midnight: TOs raised DC→DS. ~Noon next day: TOs arrive at DS.
- Clusters: DS01+DS05 (C1), DS02+DC/Rampura (C2), DS03+DS04 (C3).

---

## What's Parked (don't revisit without new data)

- **CV-based demand shaping:** 96.3% combos have CV>2.0 (sparsity-driven). No segmentation power.
- **Movement-based periods:** Simulated — worse (+8 OOS, +₹38.5L). Standard 45D flat is better.
- **Base min days adjustment (+1 for Slow/Super Slow):** Only 0.1% OOS reduction. Not worth it.
- **ROP:** 86.5% of OOS is single order > Max, not restock timing. Parked.

---

## To-Do (Active)

### 1. Category Network Analysis ✅ Shipped (2026-04-18)
`src/tabs/BasketAnalysisTab.jsx` + Plywood Network tab. Baskets: category/brand analysis with DS×Brand heat map. Plywood: per-DS thick/thin view (PCT mode) — recommendation only, does NOT write into engine.

### 2. OOS Simulation Redesign ❌ Dropped (2026-04-21)

### 3. Polish Stock Health Tab — specifics TBD

### 4. Rethink Tool Output Tab — fold buttons into Upload Data tab or keep separate?

### 5. Full UI Polish Pass — all tabs (Overview, SKU Detail, Stock Health, Logic Tweaker, etc.)

### 6. Plywood Network Design ✅ Shipped (2026-04-28)
Network Design strategy in engine (`src/engine/strategies/plywoodNetwork.js`). Full UI in PlywoodNetworkTab.jsx — unified SKU table with zone colouring, DC tab, brand assignment editor, compact modal with zone-aware formula display and lookback-period charts.

### 7. Read-only config visibility for non-admins — Logic Tweaker + Overrides tabs
Non-admins currently cannot see Logic Tweaker or Overrides tabs at all (controlled by `ADMIN_TABS` vs `PUBLIC_TABS` in App.jsx). Plan: add both to `PUBLIC_TABS` and disable all inputs with `disabled={!isAdmin}`. Upload Data tab stays admin-only. Plywood Network Design Config already done (visible to all, inputs disabled for non-admins, Save button hidden).

### 8. DC Calculation Fix for PCT + Fixed Unit Floor Categories
`sumDailyAvg × (leadTime+1)` understocks for erratic demand at DC. Fix: switch to `Σ DS Mins × mult` approach (same as floored SKUs). Held pending any follow-up from Network Design learnings.

## Deferred
- Cluster fulfillment — build into tool or ops process?
- Stock Health actionables design

---

## Key Non-Obvious Terms

| Term | Meaning |
|---|---|
| NZD | Non-Zero Days — days with at least one sale |
| ABQ | Average Buying Quantity = total qty ÷ orders in lookback |
| DOC | Days of Cover — stock ÷ daily average |
| TO | Transfer Order — stock movement DC→DS |
| Dead Stock | SKU with Max forced = Min |

---

## Logic Tweaker Params Backup

Full backup auto-saved to `params/paramsBackup` on every "Apply & Re-run Model" click. Restore from there if `params/global` is corrupted.

Key non-defaults: `overallPeriod=45`, `newDSFloorTopN=250`, `newDSList=["DS04","DS05","DS03"]`, `brandLeadTimeDays={_default:3,AsianPaints:4}`, `pctDocCap=30`, `pctDocCapLow=60`, `pctMinNZD=2`. Category strategies: 8 PCT + 2 Fixed Unit Floor + Plywood=NetworkDesign (see Supabase).
