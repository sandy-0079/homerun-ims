# CLAUDE.md — Edge Functions, Zoho & the nightly sync chain

**You are reading this because you touched a file under `supabase/functions/`.** That is
deliberate: this is the sync architecture, the measured Zoho API contracts, the rate
limits, and the incident record behind every guard in these functions. It used to sit in
root `CLAUDE.md`, which meant it loaded on every session whether or not anyone was going
near a sync. Now it loads exactly when it is relevant — but everything in it is as
load-bearing as it was, and most of the ⚠ marks are real production failures.

**Root `CLAUDE.md` still holds** the cross-cutting rules that can hurt you from anywhere:
the `team_data` row separation, `saveTeamData` / `BROWSER_OWNED_KEYS`, the params-row
rule, and validate-at-the-boundary. Read it too — it loads automatically.

**Related:** the Stock Health tab's own UI rules (health tags, columns, KPI pills) live in
`src/tabs/CLAUDE.md`; engine behaviour lives in `src/engine/CLAUDE.md`.

> ⚠ **ALWAYS NAME THE FUNCTION: `supabase functions deploy <name>`.** A bare
> `supabase functions deploy` redeploys **all seven** with whatever `_shared/*` is on
> disk. This is the single real hazard in working here.

---

## Data sources — what each sync writes

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
  - **⚠⚠ `assessMasterChange` MEASURES the active share and DELIBERATELY DOES NOT BLOCK ON IT
    (changed 2026-08-29, commit `e599d1f`). It blocked from 2026-07-29 to 2026-08-29 —
    `reason: "active_share_shift"` — and that reason can no longer occur.** It was added because a
    pull flipping SKUs to inactive changes *neither* the `inventorisedAt` mix nor the row count, so it
    passed every other check while zeroing their Min/Max.
    - **Why it was reversed: ops uses Zoho's `status` as a TEMPORARY OPERATIONAL LEVER, not a stable
      statement about whether we stock something.** On 2026-08-28 they deactivated **334 SKUs** and
      re-activated them the same day, because **Zoho will not transact an inactive item and the DC team
      could not raise TOs**. Active share moved **93.55% → 79.70%, a 13.85pp swing against the 5pp
      `CHANGE_LIMIT_PCT`**; all five slots refused, the catalogue went stale, and nothing self-healed
      until ops reverted by hand. A bulk flip of that size is routine here, so a threshold treating it
      as an emergency is a threshold that blocks normal work.
    - **⚠ THE COST WAS ACCEPTED KNOWINGLY, not overlooked.** A transient flip now reaches targets the
      same night. Measured on the 25 SKUs that had been recorded: **23 moved, 161 SKU×DS cells zeroed**,
      ~2,150 extrapolated to the full 334 — which then reverse the next night.
    - **⚠ INV VALUE CANNOT DETECT THIS.** All 25 were **unpriced**, so the rupee figure moved **₹0.00
      while 161 cells went to zero**. Watch the cell count and `statusChanged`, never the money. An
      unpriced SKU is *also* stocked at the 95th percentile under PCT, so it is the worst case to miss.
    - **The rejected alternative, recorded so it is a decision and not an oversight: HYSTERESIS** —
      apply a deactivation only after N consecutive nights, apply a re-activation **immediately**
      (asymmetric, because that is the direction that broke TOs). It absorbs a same-day reversal with
      **zero** downstream movement, and it is the better design if the whipsaw ever bites. The
      discriminator it exploits is the real one: **not magnitude, but persistence** — 334 in a day looks
      identical whether it is a real discontinuation or a same-day flip, and only elapsed time separates
      them. Rejected for now as more machinery than "Zoho owns status" taken literally.
    - **⚠ The `inventorisedAt` guard is UNCHANGED and must stay.** Supplier zeroes Min/Max at every
      location including the DC, DS zeroes the DC — and unlike `status`, nobody flips those as a daily
      lever, so a mass move there is always a mistake or a bad pull. Pinned by a test.
    - Live active share is **93.6%** (2,306 of 2,463, 2026-08-29), not the ~99.8% this line used to
      claim — the inactive tail has grown and the old figure would make any share-based reasoning wrong.
- `reports/purchasesbyitem` **does** exist on `/inventory/v1/`. `average_price` is Zoho-computed over
  the requested window — not something we derive.
- **⚠ PRICES MUST MERGE, NEVER REPLACE.** That report only sees purchases made in *this* org, i.e.
  since 2026-07-01 — not the 12-month window requested. Measured: **1,477 priced from Zoho vs 1,822
  stored.** A replace would push 345 SKUs to "No Price", which PCT reads as the 95th percentile, so
  they'd be stocked MORE aggressively. `mergePrices` keeps the stored value where Zoho is silent
  (verified live: 1,822 → 1,834, 357 retained, 0 lost). Coverage self-heals as the org ages.
