# CLAUDE.md — the tabs

**You are reading this because you touched a file under `src/tabs/`.** These are the UI
rules for Stock Health and the Tool Output Download tab: health tags, the location
universe, KPI cards, the PO/TO column sets, the CSV contracts and the freshness gate.

**Tabs are also defined in `src/App.jsx`**, which is 3,921 lines and NOT in this
directory — `ADMIN_TABS` / `PUBLIC_TABS` around line 3760, plus Overview, SKU Detail,
Upload Data, Logic Tweaker and Manual Overrides, which live inline there rather than as
files here. Editing App.jsx does not load this file; read it deliberately.

**Read root `CLAUDE.md` too** (it loads automatically) for the cross-cutting rules — in
particular `saveTeamData` / `BROWSER_OWNED_KEYS`, since several tabs write
`team_data`, and the upload guards.

**Related:** `src/engine/CLAUDE.md` for anything these tabs display;

> ⚠ **TWO TABS WERE RETIRED 2026-09-17 — OOS Simulation and Plywood v2.** `PlywoodNetworkV2Tab.jsx` and
> `src/simWorker.js` are gone, along with `SimulationTab` and its 16 helpers in `App.jsx`. Anything
> below describing them is history. Restore map + why no code was copied: `docs/retired/README.md`.
`supabase/functions/CLAUDE.md` for the syncs that produce stock, PO and TO data.

> ⚠⚠ **A GREEN BUILD IS NOT EVIDENCE THAT JSX RUNS.** esbuild does not resolve undefined
> identifiers, so `npm run build` says nothing about them. Run `npx eslint src/` **and read
> the problem count**, not just a grep of it — a count that moves in a direction the change
> cannot explain means the check measured something other than what you think. Then
> actually load the page. See the Tool Output section.

---

## Stock Health Tab

**Component:** `src/tabs/StockHealthTab.jsx`

**Data sources — stock, PO and TO — are written by the `sync-stock` and `sync-orders` Edge
Functions.** The stored shapes, the Zoho field mappings, the API contracts and every rate
limit are documented in `supabase/functions/CLAUDE.md`, which loads automatically the
moment you open anything under `supabase/functions/`. Read it before touching a sync.

**SKU filtering rules — EVERY ACTIVE SKU GETS A ROW AT EVERY LOCATION (changed 2026-08-07):**
- Only `status = Active` SKUs (from SKU Master). Inactive / Confirmation Pending are ignored.
- `Inventorised At = Supplier` → excluded entirely from all counts and table.
- DC tab: only `Inventorised At = DC` SKUs. DS tabs: both DS + DC inventorised SKUs.
- **NO min/max gate and NO stock-record gate.** Every DS tab shows the same **2,093** rows and the
  DC tab **2,080** (measured 2026-08-07); a missing stock record reads as zero rather than dropping
  the row, so a stock-sync gap cannot silently shrink the table.

**⚠⚠ WHY: A SKU WITH Min=Max=0 THAT STILL HOLDS STOCK IS 100% EXCESS, AND IT USED TO BE INVISIBLE.**
The DS teams build **reverse TOs** (send excess back to the DC) off this table. A SKU stocked
yesterday and zeroed today — demand fell out of the 45-day window, ops marked it Dead Stock, a floor
was removed — was dropped by the old `if (!minMax.min && !minMax.max) return []`, so the units sitting
on the shelf could not be seen or returned. **Measured before the fix: ₹64.0L across DS01–DS06** (828
SKU×DS from targets falling to 0/0, 17 from Dead Stock), plus ₹5.4L on Supplier SKUs which stay
excluded by design.
- **No new tag was needed** — `getHealthTag` already handles both cases, and its branch order is what
  makes this safe: `ecs > max` fires first (so `0/0` + stock → **Excess**), then `ecs === min === max`
  (so `0/0` + empty → **Okay**).
- **Critical and Low Stock counts are STRUCTURALLY unchanged** by this — verified identical before and
  after at all six DSes (DS01 5→5, 271→271). A `0/0` row can never reach the `ecs <= min` branch
  because the two earlier branches catch every zero-target case. Only Excess and Okay grew.
- **"Okay" now means "no action needed", not "healthy stock level"** — it absorbed the 352–691
  not-stocked-and-empty rows per store. Deliberate: a SKU we don't stock and don't hold needs nothing.
