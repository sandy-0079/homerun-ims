# CLAUDE.md — HomeRun IMS v2

HomeRun operates 5 dark stores (DS01–DS05) + one DC. This tool computes Min/Max inventory
levels for every SKU at every location so ops knows how much stock to hold.

This is a ground-up rebuild of the original IMS (homerun-ims repo). The original tool
remains live and untouched. Do not modify the old repo.

---

## Stack & Credentials

| Layer | Detail |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Styling | CSS custom properties in `:root` + inline `React.CSSProperties` — **no Tailwind, no shadcn/ui** |
| Charts | Recharts only — no other chart library |
| Deployment | Vercel |
| Database | Supabase (same project as v1, new v2 tables) |
| Engine | `src/engine/` — modular strategy dispatcher |
| Supabase URL | https://rgyupnrogkbugsadwlye.supabase.co |
| Supabase Anon Key | eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc |
| Admin Password | IMSAdmin123 |

---

## Design System

Match the HomeRun Sales & Margin Dashboard exactly.
Reference: https://homerun-margin-dashboard.vercel.app/

### Design Tokens — copy into `src/index.css` `:root`

```css
:root {
  --bg-base:        #0a0f1e;  /* page background */
  --bg-surface:     #111827;  /* card background */
  --bg-elevated:    #1a2235;  /* inputs, nested surfaces */
  --bg-hover:       #1e2a40;
  --border:         #1e3a5f;
  --border-light:   #162035;
  --text-primary:   #e6edf3;
  --text-secondary: #8b949e;
  --text-muted:     #484f58;
  --accent:         #f0b429;  /* gold — primary CTA, active sort */
  --green:          #3fb950;
  --green-bg:       #0d2318;
  --red:            #f85149;
  --red-bg:         #2d0f0e;
  --font:      -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
  --font-mono: "SF Mono", "Fira Code", monospace;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
```

### Layout Structure

```
Full viewport (100vh), flex column
├── Header          flex row, ~50px, flexShrink: 0
├── Controls bar    flexShrink: 0
└── Body            flex row, flex: 1, overflow: hidden
    ├── Sidebar     width: 210px, minWidth: 210px, overflowY: auto
    └── Main        flex: 1, overflowY: auto, padding: 16px
        ├── KPI cards   CSS grid, 4 columns, gap: 12px
        ├── Chart area  width: 100%, height: 300px fixed
        └── Table       width: 100%, overflowX: auto
```

### Styling Convention

Every component defines a local styles object typed as `Record<string, React.CSSProperties>`:

```tsx
const s: Record<string, React.CSSProperties> = {
  container: { background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', ... },
  card:       { ... },
};
// usage: <div style={s.container}>
```

No Tailwind classes anywhere. No external component libraries.

### Typography

| Use | Size | Weight |
|---|---|---|
| Hero numbers (KPI) | 26px | 700 |
| Section labels | 13px | 600 |
| Body / table cells | 12px | 400 |
| Secondary text | 11px | 400 |
| Table headers | 10px | 600, uppercase |
| SKUs / codes / metrics | `var(--font-mono)` | — |

### Charts (Recharts)

```tsx
<ResponsiveContainer width="100%" height={300}>
  <ComposedChart data={data}>
    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" vertical={false} />
    <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
    <YAxis yAxisId="left"  tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} />
    <YAxis yAxisId="right" orientation="right" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} />
    <Tooltip contentStyle={{ background: '#1a2235', border: '1px solid #1e3a5f' }} />
    {/* Current period */ }
    <Bar yAxisId="left" dataKey="current" fill="#22d3ee" radius={[3, 3, 0, 0]} />
    {/* Prior period */}
    <Bar yAxisId="left" dataKey="prior"   fill="#1e3a5f" radius={[3, 3, 0, 0]} />
    {/* Primary metric line */}
    <Line yAxisId="right" dataKey="metricA" stroke="#f0b429" dot={false} strokeWidth={1.5} />
    {/* Comparison line */}
    <Line yAxisId="right" dataKey="metricB" stroke="#6ee7b7" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
  </ComposedChart>
</ResponsiveContainer>
```

