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

### Zoho Inventory API
- Data centre: `.in` — base URL: `https://www.zohoapis.in`
- OAuth token: `https://accounts.zoho.in/oauth/v2/token`
- Org ID: `60044091518`
- Client ID: `1000.PZ2TU2A1JRI4FJVX102SYYMG5GMIVF`
- Client Secret: `a98c2f70e31504e01f8921920356f17a887c40c31f`
- Refresh Token: `1000.e3de20ae19cf4496182a1c2ea5aca6fa.49c27527dc5e93f158cdff66a10bce73`
- Scopes: invoices.READ, items.READ, settings.READ, reports.READ
- Daily API limit: 7,500 calls/day

### Zoho Location Mapping
DS01 Sarjapur → DS01, DS02 Bileshivale → DS02, DS03 Kengeri → DS03, DS04 Chikkabanavara → DS04, DS05 Basavanapura → DS05, DC01 Rampura → DC, HomeRun Bangalore → ignore (HQ)

### Zoho Invoice Status Mapping
- `paid` / `overdue` → use for engine (Min/Max) + simulation
- `sent` → simulation only (today's live orders)
- `void` / `draft` → ignore

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
- **PCT Guards:** NZD<2 → fall back to Standard (1 observation = no distribution). DOC cap 30D on High/Premium only — prevents capital lock-up on expensive items. Low-priced items intentionally uncapped.
- **Max formula:** Min + dailyAvg × buffer (not a multiplier of Min).

### DC Calculation
Two paths depending on whether the SKU has manual DS floors:

**Standard (no manual floors):**
`DC Min = MAX(sumDailyAvg × brandLeadTimeDays, sumDSMin × dcMultiplier.min)` — lead-time-aware, configurable per brand (default 2 days).

**Floored SKUs (SKU is in "SKU Floors - DS Level" CSV):**
`DC Min = Σ effective DS Mins × skuFloorDCMultMin (default 0.2)`
`DC Max = Σ effective DS Maxes × skuFloorDCMultMax (default 0.3)`
Movement-tag DC multipliers are bypassed entirely. Both multipliers configurable in Logic Tweaker under "SKU Floor DC Multipliers".

### Post-Blend Adjustment Order (strict)
New DS Floor → Brand Buffer (skipped if SKU has manual floor) → SKU Floor Override → Dead Stock cap → Final rounding

**Brand Buffer is skipped for SKUs with manual DS floors** — the manual floor already encodes the team's knowledge about brand replenishment behaviour. Applying both would double-count.

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

## Roadmap

### Phase 3: Actual Stock Simulation (next)
Mode 2 in OOS Simulation tab — uses 8 AM stock snapshot as opening stock instead of Max.
- S1-S4: Custom date range picker + on-demand Zoho invoice fetch — build now
- S5-S7: Mode 2 with root cause KPIs — needs stock snapshots (upload stock CSVs first)
- Stock snapshots come from Stock Health tab uploads, not from any cron

### Phase 4: Alerts
SKUs below Min, demand spikes, DOC alerts, overstock flags.

### Phase 5: Simplified Override Workflow
Inline Min/Max editing from monitoring view with audit trail.

### Open Questions
1. Alert threshold — at what DOC level to flag "at risk"?
2. Which brands have 5-day DC replenishment? (Field exists in Logic Tweaker, needs populating)
3. Cluster fulfillment — build into tool or ops process?

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