- **✅ `cf_inventorised_at` NOW EXISTS AND IS POPULATED IN ZOHO (verified 2026-07-29).** Superseding the
  earlier warning that it did not exist. Dry-run measured: **`invAtFromZoho` 2,092, `invAtFromStored` 0,
  and ZERO per-SKU reclassification** — Zoho's values match the hand-maintained master exactly
  (DC 2,021 / Supplier 58 / DS 13). The migration the fallback logic was built for turned out to be a
  no-op, which is the ideal outcome.
  - Only `HQ2B4` (newest SKU) lacks a value and defaults to DC — reported as
    `master.newSkusDefaulted`. Set it in Zoho.
  - **⚠ NEW EXPOSURE: Zoho now owns the highest-consequence field in the master** (Supplier ⇒ Min=Max=0
    at every location; DS ⇒ DC zeroed). The stored value is no longer a safety net. `assessMasterChange`
    guards a >5% shift in the mix — which catches a mass change but **not a handful**: setting ~20 SKUs
    to Supplier in Zoho is ~1%, passes the guard, and silently zeroes those SKUs everywhere.
  - So the nightly check is `invAtChanged` in `params/catalogueSyncStatus` — it reports per-SKU
    transitions and lists **every** SKU becoming Supplier in full (`invAtChanged.toSupplier`). The
    distribution alone can hide a swap: 58 SKUs leaving Supplier while 58 others join nets to zero.
  - Still true: a missing value falls back to the stored one, then to DC, with the SKU reported.

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
`DC=3915979000000118466`, `DS01=3915979000000054002`, `DS02=3915979000000054017`, `DS03=3915979000000054032`, `DS04=3915979000000054047`, `DS05=3915979000000054062`, `DS06=3915979000000118484`, **`DS07=3915979000030598119` (HAL)**, **`DS08=3915979000030600296` (Rajajinagar)**

**DS07 HAL + DS08 Rajajinagar (wired 2026-09-18; all four functions DEPLOYED 2026-09-19; DS07 LIVE
2026-09-22, DS08 still gated):** both exist in Zoho named
prefix-first, so `invoiceMap.ts`'s `dsOf()` attributes their invoices with no code change, and
`sync-orders`' name-keyed `LOCATION_TO_DS` carries the strings **verbatim** — one wrong character
silently drops every PO and TO for that store rather than erroring. Both are in `sync-stock` and
`create-to` BRANCHES. The engine held both at 0/0 via `openingDSList`; **DS08 alone is still held
there**. **`stock-sync-4` now carries `DS06,DS07`** (migration `20260918000001`): that slot was the
only single-branch group, so this restores parity rather than adding load, where a 5th cron would
have cost ~1,200 Zoho requests/day for a store holding no stock.
- **⚠⚠ DS08 MUST NOT JOIN THAT GROUP.** Three branches in one invocation is measured unsafe — 6
  concurrent chains 429 after a single group. It is in BRANCHES so it can be pulled by hand
  (`{"branches":["DS08"]}`) to verify its id, but nothing calls it on a schedule. See Open Work 39.
- **⚠ `sync-sku-floors`' duplicated `DS_LIST` gained both**, and the ORDER matters: an unrecognised
  DS column is a hard stop, so DS07/DS08 columns had to reach the floor sheet only AFTER that deploy.
  Sheet-first fails the nightly sync with `unknown_ds` and leaves the previous floors live. **Done in
  the right order: deploy 2026-09-19 ~10:10 IST, columns added later that day.** Keep the rule for
  the next store.
- **✅ `create-to`'s Zoho write to a new branch is proven for DS07, NOT yet for DS08.** `DS_ONLY` and
  `BRANCHES` carry both, and the TO tool offers a store automatically (`dsListFromTargets` reads
  `toTargets`, no deploy needed). DS07's first TO was **TO-06515, 2026-09-22 16:20 IST** (805
  lines, one POST, accepted); the 14:30 run that day covered DS01–DS06 only. For DS08: a rejected
  `to_location_id` returns **400** (validation layer, nothing created), and ⚠ `dryRun:true` does NOT
  test it — it returns before the POST. Test-fire a 1-line draft and delete it.
- **⚠ A draft TO is a pick list, not a commitment — overlapping drafts to one store are NORMAL.**
  `create-to` only ever makes drafts. The DC picks what it can and dispatches that as its own
  `in_transit` TO; whatever wasn't picked comes back in the next run's draft. DS07 on 2026-09-22 had
  two open drafts sharing 766 lines alongside three in-transit TOs. **That is not double-requesting**:
  don't total drafts against Max, and don't suggest deleting one. Stock only moves via `in_transit`.
