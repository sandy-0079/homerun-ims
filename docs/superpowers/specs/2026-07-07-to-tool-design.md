# TO Generator Tool — Design Notes (alignment doc, WIP)

**Status:** Design agreed in conversation 2026-07-07. NOT yet spec-finalized, NOT built.
Next session: finalize as a spec → writing-plans → TDD build. This doc is the handoff.

## Purpose

A simple tool for the **DC team** to generate Transfer Orders (DC→DS replenishment),
replacing today's 7 manual per-DS CSVs + spreadsheet formulas. Current process: DC team
updates current stock per location just before raising TOs, sheet formulas compute Req and
proportional partial fulfillment. Not scalable (7 CSVs to maintain), poor edge-case handling.

Trading/replenishment context: TOs raised ~midnight DC→DS, arrive ~noon. Always DC→DS
(no cluster routing for this tool).

## Access / architecture

- **Separate entry point** — own URL, own DC-team login. NOT a route inside the main IMS SPA
  (a bare-URL visit there would expose the public tabs). Implement as a second Vite entry
  point / separate deployable so the DC team's bundle literally does not contain the other tabs.
- **Featherweight**: the DC tool reads a stored `toTargets` blob + live stock. It does NOT run
  the engine and does NOT load invoiceData.

## Min/Max source — stored `toTargets` (KEY simplification)

- Targets don't change daily — only when the admin refreshes the model. So **do not run the
  engine in the tool.**
- Admin's **"Apply & Re-run Model"** serializes a compact blob to Supabase (its own row):
  ```
  toTargets = { [sku]: { name, category, invAt, status, perDS: { DS01:{min,max}, … , DS06:{min,max} } } }
  ```
  Scope: **DC-inventorised, Active SKUs only** (smallest; exactly what the tool needs).
  Blob already reflects all engine post-processing (floors, Dead Stock, DS Seed, Inventorised-At
  normalization) because it's the frozen final `res` slice.
