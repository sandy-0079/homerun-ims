# CLAUDE.md — HomeRun IMS

> 🚧 **IN-FLIGHT WORK — read [`docs/HANDOFF-2026-07-29.md`](docs/HANDOFF-2026-07-29.md) first** if you
> are touching the nightly model refresh (Stages 4–7), the invoice/catalogue syncs, or pincode
> attribution. It records what is deployed-but-not-switched-on, tonight's expected events, verification
> commands, rollback steps, and the open decisions. **Delete that file and this block once Stages 5–7
> land** — this file is for durable knowledge, that one is for transient state.

HomeRun operates 5 dark stores (DS01–DS05) + one DC. This tool computes Min/Max inventory levels for every SKU at every location so ops knows how much stock to hold.

---

## Stack & Credentials

| Layer | Detail |
|---|---|
| Frontend | React + Vite + Recharts, deployed on Vercel |
| Database | Supabase Pro + Micro compute (tables: `params`, `overrides`, `team_data`) |
| Engine | `src/engine/` — modular strategy dispatcher + Web Worker |
| Supabase URL | https://rgyupnrogkbugsadwlye.supabase.co |
| Supabase Anon Key | eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc |
| Admin Password | IMSAdmin123 |

> ⚠ **There is no staging.** `.env` `VITE_SUPABASE_URL` points at the production project, so
> `npm run dev` on localhost **reads and writes prod**. Safe locally: browsing, uploading the pincode
> map, changing any Logic Tweaker value (all local React state). Writes prod: **any Upload Data CSV**
> (replaces entirely — an accidental short invoice file truncates everyone's history), **Apply & Re-run
> Model** (`params/global`, `paramsBackup`, `pincodeMap`, `toTargets`), Plywood/Overrides Save, Sync Now.
> The tab-switch "unsaved changes" modal's first button is `▶ Apply & Continue` — that writes prod.

---

## Data Model & Key Decisions

- Invoice CSV (Zoho export) replaces entirely on upload — no merge. Engine uses whatever period admin sets.
- **⚠ Invoice exports MUST resolve line items to the item's CURRENT SKU code.** Zoho re-coded the
  catalogue ~2026-07-01 (`WHI-BIR-CEM-50K` → `UVJQ9`). An export that preserves the code *as at invoice
  time* splits ~1,090 products across two identities; the pre-July half lands on codes absent from
  `skuMaster` (measured: 39.6% of window rows unknown, network Max ₹7.81Cr → ₹6.73Cr). Splitting also
  halves each code's active-days, dropping it a movement tier, so the loss compounds.
  **Symptom signature: window volume UP but inventory value DOWN.** Sanity check after every upload:
  share of window rows whose SKU is missing from `skuMaster` should be <1% (healthy runs: 0.08–0.1%).
- Purchase Prices are **not display-only** — price drives `getPriceTag`, which selects the PCT
  percentile, the Fixed Unit Floor order-days gate, and the DOC caps. A price refresh moves Min/Max on
  SKUs whose demand never changed. When reporting an Inv-Value delta, separate the *target* effect from
  the *revaluation* effect (2026-07-27: +₹13.4L was +₹14.1L revaluation, −₹0.7L targets, +0.5% units).
- All uploads auto-save to Supabase `team_data` immediately.
- Model refresh: upload → Apply & Re-run Model → results pushed to Supabase → all users see new Min/Max.
- Stock Health: synced hourly via two separate Edge Functions:
  - `sync-stock`: stock only (inventorysummary). Parameterised by branch pair — called by 3 staggered cron jobs. Writes `stockData` + `stockDataAccounting` via branch-level deep merge (not full replace — other functions' branch data must be preserved). Uses `stockUploadedAtPerDS` for cooldown.
  - `sync-orders`: PO + TO only. Single cron at :35 UTC. Writes `poData`, `toData`, `_poCache`, `_toCache`, `_transferredTodayCache`, `ordersUploadedAt` (its own cooldown key).
  - Both functions do a **fresh read immediately before writing** to prevent race condition from parallel runs.
  - Sync functions only read/write `team_data/global`. They never touch `team_data/invoice_data`.
- **team_data row separation:** `invoiceData` lives in `team_data/invoice_data` (written once on CSV upload). All other app data + sync data lives in `team_data/global`. This keeps the global payload ~1-2MB vs ~7MB, preventing Supabase Disk IO budget exhaustion from hourly syncs.
- **Row inventory (2026-07-29).** `team_data`: `global`, `invoice_data`,
  `invoice_sync_buffer` (in-flight chunks for the 1–2 dates being pulled, keyed
  `date|round|offset` so a re-run of a chunk is idempotent; **nothing else reads it**),
  `invoice_data_shadow` (Stage 4 target — **nothing reads it**),
  `invoice_data_backup_20260728` (pre-Stage-5 safety net; the API cannot re-serve anything before
  2026-07-01, so this is the only copy of Apr–Jun history). `params`: `global`, `paramsBackup`,
  `plywoodNetworkConfig`, `plywoodNetworkV2Config`, `networkConfigs`, `pincodeMap` (attribution),
  `toTargets`, `toAudit`, `toSnapshots`, `zohoItemIds`, `binLocations`, `syncLock`,
  `invoiceSyncStatus`, `invoiceSyncCursor`, `catalogueSyncStatus`.
- **CSV upload → model re-run is safe:** `saveTeamData` only writes `invoiceData` to the `invoice_data` row when it changes; global row always uses read-merge-write (`...existing` spread) so PO/TO caches and stock data are never wiped by an upload.
- **Edge Function deploy:** plain `supabase functions deploy sync-stock` / `sync-orders` is fine.
  (An older note here required `--no-verify-jwt` — obsolete since the cron jobs started sending the
  anon Bearer header in their `pg_net` calls; verified 2026-07-08/09: two plain deploys, every cron
  cycle executed. All callers — crons, IMS, TO tool — send Authorization headers.)

---

## Category Strategy Engine

**Why:** 78.7% of SKU×DS combos are Slow/Super Slow. Averages produce near-zero Min for items selling once every 10+ days.

| Strategy | Categories | Key Logic |
|---|---|---|
| **Standard** | Cement, General Hardware, Painting, Fevicol, Water Proofing | Daily avg × base min days, long/recent blend |
| **Percentile Cover (PCT)** | Furniture & Arch HW, Tiling, CPVC, Plywood/MDF, Switches, Conduits, Lighting, Sanitary & Bath | Pxx of non-zero daily qty × cover days |
| **Fixed Unit Floor** | Wires/MCB, Overhead Tanks | P90 of individual order quantities (spike-capped); Premium/High single-order-day → Standard fallback — see guardrails below |
| **Network Design** | Plywood/MDF (opt-in) | Brand-level stocking — see below |

PCT key decisions: percentile by price (Premium=75, High=80, Medium=85, Low/Super Low/No Price=95); cover days by movement (Super Fast/Fast=2, others=1); DOC cap guards (pctDocCap=30D Premium/High, pctDocCapLow=60D others).

**Fixed Unit Floor guardrails (2026-07-14, PR #12) — mirror PCT's spirit so a single contractor bulk-buy can't dictate DS stocking of premium items:**
- **Order-days gate** (`fixedUnitFloor.minNZD`, default 2): Premium/High SKUs need ≥ minNZD distinct order-days, else fall back to **Standard** (floored at ≥1 for demand-bearing SKUs; the null-orders fallback stays 0). Cheap tags (Medium/Low/Super Low/No Price) keep threshold 1 — stay aggressive. `minNZD=1` = gate off. Mirrors PCT's `pctMinNZD` gate; gate lives in `runEngine.js` (needs `s90.nonZeroDays` + `prTag`), fallback tagged `strategyTag="standard"` + `strategyDetails.fufFallback`.
- **Spike cap / winsorise** (`fixedUnitFloor.spikeCapMult`, default 5): before the P90, clip any order qty > `median × spikeCapMult` — kills a contractor spike buried among ≥3 normal orders (needs ≥3 orders; median unstable below that). `spikeCapMult=0` = off. Lives inside `fixedUnitFloorStrategy` (`strategies/fixedUnitFloor.js`); audit in `strategyDetails.winsor`.
- **No DC impact** — non-manual-floored Fixed Unit Floor SKUs already use the rate-based DC (`sumDailyAvg × (leadTime+1)`), strategy-independent; gating only changes DS Min/Max.
- **Known accepted gap:** the 2-order spike (e.g. `[1,20]` on 2 days) slips through both — too many orders for the gate, median too high for the winsor. Consciously accepted (raising minNZD would over-gate genuine repeat demand). Both knobs in Logic Tweaker → Fixed Unit Floor Params. Tests: `src/engine/__tests__/fixedUnitFloor.test.js` (10).

### DC Calculation (non-Network-Design)
- **Standard:** `DC Min = ceil(sumDailyAvg × (leadTime+1))` · `DC Max = DC Min + ceil(sumDailyAvg × 2)`
- **Floored SKUs:** `Σ DS Mins × 0.2` / `Σ DS Maxes × 0.3`
- **Dead Stock:** Min=Max=0 at all DS and DC locations (overrides all floors)

Post-blend order (strict): New DS Floor → SKU Floor Override → Dead Stock cap → Rounding → **DS Seed** → **Inventorised-At normalization**

**New DS Floor blend is per-field max (changed 2026-07-06):** when the floor beats the strategy Min, Min = floor but Max keeps the strategy's value when higher (`max(strategyMax, floor)`). Previously the floor clobbered both (Min=Max=floor), discarding demand-informed Max headroom. Applies to every DS in `newDSList`.

### Demand Attribution — which DS gets credited (`src/engine/attribution.js`)
**LIVE since 2026-07-27 (PR #13).** When a DS is out of stock the whole order is invoiced from another
store, inflating that store's demand and hiding the real need at the customer's own DS. Measured: **~11%
of demand lines misattributed** in steady state (20.2% including DS06 launch effects).

- Two modes in `params/pincodeMap` (**its own row** — see the params-row rule below): `mode:
  "location"` (fulfilling store, historical default) or `"shippingCode"` (customer pincode → DS).
  Currently **`shippingCode`**, 127 pincodes.
- **Resolved in `runEngine` (first line), NOT at CSV-parse time.** `parseInvoiceCsv` carries the raw
  `pin` (Shipping Code = `shipping_address.zip`) into the stored rows, so switching mode is a **re-run,
  not a CSV re-upload**. `applyAttribution` returns `inv` unchanged unless `shippingCode` is on.
- **Static current mapping applied to all history is deliberate** — it asks "what would demand be if
  today's catchment had always existed", the right counterfactual for future Min/Max. No date-versioning
  even though ops reassign pincodes over time.
- Unmapped pincodes **fall back to the fulfilling location**, never dropped. A pincode claimed by two
  DSes is **rejected on upload** rather than silently resolved.
- `parsePincodeMapCsv` accepts the ops working sheet (per-DS 60/90/120-min column blocks) as well as a
  plain `Pincode,DS` sheet — no manual reformatting.
- Measured impact of the flip on live data: network Max **₹7.81Cr → ₹7.68Cr (−1.7%)**; DS02 −₹16.4L and
  DS05 −₹6.2L shed inflated demand, DS03 +₹5.1L / DS04 +₹5.9L / DS06 +₹3.9L / DC −₹6.6L; 1,120 SKUs moved.
- Tests: `attribution.test.js`, `pincodeMap.test.js`, `coverage.test.js`, `parseInvoiceCsv.test.js`.
- **Ops dependency:** DS02 is now stocked for ~16L less. If routing doesn't actually follow the pincode
  mapping, DS02 keeps receiving those orders while stocked for fewer. Known gap: pincode 560111 (193
  rows, 86% served by DS03) is not in the mapping.

**Params-row rule (learned the hard way):** new config belongs in **its own `params` row**, never
`params/global`. That row is written wholesale on every Apply and loaded with a *shallow* merge
(`{...DEFAULT_PARAMS, ...sbParams}`), so a new **nested** key is silently dropped — the
`fixedUnitFloor.minNZD` trap. Top-level keys are safe; nested ones need inline `??` defaults.
**Own-row pattern — use `src/paramConfigRows.js`, do not hand-roll it.** `loadParamConfigRows()` is
the single list of which configs live in their own row; all three load sites call it, and
`applyAndRun` strips them before writing `params/global`. ⚠ It exists because three separate places
rebuilt `activeParams` and re-attached these rows by hand — **two of them re-attached the plywood
rows but missed `pincodeConfig`.** Both then call `setParams(activeParams)` (wholesale replace) and
`runEngine(activeParams)`, and the team_data effect awaits ~12MB so it resolves last and wins. Net
effect: every page load silently reverted attribution to "location" (₹7.95Cr vs ₹7.81Cr), while
`toTargets` — written from in-memory params at Apply — stayed correct. Symptom was "the radio resets
on reload"; cause was the engine reverting too. Adding a config row is now a one-line change there.

### DS Seed — new store bootstrap (`src/engine/dsSeed.js`)
Seeds a new DS's Min/Max from the **equal-weight average of source DSes** — built for DS06 Kogilu, whose catchment carves ~50% of orders each from DS02 and DS04. Config: `params.dsSeed = { DS06: ["DS02","DS04"] }` (Logic Tweaker → "DS Seed — New Store Bootstrap" checkbox; empty object = inactive). **Do NOT sunset yet — measured 2026-07-27:** removing the seed drops DS06 from 2,374 stocked SKUs to 1,482 (892 → zero, ₹23.0L) and network Max to ₹6.13Cr. Pincode attribution gives DS06 real catchment history, but 16 pincodes over a mostly pre-launch window is too thin for assortment breadth — the seed solves 'not enough data', not 'no data'. Re-evaluate at ~90 days post-launch as its own diff.
- Per SKU, per field: `DS06 = max(organic/floor value, ceil(avg(sources)))` — "whichever wins". `ceil` ⇒ union assortment. logicTag `DS Seed`, audit entry in `postBlendSteps`, `preFloor*` untouched.
- Runs after all strategies/floors, **before Inventorised-At normalization** — Supplier/DS-inv zeroing still wins; Dead Stock propagates (0+0→0).
- **DC re-derived treating the seeded DS as a real sixth store** (deliberate transition overstock — sources are never reduced; both self-correct as carved-out demand leaves source history ~45 days post-go-live): rate-based SKUs add a synthetic rate `max(0, avg(source rates) − organic DS06 rate)` into `sumDailyAvg`; floored SKUs add the seed deltas into Σ DS sums; Network Design adds `ceil(ΔMin × brand dcMult)`. DC never decreases. Audit: `dcDetails.dsSeedAug`.
- Tests: `src/engine/__tests__/dsSeed.test.js` (18).

### Inventorised-At normalization (final engine override)
Applied as a last pass over `res` in `runEngine` (after all strategies, floors, Dead Stock), keyed on `meta.inventorisedAt`. Same character as Dead Stock — a structural location constraint. Zeroes `min`/`max`, leaves `preFloor*` intact for audit, tags `dc.dcDetails.zeroedReason`.
- **Supplier** — never stocked in our network → Min=Max=0 at every DS **and** DC. (Was previously getting real targets; this removes their phantom value from Overview/SKU Detail/Tool Output/Overrides — Stock Health already filtered them.)
- **DS-inventorised** — replenished directly to the DS, bypasses the DC → DC Min=Max=0, DS values kept.
- **DC-inventorised** — flows through the DC → untouched.

> Engine output is **recomputed client-side on every load** (`runEngine` in App.jsx load effects) — there is no stored-results blob. So engine changes go live for all users on the next page load after deploy; no "Apply & Re-run Model" needed (that button only re-pushes params/overrides).

**Downstream of Supplier exclusion:**
- **OOS Simulation** (`simWorker.js` `runSim` + `runActualStockSim`) explicitly skips Supplier SKUs via `inventorisedAt==='supplier'` — independent of the engine zeroing (holds even if a floor pushed Max>0; the actual-stock sim doesn't read Max at all). The dead inline `runSim`/`median` in App.jsx were removed (2026-06-30).
- **Overview tab** store selector "All" = **All Locations (incl. DC)** — `getInv` sums DS01–DS05 **+ DC** so the category/brand/SKU table rollups tie out to the KPI "Inv Value" cards (which always include DC). Coverage figures in "All" mode include DC stock vs DS-only sales by design.

---

## Network Design — Plywood Stocking

**Activated via:** Logic Tweaker → Category Strategy Map → "Plywood, MDF & HDHMR" → "Network Design". Off by default; PCT runs unchanged when inactive.

**v2 — capacity-aware successor (`network_design_v2`):** a separate engine in `src/engine/strategies/plywoodV2/` that stocks every SKU at every DS sized to fit shelf capacity, with a lean-reorder + one-bulk-order DC buffer (replaces v1's brand-node matrix). **Shipped to prod DORMANT 2026-06-18 (PR #11)** — admin-only "Plywood v2" tab (Locations / Assortment-Keep-Score / Settings / OOS-Sim views); the live engine stays on v1/PCT until an admin selects "Network Design v2" in the Logic Tweaker + Apply (reversible). Config in `params/plywoodNetworkV2Config` (own row). **Authoritative doc: `src/engine/strategies/plywoodV2/CLAUDE.md` — read it for v2 work.** v1 (below) is unchanged.

**Concept:** Brand-level assignments — each brand is stocked at specific DS nodes which aggregate demand from multiple DSes. Non-stocking DSes get Min=Max=0 (fulfilled from stocking node or DC).

**Current brand assignments (live Supabase config, verified 2026-07-06 — code defaults in constants.js are stale):**
- All four brands (Action Tesa, CenturyPly, ArchidPly, GreenPly) stocked at **every DS, each node covering only itself** (no cross-DS coverage, no DC direct-serve nodes). Per-brand dcMultMin/dcMultMax = 0.75/1.0.
- Merino: excluded from this tab, uses PCT.
- DS06 is not in any brand matrix — v1 gives it Min=Max=0; the DS Seed pass fills it (valid because self-covering node values ≈ local demand).

**3-zone stocking per SKU (NZD = non-zero demand days in lookback):**
- **Rare** (NZD < minNZD=2): Min=Max=0, not stocked
- **Sparse** (2 ≤ NZD < sparseNZD=5): Min=ceil(ABQ), Max=ceil(Min×abqMult) ≥ Min+1. ABQ = total qty ÷ orders.
- **Frequent** (NZD ≥ 5): Min=P95 of winsorised aggregated daily demand, Max=Min+P75(orders), capped at maxCap=20.

Winsorising: daily demand capped at median×spikeCapMult before P95 to handle outlier days.

**DC formula:** `DC = P95(direct-serving DSes) + ceil(Σ DS_Min × dcMult)`. Uses Σ DS_Min (not Σ(Max-Min)) so fast-movers get proportional DC buffer. **Floored SKUs:** DC result is floored to `max(network_dc, Σ DS_Min × skuFloorDCMultMin / Σ DS_Max × skuFloorDCMultMax)` — same global multipliers as non-network floored SKUs (defaults: 0.2/0.3).

**Config:** Plywood tab → ⚙ Network Design Configuration (admin). Stored in `params/plywoodNetworkConfig` (separate from `params/global`). Saving auto-reruns engine. Key params: lookbackDays=90, minPercentile=95, maxBufferPercentile=75, maxCap=20, spikeCapMult=3, minNZD=2, sparseNZD=5, abqMult=1.5, dcCapacity={thick:400,thin:400}, per-brand dcMultMin/dcMultMax (tuned to 0.3/0.5).

Brand-DS assignments editable in config matrix (brand×DS checkboxes + covers). Brand matching is case-insensitive.

---

## Replenishment Logic

- Trading: 8 AM–8 PM IST. End of day: closing stock ≤ Min → restock to Max overnight from DC.
- **TOs are raised DC→DS at ~2:30 PM and ~8:30 PM IST** (changed 2026-07-27; the old ~midnight run is
  retired). Both are manual, by the DC team, via the TO tool. ~Noon next day: TOs arrive at DS.
- **⚠ Invoices are RAISED by ~20:30 IST but not SETTLED until hours later** (corrected 2026-07-29; the
  old note here claimed "complete until 8:30 PM" and a 21:30 IST refresh was built on it). Zoho's
  `status` only reaches `paid` when payment is recorded, so a 21:30 pull sees a large
  `partially_paid`/`sent` fraction — see the Zoho INVOICES API section. **The finish line for invoice
  data is settlement, not the trading close.**
- **Scheduling consequence:** the nightly refresh runs in the idle **00:35–04:00 IST** window, against
  the last *complete* IST day. Trading ends 20:00 IST and ops POs start ~06:00 IST, so the night is
  free, and TOs are occasionally raised as late as ~02:00 IST — which is why the invoice write is
  **atomic** rather than merely late-scheduled (see Stage 4). This costs no freshness versus the old
  21:30 slot: both produce targets before the next day's 14:30 TO run, but only this one uses a whole
  day. Don't design against a midnight deadline; it no longer exists.
- Clusters: DS01+DS05 (C1), DS02+DC/Rampura (C2), DS03+DS04 (C3).

---

## Stock Health Tab

**Component:** `src/tabs/StockHealthTab.jsx`

**Data sources (synced hourly via `sync-stock` + `sync-orders` Edge Functions — see sync architecture in Data Model section):**

> **Zoho migration 2026-07-06:** all sync now hits the **Zoho Inventory API** (`/inventory/v1/`, org `60075214606`) — the old Zoho Books org (60044091518) is retired. Same response shapes, same `rule` filter, same custom fields. Credentials live in Supabase secrets (`ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN/ORG_ID`, scope `ZohoInventory.fullaccess.all`).

- **Stock:** Zoho Inventory Summary report per branch (7 branches × ~10 pages). Stored as `stockData[sku][ds] = { stock_on_hand, available_for_sale, in_transit }`. Zoho field mapping: `stock_on_hand` ← `quantity_available`, `available_for_sale` ← `quantity_available_for_sale`, `in_transit` ← `quantity_in_transit`.
- **PO:** Replenishment POs (open + pending_approval + partially_billed, last 12 days). Incremental via `_poCache`. Stored as `poData[ds][sku] = { qty, received, po_date, status, delivery, po_number, po_id }`.
- **TO:** Transfer Orders from DC. Two fetches per sync:
  - Active (draft + in_transit, last 3 days): incremental via `_toCache`. Priority: in_transit > draft; latest date/last_modified wins within same status. 3 days = 3× buffer over the 24h TO lifecycle (draft ~midnight, transferred ~noon next day).
  - Transferred today IST: incremental via `_transferredTodayCache` (same pattern as `_poCache`/`_toCache`). 2-day date window fetches list; detail calls only for new/modified TOs. Filtered to `last_modified_time >= midnight IST` using Date comparison (not string compare — timezone formats differ). Capped at 50 new detail calls per run — prevents cold-cache timeout deadlock (cache warms over 1-2 runs).
  - Stored as `toData[ds][sku] = { qty, rec_qty, to_date, status, to_number, to_id }` keyed by destination DS. `rec_qty` = null for all entries (always draft/in_transit). Priority: in_transit > draft.
  - Only draft and in_transit TOs are stored. Transferred TOs are not shown: once received, stock appears in AFS. Zoho's `last_modified_time` is unreliable as a transfer-date signal — any edit to a TO in Zoho updates it, causing stale transferred TOs to re-appear as "today".

**Zoho ITEMS + PRICES API — measured 2026-07-28. Read before touching `sync-catalogue`:**
- **⚠ Item custom fields arrive as TOP-LEVEL `cf_*` keys on the `/items` LIST response** — verified:
  `cf_dc01_rampura`, `cf_ds01_sarjapur` … `cf_ds06_kogilu`, with **no** `custom_fields` array and
  **no** `custom_field_hash` at all. Reading only those two shapes means a field is never found and
  the code silently falls back — indistinguishable from "not populated yet". `_shared/catalogueMap.ts`
  `customField()` checks all three shapes. (`diag-items` reported "no custom fields" for exactly this
  reason — don't trust it.) Good news: because they DO come back on the list, `cf_inventorised_at`
  will cost ~11 calls, not 2,074 detail calls.
- `/items` list returns `sku`, `name`, `category_name`, `brand`, `status` — the Books-era field names
  still hold post-migration. 2,093 items over ~11 pages, ~16s (2,083 on 2026-07-28 — it grows).
- **⚠ Item `status` vocabulary is NOT just `active`/`inactive` — `confirmation_pending` exists too**
  (measured 2026-07-29; an earlier note here claimed otherwise and led to the wrong conclusion). Values
  are **lowercase**; the CSV master writes `Active`/`Confirmation Pending`. Every downstream filter is
  `(status || "Active").toLowerCase() === "active"`, so case is harmless — but **compare
  case-insensitively in any diagnostic**, or a status diff reports all ~2,092 SKUs as changed and buries
  the few that matter.
  - Consequence: the master's `Confirmation Pending` values were **mirroring Zoho**, not a hand-made
    local override. Zoho has since confirmed 4 of the 5, so the CSV master was simply **stale**.
- **Status ownership (decided 2026-07-29): only SKUs `active` IN ZOHO get Min/Max.** Any other status is
  immaterial — Zoho wins, no local vocabulary is preserved. Two safety rules follow, because this single
  field decides whether a SKU is stocked at all:
  - **A missing status is NOT active** (`catalogueMap.ts`). Absent data is not evidence; defaulting to
    active would stock a SKU on no information.
  - **A SKU absent from the Zoho pull is RETAINED and marked `Inactive`, never dropped.** A partial
    `/items` response is indistinguishable from a deletion. Dropping also makes the SKU's invoice rows
    unknown to `assessCoverage` — the guard that refuses to write invoice data — silently coupling the
    two syncs. Retaining gives the no-Min/Max outcome while keeping `category`, which drives strategy
    dispatch. Reported as `report.absentFromZoho`.
  - **`assessMasterChange` now guards the active share too** (`reason: "active_share_shift"`). It
    previously watched only the `inventorisedAt` mix and the row count — and a pull that flipped SKUs to
    inactive changes *neither*, so it passed every check while zeroing their Min/Max. With ~99.8% of the
    catalogue active, that was most of the master riding on an unguarded field.
- `reports/purchasesbyitem` **does** exist on `/inventory/v1/`. `average_price` is Zoho-computed over
  the requested window — not something we derive.
- **⚠ PRICES MUST MERGE, NEVER REPLACE.** That report only sees purchases made in *this* org, i.e.
  since 2026-07-01 — not the 12-month window requested. Measured: **1,477 priced from Zoho vs 1,822
  stored.** A replace would push 345 SKUs to "No Price", which PCT reads as the 95th percentile, so
  they'd be stocked MORE aggressively. `mergePrices` keeps the stored value where Zoho is silent
  (verified live: 1,822 → 1,834, 357 retained, 0 lost). Coverage self-heals as the org ages.
- **⚠ `Inventorised At` DOES NOT EXIST IN ZOHO** (as of 2026-07-28) — it is hand-set in the CSV, and
  it's the highest-consequence field in the master (Supplier ⇒ 0 everywhere; DS ⇒ DC 0). The CSV path
  defaults a missing value to **"DS"**, and live is 2,004 DC / 58 Supplier / 12 DS — so treating Zoho
  as authoritative today would reclassify ~2,000 SKUs DC→DS and zero the whole DC plan. Hence: Zoho
  wins only where it has a value, else the stored value stands, else default DC (96% of the master)
  with the SKU reported. `assessMasterChange` fails closed on a >5% shift in the mix, a sharp shrink,
  or an empty pull.

**Zoho INVOICES API — measured 2026-07-27 (probe, 327 read-only calls). Read before building any
invoice sync:**
- **Line items require a per-invoice DETAIL call.** `GET /invoices` is header-level; `?include=line_items`
  is silently ignored; bulk `?accept=csv` is header-only (no SKU/quantity). Budget 1 call per invoice.
- `shipping_address` is exposed as a **key** on the list endpoint but **never populated** (0 of 3,624
  rows). The zip only appears on the detail call. Don't build on the list carrying it.
- **⚠ Status vocabulary differs from the CSV export** (same shape as the PO trap): API returns
  `paid`/`overdue`/`void`/`draft`; the CSV says `Closed`/`Overdue` and `parseInvoiceCsv` filters
  `["Closed","Overdue"]`. **`paid` IS the API's `Closed`.** Port that filter naively and you drop ~97%
  of rows. `filter_by=Status.Closed` → HTTP 400; filter client-side.
- **⚠⚠ THE ALLOWLIST `{paid, overdue}` WAS WRONG, AND THE MEASUREMENT THAT PRODUCED IT COULD NOT HAVE
  SHOWN IT.** A live invoice passes through `partially_paid` and `sent` before settling. Measured
  2026-07-29 at ~12:00 IST over 224 in-flight invoices: **paid 112 (50%), partially_paid 86 (38%),
  sent 26 (12%)**. Direct proof on 40 of that day's invoices: **30 `partially_paid` + 10 `sent`, 0
  `paid`** — 83 real rows that the allowlist produced *zero* of.
  - The 2026-07-27 probe measured 7 days of **settled** history, which by construction contains only
    terminal statuses (`paid`/`overdue`/`void`). **No amount of historical sampling can observe an
    intermediate state.** Generalise a filter from settled days and it silently deletes live demand.
  - Cost: the 2026-07-28 nightly run lost **312 rows / 2,081 units — 27.7% of the day's quantity** —
    and reported `ok: true`. Neither guard could catch it: `assessCoverage` measures the unknown-SKU
    rate *among rows that arrived*, so a dropped invoice contributes none (it actually **improves** the
    metric); `mergeInvoiceRows.report.safe` checks *date* loss, and the date was present, just short.
  - **Now a BLOCKLIST — `{void, draft}` (`invoiceMap.ts`).** The model measures DEMAND: if the goods
    left the shelf that is demand, whatever the payment state. An allowlist fails closed on demand
    (expensive, silent); a blocklist fails open (over-count, visible, correctable). A missing status is
    still rejected — absent data is not evidence of a sale.
  - On a **settled** day the widening is a verified no-op (07-28 re-listed: `paid` 29, `overdue` 1 of a
    30-invoice sample; zero `partially_paid`/`sent`), so it cannot move historical numbers.
  - Residual: an invoice counted while `sent` can later be **voided** (~0.9%, 5 of 564 on 07-28), always
    an over-count. Handled by re-fetching D-3 nightly — see Stage 4 below.
- **⚠ A settled day is not re-fetch-proof either — count the LIST first.** 07-28 listed exactly **564**
  invoices from both the API and the CSV. When shadow and CSV disagree, compare *distinct invoices
  listed* before theorising: equal counts prove the loss happened after listing (status filter or
  detail-call failure), unequal counts point at the window or pagination.
- Timing: avg detail call **289 ms** (p95 434 ms). At 4-concurrent, 1,000 invoices = **72 s** — fits one
  150 s invocation. No queue/chaining needed.
- Quota: `x-rate-limit-limit: 57500` per window (~8.4 h reset). A 1,000-call nightly pull is ~2%.
- `date_start`/`date_end` and `last_modified_time` filters are both honoured. `page_context` has **no
  `total_count`** — paginate to count.
- Volume: 511–579 invoices/day, 2.76 line items each. ~22% of exported CSV rows are unnamed charge
  lines (blank SKU, qty 1) that the engine correctly drops.

**Zoho Inventory location IDs (org 60075214606, confirmed 2026-07-06):**
`DC=3915979000000118466`, `DS01=3915979000000054002`, `DS02=3915979000000054017`, `DS03=3915979000000054032`, `DS04=3915979000000054047`, `DS05=3915979000000054062`, `DS06=3915979000000118484`

**DS06 Kogilu (go-live ~2026-07-08):** sync layer is DS06-aware (stock/PO/TO data accumulates in Supabase). **Phase 2 (2026-07-06, now in `main`):** `DS_LIST` includes DS06 (Stock Health tab/KPIs/DC ROS/DS Req Covered follow automatically; 6th `DS_COLORS` entry added) + engine **DS Seed pass** gives DS06 Min/Max = avg(DS02, DS04) — see the DS Seed section. On activation, admin ticks "Seed DS06" in Logic Tweaker (and optionally adds DS06 to `newDSList` for the floor) + Apply. Plywood tab (v1) is DS06-aware (filter button, matrix editor column, DS_DEFAULTS entry) — **at go-live, also add DS06 to each brand's matrix (self-covers) via the tab's config editor**: nodes compute 0 until Kogilu demand exists, the seed wins meanwhile, and organic node values take over as demand builds — this is what lets the plywood seed sunset (network strategy ignores DSes not in the matrix). Review later: local `DS_LIST` copies in `simWorker.js`/`BasketAnalysisTab.jsx`, cluster assignment.

**SKU filtering rules:**
- Only `status = Active` SKUs (from SKU Master)
- `Inventorised At = Supplier` → excluded entirely from all counts and table
- DC tab: only `Inventorised At = DC` SKUs. DS tabs: both DS + DC inventorised SKUs.

**Order data shown per SKU type (DS tabs):**
- `Inventorised At = DC` → TO columns (Ref #, Date, Rep. Qty, Rec Qty, Est. Delivery, Status: Picking/In Transit/Received). No PO shown.
- `Inventorised At = DS` → PO columns (Ref #, Date, Rep. Qty, Rec Qty, Est. Delivery, Status).
- DC tab → PO only (TOs are outgoing from DC, not tracked here).

**Health tags (applied in order):**
| Tag | Condition | Color |
|---|---|---|
| Critical | ecs ≤ min AND (ros − ecs ≥ 1) | Red |
| Low Stock | ecs ≤ min (but ros − ecs < 1) | Amber |
| Okay | min < ecs ≤ max | Green |
| Excess | ecs > max | Blue |
| Exception | ecs = min = max (dead stock at target) | Green |

**DC tab additional tag (checked before Critical/Low Stock):**
| Tag | Condition | Color |
|---|---|---|
| DS Req Covered | DC ecs ≤ min AND any of: (A) no DS is short, OR (B) DC_ecs ≥ Σ (DS_max − DS_ecs) for short DSes, OR (C) Σ DS_excess + DC_ecs ≥ DC_min | Purple |

DS_excess per DS = max(0, DS_ECS − DS_Max). No PO needed at DC when this tag fires.
- Cond A: all DSes have ECS ≥ Min — no demand pressure on DC
- Cond B: some DSes are short but DC stock fully covers their replenishment needs
- Cond C: network DS excess + DC stock covers DC's minimum floor (network-long, no supplier PO needed)
The DS-Req-Covered reclassification lives in **one shared helper `applyDCReqCovered(tag, …)`** called by BOTH `dsSummary` (tab-bar badges) and `allSkuRows` (KPI cards + table). Previously the logic was inline in `allSkuRows` only, so `dsSummary` (which calls `getHealthTag()` directly) missed it — the DC tab-bar badge over-counted Critical vs the KPI card. Keep both readers routed through the helper so they can't diverge.

`ECS = max(0, SoH)` — **Stock-on-Hand**, not AFS. Stale historical Sales Orders depress AFS even when stock is physically present at the location, producing false shortage tags; SoH reflects actual stock. Switched 2026-06-30. (AFS still shown as a reference column.) `applyDCReqCovered`'s per-DS short/excess also uses SoH. ROS = `dailyAvg` from engine. For DC: ROS = sum of dailyAvg across all 5 DSes.

**KPI card pills:** Each card has two pill rows on DS tabs — TO pills (No TO / Picking / In Transit, DC-inv SKUs) above PO pills (No PO / Delayed / Issued / Pending, DS-inv SKUs). PO/TO filters are mutually exclusive — activating one excludes the other's SKU type.

**PO data notes:**
- `cf_purchase_type` must be "Replenishment" to be included. Ops mandate started 2026-05-13 — older POs may lack this field.
- **PO status vocabulary is Inventory-native (post-migration):** the `status` field stored/displayed is `issued` / `partially_received` / `received` / `pending_approval` / `cancelled` — NOT Books' `open`/`partially_billed`. The edge-function query filter still uses `status=open` (a Zoho alias that returns issued+partially_received+received) + `pending_approval` + `partially_billed` — these are query keywords, distinct from the returned `status` value. Frontend `PO_STATUS_LABEL/BADGE/STYLE`, `getPoDisplayStatus` (Delayed derivation), the "Issued" KPI filter, and `PO_RANK` sort all key on the Inventory values (Books keys kept as harmless back-compat). Only `issued`/`pending_approval`/`delayed` actually render on DS tabs — `dsPoData` drops any PO with `received > 0`.
- **Zoho deep-links:** Stock Health PO/TO Ref# links use `ZOHO_INV_URL = https://inventory.zoho.in/app/60075214606#` (`/purchaseorders/{id}`, `/transferorders/{id}`) — the Books org URL is retired.
- `delivery` = `cf_confirmed_delivery_time` from `custom_fields[]` array (NOT top-level field). New-org format: `YYYY-MM-DD HH:mm` — sync-orders strips the time via `split(' ')[0]`.
- 15-min cooldown enforced server-side (both cron and manual Sync Now).
- **PO display rule:** `dsPoData` filters out any entry where `received > 0` before the frontend sees it. Latest PO per SKU already wins (sort by date DESC, first-assignment wins in sync-orders). If the latest PO has received > 0, stock already arrived — no PO shown regardless of older stale POs. Frontend-only change, no edge function impact.

**TO data notes:**
- TO statuses: `draft` (picking in progress) → `in_transit` (dispatched) → `transferred` (received at DS, shown as "Transferred").
- Only TOs where `from_location_id = DC branch ID` are fetched.
- `to_date` (creation date) used for both Date and Est. Delivery columns.
- "Transferred today" uses `last_modified_time` (the actual transfer timestamp), not `date` (creation date). TOs raised yesterday but transferred today are correctly captured via the 2-day date window + midnight IST filter.
- At midnight IST rollover: transferred TOs fall out of "today" window; new draft TOs raised that night take over at the 00:05 IST sync.
- Rec Qty shown for transferred TOs (= qty sent); "—" for draft/in_transit.

**Sync performance constraints (150s Supabase Edge Function wall time):**
- `inventorysummary` report: ~18–56s/call depending on Zoho health — dominant cost.
- **Zoho inventorysummary rate limit: ~8 calls/minute** (confirmed 2026-05-22; re-confirmed on the Inventory API 2026-07-06 — 10 calls in ~2 min → 429). 4 concurrent (2 branches × 2 modes) → 429 after 2 groups; 6 concurrent (3 branches) → 429 after 1 group. Safe: max 4 calls per invocation.
- **Zoho OAuth token-endpoint throttle (distinct from the inventory-API limit above):** `accounts.zoho.in/oauth/v2/token` throttles *access-token generation* from the refresh token — `{"error":"Access Denied","error_description":"You have made too many requests continuously"}`. On 2026-07-14 this failed stock-sync-1 + stock-sync-2 (DC/DS01/DS02/DS03 missed a cycle) at the auth step, *before* any inventory/Supabase call; stock-sync-3/4 recovered ~3 min later. Root cause: every function minted a fresh token per invocation (~5-10/hr across 4 stock crons + orders + on-demand create-to). **Fix (2026-07-15):** shared `supabase/functions/_shared/zohoToken.ts` `getZohoToken(supabase)` caches the token in `public.zoho_auth_cache` (RLS ON, no policies → service-role only; NOT in `params`, which anon can read) and reuses it until ~10 min before expiry. Cuts token calls to ~1/hr; raising a TO now logs `zoho token: cache hit` and costs zero token calls, so it can't starve the crons. FAIL-SAFE: any cache miss/read/write error → fresh refresh (pre-cache behaviour). Hot path only (sync-stock, sync-orders, create-to); the `zoho-invoices/prices/skumaster` importers still mint per-call. Logs `zoho token: refreshed` / `cache hit`.
- **Architecture:** 4 staggered cron jobs (3 branch pairs + DS06; ≤4 concurrent calls, never overlaps):
  - `stock-sync-1` at `:35 UTC` (:05 IST) → DC + DS01
  - `stock-sync-2` at `:38 UTC` (:08 IST) → DS02 + DS03
  - `stock-sync-3` at `:41 UTC` (:11 IST) → DS04 + DS05
  - `stock-sync-4` at `:44 UTC` (:14 IST) → DS06 (2 calls)
  - `orders-sync-hourly` at `:50 UTC` (:20 IST) → PO + TO (different Zoho endpoints, separate rate limit bucket). Moved from :35 on 2026-07-08 (migration `20260708000001`) — at :35 it collided with stock-sync-1's `team_data/global` write (statement timeout left DC+DS01 74m stale).
- **syncLock (2026-07-08, deployed):** `sync-stock` acquires `params/syncLock` before pulling (released in `finally`; locks older than 5 min treated as leaked and taken over). A concurrent invocation gets `{ok:true, busy:true}` — callers (TO tool's on-demand pull) retry after ~30s. Prod-verified: concurrent calls → second returned busy, lock released cleanly after.
- **Session lease + CORS (2026-07-09, `7e0711b`, function DEPLOYED 14:26 IST + prod-verified; frontend rework `c520275` DEPLOYED ~15:25 IST via main — before it shipped, old prod Sync Now caused a second 429 storm at 14:50 IST, healed by the 16:05 cycle):** same `syncLock` row gains a `session` field — a browser tool (TO pull / Sync Now) claims the sync path for its whole multi-group sequence via `{sessionStart, source}` / `{sessionEnd, sessionId}` (12-min self-expiry); crons and the other tool get `busy` meanwhile. Also: CORS headers on ALL responses (previously only the preflight had them → browsers couldn't read any POST response; Sync Now failed silently, TO tool showed successes as ✕). **Deploy this function BEFORE any browser code that sends `sessionStart`** — the old function misreads it as a full 7-branch sync (429 storm).
- **Browser-triggered syncs need explicit 90s pacing (2026-07-09 RCA):** sequencing groups back-to-back is NOT pacing — on a fast-Zoho morning (5s/group) the TO tool's pull put 12 calls in ~15s → 429 on groups 3–4 + ~60 min penalty that also killed the 04:38 UTC cron. Both Sync Now and the TO pull now enforce a 90s minimum gap between group starts (~2× margin on every observed threshold). Crons are unaffected (wall-clock stagger).
- **Supabase statement timeout:** Concurrent reads/writes from multiple functions on the same large global row cause Postgres to cancel statements. Fix: 3-min stagger ensures each function's write completes before the next function's read starts (2-min stagger still collided when Zoho took ~100s/function).
- **Supabase Disk IO budget:** Nano instance has 30-min daily burst (43 Mbps baseline). The 3-function architecture makes 12 Supabase ops/hour — with a 7MB payload (including invoiceData) this exhausted the Nano burst within hours. Fix: (1) upgrade to Pro + Micro compute (87 Mbps baseline, 60-min burst), (2) separate invoiceData into its own row reducing global payload to ~1-2MB. Together these make daily IO sustainable on Micro.
- **Migration safety:** Never run `supabase db push` after manually executing a migration SQL in the SQL editor. The CLI doesn't know it already ran and will execute it again. Use `supabase migration repair --status applied <version>` to mark it as done without re-running.
  - This had actually happened: `20260715000001` (zoho_auth_cache) was applied by hand, so the table existed while the ledger said "pending". Repaired 2026-07-28. **Fix the ledger, never delete the migration file** — the files are the replayable schema definition; a fresh project or DR restore would otherwise have no way to create the table, and the token helper is fail-safe so it would degrade silently into per-call minting.
  - Check `supabase migration list` before any `db push`: unapplied-but-already-run migrations couple unrelated changes into one aborting transaction.
- Each stock cron passes `{"branches":["DC","DS01"]}` in pg_net body; sync-stock reads this and fetches only those branches.
- **Branch-level merge:** sync-stock merges `stockData[sku][ds]` at branch level on write — never replaces the full stockData object (would wipe sibling functions' branch data).
- **Status codes:** 546 = Supabase killed the function (wall clock timeout); 500 = function caught an error and returned cleanly.
- **Rate limit recovery:** after 429 abuse, recovery takes 60+ min. Never rapid-deploy or trigger repeated manual syncs.
- **⚠ Incident 2026-07-28 (self-inflicted, worth not repeating):** testing `sync-invoices` by hand pushed
  **~1,900 Zoho calls through the org in 15 minutes**. Throughput collapsed from 24 to under 4 calls/sec
  (the 429 backoff in `zohoClient` compounding) and **`stock-sync-3` missed its 13:41 UTC cycle** —
  DS04/DS05 went an hour stale. It self-healed the next cycle. Lesson: `/invoices` tolerating 4 calls/sec
  says nothing about total pressure on the org while five other crons share it. One run, then wait.
  `_shared/syncCooldown.ts` now enforces a 15-min minimum between fresh runs (`force: true` bypasses it —
  don't).
- **⚠ THE 429 CASCADE — a per-call backoff makes a concurrency problem worse, not better** (measured from
  edge logs, 2026-07-28). `sync-invoices` at `CONCURRENCY 8`:

  | run | Zoho calls | 429 retry #1 | 429 retry #2 | **exhausted** | elapsed | HTTP |
  |---|---|---|---|---|---|---|
  | 07-27 date | 560 | 37 | 13 | **7** | 113s | 200 |
  | 07-28 date | 501 | 44 | 26 | **15** | **172s** | **504** |

  `Error: Zoho API: 429 after 3 attempts` — those invoices' rows were dropped silently. The **7** on
  07-27 matches exactly the 7 missing orders / 8 missing rows measured against the CSV, so on a settled
  day 429-exhaustion is the *only* leak.
  - **The retry cost is the timeout.** 44×10s + 26×20s = **~960 worker-seconds of sleeping** across 8
    workers ≈ 120s of wall clock — the entire gap between the ~50s the run should take and the 172s it
    did. `zohoClient` backs off *one call*; the other seven keep the limit tripped. **Fix concurrency and
    pacing, not the backoff.**
  - **`CONCURRENCY 8` was validated on the wrong day** — a 336-invoice quiet probe ("4 → 8 took it from
    85s to 14s"). A 560-invoice day at the real hour behaves nothing like it. Now **4**, an hour between
    chunks, no deadline.
- **⚠ A 504 DOES NOT MEAN NOTHING WAS WRITTEN.** On 07-28 the gateway returned 504 at exactly 150s while
  the Deno isolate kept running and completed its Supabase writes at 172s. So data landed while the
  caller saw failure — and `invoiceSyncStatus` said `ok: true` over a day missing 27.7% of its quantity.
  **`504` + `ok:true` is the signature of a silently truncated run.** Status codes: 546 = Supabase killed
  it, 500 = the function caught an error and returned, 504 = gateway gave up (function may still finish).
- **Edge function logs are reachable without the dashboard** — the CLI (v2.75.0) has no `functions logs`,
  but the Management API does: `POST /v1/projects/{ref}/database/query` for SQL, and
  `GET /v1/projects/{ref}/analytics/endpoints/logs.all?sql=…&iso_timestamp_start=…` for
  `function_logs` / `function_edge_logs`. Token lives in the macOS keychain
  (`security find-generic-password -s "Supabase CLI" -w`, `go-keyring-base64:` prefixed). **Send a browser
  `User-Agent`** or Cloudflare answers `403 error code: 1010`. Cap queries at 1000 rows — split by time
  window to attribute logs per invocation.
- **⚠ `diag-items` (deployed 2026-07-15, still live) is labelled TEMPORARY and should be deleted.** It
  also gives a **misleading** answer about item custom fields: it inspects `custom_fields[]` and
  `custom_field_hash`, neither of which `/items` uses, and reports "no custom fields" while seven arrive
  as top-level `cf_*` keys. See the Zoho ITEMS + PRICES section.
- **Manual Sync Now (reworked 2026-07-09, ships with next frontend deploy):** claims the shared sync session (source `ims`), runs the 4 cron groups with a 90s min gap between starts (+ sync-orders parallel with the first), one paced retry for failed groups, releases in `finally`. Button greys out while the TO tool holds the session (20s poll of `params/syncLock`) or during the 15-min cooldown; per-group failures surface next to the button.
- **Cold-cache deadlock:** prevented by 50-call cap on transferred-today detail calls + read-merge-write in `saveTeamData` (App.jsx).
- OPTIONS preflight: handler checks `req.method === 'OPTIONS'` and returns immediately — prevents browser CORS preflight from running the full sync.

---

## What's Parked (don't revisit without new data)

- **CV-based demand shaping:** 96.3% combos have CV>2.0 (sparsity-driven). No segmentation power.
- **Movement-based periods:** Simulated — worse (+8 OOS, +₹38.5L). Standard 45D flat is better.
- **Base min days adjustment (+1 for Slow/Super Slow):** Only 0.1% OOS reduction. Not worth it.
- **ROP:** 86.5% of OOS is single order > Max, not restock timing. Parked.

---

## Transfer Orders (TO) Tool — separate app

DC-team tool to generate DC→DS Transfer Orders (replaces 7 manual sheets). **Separate repo/build/deploy:**
`~/Documents/GitHub/homerun-to` (private repo `sandy-0079/homerun-to`) — **authoritative doc:
`homerun-to/CLAUDE.md`.** Reads Min/Max + live stock from this project's Supabase (read-only); writes
nothing. **LIVE since 2026-07-10: <https://homerun-to.vercel.app>** (own Vercel project; end-to-end
number check vs live Zoho exports passed — 12,369 comparisons, 0 plumbing mismatches).

**`create-to` edge function (this repo, deployed 2026-07-10):** creates **draft-only** Zoho TOs for
the TO tool. ⚠ Zoho trap: `is_intransit_order:false` = instant full transfer (NOT draft) — the real
draft mechanism is the undocumented `status:'draft'` body field (captured from the UI's own network
trace). Non-draft responses are auto-deleted in the same invocation. SKU→item_id map cached in
`params/zohoItemIds`; audit in `params/toAudit`. Details: homerun-to spec 2026-07-10-task6b.

**Hook in this repo (in `main`):** `applyAndRun` in `App.jsx` serializes the DC-inv Active
slice of engine results (`{name, category, brand, perDS:{ds:{min,max}}}`) to **`params/toTargets`** after
every "Apply & Re-run Model" — non-blocking, its own row (sync functions never touch `params`, so no IO
impact). The TO tool reads that + `team_data/global` stock (CS DS = accounting SoH, CS DC = physical SoH,
In Transit = Zoho `quantity_in_transit` from the **stock** sync — not orders-sync).

**Task 5 (freshness/readiness) shipped 2026-07-08:** the TO tool has an on-demand "Pull fresh stock"
button that invokes this project's `sync-stock` sequentially per cron group (DC+DS01 → DS02+DS03 →
DS04+DS05 → DS06) with the anon key — a pull updates the same `team_data/global` rows Stock Health
reads. Supporting changes in this repo (deployed): `syncLock` in `sync-stock` + `orders-sync` moved
:35→:50 (see sync architecture above). Task 6 (summary heatmap + Phase 2 Zoho write-back):
see `homerun-to/CLAUDE.md`.

## To-Do (Active)

### 1. Category Network Analysis ✅ Shipped (2026-04-18)
`src/tabs/BasketAnalysisTab.jsx` + Plywood Network tab. Baskets: category/brand analysis with DS×Brand heat map. Plywood: per-DS thick/thin view (PCT mode) — recommendation only, does NOT write into engine.

### 2. OOS Simulation ✅ Revived & Shipped (2026-06-18) — *dropped 2026-04-21 as a synthetic sim*
Now a real **backtest** inside the Plywood v2 tab (OOS Sim view): upload an invoice CSV for dates *outside* the original 90-day window → replay the **published** v2 plan → per-DS service-level + bulk-served-from-DC + a line-item table (red missed / green served). Upload is **ephemeral** (in-memory; never saved to Supabase). Engine: `simulateOOS` in `plywoodV2/oosSim.js` (two replays: DS at infinite-DC, bulk at finite DC, α=1). See `plywoodV2/CLAUDE.md`.

### 3. Stock Health Tab ✅ Shipped (2026-05-14), updated (2026-05-21)
Columns: SoH, AFS, DC Stock, Min, Max, ROS, Req Qty, Rep. Qty, Rec Qty, Date, Est. Delivery, Ref #, Status. ECS = SoH (SoH is the tag-coloured/sortable cell; AFS is a plain reference column). DC-inv SKUs show TO data on DS tabs (Picking/In Transit/Transferred); DS-inv SKUs show PO data. KPI cards have dual pill rows (TO above PO, TO pills include Transferred). TO/PO filters mutually exclusive. Transferred TOs show "Transferred" status with Rec Qty populated. ⓘ tooltip, 85% zoom, item name hover.
- DC Stock column: DS tabs only, between Req Qty and Rep. Qty. Shows DC SoH for DC-inv SKUs (green = stock available, red = zero). Follows Accounting/Physical toggle. DS-inv SKUs show —.
- **CSV download carries two extra columns the table does not render (added 2026-07-28):**
  **Movement Tag** and **Inventorised At**, appended at the END so existing sheets/macros keyed on
  column position keep working. For building **reverse TOs** — send excess back to the DC, but leave
  Fast/Super Fast SKUs in place. Movement Tag is **per-location** (`res.stores[ds].mvTag`, or
  `res.dc.mvTag` on the DC tab), which matters: **33% of SKUs stocked at 2+ DSes carry a different tag
  by location** (e.g. `K825K` is Fast at DS01 and Super Slow at DS05), so a SKU-wide tag would keep
  dead stock exactly where you least want it. `N/A` = no sales at that location in the window — the
  best reverse-TO candidates, and better than "Super Slow" which at least sold something.
  Caveat: on the **DC tab** the DC-level movement calc collapses Fast into Super Fast, so a bare "Fast"
  never appears there.
- Picking pill: yellow (matching Pending Approval colour).

### 9. DC Stock indicator in DS tabs ✅ Shipped (2026-05-21)
DC Stock column added between Req Qty and Rep. Qty on DS tabs. Shows DC SoH for DC-inv SKUs, follows mode toggle, hidden on DC tab.

### 15. Pincode demand attribution ✅ Shipped & LIVE (2026-07-27, PR #13)
`src/engine/attribution.js` — see the Demand Attribution section. Flag flipped to `shippingCode` on
2026-07-27; network Max ₹7.81Cr → ₹7.68Cr. Follow-ups: add pincode 560111 → DS03; confirm ops routing
follows the mapping (DS02 is stocked ₹16.4L lighter).

### 16. Nightly model refresh from Zoho — Stages 4-7 (in progress)
Automate the whole input chain so the model refreshes ~20:30 IST without a manual CSV.
- **Stage 4 (REWORKED + DEPLOYED 2026-07-29 — still shadow only):** `sync-invoices` →
  `team_data/invoice_data_shadow`. Nothing reads it. Migration `20260729000001` **applied**: one cron
  `invoices-sync-window` at **`5,20 19-22 * * *` UTC = 00:35–04:00 IST**, eight slots. Replaces the
  16:00/:06/:12 UTC jobs, which were built on the false "invoices complete by 20:30 IST" premise.
  - **Why overnight:** the day must be **settled**, not merely closed (see the Zoho INVOICES API
    section — a 21:30 pull lost 27.7% of quantity to `partially_paid`/`sent`). The window is idle
    (trading ends 20:00 IST, POs start ~06:00 IST) and clear of `:35–:50`.
  - **ATOMIC PUBLISH — the load-bearing safety property.** Chunks accumulate in
    `team_data/invoice_sync_buffer`; the target row is written **exactly once**, only when every planned
    date is fully pulled and both guards pass. IMS recomputes the engine client-side on every page load,
    so a partial invoice row would immediately show wrong Min/Max — and TOs are sometimes raised as late
    as ~02:00 IST. Any failure leaves the target holding the previous complete pull. **Timing alone
    cannot give this; atomicity can.**
  - **CONCURRENCY 4, chunks of 250, one hour apart** — reverted from 8. See "the 429 cascade": 8 drew
    429s continuously and its own backoff sleeping blew the 150s wall clock. With eight slots there is
    no deadline to beat, so Zoho's per-minute budget resets fully between chunks.
  - **A date with outstanding fetch failures is never marked complete.** Failed ids are retried in
    bounded rounds (`MAX_RETRY_ROUNDS 3`) by later slots; loss above `MAX_LOST_PCT` (0.5% of the *day's*
    invoices — not the retry round's, a bug worth not reintroducing) abandons the night with
    `ok: false` and the target untouched. Retrying is free now, so no accuracy/liveness trade-off remains.
  - **D-3 re-fetch each night** corrects late voids (an invoice counted while `sent` can be voided next
    day). A *fixed* lag, not a rotation: every day gets exactly one recheck, and `mergeInvoiceRows`
    replaces a fetched date wholesale so the correction lands automatically.
  - `invoiceSyncStatus` now records `statusSeen` (status histogram), `failed`, `degradedDates`,
    `publishedPlan`/`publishedAt`. The republish guard stops the later slots re-pulling a published plan.
  - State machine is pure and unit-tested: `_shared/invoiceCursor.ts` + `invoiceCursor.test.ts`.
  - **15-min cooldown** (`_shared/syncCooldown.ts`) that deliberately does NOT block cursor drains.
    ⚠ Added because repeated manual testing on 2026-07-27 pushed ~1,900 calls through the org in
    15 min, collapsed throughput 24 → <4 calls/sec, and made `stock-sync-3` miss its 13:41 UTC cycle.
    One nightly run of ~1,000 calls is fine; four runs in fifteen minutes is not.
  - **Two write guards, both fail closed:** `assessCoverage` (unknown-SKU rate >1% ⇒ refuse) and
    `mergeInvoiceRows.report.safe` (any date loss the retention trim doesn't explain ⇒ refuse).
  - Verified against a real day (2026-07-26): 336 invoices → 648 rows, **identical to the CSV** — same
    rows, same qty, **0 SKU×DS differences** — 0% unknown SKUs, 100% pin coverage. `reference_number`
    confirmed as the `Shopify Order` field.
  - Exit criteria: `node scripts/compare-invoice-shadow.mjs` clean ~5 consecutive days.
- **Stage 5 (pending decision):** point the sync at the live row — a one-line change of `SHADOW_ROW`.
  CSV upload stays as a manual override.
  - **Backup before any cutover:** `team_data/invoice_data_backup_20260728` — 73,178 rows, 90 dates,
    byte-identical row set verified. Restore = copy that payload back into `invoice_data`. Take a fresh
    dated backup before any future cutover; it turns a one-way door into an undo.
  - **⚠ APPEND-ONLY IS A DATA-SAFETY RULE, NOT AN OPTIMISATION.** The current Zoho org has no invoices
    before **2026-07-01** (org migrated; the old Books org is retired and we are not wiring it up).
    Everything earlier exists ONLY in the Supabase payload, hand-uploaded from CSV — the API cannot
    reproduce it, so a full-window rebuild would destroy it permanently. Enforced by
    `mergeInvoiceRows`, not merely intended.
  - Self-sufficiency arrives once the retention window starts on/after 2026-07-01: **~14 Aug 2026** at
    45-day retention, **~28 Sep 2026** at 90-day.
- **Stage 6 (design agreed 2026-07-28, NOT built):** headless engine run → `params/toTargets`.
  `App.jsx:3312` is the ONLY writer of that row, inside `applyAndRun` — so the TO tool runs against
  whatever an admin last clicked Apply on, while IMS recomputes client-side on every page load.
  **Two paths to the same number, and they diverged on 2026-07-28.**
  - **EVENT-DRIVEN, NOT A CRON** (Sandy's call, and the better design): the syncs chain into the engine
    run so `toTargets` is never stale relative to its inputs. Inputs that move Min/Max: `invoiceData`,
    `skuMaster`/`priceData`, `params`, `overrides`, engine code.
  - **The TO tool must keep only *mirroring*, never computing.** The engine is ~2,900 lines with 200+
    tests in this repo; a second implementation in `homerun-to` would drift, and the drift surfaces as
    wrong transfer quantities found by ops.
  - Write to **`params/toTargets_shadow`** first and diff against a browser Apply (per-SKU deep
    equality) before flipping. The first real write must not land unattended before a 14:30/20:30 run.
  - **Stamp the engine commit SHA into `toTargets`.** Vercel and Supabase deploy separately, so a
    frontend deploy can update the browser engine while the edge function still runs an older copy —
    silent drift. IMS can compare and warn.
  - End state worth aiming at: IMS reads the canonical stored result too, making divergence
    structurally impossible and page loads much faster. Costs the "engine changes go live on next page
    load" property, and Impact Preview still needs client-side compute. Not urgent.
- **Stage 7 (LIVE 2026-07-29):** `sync-catalogue` → SKU Master + Purchase Prices into
  `team_data/global` (read-merge-write, fresh read immediately before writing). ~30 calls, ~16s.
  Cron `catalogue-sync-nightly` at **`25 18 * * *` UTC (23:55 IST)**, migration `20260729000002` —
  deliberately *before* `invoices-sync-window` so the invoice coverage guard checks a fresh master.
  See the Zoho ITEMS + PRICES section for the ⚠s, including status ownership.
  - **⚠ NOT `:50`** — `orders-sync-hourly` occupies :50 of every hour and writes the same
    `team_data/global` row; concurrent writers there caused the statement timeout that left DC+DS01
    74m stale. Free minutes: `:00–:34` and `:51–:59`. (An earlier note here suggested 15:20 UTC and
    another suggested 18:50 — both superseded.)
  - Backup before the cutover: `team_data/catalogue_backup_20260729`, verified byte-identical
    (skuMaster 2,092 · priceData 1,822). **More important than the invoice backup** — `inventorisedAt`
    is hand-maintained and absent from Zoho, so a bad master write cannot be repaired from the API.
  - Dry run vs live 2026-07-29: 2,093 items, guard safe, `absentFromZoho: []` (Zoho is now a superset),
    prices 1,822 → 1,834 with 350 retained. Expected first-run effect: **5 SKUs gain Min/Max** because
    Zoho marks them active and the master was stale — `TENX4`, `E3MPF`, `WUTDS`, `XP5EV`, `P292Y`.
  - Blocked on ops for full value: create `cf_inventorised_at` in Zoho and populate it. Verify with ONE
    SKU + a `sync-catalogue` dry run (`invAtFromZoho` should go 0 → 1) **before** populating all 2,083.
  - Floors (`minReqQty`, `newSKUQty`) and Dead Stock stay manual — ops judgement, not Zoho data.

### 4. Rethink Tool Output Tab — fold buttons into Upload Data tab or keep separate?

### 5. Full UI Polish Pass — all tabs (Overview, SKU Detail, Stock Health, Logic Tweaker, etc.)

### 6. Plywood Network Design ✅ Shipped (2026-04-28)
Network Design strategy in engine (`src/engine/strategies/plywoodNetwork.js`). Full UI in PlywoodNetworkTab.jsx — unified SKU table with zone colouring, DC tab, brand assignment editor, compact modal with zone-aware formula display and lookback-period charts.

### 7. Read-only config visibility for non-admins — Logic Tweaker + Overrides tabs
Non-admins currently cannot see Logic Tweaker or Overrides tabs at all (controlled by `ADMIN_TABS` vs `PUBLIC_TABS` in App.jsx). Plan: add both to `PUBLIC_TABS` and disable all inputs with `disabled={!isAdmin}`. Upload Data tab stays admin-only. Plywood Network Design Config already done (visible to all, inputs disabled for non-admins, Save button hidden).

### 10. Sync resilience — staggered cron jobs ✅ Shipped (2026-05-22), updated 2026-05-23
Split sync into `sync-stock` (stock only, 3 staggered cron jobs) + `sync-orders` (PO+TO, :35 UTC). Solves Zoho inventorysummary ~8 calls/min rate limit and 150s timeout on slow Zoho days. Stagger increased 1→2→3 min after successive Supabase statement timeout collisions. Current schedule: :35/:38/:41 UTC = :05/:08/:11 IST. See sync performance constraints section for full architecture.

### 13. invoiceData separation + Supabase compute upgrade ✅ Shipped (2026-05-23)
3-function sync architecture made 12 Supabase ops/hour on a 7MB payload, exhausting Nano's 30-min daily Disk IO burst within hours. Fix: (1) upgraded to Supabase Pro + Micro compute, (2) moved invoiceData to `team_data/invoice_data` (written once on CSV upload, never touched by sync functions), reducing global payload from ~7MB to ~1-2MB (~70% IO reduction per sync). App startup and saveTeamData both load/write invoice_data row separately with backwards-compat fallback.

### 11. DC tab — DS Req Covered tag ✅ Shipped (2026-05-22), refined same day
Purple KPI card on DC tab only (5-column grid). Tags Critical/Low Stock DC-inv SKUs where no supplier PO is needed — DS excess covers the network gap or DC stock covers all short DS replenishment needs. Condition A threshold refined to DC_Min (not DC_Max) — covering DC's floor is sufficient to suppress a PO. See health tags section for formula.

### 12. Stock Health UX improvements ✅ Shipped (2026-05-22)
Clickable column header sorting (Item Name, Brand, AFS, Req Qty, Date, Est. Delivery, Status) with ↑/↓ indicator; third click resets to default tag-priority sort. Filters + sort reset on DS tab switch. Typing/pasting in search clears all active filters.

### 14. Dead stock logic — Min=Max=0 everywhere ✅ Shipped (2026-05-23)
Dead stock SKUs now get Min=Max=0 at all DS and DC locations, overriding all floors (New DS Floor, SKU Floor) as the absolute last post-blend step. Previously DS had Max=Min (non-zero) and DC used dcDeadMult×0.25. New behaviour: no PO or TO raised, Stock Health filters them out (0/0 excluded from table). `dcDeadMult` param in Logic Tweaker is now a no-op. Applies to Standard, Fixed Unit Floor, and Network Design paths.

### 8. DC Calculation Fix for PCT + Fixed Unit Floor Categories
`sumDailyAvg × (leadTime+1)` understocks for erratic demand at DC. Fix: switch to `Σ DS Mins × mult` approach (same as floored SKUs). Held pending any follow-up from Network Design learnings.

## Deferred
- Cluster fulfillment — build into tool or ops process?

---

## Key Non-Obvious Terms

| Term | Meaning |
|---|---|
| NZD | Non-Zero Days — days with at least one sale |
| ABQ | Average Buying Quantity = total qty ÷ orders in lookback |
| DOC | Days of Cover — stock ÷ daily average |
| TO | Transfer Order — stock movement DC→DS |
| Dead Stock | SKU with Min=Max=0 at all locations — no replenishment, filtered out of Stock Health |

---

## Logic Tweaker Params Backup

Full backup auto-saved to `params/paramsBackup` on every "Apply & Re-run Model" click. Restore from there if `params/global` is corrupted.

Key non-defaults: `overallPeriod=45`, `newDSFloorTopN=250`, `newDSList=["DS04","DS05","DS03"]`, `brandLeadTimeDays={_default:3,AsianPaints:4}`, `pctDocCap=30`, `pctDocCapLow=60`, `pctMinNZD=2`. Category strategies: 8 PCT + 2 Fixed Unit Floor + Plywood=NetworkDesign (see Supabase). `fixedUnitFloor` defaults `{orderQtyPercentile:90, maxMultiplier:1.5, maxAdditive:1, minNZD:2, spikeCapMult:5}` — note prod Supabase `params/global.fixedUnitFloor` predates minNZD/spikeCapMult, so the engine reads them via inline `?? 2`/`?? 5` (shallow param-merge drops keys prod lacks).
