# CLAUDE.md — HomeRun IMS

> ✅ **THE NIGHTLY CHAIN IS COMPLETE AND PROVEN — nothing is pending verification.** Every input the
> engine consumes daily has an unattended writer: catalogue 21:55–23:55 IST → **invoices 00:35–04:00
> (writes `team_data/invoice_data`, the live row)** → SKU floors 04:35/05:25 → engine →
> `params/toTargets` 05:45/06:15 → **digest email 06:30** → ops POs ~07:30. `minReqQty` and `deadStock`
> stay manual **by design** (ops judgement, not Zoho data). **No manual invoice CSV is needed again**;
> upload remains the emergency override.
>
> ✅ **Two proving runs, both passed, both verified from the data rather than a runbook table.**
> **Night 1 (2026-08-04)** — first unattended night: 90 contiguous dates, 77,642 rows, `datesTrimmed: 4`
> (05-02…05-05), the 07-31 re-fetch **2 rows lighter** from the D-3 void correction.
> **Night 2 (2026-08-05)** — first `nightly-digest` cron firing and first night on 12 invoice slots:
> email delivered **06:30:02 IST** green to the Inbox; live row **`05-07 → 08-04`, 90 dates over a
> 90-day span (contiguous), 78,284 rows**; `datesTrimmed: 1` (05-06, 646 rows, counted out of
> `invoice_data_backup_20260803`), `datesReplaced: 1`; `unknownPct 0`; zero 429s and **zero non-200
> responses across every function all night**. Arithmetic closes exactly:
> `77,642 − 646 trimmed − 1,143 (old 08-01) + 2,431 fetched = 78,284`, and the 08-01 re-fetch came back
> **1 row lighter** against 15 voids in `statusSeen`. `toTargets.invValue` stamped for the first time
> (₹7.99Cr Max / ₹5.60Cr Min), `digestHistory` holds one day, `recorded: true`.
> **`invoiceDataThrough: "2026-08-04"`** — the whole point.
>
> ⚠ **STEADY STATE NOW LOSES ONE PRE-JULY DATE EVERY NIGHT, PERMANENTLY — by design, not a fault.** The
> row sits at the `RETENTION_DAYS = 90` ceiling, so each night's new date trims the oldest. Those dates
> are pre-2026-07-01 and **the Zoho API cannot re-serve them**, so `team_data/invoice_data_backup_20260803`
> is their last copy. Continues until the window starts after 2026-07-01 — ~**28 Sep 2026** at 90-day
> retention. Don't "fix" a shrinking earliest-date; check it against `datesTrimmed` instead.
>
> ⚠ **`toTargets.refreshedAt` reads `06:15`, and 06:15 is CORRECT — confirmed both nights.**
> `engine-run-nightly` is `15,45 0 * * *` UTC — **two slots** — and the second rewrites it. So `05:45`
> on the chip would mean the 06:15 run FAILED. The Stage 5 runbook asked for `05:45` and nearly had a
> healthy system reported as broken. Generalisable: derive a check's expected value from the **write
> semantics** (last successful run wins), not from the schedule.
>
> ⚠ **AND FROM THE CURRENT DATA, NOT A SNAPSHOT — the same rule's second half, learned 2026-08-15.**
> A runbook written that afternoon told the reader to expect `G9NYZ DS01 = 0/0`; the operator replaced
> the ceiling test file an hour later and the correct answer became `1/1`. **The check was stale before
> anyone read it, and nothing about it looked wrong.** Any expectation drawn from an input a human can
> edit must be regenerated at check time, not written down — for ceilings that is one read-only
> command (`scripts/dryrun-sku-ceiling.mjs`), and every input has an equivalent. Hardcode only what
> the *code* guarantees; derive everything the *data* decides.
>
> ⚠ **The 12-slot gain is schedule arithmetic, not luck — 55 minutes, reproducible.** Publish moved
> `02:50 → 01:55:10 IST`. Both nights needed the same **6 working chunks**; volume did not change the
> chunk count. The old `:35,:50` layout forced a 45-min wait to the next hour (6 chunks → 02:50), the
> new `:35,:45,:55` layout does not (6 chunks → 01:55). Expect the gain on any 6-chunk night.
>
> Cleanup done: the Stage 5 runbook, the 2026-08-05 runbook, the frozen `team_data/invoice_data_shadow`
> row and `docs/HANDOFF-2026-07-31.md` are all deleted. All were transient cutover state.

HomeRun operates **6 dark stores (DS01–DS06) + one DC** (Rampura). This tool computes Min/Max inventory levels for every SKU at every location so ops knows how much stock to hold. (DS06 Kogilu went live ~2026-07-08; `DS_LIST` in `constants.js` has six entries and everything iterates it.)

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
- **⚠⚠ THE INVOICE `⬇ Data` BUTTON DOES NOT ROUND-TRIP — RE-UPLOADING ITS OUTPUT YIELDS 0 ROWS.**
  Measured 2026-07-30 by replaying `buildDataCSV("invoiceData")` through the real `parseInvoiceCsv`:
  **74,381 rows → 0.** Stored rows carry only `{date, ds, pin, qty, shopifyOrder, sku}` — `status` is
  dropped after the parse-time filter — so the export writes `r.status || ""`, an EMPTY `Invoice
  Status`, and re-upload filters `["Closed","Overdue"]`, matching nothing. Since the upload replaces
  entirely, the result is a **total wipe of invoice history**, and nothing before 2026-07-01 is
  re-fetchable from the API.
  - **✅ FIXED 2026-07-30.** The builder moved out of `App.jsx` to `buildInvoiceCsv` in
    `engine/utils.js`, directly ABOVE `parseInvoiceCsv`, and emits `"Closed"`. Verified against live
    data: 74,381 → **74,381**, 0 SKU×DS differing, qty identical. The Closed/Overdue distinction is
    unrecoverable but immaterial — both pass the filter and nothing downstream reads the field. It also
    now fills Item Name / Category from `skuMaster`, so the backup is human-readable.
  - **⚠ Keep the writer next to the reader.** The bug existed because a writer in `App.jsx` and its
    reader in `engine/utils.js` sat ~3,000 lines apart with an unasserted invariant between them.
    `invoiceCsvRoundTrip.test.js` (7) now pins `parseInvoiceCsv(buildInvoiceCsv(rows)) === rows`, so
    changing either side fails immediately. Same shape as `paramConfigRows.js` / `teamDataBundle.js`.
  - **⚠ `parseCSV` silently STRIPS an embedded quote** (it toggles on each `"` and drops it), so
    `Floor Drain, 5" x 5"` reads back as `Floor Drain, 5 x 5`. Cosmetic and deliberately left alone:
    the affected columns (Item Name, Category) are ignored by `parseInvoiceCsv`, and SKUs/order
    refs/pincodes never contain quotes. **Columns do NOT misalign** — the comma stays protected — and a
    test pins that. Fixing the un-escaping touches the parser shared by all six uploaders.
  - `minReqQty`, `newSKUQty`, `deadStock`, `skuMaster` and `priceData` round-trip **correctly** (columns
    verified symmetric on both sides). Invoice is the only broken one.