- Show **"Targets last refreshed: <date>"** in the tool.
- Caveat: an engine *code* deploy won't reach the tool until the admin next clicks Apply
  (today it'd reach on reload). This matches intent ("targets change only when admin refreshes"),
  but the ritual becomes: ship engine fix → click Apply.

## Stock data & freshness

- **CS DS** (current stock at DS) = **accounting** basis SoH (Bills & Invoices) = `stockDataAccounting`.
- **CS DC** (current stock at DC) = **physical** basis SoH (Shipments & Receives) = `stockData`.
- Both bases are already synced hourly (sync-stock fetches show_actual_stock true=physical /
  false=accounting) and toggled in the Stock Health tab.
- **Freshness gate:** if last stock pull **> 15 min** old → trigger a new pull; else reuse existing.
- **Cooldown = 15 min everywhere** (kept; NOT lowered to 10). Freshness gate aligns to it.
- **`syncInProgress` lock** in `team_data`: both the hourly cron and a DC-triggered pull set/check
  it so they never call Zoho concurrently (the one real rate-limit hazard: DC pull colliding with
  the :35–:44 UTC cron → >4 concurrent → 429).
- **Graceful degradation (ops-critical):** if a pull 429s/times out, fall back to the last good
  snapshot with a visible banner + timestamp ("Using stock from 09:12 — refresh failed, retry?").
  The tool must NEVER hard-fail; worst case = slightly stale stock, clearly flagged.
- Reuse the existing staggered **Sync Now** sequence (DC+DS01 ∥ orders → DS02+DS03 → DS04+DS05
  → DS06) and the existing 429 retry/backoff in `zohoFetch`.

## Allocation logic

Filters: **Inventorised At = DC, Status = Active** (universe = toTargets keys).

Per SKU × DS:
- **Trigger (strict parity):** if `CS DS ≤ Min` → restock toward Max.
- **Req = max(0, Max − CS DS − In Transit)** — net of in-transit so we don't double-order what's
  already arriving. A SKU can trigger yet show Req 0 (enough in transit) → Fill "—".
- **Total network need per SKU** = Σ DS Req.
- **DC allocates 100%** of DC physical SoH (no buffer held back — DC Min is a supplier-PO trigger,
  separate concern).
- If DC available ≥ total need → **Full**. Else **proportional partial fulfillment** via
  **largest-remainder rounding** — reuse the algorithm already in
  `src/engine/strategies/plywoodV2/replay.js` (proportional TO rationing).
- Always DC → DS.

## UI table (per DS, grouped)

Columns (order = the actual logic left-to-right):

`Item Name · SKU · Category · Min Qty · Max Qty · CS DS · In Transit · Req Qty · CS DC · TO Qty · Short Qty · Fill`

- **Fill** (renamed from "Replenishment Status" — short; avoid "TO Status" which collides with
  Zoho's draft/in_transit lifecycle on Stock Health). Values:
  - **Full** — TO = Req
  - **Partial** — 0 < TO < Req
  - **No DC Stock** — Req > 0, DC current = 0
  - **Unfilled** — Req > 0, DC had stock but this DS allocated 0 (rounding/lost the split)
  - **—** — not triggered (CS DS > Min) or Req netted to 0 by in-transit
- **Show ALL DC-inv active SKUs** in the UI (full transparency; this is where the procurement
  signal lives). Default sort/filter **actionable-first** (Full/Partial/Unfilled/No DC Stock at
  top; "—" collapsed/bottom) with a "show all" toggle so the night's work isn't buried.
- **In Transit column is mandatory** — it explains why a Req was reduced (stops ops distrusting
  the tool vs. the sheet).

## Review UX

- Generate → step through each DS's TO **sequentially**, reviewable before download.
- Download **one location at a time** OR **all at once**.

## CSV export

- Contains **only TO Qty > 0** rows (the actionable slice).
- **All columns** included (ops picks what they need for the Zoho paste).
- Header row + a metadata line (DS name, stock-pull timestamp, generated-at) for audit.
- Filename: **`DS01_YYYY-MM-DD_HHMM`** — IST, 24h, no colons (colons break filenames; ISO date
  sorts chronologically).
- **OPEN:** "download all" format — zip of per-DS files vs one combined CSV with a DS column. (undecided)

## Summary (per DS + network)

```
SKUs  — Needed 39 · Sending 35 · Short 4
Units — Needed 520 · Sending 486 (94%) · Short 34
```
- **Needed** = Req > 0 (post in-transit netting)
- **Sending** = TO Qty > 0 (includes partials)
- **Short** = Req > 0 not fully covered
- Headline **%** = units sent ÷ units needed (qty fill rate — truest service number; SKU-count %
  overstates because a 1-of-40 partial counts as "sending")
- **Unfilled / No-DC-Stock count = the procurement signal** (DC needs a supplier PO).

## Summary report / visualization (build LATER, use dataviz skill)

Category × SKU × Location cube. Views:
1. **Network KPIs** — qty fill %, SKUs short, units short, DC-empty SKU count.
2. **Category × Location heatmap** — cell = fill % (or short units). The money view: shows where
   shortfalls concentrate (category+region) — impossible in the 7 sheets.
3. **Per-location bars** — needed vs sent.
4. **Top-N short SKUs** — the future DC-PO worklist.
- If each run's summary is persisted (cheap), a **fill-rate trend over time** becomes possible.

## Phasing

- **Phase 1 (this doc):** read-only calculator + CSV export. No Zoho writes. Replaces the 7 sheets.
- **Phase 2 (later):** write-back — create TOs directly via Zoho `POST /inventory/v1/transferorders`
  (refresh token already has `ZohoInventory.fullaccess.all` = write). Gated + dry-run + audit log.
  Also the DC-PO worklist from the Unfilled/No-DC-Stock set. Optionally move compute server-side
  (`generate-tos` edge function) so the DC bundle is truly dumb (button + poll + download).

## Build roadmap (proposed, for next session)

1. **Admin:** add `toTargets` write to "Apply & Re-run Model" (serialize DC-inv active slice of
   engine `res` to a new Supabase row).
2. **Sync:** add `syncInProgress` lock to sync-stock/sync-orders + confirm 15-min cooldown alignment.
3. **Entry point:** second Vite entry / separate deploy + DC-team auth (distinct from admin password).
4. **Tool:** read toTargets → freshness-gated stock pull (with graceful fallback) → allocation
   solver (port plywoodV2 largest-remainder rationing) → review UI (columns + summary + sequential
   per-DS) → filtered/named CSV export.
5. **Summary report / viz** (dataviz skill).
6. **Phase 2:** Zoho TO write-back + DC-PO worklist.

Suggested next-session flow: finalize this into a spec (brainstorming is essentially done) →
writing-plans → TDD build, starting with the allocation solver (pure, testable) and the
`toTargets` write.

## Key reuse (don't rebuild)

- **Proportional allocation** → `src/engine/strategies/plywoodV2/replay.js` (largest-remainder rationing).
- **Sync** → `supabase/functions/sync-stock` + `sync-orders`; frontend "Sync Now" sequence in
  `src/tabs/StockHealthTab.jsx` (`handleSyncNow`).
- **Stock data** → `stockData` (physical) / `stockDataAccounting` (accounting) in `team_data/global`.
- **Two-basis** (accounting DS / physical DC) already synced + toggled in Stock Health.
- **Engine results** → `runEngine` output `res[sku].stores[ds].{min,max}` (App.jsx load effect).

## Decisions locked (2026-07-07)

netting in-transit ✓ · DC allocates 100% ✓ · strict parity trigger ✓ · CSV export only for now ✓ ·
always DC→DS ✓ · separate entry point ✓ · stored toTargets (no engine in tool) ✓ · toTargets scope
= DC-inv active ✓ · 15-min cooldown everywhere ✓ · syncInProgress lock ✓ · show In Transit ✓ ·
UI shows all DC-inv active SKUs ✓ · CSV only TO Qty>0, all columns ✓ · CSV name DS01_Date_Time (IST) ✓ ·
Fill (not "Replenishment Status") ✓ · summary = SKU + Qty lines, qty fill % headline ✓ ·
report = heatmap + KPIs (later) ✓

## Open questions (parked for next session)

1. "Download all" format: zip of per-DS files vs one combined CSV with a DS column.
2. Phase-2 compute location: client-side (reads toTargets) vs server-side `generate-tos` edge function.
3. DC-PO worklist surfacing (summary count now, mini-list when PO phase is built).
