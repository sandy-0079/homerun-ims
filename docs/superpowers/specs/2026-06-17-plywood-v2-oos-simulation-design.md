# OOS Simulation — Plywood Network v2 (design, 2026-06-17)

## Goal

A **backtest**: upload a real invoice CSV for a period **outside** the original 90-day fit
window, and measure how the **published v2 plan** would have performed against it — order-level
**OOS at each DS** (regular orders) and **bulk fulfilment from the DC**. Revives the OOS Simulation
idea (dropped 2026-04-21 as a synthetic sim) in a legitimate form: real out-of-window demand.

The simulation engine already exists — `replay.js` does deterministic day-by-day OOS sim and the
75/15 evaluation already runs it on the last-15-day holdout. This feature points that same machinery
at an uploaded window and surfaces the per-location detail.

## Decisions (locked in brainstorming 2026-06-17)

1. **Placement:** a 4th view, "OOS Sim", in the Plywood Network v2 tab
   (`Locations | Assortment / Keep Score | Settings | OOS Sim`). Plywood-v2-scoped — the
   "any line ≥ `bulkOrderThreshold` → whole order to DC" routing is the v2 framework.
2. **Plan source:** the **published** plan only (`savedCfg`), fit on the original `invoiceData`.
   Not the draft.
3. **Upload is ephemeral:** held in component state only. **Never** written to Supabase, never
   mutates the live `invoiceData`, `cfgDraft`, or `savedCfg`. Pure read-only what-if. A visible
   "this file is not saved" note.
4. **Unplanned SKUs** (a plywood SKU in the upload with no published plan, e.g. a new product):
   a **separate "unplannable — new SKU" bucket** (count + the SKUs), NOT folded into the OOS %.
5. **Results:** a summary strip + **6 tiles** — 5 DS (regular-order OOS) + 1 DC (bulk fulfilment).
   Each tile lists the **problem orders only**; a **Download CSV** gives the full order-by-order detail.

## Data flow (all reuse)

```
publishedPlan = computePlywoodNetworkV2Results(invoiceData /*original 90d*/, skuMaster,
                  { plywoodNetworkV2Config: savedCfg })
                → { [sku]: { storeResults: {[ds]:{min,max}}, dcResult: {min,max} } }   (memoized on savedCfg)

on upload:
  uploadedInvoice = parseCsv(file)                    // reuse the Upload Data tab parser
  universe        = buildUniverse(uploadedInvoice, cfg)  // restricted to v2 scope (4 brands, exclude Merino)
  demand          = prepareDemand(uploadedInvoice, universe, cfg)   // windowed to the uploaded date range
  { plan, dcPlan, unplanned } = alignToPlan(demand, publishedPlan)  // SKUs w/o plan → unplanned bucket
  sim             = replay(plan, dcPlan, demand, { ...cfg, lookbackDays: window.days })
  → aggregate sim.serviceLevels (regular.perDS, bulk) + sim.oosEvents (grouped by DS / bulk)
```

## `simulateOOS` glue (pure, testable)

```
simulateOOS(uploadedInvoice, publishedPlan, skuMaster, cfg) → {
  window:      { from, to, days },
  orderCounts: { regular, bulk, total },
  network:     { dsOosPct, bulkServedPct },
  perDS:       { [ds]: { oosPct, oos, total, orders: [{ ref, date, shorts: [{ sku, short }] }] } },
  dc:          { servedPct, served, total, orders: [{ ref, date, shorts: [{ sku, short }] }] },
  unplanned:   { orders, skus: [...] },
}
```
- `oosEvents` shape (from `replay`): `{ sku, ds, orderId, date, short, type: 'regular'|'bulk' }`.
- DS tile OOS % = `1 − serviceLevels.regular.perDS[ds].service`; DC served % = `serviceLevels.bulk` rate.

## Components

- **`OOSSimView`** (new, in `PlywoodNetworkV2Tab.jsx` or a sibling file) — upload dropzone + ephemeral
  state + results render (summary strip, 6 tiles, CSV download). Reuses the Upload Data CSV parser.
- **`simulateOOS`** — glue wrapping `prepareDemand` + `replay` + aggregation. Lives with the engine
  (e.g. `evaluate.js` or a new `oosSim.js`) so it's unit-testable without the UI.

## UI layout

```
Summary strip:  Window 16–30 Jun · 412 orders (reg 380 / bulk 32) · Network OOS 6.1% ·
                Bulk served from DC 84% · Unplannable (new SKU): 4 orders
5 DS tiles:     DSnn — OOS X% (n/total) + list of OOS regular orders (ref · date · short SKU(s) + sheets)
1 DC tile:      DC (bulk) — served Y% (n/total) + list of bulk orders NOT fully served from DC
Download CSV:   full order-by-order detail (all problem orders across tiles)
```
Tiles list problem orders only; the header carries the rate `n / total`.

## Edge cases

- **No published config** → disable the sim, prompt "publish a plan first".
- **Upload overlaps the original 90d** → allowed, but a note that it's meant for out-of-window dates.
- **Empty / malformed CSV** → error message, no crash.
- **No plywood orders in the file** → "no in-scope orders found".

## Safety

Ephemeral and read-only: no Supabase writes, no mutation of `invoiceData`/`cfgDraft`/`savedCfg`.
Simulates against the published plan; the uploaded file lives only in component state until cleared.

## Testing

vitest: `simulateOOS` on a small synthetic `uploadedInvoice` + a known `publishedPlan` → assert the
per-DS OOS counts, the bulk-served count, and the unplanned bucket.

## Out of scope (v1)

Draft-plan sim, multi-file comparison, persistence of uploads, non-plywood categories.
