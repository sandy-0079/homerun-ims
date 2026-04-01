# Category Strategy Engine — Design Spec

**Date:** 2026-04-01
**Status:** Approved
**Scope:** v1 — Category-assigned strategies with lead-time-aware DC logic

---

## 1. Problem Statement

The current Min/Max engine uses a single average-based formula for all SKUs. This fails for:

- **Size-volatile categories** (e.g., Plywood) — order qty ranges from 2 to 15, averages erase the demand shape, Min is set too low
- **Timing-volatile categories** (e.g., Wires) — orders arrive every 45-60 days but in predictable qty (1-2), averages dilute to near-zero over 90 days
- **Moderate/Slow/Super Slow movers at Medium/High/Premium prices** — the exact segment with the highest stockout rate

Stockouts at HomeRun do not mean lost sales — every order is fulfilled via cross-DS transfer, DC pull, or emergency supplier purchase. The real cost is **operational chaos** for the ops team. The model should therefore be biased toward overstocking for erratic SKUs, since carrying cost is far cheaper than scramble cost.

Additionally, cheap/low-priced items are harder to emergency-source (scattered across small vendors), while premium items have established supplier relationships. This inverts the traditional inventory stocking priority.

---

## 2. What Changes, What Doesn't

### Unchanged (runs exactly as today)
- Data preparation (CSV parsing, 90-day rolling window, status filtering)
- T150 ranking
- Movement tagging (based on avg interval)
- Spike detection & spike median computation
- Price tagging
- Post-blend adjustments in strict order: New DS Floor -> Brand Buffer -> NSQ Override -> Dead Stock cap -> Final rounding
- OOS Simulation engine (replay logic)
- Admin/Public access model
- Supabase sync architecture
- All existing CSV input formats

### New
- A **strategy dispatcher** between tagging and Min/Max calculation
- Each category is assigned a strategy (stored in Supabase `params`)
- Min/Max calculation routes to the assigned strategy's formula
- DC calculation becomes lead-time-aware (per-brand lead time config)
- New config sections in Logic Tweaker for strategy assignment, strategy params, and brand lead times
- Dashboard shows both a **Strategy Tag** (which strategy computed the base) and the existing **Logic Tag** (which post-blend rule modified it)

---

## 3. The Four Strategies

### 3.1 Standard (current engine)

**Use for:** Categories with predominantly Fast/Super Fast movers where the existing model works well.

**Logic:** Exactly the current engine, no changes.
- Long/Recent period split
- Per-period: Min = CEILING(baseMinDays x dailyAvg), spike ratio override, ABQ floor
- Blend with recency weights
- All existing params continue to apply (spike multiplier, buffer days, ABQ multiplier, recency weights)

### 3.2 Percentile Cover

**Use for:** Categories with size-volatile demand (e.g., Plywood) where order qty is unpredictable.

**Logic:**

**Step 1 — Percentile selection by price tag:**

| Price Tag       | Percentile | Reasoning                                      |
|-----------------|------------|-------------------------------------------------|
| Low / Super Low / No Price | 95th | Cheap to overstock, hard to emergency-source |
| Medium          | 90th       | Balanced                                        |
| High / Premium  | 85th       | Expensive to overstock, easier to source on-demand |

**Step 2 — Cover days by movement tag:**

| Movement    | Cover Days | Reasoning                              |
|-------------|------------|----------------------------------------|
| Super Fast  | 2          | Fallback — unlikely in this strategy   |
| Fast        | 2          | Fallback — unlikely in this strategy   |
| Moderate    | 3          | Orders every few days, need multi-day buffer |
| Slow        | 2          | Less frequent, daily DC restock covers  |
| Super Slow  | 1          | Rare orders, survive until next restock |

**Step 3 — Compute Min/Max:**

```
Min = CEILING(Pxx of non-zero daily qty over 90-day window x cover days)
Max = CEILING(Min + daily avg x maxDaysBuffer)
```

Where `maxDaysBuffer` is the existing configurable param (default 2).

All percentile thresholds and cover days are configurable in Logic Tweaker.

### 3.3 Fixed Unit Floor

**Use for:** Categories with timing-volatile but size-predictable demand (e.g., Wires) where order qty is consistent but arrival timing is erratic.

**Logic:**

**Step 1 — Compute P90 of order qty** across all individual order lines for that SKU x DS in the 90-day window. This filters out one-off freak orders while covering the realistic worst case.