- **⚠ THE DATE GUARD CHECKS FORMAT, NOT COVERAGE — coverage is the check that actually protects a
  replace-entirely upload, and nothing in the app performs it.** A July-only export with perfect ISO
  dates is accepted and silently destroys Apr–Jun. Before any invoice upload, verify against the stored
  row: **earliest date ≤ stored earliest**, no stored date absent from the file, row/qty/SKU×DS totals
  comparable. Cleared exactly this way on 2026-07-30 (`Invoices - Apr30_Jul28.csv`: 74,381 rows,
  90 dates, 6,231 SKU×DS combos, **0 differing** — a content no-op).
- **⚠ The unknown-SKU rate is WINDOW-DEPENDENT; quote the window or it reads as a regression.** Same
  file, 2026-07-30: **0.148% over 90d · 0.014% over 45d · 0.000% over 30d.** Every unknown row is
  pre-July (Apr 5 / May 85 / Jun 20 / Jul 0) — orphaned old-style codes from the ~2026-07-01 Zoho
  re-code — so they concentrate in the older half. The bar (<1%) applies to the **engine's** window,
  i.e. `overallPeriod` = 45 days.
- **⚠⚠ INVOICE DATES MUST BE `YYYY-MM-DD`. A locale-formatted export took prod down on 2026-07-29.**
  An export wrote the two newest days as `DD/MM/YYYY` (27/07/2026, 28/07/2026 — 2,458 rows) while the
  older 88 days were ISO. `parseInvoiceCsv` stored `Invoice Date` verbatim with no validation, so the
  mixed set reached Supabase. Then:
  1. String-sorting puts `28/07/2026` **after** `2026-07-26` (`'0' < '8'` at index 1), so the malformed
     value becomes `allDates[allDates.length-1]` — "the latest date".
  2. `plywoodNetwork.js:250` does `new Date(latest)` → **Invalid Date**, then `.toISOString()` throws
     `RangeError: Invalid time value`.
  3. That threw inside `runEngine` during App.jsx's load effect → React unmounted → **blank white page
     for EVERY user on EVERY page load**, because the engine recomputes client-side each load. Not one
     bad session.
  4. **The UI could not fix it** — the app crashed before rendering the Upload tab. Recovery required
     restoring `team_data/invoice_data` from a backup outside the app.
  - **Guarded since (`utils.js parseInvoiceCsv`): a non-ISO or impossible date now THROWS**, naming the
    offending values and row count, before anything is stored. Callers must catch — `handleInvoice`
    (App.jsx) alerts and `PlywoodNetworkV2Tab` surfaces the message; an uncaught throw would leave the
    upload spinner stuck forever. Deliberately **rejects rather than auto-corrects**: DD/MM vs MM/DD is
    ambiguous for days ≤12, and guessing wrong shifts demand by weeks with no visible symptom.
  - **⚠ THE ZOHO EXPORT ITSELF STILL PRODUCES `DD/MM/YYYY` — the locale setting was never fixed.** A
    fresh 07-29 export on 2026-07-30 was DD/MM in **all 1,704 rows**. So the guard now (correctly)
    refuses it, which means **the manual-CSV override path is unusable until the export locale is
    changed** — worth knowing before reaching for it in an incident. It also blocks
    `scripts/compare-csv-vs-live.mjs`, which imports the real `parseInvoiceCsv` on purpose. Converting
    a scratch copy is safe **only when every distinct date's leading component is >12** (provably a day);
    assert that rather than assuming, and never convert the file you would upload.
  - **Generalisable:** `plywoodV2/demand.js:52` and `PlywoodNetworkTab.jsx:461,1221` share the same
    `new Date(latest).toISOString()` pattern. Any single malformed row in a shared `team_data` row can
    take the whole app down for everyone, and lock you out of the tool that would fix it. **Validate at
    the boundary, before the write.**
    - ⚠ **Grep for the pattern, don't trust these line numbers.** Both citations here drifted within
      three months: `plywoodNetwork.js:250` was off by 2 and only became right by accident when two
      lines were deleted above it on 2026-08-05, and `1223` became `1221` in that same commit. A cited
      line number is stale the moment anyone edits above it, and nothing fails when it does —
      `grep -n "toISOString" src/` is the durable form of this note.
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
- **⚠ Input sizes drift fast — measured live 2026-09-07, and several figures below are older.**
  `invoiceData` **94,819 rows · 90 dates · 2026-06-09 → 2026-09-06** · `skuMaster` **2,573** ·
  `newSKUQty` **1,869** · `priceData` **2,185** · `skuCeiling` **815** (0 at ship on 2026-08-15 — ops
  adoption has been strong) · `deadStock` **20** · `coreOverrides` **0** · attribution `shippingCode`.
  Re-measure with `scripts/snapshot-engine-inputs.mjs` rather than trusting any number in this file;
  it prints all of them and freezes them for a diff.
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
- **⚠ Reading state? Query the exact key name.** `params/global` holds the strategy map under
  **`categoryStrategies`** (plural). A hand-rolled check that guessed `categoryStrategy` silently
  returned `{}` on 2026-07-30 and reported all 19 categories as unmapped — a confident wrong answer.
  Never write `p.get('a') or p.get('b')`: the `or` hides which key exists. Same lesson as `diag-items`
  checking the wrong custom-field shape — **a check that reads the wrong field is worse than no check.**
