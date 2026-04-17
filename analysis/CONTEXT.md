# Category Network Analysis — Context

## Status: HTML tool is a stepping stone — integration into IMS tool planned

The standalone HTML tool (`plywood-network.html`) was built to prototype and validate the analysis methodology. **The next step is to build this as two new tabs in the IMS tool** (Basket Analysis + Category Stocking).

**Key principle for the IMS integration:** Both tabs will use the invoice data and SKU Master already uploaded in the Upload Data tab — no separate uploads. Colleagues open the tool and see the analysis immediately without any file uploads.

**Until the IMS tabs are live:** continue running analysis in this HTML tool.

See `CLAUDE.md` To-Do #5 for the full build plan. This CONTEXT.md documents the methodology decisions that should carry into the IMS integration.

---

Standalone HTML analysis tool (`plywood-network.html`) for designing DS-level network stocking for bulky/erratic categories like Plywood.

---

## What It Does

Upload a raw Zoho invoice CSV (same format as the IMS tool). Select primary and secondary categories. Run analysis to get:

1. **Basket Composition** — what % of Plywood orders are standalone vs mixed with other categories (e.g. Fevicol). Determines whether keeping Plywood at DS is operationally necessary.
2. **SKU Demand Profile** — every Plywood SKU ranked by NZD, with daily median, Min/Max, fallback threshold per SKU.
3. **Capacity Check** — does the proposed Tier 1 stocking list fit within DS physical capacity?
4. **Per-SKU charts** — click any row: order qty histogram + daily consumption timeline with Min/Max lines.

---

## Key Methodology Decisions

### Metrics are at daily level for stocking, order level for routing

- **Stocking (Min/Max):** aggregate all order lines per SKU per date → daily total → take `median` of daily totals across NZD days.
  - Min = ceil(daily median × min cover days)
  - Max = ceil(daily median × max cover days × (1 + buffer%))
  - Rationale: cover days × per-order qty doesn't make sense; cover days × daily consumption does.

- **Routing threshold (fallback):** percentile of individual order quantities (not daily totals).
  - Configurable percentile (default P75). Orders above this qty → route to DC/vendor fallback.
  - Rationale: routing decision is per-order, not per-day.

### Median not ABQ for stocking

ABQ (mean) is inflated by large outlier orders that will be routed to fallback anyway. Median of daily qty represents what DS actually needs to fulfill on a typical day. Chose median.

### Tier naming

| Old | New | Meaning |
|---|---|---|
| Tier 1 | Running SKUs | Stocked at DS — NZD ≥ threshold |
| Tier 2 | Fallback SKUs | DC or vendor-direct — NZD ≥ lower threshold |
| Tier 3 | Super Slow SKUs | On-demand only — NZD below lower threshold |

### Thickness classification

Inferred from item name via regex `/(\d+(?:\.\d+)?)\s*mm/i`:
- ≤ laminate threshold (default 1mm) → **Laminate** — stocked separately, excluded from DS capacity
- ≤ 6mm → **Thin** — stored in bins, capacity 60 units
- > 6mm → **Thick** — stacked vertically, capacity 150 units

---

## DS-Specific Configs (derived from L45D data analysis)

| Config | DS01 | DS02 | Rationale |
|---|---|---|---|
| Running NZD | 10 | 10 | Only top-frequency SKUs fit capacity |
| Fallback NZD | 2 | 2 | Below this → on-demand |
| Min Cover Days | 1.5 | 1.0 | DS01 uses Om Timber (external, less reliable) so slightly higher min trigger; DS02 uses DC (same cluster, same-day) |
| Max Cover Days | 3 | 2 | DS01 needs more cushion given Om Timber reliability |
| Buffer % | 20 | 20 | Safety margin on Max |
| Thin Bin Capacity | 60 | 60 | Physical constraint — bin storage |
| Thick Vertical Capacity | 150 | 150 | Physical constraint — vertical stacking |
| Fallback Threshold Pctl | 75 | 75 | Orders above P75 of order qty → fallback |

DS03-DS05: defaults (NZD 6, 3 cover days) — not yet analysed.