**Step 2 — Min/Max:**

```
Min = CEILING(P90 of order qty)
Max = CEILING(MAX(Min + 1, Min x 1.5))
```

**Step 3 — Zero-order fallback:** If Min computes to 0 (no orders in 90 days), fall back to Standard strategy for that SKU.

Configurable params: `orderQtyPercentile` (default 90), `maxMultiplier` (default 1.5), `maxAdditive` (default 1).

### 3.4 Manual

**Use for:** Exception SKUs or categories where the operator wants full control.

**Logic:** Min and Max are set directly by the operator. No computation. Values stored and synced via Supabase using the existing override mechanism, but assignable at category level.

---

## 4. Strategy Dispatch Flow

```
For each SKU x DS:
  1. Run all tagging (Movement, Spike, Price, T150) — same as today
  2. Look up SKU's category -> assigned strategy
  3. Dispatch to strategy's Min/Max formula
  4. Apply post-blend adjustments in strict order:
     a. New DS Floor (if applicable)
     b. Brand Buffer (if applicable)
     c. NSQ Override (if applicable)
     d. Dead Stock cap (if applicable)
     e. Final rounding
  5. Record Strategy Tag (which strategy produced the base value)
  6. Record Logic Tag (which post-blend adjustment modified it, if any)
```

Dashboard displays both tags, e.g., "Percentile Cover -> Brand Buffer".

---

## 5. DC Calculation — Lead-Time-Aware

Replaces the current DS-total-multiplier approach.

```
DC Min = CEILING(sum of DS daily avgs x brand lead time days)
DC Max = CEILING(DC Min x dc max multiplier by movement tag)
```

Where:
- **Brand lead time** = per-brand config, default 2 days
- **DC max multiplier** = per-movement-tag config, using existing DC multiplier structure

This is **strategy-agnostic** — DC doesn't care how DS Min was calculated. It answers: "How much stock does the DC need to keep feeding all DS stores until the next supplier delivery arrives?"

---

## 6. Configuration & Storage

New fields added to the existing Supabase `params` table payload:

```json
{
  "categoryStrategies": {
    "Plywood": "percentile_cover",
    "Wires": "fixed_unit_floor",
    "Paints": "standard",
    "Electrical": "standard"
  },
  "percentileCover": {
    "percentileByPrice": {
      "Low": 95,
      "Super Low": 95,
      "No Price": 95,
      "Medium": 90,
      "High": 85,
      "Premium": 85
    },
    "coverDaysByMovement": {
      "Super Fast": 2,
      "Fast": 2,
      "Moderate": 3,
      "Slow": 2,
      "Super Slow": 1
    }
  },
  "fixedUnitFloor": {
    "orderQtyPercentile": 90,
    "maxMultiplier": 1.5,
    "maxAdditive": 1
  },
  "brandLeadTimeDays": {
    "_default": 2
  }
}
```

Categories not listed in `categoryStrategies` default to "standard".

All config is editable through the Logic Tweaker (extended with new sections).

---

## 7. Validation Approach

- New engine runs **alongside** the current engine (both produce outputs)
- Dashboard toggle or comparison view: "Standard Output" vs "Strategy Output"
- Use existing OOS Simulation on both outputs to compare OOS rates
- Use 90-day invoice data to calibrate:
  - Which categories should be assigned which strategy
  - Whether default percentile/cover-day values produce sensible Min/Max numbers
  - Compare OOS rates by category between old and new engine

---

## 8. What This Doesn't Cover (v2 Scope)

- **Auto-tuning parameters based on demand shape (CV)** — evolve toward Approach C where within each strategy, coefficient of variation adjusts parameters (e.g., which percentile, how much buffer)
- **Real-time sales feed** — data pipeline change, independent workstream
- **Inventory Health Monitor view** — new primary UI surface, independent workstream
- **Alerts and prioritisation** — depends on Health Monitor
- **Inline override workflow** — simplification of current override process, independent workstream

---

## 9. Default Category Assignments

To be determined after analysing 90-day invoice data. Initial hypothesis:

| Strategy | Likely Categories |
|---|---|
| Standard | Categories dominated by Fast/Super Fast movers with stable demand |
| Percentile Cover | Plywood, and other categories with high order-qty variance |
| Fixed Unit Floor | Wires, and other categories with predictable order sizes but erratic timing |
| Manual | None by default — available as escape hatch |