- **⚠ `inLocationUniverse(meta, isDC)` is SHARED by `allSkuRows` and `dsSummary`.** They previously
  carried duplicate copies of this filter, which is exactly how the DC tab-bar badge once came to
  over-count Critical against its own KPI card. Keep both readers on the helper.
- **⚠ THE NAV COVERAGE NUMERATOR IS `withTarget`, NOT `total`.** `dsTotals.total` is now 2,093 at
  every store, so the old `total/masterTotal` would read **100% everywhere** and lose the assortment
  signal. `withTarget` counts rows with `min > 0 || max > 0` and reproduces the previous figures
  exactly (DS01 77% · DS02 67% · DS03 72% · DS04 62% · DS05 63% · DS06 64%). KPI cards keep using
  `total`, so their denominator is a uniform 2,093 and their percentages are comparable across stores
  for the first time.
- KPI card percentages use **`pctFine`** (2dp below 1%, 1dp above) — with a 2,093 denominator
  `Math.round` flattened a handful of Critical SKUs to a flat "0%", which reads as "none".

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
- **⚠⚠ Zoho deep-links — TRANSFER ORDERS NEED AN `/inventory` SEGMENT AND PURCHASE ORDERS DO NOT.**
  `ZOHO_INV_URL = https://inventory.zoho.in/app/60075214606#` (the Books org URL is retired), then:
  - TO → **`#/inventory/transferorders/{id}`** · PO → `#/purchaseorders/{id}`
  - **`#/transferorders/{id}` alone 404s.** IMS carried the short form from the 2026-07-06 migration
    until **2026-08-07**, so every TO Ref # link on the DS tabs was dead for a month while the PO
    links beside them worked — which is why nobody spotted it sooner.
  - **⚠ The correct pattern was already known, in the OTHER repo.** `homerun-to/src/createTo.js`
    `zohoToUrl()` has carried it since 2026-07-10, read off a real TO's address bar, **with a test
    pinning it** (`createTo.test.js`). The fix never propagated here. Same shape as the duplicated
    Stock Health filter: two readers of one fact, only one of them corrected. **When a Zoho route is
    verified in either repo, grep the other.**
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

**Sync performance constraints, the cron architecture, rate limits, the token
singleflight, the deployed-function inventory and the log-query recipes** all moved to
`supabase/functions/CLAUDE.md`. They are unchanged — they load when you touch a function
rather than on every session.

---

> ⚠ **`SYNC_GROUPS` mirrors the crons exactly and must keep doing so** — `[["DC","DS01"],["DS02","DS03"],["DS04","DS05"],["DS06","DS07"],["DS08"]]` since 2026-09-25. If
> "Sync Now" and the crons disagree on grouping, whichever runs second stacks Zoho calls on the
> first — the shape of the 2026-07-09 429 storm. Two branches per group is the ceiling; three 429s
> after one group, so **DS08 is its own group** (cron `stock-sync-5`, :47 UTC). A gated store renders
> as a column tagged `okay` at 0/0/0 while `openingDSList` holds it. **DS07 went live 2026-09-22** and is now an
> ordinary trading column — it opened with near-zero stock, so expect it to read short across the
> board until its first TOs land rather than treating that as a data fault.

## Tool Output Download Tab

**Five download cards, no table** (rebuilt 2026-08-03 — commits `9a64dee`, `bf35922`, `f3958a7`;
fifth card added 2026-09-17, `b0473c0`).
The Min/Max table that used to fill this tab is gone: it was virtualised so it cost little to render,
but every number it showed is in SKU Detail, Overview, Stock Health or Manual Overrides, and the tab is
called *Download*. Removing it also retired `outputRows`, `outputScrollTop` and `visibleOutput`.

| card | file | shape |
|---|---|---|
| **PO Team Download** (orange, leftmost) | `PO_Targets_<today>_demand-thru-<date>.csv` | **20 cols** · all master SKUs |
| Tool Output — DS Level | `IMS_Output_DS.csv` | 15 cols · unchanged |
| Tool Output — DC | `IMS_Output_DC.csv` | 5 cols · unchanged |
| SKU Master | `SKU_Master.csv` | **10 cols** · Status normalised · `Purchase`/`Move` after Status |
| **Zero Sale SKUs** (row 2, under PO) | `Zero_Sale_SKUs_L<N>D_<from>_to_<to>.csv` | **9 cols** · 3 buttons (60/75/90 Days) |