- **⚠⚠ `saveTeamData` WRITES ONLY WHAT THE CALLER CHANGED — `src/teamDataBundle.js`, and this is a
  data-safety rule, not tidiness.** It used to rebuild the whole bundle from React state
  (`{...existing, skuMaster: overrides.skuMaster ?? skuMaster, …}`). **The `...existing` spread only
  protects keys the app does not NAME**, and it named `skuMaster`, `priceData`, `stockData` and
  `stockUploadedAt*` — so every save rewrote them from whatever that tab was holding.
  - Harmless while a human's CSV upload was the only writer of `skuMaster`: the human doing the upload
    was the human whose tab it was. **Stage 7 ended that.** `sync-catalogue` now writes `skuMaster` and
    `priceData` nightly and unattended, so a tab opened BEFORE the nightly run would, on its next
    upload or Apply, silently revert the whole catalogue — new SKUs dropped, prices reverted, deleted
    SKUs re-activated. Nearly happened 2026-07-30: a floors upload at 14:57 IST wrote `skuMaster` back
    over the 14:36 sync and survived only because that tab loaded after 14:36. Timing, not design.
  - **Symptom is maximally confusing:** `params/catalogueSyncStatus` still reads `ok:true` with
    `lastOkNight` set. The sync really did succeed and was overwritten afterwards, so it looks like a
    sync failure that isn't one.
  - `BROWSER_OWNED_KEYS` = `skuMaster`, `minReqQty`, `newSKUQty`, `deadStock`, `priceData`,
    **`skuCeiling`** (2026-08-15) — the only keys the browser may write. **Adding a key there grants permission to clobber it.**
    - **⚠ THREE OF THE FIVE NOW HAVE AN EDGE-FUNCTION WRITER TOO** — `skuMaster` and `priceData`
      (`sync-catalogue`, from 2026-07-29) and **`newSKUQty` (`sync-sku-floors`, from 2026-07-31)**.
      An earlier version of this line said "only add one no edge function writes"; that ship has
      sailed, so the rule is now the one that actually keeps it safe: **the browser may write such a
      key ONLY on an explicit human action on that specific input** (a CSV upload or a clear button),
      never as a side effect. That is exactly what `96a1bf4` bought — before it, the whole bundle was
      rebuilt from React state on every save, so any unrelated Apply rewrote all five.
    - **The remaining exposure is intentional and bounded:** a human CSV upload overrides the sync,
      and the sync re-asserts on its next run. That is the fallback path working, not a conflict.
      `sync-sku-floors` reports it as `overrodeManualUpload` rather than reverting silently.
    - **⚠ BUT TWO WRITERS MUST ALSO AGREE ON MALFORMED INPUT, WHICH IS EASY TO MISS.** For `newSKUQty`
      they did not until 2026-08-15: on a sheet with duplicate SKU rows the browser silently took the
      last row while `sync-sku-floors` refused the whole file, so the **unguarded fallback succeeded
      where the guarded primary failed**. Both now follow the ops append rule. When auditing a
      two-writer key, check the AMBIGUOUS cases, not just that the happy paths match — see Stage 8.
    - Deliberately absent: `invoiceData` (own row; back here takes the payload
    ~1-2MB → ~7MB and re-exhausts the Disk IO burst), `stockData`/`stockDataAccounting`/
    `stockUploadedAt*` (sync-stock owns them — the browser only ever READS stock, `setStockData` is
    called solely from Supabase reads), `poData`/`toData`/caches/`ordersUploadedAt` (sync-orders).
  - Tests `src/teamDataBundle.test.js` (12). `undefined` means "not changed"; `{}` is a **deliberate
    clear** (the Upload Data clear buttons pass `{skuMaster:{}}`) — never test falsiness.
  - **Generalisable:** automating an input the browser also writes turns a single-writer key into a
    **write-write conflict**. Same shape as the `pincodeConfig` incident. When a sync function takes
    over a field, audit every browser write path that names it.
  - **⚠⚠ AND AUDIT EVERY PLACE THAT *DESCRIBES* WHO WRITES IT — two such places lied for days
    (both found + fixed 2026-08-03, commits `e9640ea`/`1af1efe`).** A stage shipping silently falsifies
    constants elsewhere that were correct the day they were written, and nothing fails loudly:
    - **`autoAtFor` in `App.jsx` (the Data Inputs provenance pills).** A `null` there asserts "only
      humans write this key". `newSKUQty` was `null` from 07-30 to 08-03 even though `sync-sku-floors`
      began writing it nightly on **07-31** — three unattended syncs ran while the pill credited a
      human's 07-31 upload. (`invoiceData` was correctly `null` until Stage 5, then wired.)
    - **The knock-on was worse than a wrong label:** `assessModel` compares `toTargets` against those
      same timestamps, so a stale entry **silences the staleness check that depends on it**.
    - **A hardcoded `note` on a pill SUPPRESSES the derived one** — `SourcePill` does
      `title={note || prov.note}`, so a literal string hides `assessSyncedInput`'s
      "Auto-sync has missed a night". The two cards carrying literal notes were exactly the two that had
      just gained syncs, so the inputs whose overdue warning mattered most could not show it.
      **Rule: leave `note` off anything with an auto writer**; ops-only cards (`minReqQty`, `deadStock`)
      keep theirs.
    - **⚠ Prefer a publish-only timestamp.** Use `invoiceSyncStatus.publishedAt`, not `.at` — `at` is
      stamped on **every** exit including failures, so it would claim an auto-sync produced the value on
      a night that refused to write. `sync-catalogue` and `sync-sku-floors` have **no** publish-only
      field (floors is ok-gated by hand in App.jsx; **`catalogueAt` still has the flaw**). The real fix
      is a `lastOkAt` written by each sync — not yet done.