### Delta Badges

```tsx
// Positive
{ color: 'var(--green)', background: 'var(--green-bg)', borderRadius: 4, padding: '2px 6px', fontWeight: 600 }
// Negative
{ color: 'var(--red)',   background: 'var(--red-bg)',   borderRadius: 4, padding: '2px 6px', fontWeight: 600 }
// Neutral
{ color: 'var(--text-muted)' }
```

---

## Architecture — Four Layers

```
engine/     Pure strategy logic — no UI dependencies
store/      Shared state — params, results, user session (React Context)
tabs/       UI — each tab is a self-contained directory
lib/        Supabase client, shared utilities
```

**Rule:** Tabs read from the store and call the engine. Tabs do not talk to each other.
Adding a new tab requires no changes to existing tabs.

---

## Navigation — Side Nav

```
Core
  ├ Upload Data       (CSV upload + output download buttons)
  ├ SKU Detail
  ├ Manual Overrides

Categories
  ├ Plywood           (carry-forward, reference implementation)
  ├ Wires / MCB       (first new category tab — see below)
  ├ [future categories added here]

Analysis
  ├ Baskets
  ├ OOS Simulation
```

Adding a new category = one entry in Categories + one strategy file + one tab directory.

---

## Universal Engine Framework

**All categories use this framework. Category tabs supply config; the engine executes it.**

### Step 1 — Winsorisation (before any formula)

Cap outlier daily demand:
```
winsorisedQty = min(qty, median(nonZeroDays) × winsorisationCap)
```
- `winsorisationCap` is configurable per price tier per category
- Premium / High: tight cap — project orders distort costly SKUs most
- Medium: moderate cap
- Low / Super Low / No Price: no cap (null) — 45-day aging cap on Max handles it
- **Outlier days still count as NZD.** Winsorisation caps quantity, not frequency.

### Step 2 — Zone Classification (per DS, per SKU)

NZD = count of days with non-zero demand in the lookback window (all days, including
winsorised ones). Zone thresholds are configurable per price tier per category:

| Zone | Condition | Strategy |
|---|---|---|
| Rare | NZD < rareThreshold | Don't stock (Premium/High) or small floor (cheap) |
| Sparse | rareThreshold ≤ NZD < sparseThreshold | Demand-per-order-day formula |
| Frequent | NZD ≥ sparseThreshold | PCT formula |

Zone classification is **per DS**. Same SKU can be Frequent at DS02 and Sparse at DS01.

### Step 3 — Min Calculation

**Frequent zone:**
```
nonZeroWinsorised = winsorised daily quantities where qty > 0
Min = ceil(percentile(nonZeroWinsorised, P_x) × coverDays)
```
`P_x` and `coverDays` configurable per price tier per category.

**Sparse zone:**
```
Min = ceil(sum(winsorisedDailyDemand) / NZD)
```
"What does a typical demand day actually look like." More honest than P90 of individual
order quantities for sparse SKUs.

**Rare zone:**
- Premium / High: Min = 0
- Low / Super Low / No Price: Min = `rareStockFloor` (configurable, e.g. 1 unit)

### Step 4 — Max Calculation

**Frequent zone:**
```
Max = ceil(percentile(nonZeroWinsorised, P_x) × (coverDays + replenishmentDays))
```
Same signal as Min, extended by replenishment window.
`replenishmentDays` configurable (1 = best case, 2 = worst case DC→DS).

**Sparse zone:**
```
Max = ceil(Min × maxMultiplier)
```
`maxMultiplier` configurable per price tier per category (default 2×).

**Aging cap for cheap items (Low / Super Low / No Price):**
```
Max = min(formulaMax, ceil(dailyAvg × agingDays))
```
`agingDays` default 45, configurable. Prevents aging beyond target regardless of signal.

### Step 5 — Post-Formula Adjustments (preserved from v1)

Applied in strict order:
1. **New DS Floor** — top-N SKUs at new DSes get a demand-informed floor
2. **SKU Floor Overrides** — manual overrides from Manual Overrides tab win if they exceed formula