### ⚠⚠ The PO column order is a FROZEN CONTRACT
`src/poTargetsCsv.js` — `PO_CSV_HEADERS`:
```
Item Name · Inventorised At · SKU · Category · Brand · Status ·
DC Min · DC Max · DS01 Min · DS01 Max · … · DS06 Min · DS06 Max
```
The PO team's Google Sheet formulas key on column **POSITION**, so reordering or inserting a column
**produces wrong purchase orders, not an error**. Anything added later goes **AFTER `DS06 Max`** — same
rule as the Stock Health CSV's two appended columns. A test asserts the literal 20-column order so a
reorder fails loudly.
- **⚠ Derive indices, never hardcode them.** Inserting `Brand` after `Category` on 2026-08-03 shifted all
  14 numeric columns one right and would have silently desynced both the test file and
  `scripts/verify-po-csv.mjs`, which had positions written in by hand. They now read
  `PO_FIRST_NUMERIC_COL` / a name→index map off the header.
- **Targets only, deliberately** — no stock, no in-transit, no suggested quantity. The sheet owns the
  ordering arithmetic, so the file has **no dependency on stock freshness**.
- **Every master SKU is emitted**, including the ~89 Supplier / non-active rows that read 0/0. That is
  *why* `Inventorised At` and `Status` are columns: they are what let the sheet filter those out, which
  the older files gave no way to do. A stable row set also stops formulas shifting when a SKU is
  deactivated.
- Read-only re-check any time: `npx vite-node scripts/verify-po-csv.mjs` — asserts the header, that
  **every** row has exactly 20 columns (one unescaped comma in an item name would shift that row alone),
  and that the structural zeros hold.

### ⚠ Status is normalised — and four spellings were live
`src/skuStatus.js` `normaliseStatus`, shared by the PO file and the SKU Master CSV so the two can never
disagree. Measured live 2026-08-03, `skuMaster.status` held **four spellings at once**:
`active` 2090 · `inactive` 27 · **`Inactive` 1** · `confirmation_pending` 3. So a sheet formula
`=IF(E2="Active", …)` matched **zero rows** and `="active"` missed one. Output is now
`Active` / `Inactive` / `Confirmation Pending`; a status Zoho adds later arrives readable
(`on_hold` → `On Hold`) rather than raw.
- **✅ USE THE SPELLING TO TELL WHICH WRITER LAST WROTE `skuMaster` — a free diagnostic on a two-writer
  key.** Capitalised (`Active` / `Confirmation Pending`) is `normaliseStatus`, i.e. a **browser CSV
  upload**; lowercase snake_case (`active` / `confirmation_pending`) is **`sync-catalogue`**, i.e. Zoho
  verbatim. Live on 2026-08-29 the master was *entirely* capitalised — 2,306 `Active` / 144 `Inactive` /
  13 `Confirmation Pending` — which said a human upload, not the nightly sync, had written it last.
  ⚠ Harmless to the engine (every filter lowercases and compares to `"active"`), but it makes
  `sync-catalogue`'s change detector report phantom transitions: its `norm()` lowercases without
  folding **space vs underscore**, so `Confirmation Pending` → `confirmation_pending` shows up as 13
  fake `statusChanged` entries until the sync writes once and both sides agree.
- **⚠ NOT for engine logic.** Three call sites still read the raw lowercase value for counting, and the
  engine gates Min/Max on an allowlist of exactly `"active"`. **A display transform must never decide
  whether a SKU gets stocked** — leave those alone.

### Zero Sale SKUs — the delisting shortlist (SHIPPED 2026-09-17, `b0473c0`)
One card, **three buttons** (60 / 75 / 90 Days), each downloading the **Active SKUs that sold nothing,
anywhere** in that trailing window. Logic in **`src/zeroSaleCsv.js`** (28 tests). It is the **fifth child
of the 4-column grid**, so it flows to row 2 column 1 — directly below PO, identical width, **no grid
change**; if you are editing `gridTemplateColumns`, stop. At ship: **L60D 547 · L75D 529 · L90D 517** of
2,396 active SKUs of 2,781 (they move nightly — re-run the script, never quote these).