- **⚠ The realtime handler is NOT the place to refresh `skuMaster`/`priceData` — it looks like a
  two-line fix and is not** (`App.jsx`, channel `stock-sync`). It fires on EVERY update to
  `team_data/global` — the four stock syncs plus orders-sync, **~5×/hour** — and `loadFromSupabase`
  returns a freshly parsed object each time, so `setSKU(sbData.skuMaster)` would change the reference
  on every event and fire the `[params, invoiceData, skuMaster, …]` effect: a full `runEngine` over
  ~2,100 SKUs plus `setResults`, ~5 times an hour in every open tab, with the table changing under
  whoever is using it. It refreshes only the five stock/PO/TO keys because it predates Stage 7.
  - **Known open gap:** a long-lived tab can no longer CLOBBER the row (above) but still COMPUTES from
    a stale catalogue — stale Min/Max on screen, and a stale `params/toTargets` if someone clicks Apply
    from it. Needs change-detection against the held catalogue, or better a "catalogue updated, reload"
    prompt that leaves the user in control. Habit meanwhile: **reload before clicking Apply.**
- **CSV upload → model re-run is safe:** `saveTeamData` writes `invoiceData` to the `invoice_data` row
  only when it changes, and the global row is read-merge-write from a FRESH read, so PO/TO caches and
  stock data are never wiped by an upload.
- **`applyAndRun` writes only the `params` table** — `params/global`, `paramsBackup`, `pincodeMap`,
  `toTargets`. It never calls `saveTeamData`, so Apply cannot touch `team_data/global`. Useful when
  isolating which write moved a value: one write per verification, or a moved value has two causes.
- **Edge Function deploy:** plain `supabase functions deploy sync-stock` / `sync-orders` is fine.
  (An older note here required `--no-verify-jwt` — obsolete since the cron jobs started sending the
  anon Bearer header in their `pg_net` calls; verified 2026-07-08/09: two plain deploys, every cron
  cycle executed. All callers — crons, IMS, TO tool — send Authorization headers.)

---

## Engine — where it is documented

**The Category Strategy Engine is documented in `src/engine/CLAUDE.md`**, which loads
automatically the moment you open anything under `src/engine/`. It covers strategy
dispatch and the four strategies, the post-blend ladder and the DC ladder, Dead Stock, the
SKU × DS Ceiling, demand attribution, DS Seed, Active-only and Inventorised-At
normalization, and the Purchase / Move policy.

**Plywood Network Design** is in `src/engine/strategies/CLAUDE.md`; **v2** in
`src/engine/strategies/plywoodV2/CLAUDE.md`.

Two facts worth carrying even when you are nowhere near the engine:

- **Engine output is recomputed client-side on every page load** — there is no stored
  results blob. An engine change goes live for every user on their next page load after
  deploy, and one malformed input row can white-page the app for everyone.
- **`params/toTargets` has two writers** — `applyAndRun` in `App.jsx` and the nightly
  `api/run-engine.js` — sharing `src/toTargets.js`, which is the only thing stopping them
  drifting.

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
  the last *complete* IST day. Trading ends 20:00 IST and ops POs start ~07:30 IST, so the night is
  free, and TOs are occasionally raised as late as ~02:00 IST — which is why the invoice write is
  **atomic** rather than merely late-scheduled (see Stage 4). This costs no freshness versus the old
  21:30 slot: both produce targets before the next day's 14:30 TO run, but only this one uses a whole
  day. Don't design against a midnight deadline; it no longer exists.
- Clusters: DS01+DS05 (C1), DS02+DC/Rampura (C2), DS03+DS04 (C3).

---

## Tabs — where they are documented

**`src/tabs/CLAUDE.md`** covers the Stock Health tab (health tags, the location universe,
the DS-Req-Covered helper, KPI cards, PO/TO columns, the Reverse TO count sheet) and the
Tool Output Download tab (the five cards, the frozen PO column contract, status
normalisation, Zero Sale SKUs, and the freshness gate on every download). It loads
automatically when you open anything under `src/tabs/`.

⚠ **Overview, SKU Detail, Upload Data, Logic Tweaker and Manual Overrides live inline in
`src/App.jsx`, not in `src/tabs/`** — so that file does NOT load when you edit them. Read
`src/tabs/CLAUDE.md` deliberately when working in App.jsx.

Two consequences that reach beyond the tabs:

- **Every Tool Output download is gated on demand freshness**, tri-state, and `unknown`
  must never block — a stale CSV is correctable, a download blocked at 06:00 IST stops
  purchasing for the day.
- **The PO CSV column order is a frozen contract.** The PO team's sheet formulas key on
  column *position*, so reordering produces wrong purchase orders rather than an error.
  Anything new goes after the last column.

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

## Open Work

**Numbers are stable IDs** — they appear in commit messages and PRs, so they are never renumbered or
reused. Items are listed in priority order, not numeric order. Everything shipped keeps its number in
the changelog below.

Step 5 **passed** on 2026-08-04 and its cleanup is done (see the block at the top) — the whole nightly
chain now runs, and reports on itself, unattended.