---

## Category Tab Contract

Every category tab implements exactly this:

**1. Strategy file** — `src/engine/strategies/categoryName.js`
Pure function. Takes SKU demand data + category config → returns Min/Max per DS.
No UI dependencies.

**2. Config panel** (admin only in the tab UI)
Reads/writes the price-tier config matrix from `category_configs` Supabase table.
Saving config triggers engine re-run for that category.

**3. Results table**
Reads engine output from store.
Per-SKU, per-DS Min/Max with zone colouring (Rare / Sparse / Frequent).
Expandable row: which zone, which formula, why.

---

## Supabase Schema (v2 tables)

Same Supabase project as v1. New table names prevent collision while both tools are live.
When v1 is retired, old tables (`params`, `overrides`, `team_data`) can be dropped.

| Table | Purpose |
|---|---|
| `params_v2` | Global engine params (overallPeriod, leadTimeDays, newDSList, etc.) |
| `category_configs` | Per-category, per-price-tier config matrix — new, no v1 equivalent |
| `overrides_v2` | Manual SKU floor overrides |
| `team_data_v2` | Invoice CSV rows, stock health uploads |

### `category_configs` columns

```
category            text     e.g. "Wires/MCB"
price_tier          text     "Premium" | "High" | "Medium" | "Low" | "Super Low" | "No Price"
rare_threshold      int      NZD below this → Rare zone
sparse_threshold    int      NZD below this → Sparse zone (≥ this → Frequent)
percentile          int      PCT percentile for Min in Frequent zone
cover_days          int      Cover days for Min
replenishment_days  int      Buffer days for Max (1 or 2)
winsorisation_cap   float    Median multiplier for cap (null = no winsorisation)
max_multiplier      float    Sparse Max = Min × this
aging_days          int      Cheap items Max cap = dailyAvg × this (null = no cap)
rare_stock_floor    int      Units to hold in Rare zone (0 = don't stock)
```

---

## Carry-Forward from v1

**v1 repo location:** `homerun-ims` — do not touch.

### Copy verbatim

| Piece | Notes |
|---|---|
| `src/engine/` (full directory) | Already modular and clean. Drop into new repo as-is. |
| `src/engine/strategies/plywoodNetwork.js` | Reference implementation for category tab pattern. |
| `src/simWorker.js` | Web Worker for OOS Simulation tab. |

### Replicate logic, rebuild UI

For every carry-forward tab: understand what it does, rewrite the structure cleanly.

| Tab | Logic to preserve | What to rewrite |
|---|---|---|
| Upload Data | CSV parsing (`parseCSV` in utils.js), Supabase save, output download | Full UI — add download buttons to same tab |
| SKU Detail | Display and filtering logic | Full UI |
| Plywood | `PlywoodNetworkTab.jsx` logic, all config params | Rebuild into new tab contract — use as architecture validation |
| Baskets | `BasketAnalysisTab.jsx` — basket analysis logic | Full UI |
| Manual Overrides | Override apply/revert logic with `overrides_v2` table | Full UI |
| OOS Simulation | `simWorker.js` simulation logic | Full UI |

### Do not copy

- `App.jsx` — monolithic, prop-drilled, tangled state management. Rebuild from scratch.
- Top nav structure — replaced by side nav.
- `params/global` Supabase key structure — replaced by `category_configs` + `params_v2`.

---

## Build Sequence

### Phase 1 — Shell
1. `npm create vite@latest . -- --template react-ts` — React 19 + TypeScript
2. `npm install recharts @supabase/supabase-js`
3. Add design tokens to `src/index.css` `:root` (see Design System section)
4. Copy `src/engine/` from homerun-ims repo verbatim
5. Copy `src/simWorker.js` from homerun-ims repo
6. Build side nav (Core / Categories / Analysis groups) — no tab content yet
7. Set up React Context store (params, engine results, user session)
8. Set up Supabase client pointing to v2 tables

