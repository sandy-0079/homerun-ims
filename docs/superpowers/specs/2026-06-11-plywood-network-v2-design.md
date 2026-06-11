# Plywood Network Design v2 — Capacity-First Allocation

**Date:** 2026-06-11
**Status:** Draft for review
**Replaces:** Network Design v1 (`src/engine/strategies/plywoodNetwork.js` brand-node stocking)

---

## 1. Problem

Under Network Design v1, many SKU×DS combos carry Min=Max=0 (rare zone, non-stocking
nodes). Orders for those combos are fulfilled from another location — heavy ops cost,
slow service against a same-day (60-min) delivery promise. L90D data (11 Mar – 08 Jun
2026): at DS04/DS05, ~60% of the catalog is locally dead (NZD ≤ 1), yet 80%+ of those
SKUs sell actively elsewhere in the network. Meanwhile naive 99%-service stock does not
fit: ΣMax would run 117–194% of shelf capacity at every node.

**Goal:** minimise stockouts on regular orders by stocking (nearly) every SKU at every
DS, allocating limited shelf capacity where it serves the most demand, with a
drain-based DC and a measurable, order-level service level.

## 2. Key decisions (agreed in brainstorm)

| # | Decision |
|---|---|
| 1 | All brands stocked at all locations — brand-level node assignments are removed. |
| 2 | Blanket bulk definition: any **order** containing a ply line with qty ≥ 10 is a bulk order (all its lines, including small ones). Order-level, not line-level. |
| 3 | Bulk demand is excluded from DS provisioning; DSes serve regular orders only, targeting ~99% order-level service. |
| 4 | Bulk orders are served from DC (assume 100% DC-served for sizing & simulation v1; `bulkDcServedShare` configurable, default 1.0). Supplier-direct fulfilment is upside, not modelled. |
| 5 | SKUs with no local sales but network demand are stocked everywhere via floors sized from network behaviour. |
| 6 | Per-DS thick/thin capacity is a hard budget, respected by construction (allocation-first, not compute-then-trim). |
| 7 | DC replenishment stock is drain-based (simulated TO stream), 98% service. DC bulk stock is additive, 90% service. |
| 8 | Service level is measured by replaying real demand: order-level (one short line ⇒ OOS order), reported separately for Regular (DS) and Bulk (DC). |
| 9 | Stock/stop decision (Keep Score) is computed AFTER the plan, using planned holding value; cut SKUs trigger a re-run (two-pass). |

## 3. Universe

- Category `Plywood, MDF & HDHMR`, brands Action Tesa / CenturyPly / ArchidPly /
  GreenPly (case-insensitive), `status = Active`. Merino (and any brand in an
  `excludedBrands` config list) falls through to PCT, unchanged.
- 122 SKUs as of 2026-06-11: 79 thick (>9 mm), 43 thin (≤9 mm). Thickness inferred
  from item name (`inferThickness`), boundary `thickBoundaryMm = 9`.
- Discontinuation (Keep Score) may shrink this after pass 1.

## 4. Demand preparation

1. Window: lookback over invoice data (`lookbackDays`, default 90).
2. Group invoice lines by order id (`shopifyOrder`). Orders with any ply line
   qty ≥ `bulkOrderThreshold` (default 10) → **bulk orders**; all their lines are
   excluded from DS regular demand and routed to the bulk stream.
3. **Regular stream** per SKU×DS: daily demand series (sum of qty per date) and
   order-line list. **Bulk stream** per SKU: network daily bulk demand series.
4. Per SKU network stats from regular orders: median order qty, NZD per DS, network NZD.

L90D facts: 2,239 ply orders, 365 bulk (16.3%, ~4.1/day), bulk carries 60.7% of sheet
volume; 52% of bulk orders are mixed (also contain <10 lines, ~1,577 sheets/90d).

## 5. DS Min/Max — greedy capacity allocation

Budget per (DS × thickness class) = configured capacity (sheets), counted against ΣMax.
Current capacities: DS01–03 360 thick / 150 thin, DS04 225/150, DS05 200/150.

**Priority 1 — Floors (breadth, never trimmed):** every universe SKU at every DS gets
`Min_floor = max(1, round(network median regular order qty))` (observed: 1–4, mode 2),
`Max_floor = Min_floor + 1`. SKUs with zero regular orders network-wide: Min 1 / Max 2.