### 19. The Zoho export locale is still `DD/MM/YYYY` — the documented rollback is unusable
Measured again 2026-08-03: all rows. The date guard correctly refuses it (see the 2026-07-29 outage), so
**the manual-CSV override — the fallback every rollback plan in this file points at — cannot currently be
used.** Not a code change; a Zoho setting. Cheap, and it is the emergency path.

### 8. DC calculation for PCT + Fixed Unit Floor — 639 SKUs, measured 2026-08-03
`sumDailyAvg × (leadTime+1)` (`runEngine.js:397`) understocks the DC for erratic demand. Proposed fix:
`Σ DS Mins × mult`, as floored SKUs already use.
- **⚠ IT LOOKS FIXED AND IS NOT — don't re-close it from memory.** Two *adjacent* things did get
  `Σ DS Min`: **floored SKUs** (`runEngine.js:387`, gated on having a manual `newSKUQty` floor — a
  strategy-independent condition) and **Network Design**, which has its own
  `P95 + ceil(Σ DS_Min × dcMult)` in `plywoodNetwork.js`. The `else` branch is untouched and applies to
  every non-dead, non-floored SKU whatever its strategy.
- **Scope, of 2,019 DC-inventorised active SKUs:** Fixed Unit Floor **406**, PCT **233**. PCT is
  already 75% covered via the floor path (714 of 947), so **the gap is concentrated in Fixed Unit Floor
  — 30% floored** — i.e. exactly Wires/MCB and Overhead Tanks, the erratic categories the item was
  written about. Standard is out of scope by design.
- Its old blocker ("held pending Network Design learnings") was satisfied on 2026-04-28 and nobody
  revisited for three months. **Decide it: do it, or park it with a stated reason.**

### 25. The D-3 recheck re-fetches ~585 invoices to change ~2 rows
**Half the runway problem is fixed AND NOW PROVEN; the waste is not.** Slots went 8 → 12 on 2026-08-04
(migration `20260804000002`), which carries N to 2,750 invoices/night ≈ **~1,375 orders/day** against
~600 today. Verified working on its first night (2026-08-05: 12/12, publish 01:55, zero 429s), so the
runway is real — but it **bought time, not a cure**, and there is now slack in the window precisely
because the publish finishes two hours before the last slot.

**The waste, now measured on two nights, and it reproduced almost exactly:**

| night | recheck date | detail calls | of total | rows corrected |
|---|---|---|---|---|
| 1 (08-04) | 07-31 | 1,175 | of 2,408 | **2** (2 lighter) |
| 2 (08-05) | 08-01 | ~1,143 | of 2,431 | **1** (1 lighter) |

Half the night's calls, both nights, to move 1–2 rows. Night 2's recheck cost is derived from the row
arithmetic (`old 08-01 = 1,143`) and confirmed by the chunk logs, which show the 08-01 pass consuming
three of the six working invocations on its own. **This is no longer a one-night anecdote — the ratio is
stable, which is what makes the splice worth costing out.**

- **⚠ THE RECHECK IS NOT OPTIONAL, and the reason is not voids.** It catches four things, and *three*
  are under-counts (the expensive direction): an invoice **created** after the pull, a **line item
  added** to an existing one, and invoices lost to `MAX_LOST_PCT` — the initial pull may silently
  publish having lost up to 0.5% of a day, and this is the only thing that heals it. Voids are the
  cheap direction. Do not "simplify" this away.
- **⚠ AND THE OBVIOUS FIX IS WRONG.** "Fetch only *modified* invoices for D-3" collides with
  `mergeInvoiceRows`, which drops each fetched date **wholesale** — and stored rows carry no invoice
  identity (`{date,sku,ds,qty,shopifyOrder,pin}`; `shopifyOrder` is `reference_number` and can be
  blank). A partial set would delete the rest of that day.
- **⚠ SO IS THE FIRST FIX FOR THAT.** Using modified-time as a *trigger* (list; skip the date if
  nothing changed) only pays off on nights where **nothing at all** changed — and night 1 changed. With
  ~585 invoices/day at a ~0.9% void rate, something probably changes most nights, so the trigger likely
  saves ~nothing. **Nobody has measured the rate.**
- **The design that works — splice, don't re-fetch.** List the date (~3 header calls), then: now
  `void`/`draft` ⇒ **delete its rows, zero detail calls** (you already know from the list); id we don't
  hold ⇒ detail-fetch it; `last_modified_time` newer than recorded ⇒ detail-fetch and replace. **~5
  calls instead of 585.** Needs `inv` (Zoho `invoice_id`) on stored rows.
  - **Guard 1: NEVER delete on absence from the list — only on an explicit `void`/`draft` status.** A
    partial/paginated list is indistinguishable from a mass void, and that mistake deletes real demand.
  - **Guard 2: only splice a date where EVERY stored row carries `inv`; otherwise fall back to today's
    full re-fetch.** D-3 is always three days old, so every recheck date qualifies within three days of
    shipping, and the fallback is current behaviour — the failure mode is "no saving", never "wrong data".
  - **Guard 3: keep a full re-fetch WEEKLY** (Sunday, the lightest day) to sweep up anything the
    splice's assumptions missed — e.g. a change that does not bump `last_modified_time`. Average cost
    ~88 calls/night instead of 585.
- **⚠ DO PHASE 1 FIRST, AND IT IS MEASUREMENT, NOT CODE.** Stamp `inv` on new rows, record per-date
  invoice count + `max(last_modified_time)` at publish, and record how much each recheck actually
  changed. **Zero behaviour change**, and after a week it says whether the splice is worth building or
  whether dropping the recheck to weekly is enough. Every option above — including the ones here — is
  currently a guess.