### Phase 2 — Plywood Tab (architecture validation)
Port `PlywoodNetworkTab.jsx` from v1 into the new tab contract.
Most complex carry-forward — if it fits cleanly, all simpler tabs are guaranteed to work.
Do not move to Phase 3 until Plywood is clean and working.

### Phase 3 — Carry-Forward Tabs
Port in this order (simplest to most complex):
- Manual Overrides
- SKU Detail
- Baskets
- Upload Data (CSV upload + output download buttons in same tab)
- OOS Simulation

### Phase 4 — Wires/MCB Tab
First new category tab. Implements the universal engine framework from scratch.
Establishes the pattern for all future category tabs.

### Phase 5 — Engine Migration
After Wires/MCB validates the new framework, migrate remaining categories one by one.
Each migration: add strategy file → add category tab → add default config rows to `category_configs`.

---

## Wires/MCB — Default Config

First new category tab. Defaults encode domain knowledge; admin can override per price tier.

| Config | Premium / High | Medium | Low / Super Low / No Price |
|---|---|---|---|
| Rare threshold (NZD) | 5 | 3 | 2 |
| Sparse threshold (NZD) | 15 | 10 | 5 |
| Percentile (P_x) | 75 / 80 | 85 | 95 |
| Cover days | 2 | 1 | 1 |
| Replenishment days | 2 | 2 | 2 |
| Winsorisation cap | 1.5× median | 2× median | None |
| Max multiplier (sparse) | 1.5× | 2× | 2× |
| Rare stock floor | 0 units | 0 units | 1 unit |
| Aging cap (days) | None | None | 45 |

---

## Domain Knowledge

### Operations

- Trading hours: 8 AM–8 PM. End of day: closing stock ≤ Min → restock to Max overnight.
- ~Midnight: Transfer Orders raised DC→DS. ~Noon next day: TOs arrive at DS.
- HomeRun never shows customers a stockout. Every order fulfilled via cross-DS transfer,
  DC pull, or emergency supplier purchase. Cost of OOS = ops chaos, not lost revenue.
- Clusters: DS01+DS05 (C1), DS02+DC/Rampura (C2), DS03+DS04 (C3).
- Growing 20–25% MoM — historical 90-day data is structurally deflated vs current run rate.

### Inventory Bias

- **Cheap items (Low / Super Low):** Stock aggressively. Hard to emergency-source
  (scattered small vendors). Overstock cost is low.
- **Premium / High items:** Stock lean. Established supplier relationships — easy to
  call and get delivered. Overstock = aging risk + capital tied up.

### Plywood Network Design (carry-forward, already solved)

Brand-level stocking — each brand assigned to specific DS nodes that aggregate demand.
Non-stocking DSes get Min=Max=0. Config stored in `category_configs` for Plywood.

Current brand assignments:
- Action Tesa, CenturyPly: DS01 (covers DS01+DS05) + DS03 (covers DS03+DS04+DS05)
- ArchidPly, GreenPly: DS02 (DS02+DS01) + DS04 (DS04+DS03) + DS05 (DS05+DS01+DS03)
- Merino: excluded from network design, uses PCT

---

## Key Terms

| Term | Meaning |
|---|---|
| NZD | Non-Zero Days — days with at least one sale |
| ABQ | Average Buying Quantity = total qty ÷ orders |
| DOC | Days of Cover — stock ÷ daily average |
| TO | Transfer Order — stock movement DC→DS |
| PCT | Percentile Cover — formula using P_x of non-zero daily demand |
| Rare / Sparse / Frequent | Zone classification by NZD count |
| Winsorisation | Cap outlier daily quantities at median × cap before any formula runs |
| agingDays | Max aging target (default 45) — Max ≤ dailyAvg × agingDays for cheap items |
| rareStockFloor | Units to hold for cheap items in Rare zone (0 = don't stock) |

---

## What's Parked (do not revisit without new data)

- CV-based demand shaping: 96.3% of SKU×DS combos have CV>2.0 (sparsity-driven). No segmentation power.
- ROP: 86.5% of OOS is single order > Max, not restock timing.
- Movement-based periods: simulated worse than flat 45D. Standard 45D is better.