- **⚠ A new store's first TO is enormous, because parity restock sees an empty store.** `Req = Max −
  CS DS − In Transit` with stock at zero means every SKU triggers at full Max. Measured for DS07 on
  2026-09-22: **963 SKUs / 14,731 units requested, 811 lines / 10,978 units allocated in ONE POST** —
  `buildLines` does not chunk. The existing six lost only 212 units (−5.9%) to the proportional
  split, so the squeeze is mild; the size is the thing to watch. TO-00892 has gone through at 514
  lines, so there is headroom, but note `create-to` never retries a 5xx/timeout (a TO may exist), so
  a timeout at this size means checking Zoho by hand.

**DS06 Kogilu (go-live ~2026-07-08):** sync layer is DS06-aware (stock/PO/TO data accumulates in Supabase). **Phase 2 (2026-07-06, now in `main`):** `DS_LIST` includes DS06 (Stock Health tab/KPIs/DC ROS/DS Req Covered follow automatically; 6th `DS_COLORS` entry added) + engine **DS Seed pass** gives DS06 Min/Max = avg(DS02, DS04) — see the DS Seed section. Both go-live steps are **done**: DS06 is in `newDSList`, and DS06 is in all four plywood brand matrices. **The DS Seed was sunset 2026-07-31** once pincode attribution gave DS06 a full 45-day catchment history — see the DS Seed section for the measurement and the reasoning. Review later: cluster assignment.


---

## Sync performance, rate limits & the cron architecture

**Sync performance constraints (150s Supabase Edge Function wall time):**
- `inventorysummary` report: ~18–56s/call depending on Zoho health — dominant cost.
- **Zoho inventorysummary rate limit: ~8 calls/minute** (confirmed 2026-05-22; re-confirmed on the Inventory API 2026-07-06 — 10 calls in ~2 min → 429). 4 concurrent (2 branches × 2 modes) → 429 after 2 groups; 6 concurrent (3 branches) → 429 after 1 group. Safe: max 4 calls per invocation.
  - **⚠⚠ THAT "8/MIN" COUNTS FETCH CHAINS, NOT HTTP REQUESTS — CORRECTED 2026-09-11.** `fetchBranchStock`
    **paginates** (`per_page=200`, `while(true)` until `has_more_page`), so one "call" above is ~14
    requests at today's ~2,700 SKUs. A 2-branch invocation = 4 chains ≈ **50–56 real requests**, not 4.
    Measured live: DC+DS01 = 2,704 SKUs in **31.8s ≈ 100–105 requests/min** — a running group sits
    **AT Zoho's documented 100 req/min/org ceiling**, not at 8/min. Nothing here is undocumented; we
    were miscounting by ~13×, and the 2026-07-09 storm (12 "calls" in 15s ≈ 150+ real req/min) fits
    the documented limit exactly.
  - **Consequences.** (1) The 3-min cron stagger is NOT padding — it holds the duty cycle near 35%;
    overlapping two groups ≈ 200 req/min, i.e. the 2026-07-09 storm. **Do not compress the cron
    cycle**, and never read "8/min" as headroom. (2) Real volume is **~180 req/cycle ≈ 4,400/day**
    from stock sync alone — budget any new caller against that, not against 14/cycle.
  - **The highest-leverage lever is `per_page`, not spacing or cooldown.** If the report accepts
    >200, ~14 pages becomes ~3 and both the burst rate and the ~4,400/day fall ~4×. **Untested** —
    settle this before touching cron spacing or `COOLDOWN_MINS`.
- **Zoho OAuth token-endpoint throttle (distinct from the inventory-API limit above):** `accounts.zoho.in/oauth/v2/token` throttles *access-token generation* from the refresh token — `{"error":"Access Denied","error_description":"You have made too many requests continuously"}`. On 2026-07-14 this failed stock-sync-1 + stock-sync-2 (DC/DS01/DS02/DS03 missed a cycle) at the auth step, *before* any inventory/Supabase call; stock-sync-3/4 recovered ~3 min later. Root cause: every function minted a fresh token per invocation (~5-10/hr across 4 stock crons + orders + on-demand create-to). **Fix (2026-07-15):** shared `supabase/functions/_shared/zohoToken.ts` `getZohoToken(supabase)` caches the token in `public.zoho_auth_cache` (RLS ON, no policies → service-role only; NOT in `params`, which anon can read) and reuses it until ~10 min before expiry. Cuts token calls to ~1/hr; raising a TO now logs `zoho token: cache hit` and costs zero token calls, so it can't starve the crons. FAIL-SAFE: any cache miss/read/write error → fresh refresh (pre-cache behaviour). Hot path only (sync-stock, sync-orders, create-to); the `zoho-invoices/prices/skumaster` importers still mint per-call. Logs `zoho token: refreshed` / `cache hit`.
  - **⚠ KNOWN-BENIGN, DO NOT TREAT AS AN INCIDENT: nightly `401 → force-refresh` bursts, in groups of
    exactly FOUR.** Measured 2026-08-05 (and present on the 08-03 night, so not new): **11 events in one
    night** — `00:35 ×1`, `01:05 ×4`, `01:55 ×4`, `02:14 ×2` — each logging
    `zoho: 401 — force-refreshing token and retrying once` immediately followed by
    `zoho token: force-refreshed (after 401)`. **Every one self-healed on the retry; zero 429s, zero
    non-200 responses, no data effect.** This is the FAIL-SAFE working, not a fault.
  - **The group-of-4 shape is the diagnostic:** it is `CONCURRENCY 4` workers hitting the same expired
    cached token simultaneously, so **four mint a replacement where one would do**. That is the only
    pattern in the system that multiplies token-endpoint volume — the same endpoint behind the
    2026-07-14 throttle above — but 11 mints/night is nowhere near the ~5-10/hr sustained rate that
    caused it. **Not worth a deploy on its own** (piggyback rule). If it ever needs fixing, the lever is
    the cache's ~10-min pre-expiry margin or single-flighting the refresh, not the retry.
  - **🚀 ESCALATED, THEN FIXED 2026-09-11 — the benign ×4 became a fatal "4 chains, 4 mints".** Each of
    the 4 concurrent branch-fetch chains force-refreshes independently on a dead token, and each extra
    mint evicts a sibling's still-live token (Zoho caps concurrent access tokens per refresh token) →
    **self-sustaining**. 2026-09-11 08:38:01 UTC (stock-sync-2): `4 × 401 — force-refreshing` → `Zoho
    auth failed: "You have made too many requests continuously"` → **HTTP 500, DS02+DS03 lost that
    cycle**. Recurring daily (5.6% 5xx over 3h). Likely also the answer to the long-open "why do tokens
    die before expiry" question — **we were our own other consumer**, not a third-party app.
    - **⚠⚠ CORRECTED 2026-09-12: THE "×16 IN ONE BURST" FIGURE WAS NEVER MEASURED.** It was `36 − 20`
      subtracted across a 10.9h window and attributed to a single burst. Grouped by timestamp,
      **every** pre-fix burst was exactly **4 × 401** — 08:38:01 included — and the 16 is **4 failed
      bursts × 4** (06:35, 06:38, 08:35, 08:38 UTC). Arithmetic closes both ways: pre-fix
      `36 = 20 mints + 16 unresolved`, post-fix `35 = 12 mints + 15 joins + 8 unresolved`.
      **So `reminted` being PER PAGE does NOT produce a per-page stampede** — the guard holds within a
      chain, and a dead token costs one 401 per *concurrent chain* (4), never ~14 per page. The
      amplification removed is **4×, not 16×**; still worth having (mints per dead token 4 → 1).
      **Generalisable: two window totals subtracted is not a burst measurement — group by timestamp
      before claiming a shape.**
  - **Fix = the singleflight this entry predicted.** `mintOnce` in `zohoToken.ts`: concurrent callers
    join one in-flight promise and all get the same token; the cache write-back moved inside it (N
    upserts → 1). The slot is cleared on **rejection as well as resolution** — module state outlives a
    request in a warm isolate, so a retained failed mint would be replayed to every later caller there.
    New log line **`zoho token: joined in-flight mint`** = the fix engaging; its absence plus no 500s
    also means healthy.
  - **⚠ DELIBERATELY NOT ADDED: a cache re-read before a forced mint.** That would regress 2026-07-15
    (`aae5e85`), whose whole lesson is that **`isTokenFresh` is unreliable** — a token can pass the
    expiry check and already be revoked. A forced caller must ALWAYS mint. The singleflight changes only
    HOW MANY callers mint, never WHETHER a forced one does. If you ever add the re-read, key it on token
    **identity** ("is this a different token from the one that just 401'd?"), never on freshness.
  - **Deployed `sync-stock` ONLY (v39 → v40).** `create-to` stays **v13**, `sync-orders` **v8** — edge
    functions bundle their imports at deploy time, so the TO-creation path runs **byte-identical** code
    and needed no re-verification. `create-to` also pages **sequentially** (`create-to/index.ts:97-112`),
    concurrency 1, so it never had the stampede. 7 new tests in `zohoToken.test.ts` (677 total green);
    `getZohoToken` gained an optional 3rd arg `{refresh}` for injection — existing callers unchanged.
- **⚠ ZOHO GOES DOWN ORG-WIDE, AND A FUNCTION CAN BE A VICTIM RATHER THAN A CAUSE — TWICE NOW,
  2026-07-29 and 2026-07-30.** First occurrence: between **17:35–18:30 UTC every Zoho consumer failed
  identically** with
  `Zoho API: 429 after 3 attempts` from `zohoFetchWithRetry` — all four stock syncs, orders-sync, and
  `sync-catalogue`'s first-ever real run — and all recovered at 18:35. Ruled out: our own call volume
  (the day was clean; last burst `create-to` ×20 at 15:45 UTC, ~1h50m earlier), a recurring nightly
  Zoho window (same window on 07-26/27/28: **0 non-200 of 15/18/33** invocations), and the token cache
  (`zoho token: cache hit` throughout). Trigger external and not reproducible from our logs.
  - **⚠ DO NOT "FIX" THIS BY SPLITTING THE WORK.** `sync-invoices` was *causing* its own 429s — 8
    concurrent workers, backoff sleeping ~960 worker-seconds past the 150s wall clock — so chunking cut
    instantaneous pressure. `sync-catalogue` is ~30 calls, **sequential (concurrency 1)**, ~16s, and
    **died on page 1 having consumed nothing.** Same symptom, opposite cause: when you trip the limit
    yourself, reduce concurrency; when you walk into someone else's penalty, **retry later in time**.
  - So the durable defence is **more slots spread wider than a plausible outage**, plus recording the
    failure so it is visible. Diagnostic that distinguishes the two: did it die on the first call?
  - **SECOND OCCURRENCE, 2026-07-30, ~15:41–16:30 UTC (~50 min).** Killed `stock-sync-3` (DS04+DS05)
    at 15:41, `stock-sync-4` (DS06) at 15:44, `orders-sync` at 15:50, and a browser-triggered TO-tool
    stock pull at 16:28. All recovered 16:41–16:53. **Zero 429s in the other 12 hours of that day.**
    - **⚠ THE DECISIVE EVIDENCE IS CROSS-BUCKET: two DIFFERENT rate-limit buckets failed inside ten
      minutes.** 15:41/15:44 were `inventorysummary`; **15:50 was `sync-orders`**, i.e.
      `/purchaseorders` + `/transferorders` — a *separate* bucket (see the rate-limit notes above). So
      it was **not** our inventorysummary pacing, which is the whole thing the 4-cron stagger exists to
      manage, and which was demonstrably working. Something above the endpoint level shed our requests.
      **Check the buckets before blaming the stagger.**
    - Four self-inflicted hypotheses ruled out, measured: **(1)** load was metronomic — 11:00–15:44 is
      exactly 4 cron pulls/hour on `:35 :38 :41 :44`, **0 off-schedule pulls**, and the 8 calls in the
      6 min before the failure ≈ 1.3/min against a ~8/min limit; **(2)** no `create-to` burst — 12 TOs
      all day, 6 at 08:55–08:59 and 6 at 16:44–16:57, i.e. **nothing between 09:00 and 16:44**, the
      second burst landing *after* the window closed; **(3)** no browser Sync Now / TO pull before
      15:41; **(4)** not org quota — ~3k calls/day against `x-rate-limit-limit: 57500` per ~8.4h ≈ 5%.
      It **died on the first call** (`429 attempt 1/3` at 15:41:01) — the diagnostic above — so:
      someone else's penalty.
    - **Ops impact was near zero and that is the point.** Each branch pair missed exactly one cycle
      (DS04/DS05 + DS06 ~2h stale at worst; DC/DS01 77 min, DS02/DS03 75 min; PO/TO ~2h). The TO team
      saw the staleness, repulled, raised TOs, ops resumed. Everything self-healed within the hour.
    - **⚠ WHY WE STILL CANNOT NAME THE CAUSE — and the deliberate decision (2026-07-31) NOT to fix
      it.** `zohoFetchWithRetry` logs only the attempt number: it never reads `res.headers`
      (`x-rate-limit-remaining`, `Retry-After`) nor the 429 **body** (`{code, message}`, which is what
      distinguishes a per-minute throttle from quota exhaustion from a concurrency cap), and
      `throw new Error("Zoho API: 429 after N attempts")` carries none of it. Instrumenting it was
      considered and **rejected**: `_shared/zohoClient.ts` is the path for **all five** functions, the
      body-consumption hazard lands exactly on the `retry429: false` branch that **only `create-to`**
      uses (the live DC TO-raising write path), and the payoff is diagnostic-only on an event ops
      absorbs with a repull. **Get the diagnosis instead from ONE read-only local call DURING the next
      window** — they last ~50 min, which is ample, and it needs no deploy and bundles nothing.
    - **Generalisable: piggyback observability on a deploy you are already making for a substantive
      reason; never deploy solely for observability.** The risk is the redeploy, not the diff —
      `supabase functions deploy X` bundles whatever `_shared/*` is on disk, so a one-line log change
      also ships the current local `_shared/` to prod, and checking for that drift means
      `functions download`, which itself overwrites `_shared/*`. A **new** function gets its own
      bundle, so adding one cannot disturb the five that are running.
    - **Two occurrences in two days, both in the 15:40–18:30 UTC band. Not yet a pattern — a THIRD
      makes it one**, at which point revisit the "no recurring nightly Zoho window" conclusion above
      (which rests on 07-26/27/28 being clean).
- **Architecture:** 4 staggered stock crons (3 branch pairs + DS06; ≤4 concurrent calls, never overlaps)
  + orders + 2 catalogue + the invoice window + 2 floors + 2 engine + the digest. **11 jobs, no two
  sharing a minute WITHIN THE SAME HOUR** (the floors, engine and digest slots reuse free minutes at
  hours 23, 00 and 01) — verify with
  `select jobname, schedule from cron.job order by jobname;`:
  - `stock-sync-1` at `:35 UTC` (:05 IST) → DC + DS01
  - `stock-sync-2` at `:38 UTC` (:08 IST) → DS02 + DS03
  - `stock-sync-3` at `:41 UTC` (:11 IST) → DS04 + DS05
  - `stock-sync-4` at `:44 UTC` (:14 IST) → DS06 (2 calls)
  - `orders-sync-hourly` at `:50 UTC` (:20 IST) → PO + TO (different Zoho endpoints, separate rate limit bucket). Moved from :35 on 2026-07-08 (migration `20260708000001`) — at :35 it collided with stock-sync-1's `team_data/global` write (statement timeout left DC+DS01 74m stale).
  - `catalogue-sync-earlier` at `25,55 16,17 * * *` UTC + `catalogue-sync-nightly` at `25 18 * * *`
    → five attempts, 21:55–23:55 IST (migrations `20260730000001` + `20260729000002`)
  - `invoices-sync-window` at `5,15,25 19-22 * * *` UTC → 00:35–03:55 IST, **twelve slots**
    (widened from eight on 2026-08-04, migration `20260804000002`, via `cron.alter_job` so the
    POST command could not be disturbed — verified by md5). **Proven on its first night, 2026-08-05:**
    12 firings → 12 `booted` → 12 edge rows, zero 429s, publish at **01:55:10 IST** vs 02:50 on eight
    slots. The 55-min gain is **schedule arithmetic, not lighter volume** — both nights needed the same
    6 working chunks, and `:35,:45,:55` avoids the 45-min wait that `:35,:50` forced to the next hour.
    Steady state: **6 working invocations (8.8–21.0s) then 6 no-ops (~0.8s)** returning
    `already_published`.
  - **`sku-floors-sync` at `5,55 23 * * *` UTC → 04:35 + 05:25 IST** (migration `20260731000001`) →
    the ops Google Sheet into `newSKUQty`. Body **MUST** carry `{"dryRun": false}`.
  - **`engine-run-nightly` at `15,45 0 * * *` UTC → 05:45 + 06:15 IST** (migration `20260731000002`) →
    POSTs the **Vercel** endpoint `/api/run-engine`, which recomputes the engine and writes
    `params/toTargets`. Body **MUST** carry `{"mode":"live"}`. See Stage 6.
    ⚠ **BOTH slots run — there is no once-per-night gate — so the SECOND one's stamp is what you see.**
    A chip or footer reading `05:45` means the 06:15 run failed. Steady state is **06:15**.
  - **`nightly-digest` at `0 1 * * *` UTC → 06:30 IST** (migration `20260804000001`) → one email
    reporting whether the chain worked. **After** the engine's second slot, an hour before ops POs at
    ~07:30 IST. `:00` is free and hour 01 UTC carries nothing else. See item 17 in the changelog.
  - **⚠ THE TWO NIGHTLY ADDITIONS ARE 50 MINUTES APART FOR A REASON, and it is not the Zoho limit.**
    `COOLDOWN_MS` (15 min) is stamped on FAILURE too, so a retry slot closer than that is silently
    refused. Measured against the real `shouldRun`: `23:05 fails → 23:20 retry` = **run=FALSE, wait
    3s** — three seconds short, and indistinguishable from "the retry never fired". Any slot added to
    either job must clear 15 minutes from the END of the previous run.
  - **⚠ These are the first slots that fall AFTER midnight IST.** Safe only because `syncNightKey`
    shifts 3h before taking the IST date — verified: `23:05Z` and `23:55Z` both key to the *same*
    night. Re-read it before adding any further post-midnight slot.
  - **Full nightly order:** catalogue 21:55–23:55 → invoices 00:35–04:00 → floors 04:35/05:25 →
    engine 05:45/06:15 → **digest 06:30** → ops POs ~07:30 IST. (An earlier note here said POs start
    ~06:00; the operator confirmed 2026-08-04 that 06:00 was their own buffer and the real start is
    ~07:30.)
  - **Free minutes each hour: `:00–:34` and `:51–:59`.** `:35 :38 :41 :44` and `:50` are taken, and
    `:50` in particular writes `team_data/global`.
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
  window to attribute logs per invocation. ⚠ **An `order by timestamp asc limit 1000` that HITS the cap
  truncates the END of the window silently** — a missing log line can be the cap, not a missing event.
  Prefer a `where event_message like '%429%'`-style filtered query when counting, so "zero" means zero.
  - **⚠⚠ "DID THE CRON FIRE?" NEEDS BOTH LOG TABLES, AND THEY ANSWER DIFFERENT HALVES. `booted` in
    `function_logs` COUNTS invocations; `function_edge_logs` CLASSIFIES them — and only the first is
    complete.** An earlier version of this note said "use `function_edge_logs`, **not**
    `function_logs`", which is wrong in the one case you reach for it.
    - **HOW MANY TIMES DID IT RUN → `function_logs where event_message like 'booted%'`.** One line per
      invocation, cheap to count, and it has never been observed to drop one.
    - **DID IT WORK OR SKIP → `function_edge_logs.execution_time_ms`.** The duration alone separates the
      cases. Measured 07-30: `sync-stock` **1176ms / 1139ms** at 16:35/16:38 = fired-and-skipped, vs
      **14425ms / 12085ms** at 16:41/16:44 = fired-and-did-the-work; `sync-catalogue` skips are
      ~**810ms**. Measured 08-05 on `sync-invoices`: working chunks **8.8–21.0s**, `already_published`
      no-ops **0.72–0.88s**.
      ```sql
      select timestamp, req.url, resp.status_code, m.execution_time_ms from function_edge_logs
      cross join unnest(metadata) as m cross join unnest(m.request) as req
      cross join unnest(m.response) as resp order by timestamp asc
      ```
    - **⚠ `function_edge_logs` SILENTLY DROPS ROWS — a missing row is NOT evidence the cron did not
      fire. Proven 2026-08-05.** On the night of 08-03 the cron fired 8 times (`cron.job_run_details`
      all `succeeded`) but only **7** rows existed for `sync-invoices` in `function_edge_logs`; `01:35`
      was absent. Re-queried two days later it was **still** absent, so not ingestion lag. Two
      candidate artefacts were ruled out before blaming the table: the triple-`unnest` above drops any
      row whose `response` array is empty (a request-only unnest still returned 7), and the 1000-row
      cap was nowhere near. `function_logs` settled it — `booted (time: 33ms)` at `01:35:00` followed
      by real Zoho work. **8 firings → 8 `booted` → 7 edge rows.** The next night, on 12 slots, all
      three agreed: **12 = 12 = 12.**
    - Why the older note preferred the edge table anyway, still true: **the skip paths log NOTHING**.
      `sync-stock`'s cooldown skip and its `busy` exit, and `sync-catalogue`'s cooldown gate, all
      `return json(...)` with no `console.log`, so a skipped invocation appears in `function_logs` as
      `booted` → `shutdown` with nothing between — indistinguishable from a crash. That argues for
      reading `execution_time_ms` to classify, **not** for counting in the incomplete table. Adding
      those log lines was **considered and rejected 2026-07-31** on the piggyback rule above: it would
      only add the *reason* (cooldown vs busy vs foreign session), usually inferable from the
      lease/cooldown arithmetic. Don't redeploy two live functions for it.
    - **Generalisable:** `cron.job_run_details.status = 'succeeded'` proves only that the `net.http_post`
      **enqueue** succeeded — pg_net is asynchronous, so it is not evidence of delivery. Three
      independent signals exist (cron enqueue → `booted` → edge row); when they disagree, the one that
      can only under-report is the one to distrust.
  - **⚠ A BROWSER-HELD SESSION LEASE LOOKS EXACTLY LIKE A FAILED CRON.** `SESSION_TTL_MINS = 12` while
    the stock crons sit 3 min apart at `:35 :38 :41 :44`, so **one browser Sync Now / TO pull can block
    up to all four stock groups** for a cycle, silently (above). Worked example 07-30: a pull claimed
    the lease ~16:28, `:35` and `:38` returned `busy`, and `:41`/`:44` ran normally because the lease had
    expired — that split is the signature. The browser tool's own paced retry (90s gaps — visible as
    16:52:14 then 16:53:45) recovered the two blocked pairs. **⚠ But if the tab goes away after
    `sessionStart`, nothing retries and those branches stay stale for the full hour with no signal** —
    the argument for surfacing freshness in the UI rather than shortening the TTL, which exists to
    prevent the 2026-07-09 429 storm.
- **Deployed function inventory (2026-08-04).** **SEVEN**, all load-bearing: `sync-stock`,
  `sync-orders`, `create-to`, `sync-invoices`, `sync-catalogue`, `sync-sku-floors` (2026-07-31),
  **`nightly-digest`** (2026-08-04). Anything else you find deployed is drift — check before assuming
  it is wanted.
  - ⚠ **ALWAYS NAME THE FUNCTION: `supabase functions deploy <name>`.** A bare
    `supabase functions deploy` redeploys **all** of them with whatever `_shared/*` is on disk. This is
    the single real hazard in adding a function; a named deploy bundles only the files that function
    imports (verified 2026-08-04 — deploying `nightly-digest` uploaded exactly `index.ts` and
    `_shared/nightlyDigest.ts`, and left the other six on their existing versions).
  - ⚠ A **seventh** surface now exists outside Supabase: **`api/run-engine.js` on Vercel** (Stage 6).
  It is not an edge function and will not appear in `supabase functions list` — see Stage 6.
  - **Deleted 2026-07-29:** `zoho-invoices`, `zoho-prices`, `zoho-skumaster` (Books-era importers,
    superseded by `sync-invoices`/`sync-catalogue`). ⚠ They were **not** broken by the org migration —
    `_shared/zoho.ts` points at `/inventory/v1` and reads the current `ZOHO_ORG_ID`, so they would have
    worked if called. Removed for being unused, verified three ways: zero code references in this repo
    or `homerun-to`, no cron, and **zero invocations** in `function_edge_logs`. Source is committed
    (`zoho-invoices` was recovered via `supabase functions download` — its directory had been empty, so
    the deployment was the only copy).
  - ⚠ **`supabase functions download <name>` overwrites `_shared/*` with the deployed copy.** It
    silently reverted `_shared/zoho.ts` to an older version. Always `git status` after a download.
  - ⚠ **`_shared/zoho.ts` is now orphaned and is a trap — never import it in new code.** Its
    `getAccessToken()` mints a token per cold start with only in-memory caching: the exact pattern
    behind the 2026-07-14 throttle incident that failed stock-sync-1/-2 at the auth step. Use
    `zohoClient.ts` → `zohoToken.ts` (shared cache in `public.zoho_auth_cache`).
  - `diag-items` was **deleted 2026-07-29** (verified unreferenced first). It had been labelled
    TEMPORARY since 2026-07-15 and, worse, gave a *misleading* answer: it inspected `custom_fields[]`
    and `custom_field_hash`, neither of which `/items` uses, reporting "no custom fields" while seven
    arrive as top-level `cf_*` keys. **A diagnostic that checks the wrong shape is worse than none** —
    it produced a confident negative that stalled the `cf_inventorised_at` work. Its lesson lives on in
    the Zoho ITEMS + PRICES section; don't rebuild it.
- **Manual Sync Now (reworked 2026-07-09, ships with next frontend deploy):** claims the shared sync session (source `ims`), runs the 4 cron groups with a 90s min gap between starts (+ sync-orders parallel with the first), one paced retry for failed groups, releases in `finally`. Button greys out while the TO tool holds the session (20s poll of `params/syncLock`) or during the 15-min cooldown; per-group failures surface next to the button.
- **Cold-cache deadlock:** prevented by 50-call cap on transferred-today detail calls + read-merge-write in `saveTeamData` (App.jsx).
- OPTIONS preflight: handler checks `req.method === 'OPTIONS'` and returns immediately — prevents browser CORS preflight from running the full sync.

---

## `create-to` — the DC TO-raising write path

The TO tool itself is a separate repo (`~/Documents/GitHub/homerun-to`, authoritative doc
`homerun-to/CLAUDE.md`). What lives HERE is the edge function it calls to create draft
Zoho transfer orders. It is the only **write** path into Zoho in this project, so its
failure modes are ops-visible immediately.

**`create-to` edge function (this repo, deployed 2026-07-10):** creates **draft-only** Zoho TOs for
the TO tool. ⚠ Zoho trap: `is_intransit_order:false` = instant full transfer (NOT draft) — the real
draft mechanism is the undocumented `status:'draft'` body field (captured from the UI's own network
trace). Non-draft responses are auto-deleted in the same invocation. SKU→item_id map cached in
`params/zohoItemIds`; audit in `params/toAudit`. Details: homerun-to spec 2026-07-10-task6b.
- **TO Type = "Mid Mile" (custom field, live 2026-08-07, prod-verified TO-02821).** Zoho added a
  `TO Type` dropdown (`cf_to_type`; options `Mid Mile` | `Order Fulfilment`, default
  **Order Fulfilment**, NOT mandatory) and the DC team was flipping every tool-created TO by hand.
  `create-to` now sends `custom_fields: [{ api_name: 'cf_to_type', value: 'Mid Mile' }]` — a
  server-side constant, since every TO this endpoint creates is a DC→DS mid-mile restock; the tool
  neither asks nor sends it, so **no homerun-to deploy was involved**. ⚠ Custom fields must go in
  `custom_fields`; a top-level `cf_to_type` key would be silently ignored (same trap as `reason`
  vs `description`) — and because the field has a *default*, a wrong api_name fails **invisibly**
  as "Order Fulfilment", not as a blank. Hence the read-back check that logs the whole
  `custom_fields` array on mismatch. **Safety valve:** on a `400` (Zoho validation ⇒ nothing
  created) the POST is retried ONCE without the custom field, so a labelling nicety can never
  block a transfer — worst case is the pre-2026-08-07 behaviour. Deliberately not retried on
  5xx/timeout/429, where a TO may exist and a repeat would duplicate it.
- **⚠⚠ INACTIVE SKUs ARE DROPPED, NOT FATAL (live 2026-08-29, commit `e1c33c5`).** Zoho refuses the
  **ENTIRE** transfer order if any line names an item marked inactive or deleted — *"Transfer Order
  cannot be raised for item &lt;name&gt; that has been deleted or marked as inactive"*, nothing created.
  So one bad SKU blocked a 94-line TO. On **2026-08-28** ops deactivated 334 SKUs mid-afternoon and
  **the DC team could not raise a single TO** until they reverted the flip in Zoho by hand.
  - **⚠ THE ENGINE CANNOT PREVENT THIS AND NEVER WILL.** `buildToTargets` already emits only SKUs
    whose master status is `active` — but `skuMaster` is a **nightly** copy, so it is *structurally
    blind* to a same-day flip. Only Zoho knows. Don't "fix" this upstream in the engine.
  - Pure logic in **`_shared/toLineFilter.ts`** (19 tests): `partitionInactive` splits the requested
    SKUs, `skipSetGrew` is the retry condition. A **missing** status counts as active (**fails OPEN**)
    so an older cached item map behaves exactly as before. A SKU **absent** from the map is left alone
    — `badSkus` owns that and *refuses*; two owners for one fact is how the Stock Health filter and the
    TO deep link both drifted.
  - **⚠⚠ `ITEM_MAP_TTL_HOURS` 24 → 0.5, AND THE TTL IS A CORRECTNESS PARAMETER, NOT A PERFORMANCE
    ONE.** It decides whether validation can *see* a same-day deactivation: at 24h the map called
    yesterday's flipped SKUs active, the pre-flight passed, and only the POST discovered otherwise.
    ~12 TOs/day in two windows ⇒ roughly **2 refreshes/day**; the first TO of a session pays ~8s
    (surfaced in the tool's existing `validating` stage), the rest are instant.
  - **⚠ A REFRESH FAILURE FALLS BACK TO THE CACHED MAP, never throws.** At a 24h TTL almost every TO
    was served from cache and never touched `/items`; at 30 min most TOs refresh, which would newly
    expose the whole DC TO path to Zoho being slow or 429'd. This is the guard that stops a latency
    change from becoming an availability change.
  - **⚠⚠ A SKIP PROPOSED FROM A CACHED MAP IS NEVER ACTED ON — refresh and re-ask first.** The cache
    is stale in **both** directions and the second is worse: *"says inactive, actually active"* would
    **silently drop good lines**. Not hypothetical — on 2026-08-29 ops reactivated 334 SKUs, and a map
    from the previous evening would have skipped every one of them while the screen calmly read
    "90 of 94 items". Costs nothing on a clean TO, because `buildToTargets` already emits active-only.
  - **Reactive backstop:** after the TO Type valve, a 400 triggers one forced refresh + re-partition,
    and retries **once only if the skip set GREW**. ⚠ That condition is the whole safety of the branch
    and is why we do **not parse Zoho's message**: a numbering or location 400 produces no new skips,
    so nothing is retried and the original error is surfaced untouched. **Zoho names exactly ONE item
    per 400**, so parsing would cost one write attempt per bad SKU (four attempts for four SKUs) and
    would only ever yield the item *name*, not the SKU. Re-partitioning catches all of them in one
    pass. Gated strictly on `400`; never 5xx/timeout/429.
  - **An empty TO is refused, never created** — a zero-line draft in Zoho is worse than a clear error.
  - Response and `params/toAudit` gain `skipped` + `requested`. **The nightly digest names them; the
    ground team sees only a COUNT** — an inactive SKU is a Zoho catalogue problem they cannot act on,
    and a list would invite chasing stock that was never sent. Admin-only **by construction** (one
    recipient), no new UI and no new gate. Reported **green**: a dropped line means the TO *succeeded*
    where it used to fail. Deduped by SKU across TOs — one bad SKU in six transfers is one thing to fix.

---

## Supabase row inventory

Which rows exist, who owns each, and which are the only surviving copy of something. Most
of these are written by the syncs in this directory; the two-row `team_data` separation
and the params-row rule are in root `CLAUDE.md`, which loads automatically.

- **Row inventory (verified live 2026-08-05).** `team_data` — **8 rows**: `global` (4.3MB), `invoice_data`
  (8.6MB), `invoice_sync_buffer` (in-flight chunks for the 1–2 dates being pulled, keyed
  `date|round|offset` so a re-run of a chunk is idempotent; **nothing else reads it** — sits at **32
  bytes** when drained, which is what a healthy morning looks like),
  (`invoice_data_shadow` was **deleted 2026-08-04** — verified first that all 8 of its dates existed in
  the live row, none were pre-July, and where counts differed the live row was the *more* correct one,
  post-void-correction),
  `invoice_data_backup_20260728` + `_20260729` + **`_20260803`** (the last is the Stage 5 cutover backup,
  75,699 rows / 90 dates verified; the API cannot re-serve anything before 2026-07-01, so these are the
  only copy of Apr–Jun history — and **the only copy of each date the retention trim trims**, one per
  night until ~28 Sep 2026), **`sku_floors_backup_20260731`** (159KB, taken at the Stage 8 cutover),
  `catalogue_backup_20260729`
  (skuMaster/priceData — **matters more than the invoice backup**, see Stage 7). `params`: `global`,
  `paramsBackup`, `plywoodNetworkConfig`, `plywoodNetworkV2Config`, `networkConfigs`, `pincodeMap`,
  **`dsCapacities`** (a FIFTH own-row config this list omitted until 2026-09-07 — `loadParamConfigRows`
  attaches it, so verify against that function rather than this list)
  (attribution), `toTargets`, `toAudit`, `toSnapshots`, `zohoItemIds`, `binLocations`, `syncLock`,
  `invoiceSyncStatus`, `invoiceSyncCursor`, `uploadProvenance` (**new 2026-07-30** — when each input was
  last set BY HAND; the browser is its only writer, syncs record their own times in their own status
  rows, so no key has two writers), `catalogueSyncStatus` (now also carries **`lastOkNight`** —
  the once-per-night gate; see Stage 7), **`digestHistory`** + **`digestStatus`** (new 2026-08-04 —
  `nightly-digest` is the only reader and writer of both; history is `{days:[{date,min,max}]}`,
  idempotent by IST date, trimmed to 60; **first real entry written 2026-08-05**, so the email's ₹ delta
  line starts appearing from 2026-08-06).