### 18. `lastOkAt` written by each sync
`sync-catalogue` and `sync-sku-floors` stamp `at` on **every** exit including failures, and store no
last-success timestamp — so a failed night can claim to be the source of the current value.
`sync-sku-floors` is `ok`-gated by hand in `App.jsx`; **`catalogueAt` still has the flaw.** Fix it at the
source, then drop the hand-gating. ⚠ Piggyback on a deploy you are making anyway — never redeploy live
functions for observability alone.

### 20. Pin the provenance invariant with a test
Extract `autoAtFor` from `App.jsx` and assert that **every input with an auto writer has a non-null
`autoAt`** — literally the 2026-08-03 bug. Same shape as `invoiceCsvRoundTrip` / `paramConfigRows` /
`teamDataBundle`.
- ⚠ **An earlier version of this entry claimed `src/freshness.js` has no test file. That was wrong** —
  `src/freshness.test.js` has existed since 2026-07-30 (37 tests as of 08-03). The gap is narrower than
  stated: the module's *pure functions* are well covered; what is unpinned is the `autoAtFor` **map**,
  which lives in `App.jsx` and is therefore not reachable from that suite. Extracting it is the whole
  task.

### 21. `demand through …` in the TO tool footer
The IMS chip has it since 2026-08-03; the TO tool footer still shows only `refreshedAt` and flags stale
merely as "not from today IST", so it renders no ⚠ while running on days-old demand. Same one-line fix,
but here the consequence is transfer quantities. Repo: `homerun-to`.

### 22. Stale-tab gap — a long-lived tab computes from a stale catalogue
It can no longer *clobber* `team_data` (see `teamDataBundle.js`) but still computes from a stale
catalogue, and can publish a stale `params/toTargets` if someone clicks Apply. Wants change-detection or
a "catalogue updated, reload" prompt. Habit meanwhile: **reload before clicking Apply.**
- **✅ The DOWNLOAD half of this gap is closed (2026-08-03)** — every Tool Output download is now
  gated on demand freshness, so a stale tab cannot produce a CSV. See the Tool Output Download section.
  What remains is **Apply**, which is the higher-consequence half: it writes `params/toTargets`. The same
  tri-state assessment could gate it, but Apply is not a download — blocking it would strand a genuine
  config change, so it likely wants the "catalogue updated, reload" prompt instead.

### 7. Read-only config visibility for non-admins — Logic Tweaker + Overrides tabs
**Verified still open 2026-08-03:** `PUBLIC_TABS` (`App.jsx:3589`) lacks `logic` and `overrides`, so
non-admins cannot see them at all. Plan: add both to `PUBLIC_TABS` and disable every input with
`disabled={!isAdmin}`. Upload Data stays admin-only. Plywood Network Design Config is already done this
way (visible to all, inputs disabled, Save hidden) — copy that pattern.

### 23. DS06 cluster assignment
Clusters are DS01+DS05 (C1), DS02+DC/Rampura (C2), DS03+DS04 (C3). DS06 went live ~2026-07-08 and has
never been assigned one. Flagged "review later" since then.

### 24. Make the invoice row-count sanity floor day-of-week aware
The Stage 5 runbook's flat `< 800 rows ⇒ stop` false-alarmed on 08-02's 752 rows, which was the
**second-busiest Sunday on record** (13 Sundays: min 382 / median 522 / max 760, vs non-Sunday median
866). Compare against the same weekday's median. A guard that cries wolf on schedule gets ignored.

### 27. `params/binLocations` is rot — 98.3% of it cannot be joined
Measured 2026-08-07: **1,148 entries**, keyed by **pre-July SKU codes** (`HAR-TEL-HET-4732-SC-450`,
`WIR-FRL-POL-250-BLU-300-1`). Only **20 (1.7%)** match a current `skuMaster` key — the rest were
orphaned by the ~2026-07-01 Zoho re-code, the same event behind the invoice unknown-SKU story.
**Nothing in `src/` reads the row**, so nothing is broken today; it is a trap for whoever finds it and
assumes it is usable.
- **The concrete loss:** the Reverse TO list (item 26) is a *physical walk* of the store, and sorting
  it by bin would cut the walk substantially. It sorts Category → Brand → Item Name instead, purely
  because bin data cannot be joined. This is the first real consumer bin locations would have had.
- Either rebuild it against current SKU codes (an ops task, not a code one) or delete the row. Do not
  wire anything to it first — **check the join rate before believing it**, which is the whole lesson.

### 28. A browser Apply strips `toTargets.invValue`, so the digest loses its ₹ line
Measured 2026-08-15: `params/toTargets.invValue` was **null** with `refreshedAt` at 06:38 IST — a
browser **Apply & Re-run Model**, not either nightly slot. `api/run-engine.js` stamps `invValue`
(`computeInvValue`); `applyAndRun` in `App.jsx` imports `computeInvValue` for the Overview KPI card but
does **not** write it into the row. So any daytime Apply blanks it until the next 05:45 engine run.
- Self-healing within a night and purely cosmetic — the digest omits the value line rather than
  printing a wrong one, which is the designed behaviour.
- Same shape as the Stage 8 duplicate bug: **two writers of one row, one of them silently dropping a
  field the other maintains.** Fix is one line in `applyAndRun`; worth doing next time `App.jsx` is
  open rather than on its own.

### 29. SKU Ceiling follow-ups, all consciously descoped 2026-08-15
Shipped without these, deliberately. Listed so they are decisions, not omissions.
- **Google Sheet sync.** CSV upload first, on the Stage 8 pattern — a sheet + published URL + sync all
  landing at once, the day after a sheet sync broke, was not worth it. When it arrives it inherits the
  `newSKUQty` situation: two writers that MUST agree on ambiguous input (append rule, blank vs 0).
- **An outlier discovery report.** Nothing surfaces ceiling candidates in the app, so the input will
  stay as empty as ops leaves it. `scripts/dryrun-sku-ceiling.mjs` and a days-of-cover sort are the
  manual substitutes. ⚠ This is the item most likely to make the feature quietly unused.
