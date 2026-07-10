# CLAUDE.md — HomeRun IMS

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

---

## Data Model & Key Decisions

- Invoice CSV (Zoho export) replaces entirely on upload — no merge. Engine uses whatever period admin sets.
- All uploads auto-save to Supabase `team_data` immediately.
- Model refresh: upload → Apply & Re-run Model → results pushed to Supabase → all users see new Min/Max.
- Stock Health: synced hourly via two separate Edge Functions:
  - `sync-stock`: stock only (inventorysummary). Parameterised by branch pair — called by 3 staggered cron jobs. Writes `stockData` + `stockDataAccounting` via branch-level deep merge (not full replace — other functions' branch data must be preserved). Uses `stockUploadedAtPerDS` for cooldown.
  - `sync-orders`: PO + TO only. Single cron at :35 UTC. Writes `poData`, `toData`, `_poCache`, `_toCache`, `_transferredTodayCache`, `ordersUploadedAt` (its own cooldown key).
  - Both functions do a **fresh read immediately before writing** to prevent race condition from parallel runs.
  - Sync functions only read/write `team_data/global`. They never touch `team_data/invoice_data`.
- **team_data row separation:** `invoiceData` lives in `team_data/invoice_data` (written once on CSV upload). All other app data + sync data lives in `team_data/global`. This keeps the global payload ~1-2MB vs ~7MB, preventing Supabase Disk IO budget exhaustion from hourly syncs.
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
| **Fixed Unit Floor** | Wires/MCB, Overhead Tanks | P90 of individual order quantities |
| **Network Design** | Plywood/MDF (opt-in) | Brand-level stocking — see below |

PCT key decisions: percentile by price (Premium=75, High=80, Medium=85, Low/Super Low/No Price=95); cover days by movement (Super Fast/Fast=2, others=1); DOC cap guards (pctDocCap=30D Premium/High, pctDocCapLow=60D others).

### DC Calculation (non-Network-Design)
- **Standard:** `DC Min = ceil(sumDailyAvg × (leadTime+1))` · `DC Max = DC Min + ceil(sumDailyAvg × 2)`
- **Floored SKUs:** `Σ DS Mins × 0.2` / `Σ DS Maxes × 0.3`
- **Dead Stock:** Min=Max=0 at all DS and DC locations (overrides all floors)

Post-blend order (strict): New DS Floor → SKU Floor Override → Dead Stock cap → Rounding → **DS Seed** → **Inventorised-At normalization**

**New DS Floor blend is per-field max (changed 2026-07-06):** when the floor beats the strategy Min, Min = floor but Max keeps the strategy's value when higher (`max(strategyMax, floor)`). Previously the floor clobbered both (Min=Max=floor), discarding demand-informed Max headroom. Applies to every DS in `newDSList`.

### DS Seed — new store bootstrap (`src/engine/dsSeed.js`)
Seeds a new DS's Min/Max from the **equal-weight average of source DSes** — built for DS06 Kogilu, whose catchment carves ~50% of orders each from DS02 and DS04. Config: `params.dsSeed = { DS06: ["DS02","DS04"] }` (Logic Tweaker → "DS Seed — New Store Bootstrap" checkbox; empty object = inactive; removing the entry is the sunset switch once DS06 has ~45 days of organic history).
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

- Trading: 8 AM–8 PM. End of day: closing stock ≤ Min → restock to Max overnight from DC.
- ~Midnight: TOs raised DC→DS. ~Noon next day: TOs arrive at DS.
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

**Zoho Inventory location IDs (org 60075214606, confirmed 2026-07-06):**
`DC=3915979000000118466`, `DS01=3915979000000054002`, `DS02=3915979000000054017`, `DS03=3915979000000054032`, `DS04=3915979000000054047`, `DS05=3915979000000054062`, `DS06=3915979000000118484`

**DS06 Kogilu (go-live ~2026-07-08):** sync layer is DS06-aware (stock/PO/TO data accumulates in Supabase). **Phase 2 built on `feature/ds06-seed` (2026-07-06, unmerged):** `DS_LIST` includes DS06 (Stock Health tab/KPIs/DC ROS/DS Req Covered follow automatically; 6th `DS_COLORS` entry added) + engine **DS Seed pass** gives DS06 Min/Max = avg(DS02, DS04) — see the DS Seed section. On activation, admin ticks "Seed DS06" in Logic Tweaker (and optionally adds DS06 to `newDSList` for the floor) + Apply. Plywood tab (v1) is DS06-aware (filter button, matrix editor column, DS_DEFAULTS entry) — **at go-live, also add DS06 to each brand's matrix (self-covers) via the tab's config editor**: nodes compute 0 until Kogilu demand exists, the seed wins meanwhile, and organic node values take over as demand builds — this is what lets the plywood seed sunset (network strategy ignores DSes not in the matrix). Review later: local `DS_LIST` copies in `simWorker.js`/`BasketAnalysisTab.jsx`, cluster assignment.

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
- Each stock cron passes `{"branches":["DC","DS01"]}` in pg_net body; sync-stock reads this and fetches only those branches.
- **Branch-level merge:** sync-stock merges `stockData[sku][ds]` at branch level on write — never replaces the full stockData object (would wipe sibling functions' branch data).
- **Status codes:** 546 = Supabase killed the function (wall clock timeout); 500 = function caught an error and returned cleanly.
- **Rate limit recovery:** after 429 abuse, recovery takes 60+ min. Never rapid-deploy or trigger repeated manual syncs.
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

**Hook in this repo (branch `feature/to-tool`):** `applyAndRun` in `App.jsx` serializes the DC-inv Active
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
- Picking pill: yellow (matching Pending Approval colour).

### 9. DC Stock indicator in DS tabs ✅ Shipped (2026-05-21)
DC Stock column added between Req Qty and Rep. Qty on DS tabs. Shows DC SoH for DC-inv SKUs, follows mode toggle, hidden on DC tab.

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

Key non-defaults: `overallPeriod=45`, `newDSFloorTopN=250`, `newDSList=["DS04","DS05","DS03"]`, `brandLeadTimeDays={_default:3,AsianPaints:4}`, `pctDocCap=30`, `pctDocCapLow=60`, `pctMinNZD=2`. Category strategies: 8 PCT + 2 Fixed Unit Floor + Plywood=NetworkDesign (see Supabase).