Configs persist in `localStorage` key `hrDsConfigs` — survive page refresh and new CSV uploads.

---

## Fallback Sources

| DS | Fallback | Constraints |
|---|---|---|
| DS01 | Om Timber (vendor-direct) | Closed Sundays. Does NOT carry Archidply brand — those SKUs must always be stocked at DS01. |
| DS02 | DC (Rampura) | Same-day delivery possible (Cluster 2). No brand constraints. |

---

## DS01 Stocking List (L45D, NZD ≥ 10, from April 2026 analysis)

11 SKUs fit within capacity. Thin: 47/60 (78%), Thick: 128/150 (85%).

| SKU | Thickness | NZD | Daily Median | Min | Max | Threshold |
|---|---|---|---|---|---|---|
| HDHMR-ACT-PLN-3mm | 3mm Thin | 17 | 5 | 8 | 19 | >6 |
| HDHMR-ACT-PLN-18mm | 18mm Thick | 13 | 4 | 6 | 14 | >4 |
| PLY-ACT-INT-4MM | 4mm Thin | 13 | 2 | 3 | 8 | >3 |
| HDHMR-ACT-PLN-16mm | 16mm Thick | 13 | 10 | 15 | 36 | >14 |
| PLY-CEN-SAI-MR-19M-32 | 18mm Thick | 13 | 3 | 5 | 12 | >5 |
| PLY-GRP-ECO-MR-18M-32 | 18mm Thick | 12 | 4 | 6 | 14 | >5 |
| PLY-ACT-INT-11MM | 11mm Thick | 12 | 3 | 5 | 11 | >2 |
| HDHMR-ACT-PLN-12mm | 12mm Thick | 11 | 2 | 3 | 7 | >3 |
| PLY-ARC-CLA-MR-18M-32 | 18mm Thick | 11 | 5 | 8 | 18 | >5 |
| PLY-ACT-INT-3.3MM | 3.3mm Thin | 10 | 5 | 8 | 18 | >4 |
| PLY-CEN-SAI-BWP-710-19M-32 | 19mm Thick | 10 | 4 | 6 | 15 | >4 |

Note: PLY-ARC-CLA-MR-18M-32 is Archidply — Om Timber doesn't carry it, so DS01 MUST stock it regardless of threshold.

---

## DS02 Notes (L45D, NZD ≥ 10)

DS02 has ~50% more Plywood demand than DS01. Even NZD ≥ 10 at 3 cover days exceeds thick capacity (193/150). Solution: 2 cover days (DC is same-day fallback). Demand patterns differ significantly from DS01:
- DS02 skews toward Archidply and CenturyPly
- DS01 skews toward Action Tesa / HDHMR

**Different stocking lists per DS — do not use the same list for both.**

---

## CSV Format Expected

Same as raw Zoho invoice export (and IMS tool's input CSV):

| Column | Notes |
|---|---|
| Invoice Date | YYYY-MM-DD |
| Invoice Status | Filter: Closed, Overdue only |
| Shopify Order | Used for basket grouping (preferred over Invoice Number) |
| Invoice Number | Fallback for basket grouping |
| SKU | Product SKU |
| Category Name | Used for primary/secondary category selection |
| Quantity | Order qty |
| Line Item Location Name | e.g. "DS01 Warehouse" — first word used as DS identifier |

**Do not use the IMS tool's Data export** — it drops Category Name and Shopify Order during storage (handleInvoice only keeps date/sku/ds/qty). Use the original Zoho CSV.

---

## TODO

- [ ] Run DS02 full analysis and finalise stocking list
- [ ] Run DS03, DS04, DS05 when Plywood is introduced there
- [ ] Validate Om Timber Sunday constraint in ops process (no orders dispatched from DS01 on Sundays?)
- [ ] Validate Archidply availability at DS01 — confirm it's always stocked regardless of NZD
- [ ] Consider extending analysis to other bulky categories (Tiling, Sanitary & Bath)
- [ ] Phase 2: model the DC stocking for Plywood separately (DC holds what DS01+DS02 need during supplier lead time)