- **The rate-based DC gap** — 81 SKUs, ₹4.4L. See the ceiling section. ⚠ **Still open, and DC-only
  SKUs are NOT affected** — they take the strategy branch, then the `DC Cap`, so they are cappable.
- ✅ **A `DC Cap` column now exists** (2026-09-07), added for DC-only SKUs but applying to all. Ops
  adoption of the ceiling has been strong meanwhile: **815 SKUs** carry one, up from 0 at ship.
- **A DOC cap for Fixed Unit Floor.** PCT has `pctDocCap`/`pctDocCapLow`, plywood has `maxCap: 20`,
  Fixed Unit Floor has **nothing** — which is why all 10 top ceiling candidates are Fixed Unit Floor
  Finolex wire at 42–62 days of cover. One parameter would clear today's crop with no ops maintenance.
  Ceiling first was the right call (it generalises), but this is cheap and still open.

### 30. ✅ CLOSED 2026-09-07 — two floor-sheet reader gaps (found 2026-08-26)
Both latent, both the invoice-round-trip shape — a writer and a reader that disagree, failing `ok: true`.
Kept for the reasoning; **both are fixed**, and the ineffective report now carries **four** reasons
(absent · not Active · **Dead Stock** · **DC-only with DS floors**), deduplicated because a SKU can be
both. Live at close: 107 of 1,877 ineffective — 1 absent + 106 not Active, 0 dead-with-floor.
- **`scripts/dryrun-sku-floors.mjs` under-reports ineffective floors:** it counts "absent from
  `skuMaster`" and "not Active" but **not Dead Stock**, whose floor equally can never take effect.
  Measured live: of **1,798** floors carrying a value, **34 are ineffective — 4 absent + 24 not Active
  (14 of those also Dead Stock) + 6 Active-but-Dead-Stock**. Those 6 are exactly the SKUs from the Dead
  Stock bug, so the script called them healthy on the morning they were wrong.
  **Fixed in both places** — the script AND `sync-sku-floors`, which had the same two-reason gap.