**⚠⚠ DO NOT WIRE THIS TO `results[sku].meta.t150Tag === "Zero Sale"`.** That value already exists,
already says these exact words, and answers a **different question**: it is computed over
`invSliced = allDatesRaw.slice(-overallPeriod)`, and `overallPeriod` is **45** live — an L45D verdict.
Three buttons reading it emit **three IDENTICAL 45-day files labelled 60/75/90**: every count plausible,
every column right, **nothing fails**. Exactly the `maxBufferPercentile` shape — a coherent-looking value
already in scope that answers a different question than the one asked. The module therefore recomputes
from raw invoice rows and **never imports engine output**.

**⚠ RAW `invoiceData` IS CORRECT HERE — the "pass `attributedInvoice`" rule does NOT apply**, and the
next reader will assume it does. Zero-sale asks *"did this sell ANYWHERE?"*, so the membership test is on
`r.sku` alone and never `r.ds`; `applyAttribution` only ever RELABELS `r.ds`, dropping no rows and
creating none. Raw and attributed are **provably byte-identical** here, so passing attributed rows would
imply a dependency that does not exist. Commented at both sites.

**⚠ A window is `dates.slice(-N)` over the dates PRESENT**, matching `runEngine.js:77` — not a calendar
subtraction, so the card and the engine cannot disagree about what a window is. The two readings coincide
only while the invoice row is contiguous. Hence the **filename carries the RESOLVED range**
(`Zero_Sale_SKUs_L60D_2026-07-19_to_2026-09-16.csv`) instead of asserting a duration — not a comment row
above the header, which breaks paste-into-sheet. And because `RETENTION_DAYS = 90` puts the 90-day button
permanently at the data's edge, **that button disables itself** when fewer dates exist rather than
emitting a short window under a filename claiming 90.

**⚠ `DownloadCard` took ONE button and now takes an optional `actions` prop**
(`[{label,onClick,hint,disabled}]`). Absent ⇒ the original single-button path, so the four older cards are
byte-identically untouched — that was the acceptance bar. **One shared button-style helper serves both
paths**; a separate `MultiDownloadCard` was rejected because it would duplicate the border, accent, blurb,
shape, footnote and disabled styling, and the two would drift the first time anyone restyles a card — the
duplicated-Stock-Health-filter shape. A per-action `disabled` is what lets one window refuse while its
siblings stay live.

**Columns are the SKU Master set MINUS `Top N`** (9): `Item Name · Inventorised At · SKU · Category ·
Status · Purchase · Move · Brand · Price Tag`. `Top N` is absent precisely *because* it is the L45D tag
above. **Nothing is excluded** — Supplier, Dead Stock and DC-only SKUs all stay in, and `Inventorised At`
/ `Status` are what let the sheet filter them. Formatters are the real shared ones (`normaliseStatus`,
`normalisePolicy`, `getPriceTag`). **NOT a frozen contract** unlike `PO_CSV_HEADERS` — pinned by a test
for regression only, with none of the append-only ceremony.

**⚠ `skuMaster` HAS NO CREATED-DATE FIELD**, so a SKU created last week is indistinguishable from one dead
for a year — both read "zero sale in 90 days". The master grew 2,573 → 2,781 between 2026-09-07 and
09-16, so genuinely-new SKUs **are** in these lists. Shipped without a flag by operator decision, and
**surfaced in the card blurb**: a delisting decision made from an unqualified list is the failure mode.

**Oracle: `scripts/adhoc-zero-sale-lists.mjs`** (read-only, `npx vite-node`, writes to gitignored
`validation-out/`). It **now imports the module**, so the two cannot drift — but it deliberately did NOT
while the card was being verified, and the three browser downloads were diffed **byte-identical** against
it as two independent implementations first. **Keep that order:** point a checker at the code it checks
and the diff compares the module to itself while looking exactly as reassuring.