**Priority 2 — Min depth (service):** remaining budget is allocated one sheet at a
time. Each sheet goes to the SKU (within the class) with the highest marginal coverage:

```
marginal(sku, k→k+1) = (# days in window where regular demand ≥ k+1) / window days
```

i.e. the empirical probability that the (k+1)-th sheet is needed on a given day.
A SKU stops receiving depth at its P99 demand day (further sheets buy <1% coverage).
Ties: higher total regular qty first, then SKU id (deterministic).

**Priority 3 — Max buffer (ops efficiency):** with leftover budget, raise Max toward
`Min + max(1, round(network median regular order))` so one overnight TO covers a typical
sale day. Allocated greedily by TO-frequency reduction (most frequently-selling SKUs
first). Max ≥ Min + 1 always (guaranteed by floors).

Properties: capacity is never breached (by construction); if capacity is scarce the
floor breadth survives and depth degrades gracefully; every sheet's placement has a
one-line justification ("serves demand on N of 90 days").

## 6. DC Min/Max — drain-based, two additive components

**Replenishment component (98%):**
1. Replay the regular stream day-by-day through the allocated DS plans:
   closing stock ≤ Min → TO for (Max − stock) raised overnight, arrives next noon.
   Output: daily TO drain series per SKU (this is DC's true demand; floor SKUs included
   automatically).
2. `DC_repl_Min[sku] = P98( rolling (L+1)-day sums of TO drain )`, where
   L = `brandLeadTimeDays` (default 3).

**Bulk component (90%):**
`DC_bulk[sku] = P90( rolling (L+1)-day sums of bulkDcServedShare × daily bulk demand )`.
With share = 1.0 this is the prepared-for-worst posture; SKUs with rare bulk activity
naturally size to ~0.

**Totals:** `DC_Min = DC_repl_Min + DC_bulk`;
`DC_Max = DC_Min + ceil(mean daily total drain × dcCoverDays)` (default 2).

**DC capacity** (thick/thin, live: 1000/500): if ΣMax breaches, trim in order:
(1) dcCoverDays cycle stock, (2) bulk component percentile (90→85→80), never the 98%
replenishment component. Any trim is reported, not silent.

## 7. Service-level simulator

One pure replay engine, two consumers (DC sizing step 6.1 reuses it):

```
replay(plan, demandWindow, config) → { toDrainSeries, oosEvents, serviceLevels, opsLoad }
```

- **Inputs:** a Min/Max plan; a demand window — date-range over existing invoice data
  or a freshly uploaded CSV (same format); config (bulk threshold, share, lead times).
- **Mechanics:** day-by-day. Regular orders draw from DS shelf stock in order sequence;
  bulk orders draw from DC stock. Overnight: DS TOs (≤Min → to Max) arrive next noon,
  drawing DC stock; DC POs (≤DC Min → to DC Max) arrive after brand lead time.
  Initial stock = Max everywhere. Deterministic — no randomness.
- **Scoring (order level, as agreed):** an order is OOS if ANY of its lines cannot be
  served in full from its designated source.
  `Regular service = 1 − OOS regular orders / total regular orders` (overall + per DS);
  `Bulk service = 1 − OOS bulk orders / total bulk orders` (DC).
- **Outputs:** the two service percentages, OOS drill-down (order, date, DS, SKU,
  shortfall) in the style of the existing Simulation Tab, TO/PO counts per day
  (ops load), and per-SKU average shelf position (feeds Keep Score).

## 8. Keep Score (stock / stop selling) — pass 2

Computed per SKU after the plan exists, from planned holding rather than an assumed
floor presence:

```
HoldingValue = Σ over locations+DC of (Min + Max)/2 × PurchasePrice
RentRatio    = (WindowSales × grossMarginPct) ÷ (HoldingValue × carryRateQuarterly × opsBuffer)
ServiceRatio = NetworkNZD ÷ serviceNZDThreshold        # default threshold 5
KeepScore    = max(RentRatio if network regular NZD ≥ 2 else 0, ServiceRatio)
```