- **⚠ `App.jsx buildDataCSV("newSKUQty")` QUOTES the SKU cell; `parseFloorSheet` never strips quotes.**
  Verified: feeding the app's own floors download to the sync's parser returns **`ok: true` with keys
  like `"\"ATGRU\""`** — every SKU matching nothing, reported as success. Harmless today (the sync reads
  only the Google Sheet; the browser's `parseCSV` strips quotes) but it is the exact shape of the invoice
  `⬇ Data` bug. **Emit floors CSVs UNQUOTED** — SKUs are plain alphanumeric; assert it before writing.
  **Fixed:** the writer now emits the SKU cell unquoted.

### 31. Purchase/Move follow-ups, all consciously deferred 2026-09-07
Listed so they are decisions, not omissions.
- **Hysteresis on `status`.** The operator confirmed `status` stays the FIRST gate (inactive ⇒ 0/0
  everywhere, beating everything), which is the conservative choice and keeps a discontinued item
  self-zeroing without anyone setting `Purchase=No`. **The cost is that the 2026-08-28 whipsaw stays**:
  a transient bulk deactivation still zeroes ~2,150 SKU×DS cells the same night and reverses the next,
  with **₹0.00** of visible value movement because those SKUs were unpriced. Hysteresis — apply a
  deactivation only after N consecutive nights, apply a re-activation **immediately** — is the fix, and
  the discriminator it exploits is the real one: **not magnitude, but persistence**. Machinery is a
  `{sku: consecutiveInactiveNights}` counter in `catalogueSyncStatus`. Explicitly the operator's call.
- **Dropping SKUs absent from `skuMaster` from `res`.** Agreed to defer: those entries are already
  `0/0` so **no number changes**, it only affects which lists include them (the Overview card's
  `Unknown` category row of 5 would go). ⚠ It is the ONE change here that **cannot** produce a
  byte-identical diff, because it changes the key set of `res` — so it wants its own change with its
  own diff, where a changed key set is the expected result rather than noise.
  ⚠ **Dropping from `skuMaster` on absence from the Zoho pull is a firm NO** — `assessCoverage` builds
  `knownSkus` from master keys, so it would push `unknownPct` past 1% and make **`sync-invoices` refuse
  to write**. One sync silently breaking another.
- **Aligning the `Purchase` dropdown to `Yes`/`No`.** It is `ON`/`OFF` while `Move` is `Yes`/`No`. The
  code accepts both deliberately (no dependency on a UI setting staying put), so this is cosmetic —
  but two vocabularies on adjacent fields is a trap for whoever maintains them.
- **A `Sell` flag, if the Shopify Draft signal is ever synced.** Today "we stopped selling this" lives
  in Shopify, and with two fields it has to be written as *two* values (`N/N`) — a lossy encoding of
  one fact. Don't build the field before the signal exists.
- **"Sold at the DC *and* the DSes."** `Y/Y` understates the DC once the DC can sell: the DC target is a
  pure replenishment buffer with no allowance for the DC's own retail sales, and those `DC01` rows are
  today either reassigned to a DS by attribution (inflating it) or dropped by `tags90`. The precedent
  for fixing it exists — `dcDetails.dsSeedAug` adds a synthetic rate into the DC calc.

### 34. ✅ CLOSED 2026-09-08 — two dry-run scripts had drifted from the code they check
Kept for the shape, which recurred twice in one file and is the `diag-items` shape: a diagnostic
drifting from its subject gives a confident wrong answer, which is worse than no check. **Neither was
prod code and neither could break anything** — the damage is being wrong exactly when someone is about
to do something risky, which is the only time these are run.
- **`dryrun-sku-master.mjs` called `Move=No` on a non-DC SKU "RED incoherent"** (13 SKUs) while
  `nightly-digest` had reported it green since the day it shipped, *and* its verdict text claimed "the
  nightly digest will go RED every morning", which was false. Now informational. The cost of leaving
  it: this script also emits **real** reds — SKUs that would be deleted, categories lost — and a
  standing false red teaches the reader to skip all of them.
- **`dryrun-sku-policy.mjs` printed "ALL ASSERTIONS PASSED" over 4 classes while claiming 5.** Now
  names the unbuilt ones and folds the count into the success line. See the ⚠ in the Purchase/Move
  section for why the lost class — unfloored DC — was the worst one to lose quietly.

### Later, not urgent
- **IMS reads the canonical stored result** instead of recomputing client-side — makes divergence
  structurally impossible and page loads much faster. Costs the "engine changes go live on next page
  load" property, and Impact Preview still needs client-side compute.

---

## Shipped — stable ID index

**Full text lives in `docs/CHANGELOG-ARCHIVE.md`** (not auto-loaded; open it when you
need to reconstruct why something was built the way it was). This index stays here for
one reason: **the numbers are stable IDs that appear in commit messages and PRs, so they
are never renumbered or reused** — and an index that left the file with the entries would
let the next feature silently reuse a taken number.

**Highest used: 34. `33` was never used (a gap, not a free slot — leave it). Next: 35.**

| # | what | shipped | live documentation |
|---|---|---|---|
| 1 | Category Network Analysis (Baskets + Plywood tabs) | 2026-04-18 | archive only |
| 2 | OOS Simulation — revived as a real backtest | 2026-06-18 | `src/engine/strategies/plywoodV2/CLAUDE.md` |
| 3 | Stock Health Tab | 2026-05-14 | Stock Health Tab § |
| 4 | *(retired — "rethink Tool Output tab", dropped 2026-08-03; done anyway that day as the download-cards rebuild)* | — | Tool Output Download Tab § |
| 5 | *(retired — "full UI polish pass", dropped 2026-08-03, never specified)* | — | — |
| 6 | Plywood Network Design strategy | 2026-04-28 | Network Design § |
| 7 | Read-only config visibility for non-admins | **open** | Open Work § |
| 8 | DC calculation for PCT + Fixed Unit Floor | **open** | Open Work § |
| 9 | DC Stock indicator in DS tabs | 2026-05-21 | Stock Health Tab § |
| 10 | Sync resilience — staggered cron jobs | 2026-05-22 | sync architecture § |
| 11 | DC tab — DS Req Covered tag | 2026-05-22 | Stock Health Tab § |
| 12 | Stock Health UX improvements | 2026-05-22 | Stock Health Tab § |
| 13 | invoiceData separation + Supabase compute upgrade | 2026-05-23 | Data Model § |
| 14 | Dead stock logic — Min=Max=0 everywhere | 2026-05-23 | Dead Stock § |
| 15 | Pincode demand attribution | 2026-07-27 | Demand Attribution § |
| 16 | Nightly model refresh from Zoho — Stages 4–8 | 2026-07-29 → 08-03 | sync architecture § + archive |
| 17 | Nightly digest | 2026-08-04 | archive + `docs/superpowers/specs/2026-08-04-nightly-digest-design.md` |
| 18 | `lastOkAt` written by each sync | **open** | Open Work § |
| 19 | Zoho export locale still `DD/MM/YYYY` | **open** | Open Work § |
| 20 | Pin the provenance invariant with a test | **open** | Open Work § |
| 21 | `demand through …` in the TO tool footer | **open** | Open Work § |
| 22 | Stale-tab gap — stale catalogue on Apply | **open** | Open Work § |
| 23 | DS06 cluster assignment | **open** | Open Work § |
| 24 | Day-of-week-aware invoice row-count floor | **open** | Open Work § |
| 25 | D-3 recheck re-fetches ~585 invoices to change ~2 rows | **open** | Open Work § |
| 26 | Reverse TO list — a count sheet, not a report | 2026-08-07 | Stock Health Tab § |
| 27 | `params/binLocations` is rot — 98.3% unjoinable | **open** | Open Work § |
| 28 | Browser Apply strips `toTargets.invValue` | **open** | Open Work § |
| 29 | SKU Ceiling follow-ups | **open** | Open Work § |
| 30 | Two floor-sheet reader gaps | closed 2026-09-07 | Open Work § (kept for the reasoning) |
| 31 | Purchase/Move follow-ups | **open** | Open Work § |
| 32 | Purchase / Move — commercial policy | 2026-09-07 | Purchase / Move § |
| 33 | *(never used)* | — | — |
| 34 | Two dry-run scripts had drifted | closed 2026-09-08 | Open Work § (kept for the shape) |


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

Key non-defaults (verified live 2026-07-31): `overallPeriod=45`, `newDSFloorTopN=250`,
`newDSList=["DS04","DS05","DS06","DS03"]` (DS06 added at go-live), `brandLeadTimeDays={_default:3,"Asian Paints":4}`,
`pctDocCap=30`, `pctDocCapLow=60`, `pctMinNZD=2`, **`dsSeed={}` — sunset 2026-07-31**, see the DS Seed
section for the measurement. Category strategies:
**11** — 8 PCT + 2 Fixed Unit Floor + Plywood=NetworkDesign (`Kitchen Sinks & Faucets` → PCT added 2026-07-30).
**A reload→Apply round trip is verified lossless** (2026-07-30: fresh Incognito load, Apply, all 7 params
rows byte-identical bar `_backedUpAt`/`refreshedAt`) — the historic "a reload changed my params" was the
`loadParamConfigRows` bug, now fixed. The write is always an Apply, never the reload itself. `fixedUnitFloor` defaults `{orderQtyPercentile:90, maxMultiplier:1.5, maxAdditive:1, minNZD:2, spikeCapMult:5}` — note prod Supabase `params/global.fixedUnitFloor` predates minNZD/spikeCapMult, so the engine reads them via inline `?? 2`/`?? 5` (shallow param-merge drops keys prod lacks).