### ⚠ EVERY download is GATED on demand freshness
These files serialise a **client-side engine run from page load**, so a tab left open overnight produces
yesterday's Min/Max in a file that looks entirely normal — and the PO team commits spend from it. On
opening the tab, and on the 5-minute tick that already drives the provenance pills, the newest invoice
date *this tab computed from* is compared against the newest date **published** to Supabase
(`params/invoiceSyncStatus.dates`, taken from the same read that feeds the Invoice Data pill, so gating
costs no extra request). If the page is behind: amber banner naming both dates, a `↻ Reload now` button,
and **every button disabled**. Reload recomputes through the existing load path rather than
re-implementing the engine inside a click handler.
- **⚠⚠ TRI-STATE — `unknown` MUST NEVER BLOCK** (`assessOutputFreshness`, `src/freshness.js`). The two
  failure directions are not symmetric: a stale file is **mildly wrong and correctable**, a download
  blocked at 06:00 IST **stops purchasing for the day**. So capability is removed ONLY on positive
  evidence — both dates present and the published one genuinely newer. A missing status row, slow
  network, malformed date, or a night the sync did not publish all resolve to `unknown`, which downloads
  freely. **Blocking on uncertainty turns a freshness check into an availability risk on the critical
  path.** Seven of the nine tests assert exactly this.
- Consequence to expect: each night between the invoice publish (~04:00 IST) and the engine run (~05:45),
  a tab left open from the previous day shows all downloads disabled until reloaded. That is the feature.
- All of them are gated, not just PO — the DS/DC files are equally stale, and SKU Master embeds engine
  output (`Price Tag`, `Top N`).
- ⚠ **Zero Sale is gated too even though its gate is genuinely WEAKER** — it reads `invoiceData`, not the
  engine's computed targets, so a stale tab degrades more gracefully there. Gated anyway for consistency
  and because one live button under a banner reading "downloads are disabled" reads as a bug. That is an
  argument for keeping the gate (no downside), never for dropping it.

### ⚠ A GREEN BUILD IS NOT EVIDENCE THAT JSX RUNS
Three bugs in the 2026-08-03 rebuild **all passed `npm run build` cleanly** and would each have broken
production:
1. `dlCSV` is defined inside the Upload tab's IIFE — out of scope on this tab, so every card would
   have thrown on click. (Hence the module-level `downloadCsvFile`.)
2. `PO_CSV_HEADERS` was used on a card but never imported — `ReferenceError`, white-screened the tab.
3. `setOutputScrollTop` was still called in `handleTabClick` after the table's state was removed —
   **that throws on every tab click, breaking navigation app-wide.**

esbuild does not resolve undefined identifiers, so `npm run build` says nothing about them. What caught
all three was **`npx eslint src/ | grep no-undef`** plus actually loading the page. Run both before any
frontend push. (Lint baseline `npx eslint src/` is **58 problems** — measured 2026-09-17 AFTER
the OOS Simulation + Plywood v2 tab removal, down from 75; this line has said 68, 75 and 79 at different times, so **re-measure rather than trusting it**.
`scripts/` is clean. Suite was **705 tests** on 2026-09-17.)

- **⚠⚠ AND THE LINT CHECK ITSELF CAN RETURN A FALSE CLEAN — 2026-09-17, a fourth bug of the same
  family.** Adding the Zero Sale card redeclared `const zeroSale`, a name **already** taken in `App.jsx`
  for an unrelated all-time never-sold count feeding the Data Health KPI. That is a **parse error, not a
  lint finding**, and the consequence is worse than the identifier bugs above: **eslint abandons the file
  and reports one problem for the whole of it**, so `| grep no-undef` printed nothing *because nothing
  was analysed*, not because it was clean. Verbatim: `Parsing error: Identifier 'zeroSale' has already
  been declared`. It would have white-screened every user, since the engine recomputes client-side on
  every page load.
  - **The tell was the TOTAL, not the grep: 75 → 23 problems**, an impossible *improvement* for a purely
    additive change. **A check whose result moves in a direction the change cannot explain is measuring
    something other than what you think.** Always read the problem count beside the grep, and treat a
    *drop* as suspicious.
  - `npx eslint src/App.jsx` alone names the parse error immediately; the whole-directory run buries it.
  - **Generalisable beyond lint:** this is the `diag-items` shape again — a tool that inspects the wrong
    thing yields a confident negative. Here the tool was right and the *file selection* silently changed
    what it inspected.