Keep if ≥ 1; cut if < 1; 1.0–1.3 = watchlist. Defaults: grossMarginPct 6%,
carryRateQuarterly 5% (20%/yr), opsBuffer 1.5. The RentRatio NZD ≥ 2 gate prevents a
single fluke transaction from buying a permanent slot. Output: scored CSV
(SKU, ratios, score, Keep/Watch/Cut flag) for the category team. After cuts are
confirmed, the allocator re-runs on the surviving universe (freed budget becomes depth).

## 9. Configuration (new `params/plywoodNetworkV2Config`)

| Param | Default | Meaning |
|---|---|---|
| lookbackDays | 90 | demand window |
| bulkOrderThreshold | 10 | order-level bulk cutoff (sheets) |
| bulkDcServedShare | 1.0 | share of bulk demand provisioned at DC |
| minDepthStopPercentile | 99 | DS depth allocation ceiling |
| dcReplPercentile | 98 | DC replenishment service |
| dcBulkPercentile | 90 | DC bulk service |
| dcCoverDays | 2 | DC cycle stock |
| dsCapacities | per DS thick/thin | hard shelf budgets (editable matrix) |
| dcCapacity | thick/thin | DC budget |
| thickBoundaryMm | 9 | thick/thin split |
| excludedBrands | [Merino] | fall through to PCT |
| keepScore: grossMarginPct / carryRateQuarterly / opsBuffer / serviceNZDThreshold | 6% / 5% / 1.5 / 5 | pass-2 economics |

Brand-node assignment matrix, zones (rare/sparse/frequent), per-SKU ABQ bulk
thresholds, winsorising, and dcMultMin/Max are all **removed** in v2.

## 10. Engine & UI integration

- New module `src/engine/strategies/plywoodNetworkV2.js` (pure functions). v1 module
  stays untouched for rollback. Activation: Category Strategy Map option
  `network_design_v2` — **dormant until prod config selects it**.
- Post-processing unchanged: Dead Stock cap (Min=Max=0 everywhere) still overrides;
  SKU Floor Override / New DS Floor follow existing post-blend order.
- Plywood tab v2: allocation view (per-DS table: floor/depth/Max per SKU, capacity
  utilisation bars), DC view (component breakdown per SKU), simulator panel (window
  picker / CSV upload → service levels + OOS drill-down), Keep Score report + CSV
  export, config editor (admin-only writes).

## 11. Build & safety plan

1. Branch `feature/plywood-network-v2`; nothing merges to main until end-to-end
   sign-off. Never push/PR without explicit approval.
2. Engine first as pure functions with unit tests (known inputs → expected
   allocations; capacity-respect property tests; deterministic replay).
3. Offline validation harness: script runs allocator + simulator against the real
   L90D snapshot, emits comparison CSV (v1 vs v2 Min/Max per SKU×DS, capacity
   utilisation, simulated service levels) — reviewed before any UI work.
4. Local app testing must not write to prod Supabase: the strategy stays dormant in
   prod config; "Apply & Re-run" is not clicked against prod params during testing.
5. Cutover only after: simulated Regular ≥ 99% (or best-achievable documented), Bulk
   ≥ 90%, capacity respected at every node, Keep Score CSV reviewed by category team.

## 12. Assumptions

1. Gross margin 6% uniform across ply SKUs.
2. Carrying cost 20%/yr (capital + space + damage + obsolescence) → 5%/quarter.
3. L90D window is representative (no seasonality correction in v1).
4. Supplier-direct bulk fulfilment is not modelled in v1 (`bulkDcServedShare = 1.0`
   means DC carries everything); any real supplier-direct offload only improves
   realized service vs simulated.
5. Same-day promise means DS shelf (regular) and DC shelf (bulk) are the only service
   mechanisms — no procurement-against-order.
6. Replenishment timing per current ops: TO raised ~midnight, arrives ~noon next day.
7. Thickness parsed from item name is accurate enough for capacity classing.

## 13. Open items (not blocking build)

- Bulk fulfilment SOP (DC vs supplier-direct routing rule) — owns the future value of
  `bulkDcServedShare` < 1.0.
- Discontinuation execution: delist-now vs sell-down-first split, liquidation of ~₹4.2L
  slow stock.
- DS03 bulk skew (71% of volume) — watch whether its regular-only provisioning leaves
  shelf under-used or DC over-drained.
- DC thick capacity headroom under α=1.0 — verify with real numbers in validation
  harness.
