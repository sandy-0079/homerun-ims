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

## Category Strategy Engine

**Why:** 78.7% of SKU×DS combos are Slow/Super Slow. Averages produce near-zero Min for items selling once every 10+ days.

**✅ STANDARD IS THE DEFAULT, BY DESIGN — a category is Standard until someone changes it** (confirmed
with the operator 2026-08-05). This is intended behaviour, not a gap, and the earlier framing here
("a decision to make, not a default to accept") overstated it.

**⚠ BUT STANDARD IS ENCODED AS THE *ABSENCE* OF A KEY, so no audit can tell a deliberate Standard from a
never-considered category.** `App.jsx:4531` does `if (v === "standard") delete next[cat]; else next[cat] = v`,
and `resolveStrategy` (`runEngine.js:38`) returns `"standard"` for any missing key. Consequences worth
knowing before you write a check:
- **`categoryStrategies` can NEVER contain a Standard entry.** "Zero categories map to Standard" is true
  by construction, not a finding — don't report it as one.
- The old claim that "only 259 of 384 were the *intended* Standard categories" asserted a distinction the
  data cannot represent. It was somebody's judgement about which categories look intended, presented as
  measured. **Verified live 2026-08-05:** 11 mapped entries (8 PCT + 2 Fixed Unit Floor + 1 Network
  Design), **377 of 2,110 active SKUs on Standard, all of them unmapped** — Painting 110, General
  Hardware 90, Home Appliances 58, Fevicol 46, Glass Hardware 34, Water Proofing 19, Cement 18,
  Service 2.
- **The residual risk is visibility, not correctness:** a new Zoho category lands on Standard with nobody
  told. Glass Hardware (34 active SKUs, **zero sales in the window**) arrived this way. Audit by diffing
  `Object.values(skuMaster).category` against `params/global.categoryStrategies` — the key is
  **`categoryStrategies`** (plural).

| Strategy | Categories | Key Logic |
|---|---|---|
| **Standard** | *(default — the 8 unmapped categories above, incl. Cement, General Hardware, Painting, Fevicol, Water Proofing)* | Daily avg × base min days, long/recent blend |
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

Post-blend order (strict), **re-derived from `runEngine.js` 2026-08-26.** Inside the per-DS loop:
New DS Floor → Rounding (`Math.ceil`, and `preFloor*` captured here) → SKU Floor Override. Then as
passes over the **FINISHED `stores` map**, before the DC is derived from it: **SKU Ceiling** →
**Dead Stock**. Then as later passes over `res`: **DS Seed** → **Active-only** →
**Purchase/Move policy** → **Inventorised-At normalization**.

**The DC cell has its own ladder** (2026-09-07): branch (Dead Stock / **DC-only** / floored / rate /
network) → **DC Floor** (per-field max) → **DC Cap** (clamps both) → DS-Seed augmentation → **policy
(`Purchase=No` ⇒ 0)** → Inventorised-At. ⚠ **The DC-only branch MUST precede `isFlooredSKU`** — see
the Purchase/Move section.
- ⚠ **The two `stores`-map passes are NOT steps in the blend, and that distinction IS the bug below.**
  An earlier version of this line ran them together as inline steps; Rounding was also in the wrong
  place until 2026-08-15.
- **Generalisable: a rule that only ever REDUCES a value belongs in ONE pass over the finished object,
  never inline in the branch that computed it.** `applyCeilingToStores`, `applyDeadStockToStores`,
  Active-only and Inventorised-At are all this shape. Dead Stock was the odd one out and it broke.

### Dead Stock — Min=Max=0 everywhere (`src/engine/deadStock.js`)
`team_data/global.deadStock` (SKU array, ops-maintained, manual **by design**). Outranks every strategy,
floor and ceiling; zeroes all six DSes **and the DC**. Touches `min`/`max` only — `preFloor*` is left for
audit, same convention as Active-only and Inventorised-At.

**⚠⚠ IT WAS APPLIED INLINE IN THREE OF THE FOUR BRANCHES THAT BUILD `stores[dsId]` — fixed 2026-08-26,
commit `80cda31`.** The branch missed was NO-DATA-with-a-manual-floor, so a Dead Stock SKU with a
`newSKUQty` floor at a store **outside `newDSList`** and no sales there kept the floor as its Min/Max.
- Measured live: **6 SKUs, 12 cells, ₹0.86L** — `4BK45 EDUNK RYNJT RU5YU WUZUF Y8SCD`, each with an
  identical `1/1` floor at all six stores, reading `1/1` at **DS01/DS02** and `0/0` at DS03–DS06. Live
  `newDSList` is `["DS04","DS05","DS06","DS03"]`, so DS01/DS02 are the **only** stores that reach that
  branch. One SKU, one floor, two answers — the leak's signature is a store disagreeing with its siblings.
- **The DC was never affected** (`if (isDead)` already sat on the finished-map side), so those SKUs read
  DC `0/0` beside a non-zero DS — incoherent state the **TO tool acts on**, proposing DC→DS transfers
  against a DC target of zero.
- Present since `54e2b08` (2026-05-23): the missed branch already existed at line 206 that day.
- **⚠ WHY TESTS DIDN'T CATCH IT — the reusable part.** `skuCeiling.test.js` has a "Dead Stock still wins"
  case that **passed throughout**: its DS01 has demand, so it took a branch that worked. Identical to the
  ceiling post-mortem's own note — *the zero-demand case was never constructed*. And there was **no
  `deadStock.test.js` at all**, for the rule with the widest blast radius in the engine. Now
  `src/engine/__tests__/deadStock.test.js` (11) covers all four branches; 3 failed before the fix.
- **✅ DS Seed CANNOT reintroduce it — verified 2026-08-26, and this DIFFERS from the ceiling.** Dead
  Stock is SKU-wide, so every source store is 0 and `max(0, ceil(avg(0,0)))` is 0 (measured with
  `dsSeed:{DS06:["DS02","DS04"]}`: 48/64 seeded when live, `0/0` at DS02/DS06/DC when dead). A **ceiling**
  is per-DS and genuinely can be lifted back by a seed — do not copy that warning across.
- Read-only re-check: `npx vite-node scripts/audit-deadstock-leak.mjs` — runs the real engine and reports
  which of the four branches each non-zero Dead Stock cell came from.
- **Inertness proof for a change of this shape:** old vs new engine over live data, **2,375 SKUs →
  exactly 12 min/max changes, 0 DC changes, 0 logic-tag-only changes.** A `git stash` of the one engine
  file gets you the "before"; dump both to JSON and diff.

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
- **⚠ THAT SINGLE CALL SITE WAS A TRAP FOR FIVE WEEKS — fixed 2026-07-31.** Because `invoiceData` in
  React state stays RAW (deliberately, see above), every tab that computed its own demand by grouping
  `r.ds` was silently still on fulfilling-location behaviour while the engine used pincodes. SKU
  Detail's per-location chart therefore **contradicted the Min/Max printed beside it on the same
  screen**, and Plywood v2 showed different numbers than the engine would produce from the same config
  (`plywoodV2/` never attributes internally: via `runEngine` it gets attributed rows, from the tab it
  got raw ones — so an admin tuning and publishing from that view would have published a plan fitted to
  the wrong demand). Plywood v1 and Baskets had it too.
  - Fixed with **one derivation** in `App.jsx` — `attributedInvoice = useMemo(() =>
    applyAttribution(invoiceData, params.pincodeConfig), …)` — passed to SKU Detail, Plywood v1,
    Plywood v2, Baskets and Simulation. `OverviewTab` deliberately still gets raw: it never groups by
    `r.ds`, so attributing would change nothing.
  - **⚠ `runEngine` still gets RAW `invoiceData`** and attributes internally. Double-applying is
    harmless (idempotent — `r.pin` is never modified) but it is a trap for the next reader, so keep the
    two paths distinct. **If you add a tab that reads `invoiceData`, pass it `attributedInvoice`.**
  - Measured effect on what the tabs display (45d window): **20.5% of demand lines change store.**
    DS06 **+190%** (credited 5.1% of demand while its catchment generates 14.8%), DS02 **−34.9%**,
    DS05 −20.1%, DS03 +7.9%, DS04 +6.4%, DS01 −2.3%. No engine or `toTargets` change.
  - Same commit fixed two DS06 blind spots: `SD_DS_OPTS` (the SKU Detail store picker) was hardcoded
    to five stores while the rest of the tab used `DS_LIST`, so DS06 data existed with no per-store
    view; it now **derives** from `DS_LIST`. `BasketAnalysisTab` had a stale local five-store `DS_LIST`
    (now imports the canonical one), and `simWorker.js` had one ×2 — it **cannot** import (Web Worker),
    so the literal is completed to six with a comment saying why it is duplicated.
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
  mapping, DS02 keeps receiving those orders while stocked for fewer. (The 560111 gap is **closed** —
  verified live 2026-07-30: `560111 → DS03`, 128 pincodes mapped, mode `shippingCode`.)

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
Seeds a new DS's Min/Max from the **equal-weight average of source DSes** — built for DS06 Kogilu, whose catchment carves ~50% of orders each from DS02 and DS04. Config: `params.dsSeed = { DS06: ["DS02","DS04"] }` (Logic Tweaker → "DS Seed — New Store Bootstrap" checkbox; empty object = inactive).

**✅ SUNSET 2026-07-31 — `dsSeed = {}` is now live, and this was the right call.** Superseding the
earlier "do NOT sunset yet" note (measured 07-27: 2,374 → 1,482 stocked SKUs, 892 → zero, ₹23.0L).
That note reasoned from the *map's* sparseness — "16 pincodes over a mostly pre-launch window is too
thin" — and set a ~90-day calendar trigger. Both were wrong, for the same reason:

- **⚠ THE "PRE-LAUNCH WINDOW" ARGUMENT IS INVALID, and it is easy to re-derive by mistake.** Attribution
  applies the **static current mapping to ALL history** on purpose (see Demand Attribution), so
  pre-go-live orders from DS06 pincodes are reassigned to DS06. DS06 therefore has a **full 45 days** of
  real catchment demand, not 23. Anyone re-opening this question will be tempted by "half the window
  predates go-live" — it does, and it does not matter.
- **DS06 is not a data-poor store.** Measured 2026-07-31 over `2026-06-16 → 07-30` with
  `shippingCode` on: attributed demand share **DS01 26.3% · DS03 21.5% · DS02 16.9% · DS06 14.8% ·
  DS04 11.3% · DS05 9.1%.** Its 16 pincodes out-earn two long-established stores, and bought **941
  distinct SKUs** in the window.
- **The decisive measurement — the seed was inventing assortment, not bridging thin data.** Of the
  **431** SKUs that lose DS06 stocking when the seed is removed, **417 (97%) have ZERO DS06-attributed
  demand in 45 days**; the other 14 have exactly one order-day each (111 units total). Of the ₹19.5L the
  seed added, **₹18.8L sat on zero-demand SKUs.** By category the 431 were: Furniture & Arch HW 117 ·
  Wires/MCB 85 · CPVC 57 · Plywood/MDF 32 · Sanitary & Bath 32 · Tiling 27 · Switches 18 · Lighting 14.
- **Why, mechanically:** under `shippingCode`, DS02's and DS04's historical orders *from DS06 pincodes
  have already been moved to DS06*. Seeding DS06 from their averages then adds back their **remaining**
  demand — which belongs to other catchments. It is not filling a gap.
- **The chicken-and-egg objection does not apply**, which is what makes the sunset safe: a SKU never
  stocked at DS06 can still be ordered by a DS06-catchment customer and fulfilled elsewhere, and
  attribution credits it to DS06 by pincode. So "zero attributed demand" means that catchment has not
  wanted it — not that it was unavailable.
- **Residual protection:** DS06 stays in `newDSList` with `newDSFloorTopN` 250, so the New DS Floor
  still guarantees baseline breadth. ⚠ The floor does **not** compensate for the seed — the 431-SKU drop
  was measured with the floor active in both runs. Different jobs: the floor gives a new store top-N
  breadth, the seed mirrored its donors' whole assortment.
- Decay confirms it had done its job: the same removal cost **892 SKUs on 07-27 and 431 on 07-31** as
  DS06's own history accumulated.

**⚠ GENERALISABLE — a bootstrap justified by "no data" must be re-tested when the DEFINITION of the data
changes, not when a calendar trigger fires.** The 07-27 note set a 90-day review. What actually
obsoleted the seed was the attribution flip four days later, which changed what "DS06 demand" *means*.
Re-derive with `applyAttribution` + a two-way `runEngine` diff (`dsSeed:{}` vs `{DS06:[…]}`) rather than
trusting either this entry or the calendar. Re-enabling it needs a fresh measurement, not a rollback.
- Per SKU, per field: `DS06 = max(organic/floor value, ceil(avg(sources)))` — "whichever wins". `ceil` ⇒ union assortment. logicTag `DS Seed`, audit entry in `postBlendSteps`, `preFloor*` untouched.
- **⚠ WHILE ACTIVE, A 5-COLUMN SKU-FLOOR FILE SET SIX STORES — no longer true since the 07-31 sunset,
  but re-read this before re-enabling.** A floor lifting DS02 and DS04 propagated to DS06 through the
  seed. Worked example (2026-07-30, `SMBTV`): a `2/5` floor on DS01–DS05 took DS06 from `2/2` to `2/5`
  as well, because both its sources became 5. With `dsSeed = {}` a floor now sets exactly the columns
  you type — the ops sheet carries explicit DS06 columns (260 SKUs) and those are the only thing setting
  DS06 floors.
- Runs after all strategies/floors, **before Inventorised-At normalization** — Supplier/DS-inv zeroing still wins; Dead Stock propagates (0+0→0).
- **DC re-derived treating the seeded DS as a real sixth store** (deliberate transition overstock — sources are never reduced; both self-correct as carved-out demand leaves source history ~45 days post-go-live): rate-based SKUs add a synthetic rate `max(0, avg(source rates) − organic DS06 rate)` into `sumDailyAvg`; floored SKUs add the seed deltas into Σ DS sums; Network Design adds `ceil(ΔMin × brand dcMult)`. DC never decreases. Audit: `dcDetails.dsSeedAug`.
- Tests: `src/engine/__tests__/dsSeed.test.js` (18).

### SKU × DS Ceiling — the ops override for outliers (SHIPPED + PROVEN LIVE 2026-08-15)
An absolute cap on Min/Max at a store, whatever the strategy computed.
`team_data/global.skuCeiling = {sku: {DS: cap}}`, sixth `BROWSER_OWNED_KEY`, CSV upload on Upload Data.
Engine: `src/engine/skuCeiling.js` (`capFor` / `clampToCeiling`), parse+write `src/skuCeilingCsv.js`.

**WHY, with the case that prompted it.** `G9NYZ` (Finolex 300m coil, ₹6,269) came out **19/29 at DS05**
off two order-days — **20 units on 07-09, 1 on 07-29**. Fixed Unit Floor's P90 of `[20,1]` is 18.1; its
order-days gate needs `NZD >= 2` and NZD was exactly 2; its spike cap needs **≥3 orders** and there were
2. Both guardrails correctly declined. ₹1.82L of wire at one dark store. **This is the "2-order spike"
CLAUDE.md logged as a consciously accepted gap in July** — the doc predicted the shape a month before it
bit. The decision was a blunt manual cap rather than a fourth guardrail for the fifth outlier to slip past.

**⚠⚠ BLANK AND 0 ARE OPPOSITES, and this is the one place NOT to copy `parseFloorSheet`.** That parser
folds a blank cell into 0 because for a FLOOR they say the same thing. Here: **blank = no cap**,
**0 = stock nothing at this DS**. Fold them and a mostly-blank sheet zeroes the network. 0 is a wanted
case — Dead Stock zeroes every location *including the DC*, so it cannot express "none at DS01–03,
normal at DS04–06". `capFor` returns `null` (never `undefined`) for "no cap" so `if (cap)` can never
silently drop a zero-cap; the same trap made `skuCeilingSummary` count presence, not truthiness.

**⚠ THE CEILING BEATS THE SKU FLOOR, deliberately** — a cap a floor can overrule is not a cap. Not
theoretical: **7 of the top 10 candidates have an ops floor exactly equal to the engine's own output**
(19/29, 10/15, 3/5 …), so for those the ceiling is overriding the *floor sheet*, not the strategy.
Measured across all 8,033 floor cells against a no-floor run: **73.3% genuinely lift the strategy,
14.1% (1,132) are identical to it, 12.6% sit below it.** 161 of the echoes are at Max ≥ 10. An echoed
floor is *stickier* than the outlier — if demand later falls, the floor holds the old high number
forever. A cap below a floor is legal but usually a typo, so the upload preview lists them.

**⚠⚠ `runEngine` WRITES `stores[dsId]` FROM FOUR PLACES, AND THE FIRST IMPLEMENTATION CLAMPED ONE.**
Shipped 2026-08-15 morning, found in production the same afternoon. The per-DS loop has a **NO-DATA
path that `return`s early** with three sub-branches (new-DS floor / manual floor / neither), plus the
**Network Design bypass** builds its own `_stores` entirely separately. Clamping inside the HAS-DATA
branch therefore did nothing at any store where the SKU had **no sales in the window** — which is
exactly where a manual floor is usually the thing setting the number, i.e. where a ceiling matters most.
- Symptom: `G9NYZ` capped at **0** for DS01 still read **Min=Max=1**, because DS01 had zero demand and
  a 1/1 floor. Blank and non-zero caps looked fine, so it presented as "0 doesn't work".
- **The tell is `postBlendSteps`:** every store built by the main loop has `[]`; the NO-DATA branches
  never create the key at all, so it reads `undefined`. **A differing shape means a different code
  path** — the fastest way to find this class of bug in this engine.
- Why testing missed it: the cap was verified on `UVVJB`/DS01 and `HZKY8`/DS01 and **both had demand**.
  The zero-demand case was never constructed.
- **Fix: ONE `applyCeilingToStores()` helper applied to the FINISHED `stores` map**, called at the two
  structural sites (main path, Network Design bypass) immediately before each derives its DC. Four
  copies of a clamp would have been the same bug waiting to recur.
- **⚠ It must run BEFORE the DC and the sums must come from `stores`.** `sumMin`/`sumMax` feed the
  floored DC branch (`round(sumMin × 0.2)`); they used to be push-as-you-go arrays filled *before* the
  clamp, so they now derive from `stores`. Verified inert: pre-fix vs post-fix with no ceilings,
  **0 of 2,273 SKUs differing across all six stores AND the DC**.
- **Generalisable, and this is the THIRD instance in one day** (the others: the floor sheet's parser vs
  `handleNSQ` on duplicates, and the digest reading `change.reason` while the reason lived at the top
  level). When you add behaviour to a value, **grep for every place that value is CONSTRUCTED, not just
  where it is read.**
- **⚠ It does NOT reach the rate-based DC branch** (`ceil(sumDailyAvg × (leadTime+1))`), which derives
  from raw demand. Measured: **1,405 of 1,486 candidate SKUs (94.5%) carry a floor** and so are on the
  DC branch that follows the cap; **81 do not** (₹4.4L of ₹290L). Known, pinned by a test, not fixed.
- **⚠ DS Seed runs LATER** and would lift a seeded store back over its cap. Inert today (`dsSeed = {}`)
  and deliberately untouched — re-enabling the seed must revisit this.
- **✅ PLYWOOD / Network Design IS capped at DS level** — verified 2026-08-15 on `TJSTU`/DS01
  (ArchidPly, `strategyTag: network_design`): **12/15 → 2/2**, tagged and audited. 395 network-design
  cells are cappable. This only works because the four-writers fix put the clamp in that bypass; it
  did NOT work in the morning's first implementation.
  - **✅ AND THE PLYWOOD DC NOW FOLLOWS TOO (fixed same day).** It did not at first: the DC is
    `dcP95 + ceil(sumMin × dcMult)` computed inside `computePlywoodNetworkResults` from UNCAPPED
    mins, and the floored-SKU calc downstream is a `Math.max` FLOOR on top of it — never a
    replacement — so a smaller store sum could not pull it down (`TJSTU` capped 12/15 → 2/2 while
    its DC sat at 30/39). Fix: `dcResult` now exposes **`dcP95` and `sumMin`**, and `runEngine`
    re-derives the DC from the clamped stores. `TJSTU` → **DC 30/39 → 25/33**.
  - **⚠⚠ THE SUM MUST BE `min(preFloorMin, min)`, NOT `min` — and getting this wrong inflated EVERY
    plywood DC.** `_stores[ds].min` carries the SKU FLOOR lift; the network's own `sumMin` is the
    **pre-floor node basis**. Summing the floored value took `TJSTU` from 30 to **39 with nothing
    capped at all**. A floor only ever raises, so the lower of the two is the node basis when
    uncapped and the capped value once a ceiling bites — which makes the re-derivation reduce to
    `sumMin` exactly. **Verified: 0 of 2,273 SKUs differing (all six stores AND the DC) with no
    ceilings.** The re-derivation runs unconditionally for that reason: making it conditional would
    hide a formula drift instead of failing loudly.
  - ⚠ A floor still raises the DC through the **separate** floored-SKU multiplier
    (`Math.max(dc, round(sumWithFloors × mult))`). That path is unchanged and is not the network term.

**✅ PROVEN ON THE NIGHTLY PATH, not just in the browser.** `POST /api/run-engine {"mode":"dry"}`
runs the entire production path and writes nothing (`wroteTo: null`) — the way to test the 05:45 cron
without waiting for it or touching `toTargets`. ⚠ The proof is **`invValue`**, not
`inputs.skuCeiling`: that stamp counts `team_data.skuCeiling` directly and reads the same whether or
not the engine was actually handed the map. Live check agreed to 4 dp across three independent paths
(browser KPI, local engine, Vercel dry run).

**⚠ ONLY EVER REDUCES, which is the rollout property.** A 0/0 cell with a cap of 5 stays 0/0. With
`skuCeiling` absent the engine is provably a no-op: verified against live data,
`diff-headless-totargets.mjs` **0 of 2,072 SKUs differing**. So the code shipped ahead of any data.
Dead Stock still wins over a cap (0 ≤ any cap).

**⚠ THE ONLY UPLOADER THAT DOES NOT WRITE ON DROP.** Per the operator there is **no hard guard** on this
input, so the confirm modal IS the protection: it parses, runs the engine BOTH ways and shows cells
capped / **zero-caps broken out separately** / Inv Value before→after / floor conflicts. Nothing is
written until Apply. Rollback is the card's `🗑 Clear` (writes `{}` — a deliberate clear, not
"unchanged"). Duplicate rows follow the **append rule**, identical to the floor sheet.
Read-only measurement without touching prod: `npx vite-node scripts/dryrun-sku-ceiling.mjs <file.csv>`.

**⚠ `runEngine` gained an 8th positional arg (`ceilings = {}`) and the default is a silent no-op.** A
call site that forgets it publishes UNCAPPED targets with nothing looking wrong — the
`loadParamConfigRows` trap. All 9 App.jsx sites, `api/run-engine.js` and 4 scripts were updated
together, and `toTargets.inputs.skuCeiling` is stamped as the DETECTOR: that count next to a non-empty
`team_data/global.skuCeiling` is how you would catch a missed writer.

### Purchase / Move — commercial policy (SHIPPED 2026-09-07)
Two item-level Zoho dropdowns that answer what `status` and `inventorisedAt` could not: *may we buy
more*, and *may the dark stores hold it*. `src/skuPolicy.js` (+ a Deno mirror, below).

**The 2x2 is COMPLETE and has NO invalid states, which is why there is no third `Sell` flag:**

| Purchase | Move | means | DC target | DS targets |
|---|---|---|---|---|
| Y | Y | normal | as today | as today |
| Y | **N** | **DC-only** — buy at the DC, sell from the DC, never transfer | **category strategy on TOTAL demand** | 0/0 ⇒ no TO |
| **N** | Y | winding down, still distributing | 0/0 ⇒ no PO | as today ⇒ TOs keep pulling |
| **N** | **N** | withdrawn | 0/0 | 0/0 |

A `Sell` flag was considered and dropped: it added three *incoherent* combinations (`Sell=No,
Purchase=Yes` = buy stock for something you don't sell) needing a master-switch derivation and a
guard, and it had **no actuator** — IMS does not control Shopify listing, so it could only ever have
expressed itself as the zeroes the other two already produce.

**⚠ TOPOLOGY OUTRANKS POLICY.** `inventorisedAt` is *which arcs exist*; the flags are *which existing
arcs we use*. So `Supplier` ignores both, and a **DS-inventorised SKU ignores `Move`** — that flag
governs the DC→DS arc and the arc does not exist there. **One arc, one switch.** `policyOf()` forces
`move` true wherever it cannot act, so no caller has to remember the rule.
- **⚠⚠ THIS WAS SHIPPED AS A RED ALERT AND THAT WAS WRONG — corrected the same day, and the mistake is
  worth more than the fix.** The argument was the floors-miss argument: *"`Move=No` on a non-DC SKU is
  anomalous BY CONSTRUCTION, there is no legitimate reason to set it, so it can essentially never fire
  spuriously — which earns a first-occurrence red."* **The very first real dataset falsified it: ops had
  set 11 deliberately.** `Move` genuinely does not matter for a DS-direct SKU whichever way it is set.
  - **And the dangerous case is INDISTINGUISHABLE from the benign one.** "Meant DC-only, got
    `inventorisedAt` wrong" and "set `Move=No` on a DS-inv SKU, which does nothing" look identical in
    the data; only a human knows the intent. A nightly red nobody can action except by editing Zoho to
    silence it is the **Sunday-row-count mistake**, and it would discredit the reds beside it.
  - Now **green and informational** (`policy.moveNoEffect`), still listed because it is the only place a
    mis-set `inventorisedAt` would ever surface. **Generalisable: "no legitimate reason to set this" is
    a claim about OPS BEHAVIOUR, not about the code — so it cannot be asserted from the code, and it is
    exactly the kind of claim the first real dataset can refute.** Prefer green until measured.
  - Still worth doing: **leave `Move` blank on DS-inv and Supplier SKUs** — it does nothing there.
  - **⚠ `scripts/dryrun-sku-master.mjs` CALLED THIS "⚠ RED incoherent" FOR A DAY — fixed 2026-09-08.**
    The digest was corrected on 09-07 and the script was not, so two readers of one fact disagreed —
    the TO deep-link shape exactly, where the right answer already existed in one place and never
    propagated. It also *predicted* a red digest in its verdict text, which was simply false. Now
    reports it informational and says the digest is green. **When a severity ruling changes, grep for
    every place that RESTATES it, not just the one that raised it.**
- `Purchase=No` on a DS-inv SKU necessarily also stops it selling — one number drives both the PO and
  the shelf. **13 SKUs, accepted limitation.** A `Sell` flag would not have fixed it.

**⚠⚠ THE ZOHO FIELDS USE DIFFERENT VOCABULARIES AND THE api_name IS NOT GUESSABLE.** From the live
field definitions:

| label | api_name | options | default |
|---|---|---|---|
| Purchase | **`cf_purchase_status`** | **`ON` / `OFF`** | ON |
| Move | `cf_move` | `Yes` / `No` | Yes |

- Both are **Dropdown**, not checkbox — which is what avoids the `"false"` catastrophe below.
- **Both carry a DEFAULT, so a wrong api_name fails INVISIBLY as that default rather than as a blank**
  — the `cf_to_type` trap verbatim. `catalogueSyncStatus.policy.fromZoho` is the ONLY way to tell
  "nobody has set a value" from "we are reading the wrong field". A test pins both names and asserts
  `cf_purchase` (what you'd guess from the label) is **not** it.
- Both vocabularies are accepted (`no`/`off` ⇒ No) and **canonicalised to Yes/No** for storage, so the
  PO CSV never shows two spellings — the `normaliseStatus` lesson.

**⚠⚠ BLANK MEANS YES — the OPPOSITE of the `status` rule, deliberately.** `status` follows *"absent
data is not evidence"*; here absence is the overwhelming normal state (all ~2,573 items blank, ~12 new
SKUs blank daily), so fail-closed would zero the entire network on night one and silently un-stock
every new SKU after. **`"false"` is NOT No**: `customField()` stringifies before its empty-check, so an
unchecked checkbox returns the *string* `"false"` — counting that as No is the catastrophe. Anything
outside both vocabularies is treated as Yes and **reported** (`policy.unrecognised`, amber).

**⚠⚠ THE DC-ONLY BRANCH MUST PRECEDE `isFlooredSKU`, AND THAT IS NOT COSMETIC.**
`isFlooredSKU = !!(nsq && nsq[skuId])` tests **presence of the SKU key**, not any value — so the moment
a DC-only SKU is given a DC floor it would otherwise land on `round(sumMin × 0.2)`, i.e. 20% of its own
**DS** mins, which are still un-zeroed at that point because the `Move=No` pass runs later over the
finished `res`. Plausible-looking and meaningless. Measured on `DBQC2`: **7/12 → 10/13**.

**Why the DC runs a STRATEGY rather than the rate formula.** The rate branch is a *replenishment
buffer* sized off store demand, and open item #8 already records that it understocks erratic demand —
which a DC-only item has no store to fall back on for. So the SKU's own category strategy (PCT / Fixed
Unit Floor / Standard) runs against **total demand**, summed from every row rather than from per-DS
`dailyAvg`: attribution only *relabels* rows, so unmapped-pincode DC sales keep `ds="DC01"` and
`tags90` never reads them. Same counterfactual as attribution's static map — *"what if this had always
been sold only from the DC"*.
- **Network Design is skipped for DC-only SKUs** — it is entirely about *which DS nodes* stock a brand,
  and its DC term collapses to the P95 once every store is zero. They take
  `plywoodNonNetworkStrategy` instead. Measured on `5PDDQ`: **24/31 → 67/89**.
- **⚠ Flagging a Rare-zone SKU DC-only can START stocking it.** `KSK9H` (GreenPly, 3 order-days split
  across DS02/DS05) is **Rare at every plywood node** (NZD < `minNZD`) so it reads 0/0 everywhere
  today; pooled into one location NZD is 3, above the PCT gate, giving **DC 5/6**. Inv value goes *up*
  for that class. Set a `DC Cap` alongside the first few.

**DC is now a floor and a ceiling location.** Floors gain **two** columns (`DC Min`, `DC Max` — a floor
is two-sided); the ceiling gains **one** (`DC Cap` — `clampToCeiling` applies a single absolute cap to
both). Both apply to **every** SKU, not only DC-only ones: symmetric with the DS columns, and a column
whose meaning depends on another field is how things drift here. Provably inert until filled.
- **⚠ A DC-only SKU with no demand and no DC floor is stocked NOWHERE.** Measured on the first real
  file: **3 of 19** had zero demand in 90 days. That is what the DC floor is *for*.
- **⚠ The floor column had to change in the SHEET parser too, not just the browser.** The sheet
  replaces `newSKUQty` **wholesale at 04:35 IST**, so a DC floor the sync ignored would be dropped
  every night while reporting `ok: true`. **Put DC floors in the Google Sheet, not only in a CSV.**
- Ladder: **floor lifts → cap clamps → Dead Stock → policy.** *A cap a floor can overrule is not a
  cap*; and policy beats a stale floor **for free**, because it is one later pass over the finished
  `res` — exactly the property the Dead Stock post-mortem bought.

**⚠ `_shared/skuPolicy.ts` DUPLICATES `src/skuPolicy.js`** because Deno cannot import from `src/`.
`skuPolicy.agreement.test.ts` imports **both** and asserts they answer identically across 34 values
including every ambiguous one. The invoice `⬇ Data` bug, the floor-sheet duplicate incident and the TO
deep link were all two sides agreeing on the happy path and diverging on an ambiguous input — this
makes that mechanical rather than a matter of discipline.

**⚠ NO new `runEngine` argument.** The flags ride on `skuMaster`, already passed, arriving as
`r.meta.purchase` / `r.meta.move`. That avoids the whole failure class the ceiling had, where an 8th
positional arg defaulting to a no-op meant a forgetful call site published uncapped targets.

**⚠ `policyChanged` compares NORMALISED values on both sides.** That is what stops the first run after
deploy reporting ~2,573 phantom transitions — no stored entry has these fields yet, and
`normalisePolicy(undefined) === "Yes"` equals the new value. A literal comparison would have flagged
every SKU and buried any real move (the same failure as `norm()` reporting 13 fake `Confirmation
Pending` transitions). **Reported, never blocking**, and stored in full.

**⚠ `toTargets` still EMITS DC-only SKUs, with all-zero `perDS`** — byte-identical to how Dead Stock
SKUs have been published since May 2026, and `homerun-to`'s solver handles it (`triggered = cur <= min`
with min 0 gives `req = max(0, 0 − cur − it) = 0`). Filtering them would shrink the target count into
`assessTargetsChange`'s >20% collapse guard, which exists to catch an **input** that failed to load,
not a policy change. **`homerun-to` needed no deploy.**
- **⚠⚠ NEVER PUT A `DC` KEY IN `perDS`.** Verified in `homerun-to`: `solver.js` does
  `Object.keys(perDS)`, iterating the KEYS rather than a hardcoded DS list, so a DC entry would render
  a DC row and attempt a **DC→DC transfer**. Inert until the DC became a first-class location for
  floors and ceilings — so the instinct to "add DC everywhere for symmetry" now reaches it.

**Inertness proof, and the harness that produces it.** `scripts/snapshot-engine-inputs.mjs` →
`dump-engine-output.mjs` → `diff-engine-dumps.mjs`: **0 of 18,046 cells differing across 2,578 SKUs**,
Inv Value identical to 4 dp, re-verified after every step.
- **⚠ THE SNAPSHOT IS THE POINT.** Prod inputs move nightly (sliding window, retention trim, catalogue
  sync, floors re-read), so "dump today, dump again after the change" shows differences from the
  **clock**, not the code — and those look exactly like a regression. The diff **refuses** to compare
  dumps from different snapshots, and counts min/max changes separately from **tag/branch-only**
  changes, because identical numbers arriving via a different code path is how both the four-writers
  ceiling bug and the Dead Stock branch bug presented.
- **Inertness says nothing about whether the feature WORKS** — a policy pass that never fired would
  pass it perfectly. `scripts/dryrun-sku-policy.mjs` asserts the outcome of all four combinations
  against real SKU classes, **using the real `ON`/`OFF` + `Yes`/`No` values**: testing with
  Yes/No on both would pass while `Purchase = OFF` silently meant Yes in production.
  - **⚠⚠ IT PRINTS "ALL ASSERTIONS PASSED" OVER A SHRINKING SET — 4 classes, not 5, measured
    2026-09-08.** Classes are `pick()`ed from live data and `.filter(Boolean)`'d, so one that no longer
    exists is dropped **silently**. The lost one is "DC + active + has demand + UNFLOORED": the floors
    sheet grew 1,877 → 2,201, leaving exactly **one** unfloored DC-active SKU (`MAXT8`, created that
    day, no demand). **A check whose coverage is decided by prod data narrows as the data moves while
    still reporting success** — the ceiling's untested zero-demand branch again. **Fixed 2026-09-08:
    unbuilt classes are NAMED and the count is carried into the success line itself** (`4 of 5 SKU
    classes — ⚠ 1 class(es) NOT TESTED`), so a pass cannot be read without its gap. Deliberately still
    exit 0 — a missing class is a fact about prod data, not a defect, and failing every run would
    train the reader to ignore the script.

**⚠ `scripts/dryrun-sku-master.mjs` exists because THE SKU MASTER UPLOAD REPLACES ENTIRELY AND HAS NO
GUARD** — floors, invoices and ceilings all have one. A file short by 200 rows silently deletes 200
SKUs, and `inventorisedAt` alone decides whether a SKU is stocked anywhere. It parses with the **real**
`parseCSV` and reproduces `handleSKU`'s mapping, which is how the first bulk file's **`Item Name`**
header was caught: IMS read **`Name`**, so all 2,573 item names would have been blanked — including on
the Reverse TO list, where the name is how the DS team finds the item on the shelf.
- **✅ CLOSED 2026-09-08 (`4be7846`): `handleSKU` accepts `Item Name` as an ALIAS for `Name`**, the
  same one-line shape as `Category`/`Category Name` beside it. Forced by the Tool Output tab's
  `SKU_Master.csv`, which emits `Item Name` and, once it gained `Purchase`/`Move`, carried **every**
  field the parser reads — so it looked re-uploadable and was not. Round-tripped on live data: 2,574
  rows, name column resolved as `Item Name`, **blank names after parse 0 (was 2,574)**, 0 SKUs dropped.
- **⚠ The script MIRRORS the alias and must keep mirroring it**, resolving name as an alias PAIR so a
  well-formed file reports no missing column either way.

**⚠ INV VALUE CANNOT VERIFY AN UNPRICED SKU.** On the first real floors file, **7 of 15 DC floors were
`50/50` on UNPRICED SKUs** — 350 units of committed stock that move the rupee figure by **₹0.00**.
Identical to 2026-08-28, where 161 cells zeroed while the money read ₹0.00. Check the **cell count and
the cells**, never the money; and an unpriced SKU is already stocked at the **95th percentile** under
PCT, so it is the worst class to get wrong silently.

### Active-only normalization (final engine override, LIVE 2026-07-30)
**Only SKUs `active` in the SKU Master get non-zero targets.** Runs immediately before the
Inventorised-At pass below, with the same conventions: zero `min`/`max`, leave `preFloor*` for audit,
record `zeroedReason`, and **KEEP the entry** (consumers iterate `Object.keys(res)`, and the Upload
tab's "SKUs in Invoice not Active in SKU Master" warning needs them visible).
- **⚠ Before this, `status` gated Min/Max NOWHERE in the engine.** Its only appearances were a
  Zero-Sale tag and two lines that *fabricated* a master entry for any SKU seen in invoice data:
  `skuM[skuId] || { …, status: "Active", inventorisedAt: "DS" }`. Measured on live data: **9 SKUs**
  got targets they had no business having — 4 in the master but not active, 5 absent from it entirely
  (orphaned pre-July codes like `FUT-DURA-24-18-8`, from the ~2026-07-01 Zoho re-code). 6 carried real
  quantities, including `Z8DJK` at 10 units ≈ ₹1.6L, a SKU ops had marked not-for-sale.
- **Fabricated meta now says `status: "Unknown"`, not `"Active"`.** That claim was the lie every other
  symptom followed from. The rest of the meta is still fabricated — consumers read `r.meta`
  unconditionally and would crash on undefined.
- **An allowlist of exactly `"active"` is the only safe rule** — Zoho's vocabulary already includes
  `confirmation_pending` and can grow. A **missing** status still counts as active (the established
  `(status || "Active")` convention for a master row that omits the field) — distinct from a SKU
  absent from the master.
- **Measured effect (exact):** Inv Value Max **₹8.0195Cr → ₹7.9952Cr**, Min **₹5.6369Cr → ₹5.6238Cr**
  — i.e. the Overview card reads **8.02 → 8.00**, −₹2.43L. `toTargets` rebuilt from the new engine is
  **byte-identical** to the old (0 SKUs lost/gained/changed) because it already filtered
  `status==="active"` *and* `inventorisedAt==="dc"` — so the TO tool was never exposed. Stock Health
  already filtered too. Overview's "Active SKUs" 2,106 → 2,101 and its `Unknown` category row goes.
- ⚠ **`toTargets` escaping was luck, not design:** unknown SKUs were fabricated as `"DS"` and the
  filter only admits `"dc"`. Had that default been `"DC"`, phantom SKUs would have been reaching the DC
  team's transfer orders. Every consumer was separately remembering to filter; now the engine doesn't
  emit them. Tests: `src/engine/__tests__/activeOnly.test.js` (10).
- ⚠ **Reconciling an Inv-Value delta: the KPI sums `Object.entries(results)` — EVERY entry**, not the
  `activeSkus` set (`App.jsx` `kpis`). That is why non-active SKUs were in the headline figure at all,
  and it is the trap that made a first pass at this misquote the before/after as 8.00 → 7.98: a
  per-class breakdown printed at 2dp (`active 8.00 + non_active 0.02 + absent 0.01`) reads as
  self-consistent while the active subtotal is silently the *after* number. **Reconcile parts against
  the total at full precision** whenever the measurement's purpose is a before/after delta.

### Inventorised-At normalization (final engine override)
Applied as a last pass over `res` in `runEngine` (after all strategies, floors, Dead Stock), keyed on `meta.inventorisedAt`. Same character as Dead Stock — a structural location constraint. Zeroes `min`/`max`, leaves `preFloor*` intact for audit, tags `dc.dcDetails.zeroedReason`.
- **Supplier** — never stocked in our network → Min=Max=0 at every DS **and** DC. (Was previously getting real targets; this removes their phantom value from Overview/SKU Detail/Tool Output/Overrides — Stock Health already filtered them.)
- **DS-inventorised** — replenished directly to the DS, bypasses the DC → DC Min=Max=0, DS values kept.
- **DC-inventorised** — flows through the DC → untouched.

> Engine output is **recomputed client-side on every load** (`runEngine` in App.jsx load effects) — there is no stored-results blob. So engine changes go live for all users on the next page load after deploy; no "Apply & Re-run Model" needed (that button only re-pushes params/overrides).

**Downstream of Supplier exclusion:**
- **OOS Simulation** (`simWorker.js` `runSim` + `runActualStockSim`) explicitly skips Supplier SKUs via `inventorisedAt==='supplier'` — independent of the engine zeroing (holds even if a floor pushed Max>0; the actual-stock sim doesn't read Max at all). The dead inline `runSim`/`median` in App.jsx were removed (2026-06-30).
- **Overview tab** store selector "All" = **All Locations (incl. DC)** — `getInv` sums DS01–DS05 **+ DC** so the category/brand/SKU table rollups tie out to the KPI "Inv Value" cards (which always include DC). Coverage figures in "All" mode include DC stock vs DS-only sales by design.
- **⚠ Overview's "Active SKUs" card counts ENGINE RESULTS, not `skuMaster` rows — the two use different
  denominators.** Measured 2026-07-30: card read **2,106** while the master held **2,101** active, the
  difference being an **`Unknown` category row of 5** that does not exist in the master (zero active SKUs
  there lack a category). Those 5 are SKUs appearing in invoice data but absent from `skuMaster` — the
  same population as the 0.014% unknown-SKU rate — and they draw real inventory value (₹35.7K Inv Min)
  with no category to drive strategy selection, so they fall through to Standard. Don't reconcile the
  card against a `skuMaster` count and conclude something is broken.

---

## Network Design — Plywood Stocking

**Activated via:** Logic Tweaker → Category Strategy Map → "Plywood, MDF & HDHMR" → "Network Design". Off by default; PCT runs unchanged when inactive.

**v2 — capacity-aware successor (`network_design_v2`):** a separate engine in `src/engine/strategies/plywoodV2/` that stocks every SKU at every DS sized to fit shelf capacity, with a lean-reorder + one-bulk-order DC buffer (replaces v1's brand-node matrix). **Shipped to prod DORMANT 2026-06-18 (PR #11)** — admin-only "Plywood v2" tab (Locations / Assortment-Keep-Score / Settings / OOS-Sim views); the live engine stays on v1/PCT until an admin selects "Network Design v2" in the Logic Tweaker + Apply (reversible). Config in `params/plywoodNetworkV2Config` (own row). **Authoritative doc: `src/engine/strategies/plywoodV2/CLAUDE.md` — read it for v2 work.** v1 (below) is unchanged.

**Concept:** Brand-level assignments — each brand is stocked at specific DS nodes which aggregate demand from multiple DSes. Non-stocking DSes get Min=Max=0 (fulfilled from stocking node or DC).

**Current brand assignments (live Supabase config, re-verified 2026-08-05 — code defaults in constants.js are stale):**
- All four brands (Action Tesa, CenturyPly, ArchidPly, GreenPly) stocked at **every DS, each node covering only itself** (no cross-DS coverage, no DC direct-serve nodes — the engine also `continue`s on any `DC` node key). Per-brand dcMultMin/dcMultMax = **0.75/1.0**, identical across all four.
- Merino: excluded from this tab, uses PCT.
- **DS06 IS in all four brand matrices** (verified live 2026-07-31 — added at go-live, superseding an
  earlier note here that said it was absent and relied on the DS Seed to fill it). With the seed now
  sunset, DS06's plywood stocking is entirely organic: **75 SKUs vs 107 under the seed**, and the 32
  difference are Rare-zone by the network's own `minNZD` rule (NZD < 2), i.e. correctly not stocked
  rather than a gap.

**3-zone stocking per SKU (NZD = non-zero demand days in lookback). ⚠ Re-derived from
`plywoodNetwork.js` on 2026-08-05 — the formulae here were WRONG for both stocked zones:**
- **Rare** (total NZD < minNZD=2): Min=Max=0, not stocked
- **Sparse** (2 ≤ NZD < sparseNZD=5): `Min = ceil(ABQ)` · **`Max = min(max(winsorisedMax, Min+1), maxCap)`**.
  ABQ = total qty ÷ orders, from **regular** orders only.
- **Frequent** (NZD ≥ 5): **`Max = min(max(winsorisedMax, P95+1), maxCap)`**, then
  **`Min = min(P95, max(0, Max−1))`** — note Min is derived *from* Max and can be pulled BELOW P95 to
  keep Max > Min. P95 is of winsorised **regular** daily demand.
- **⚠ Both Maxes are driven by `winsorisedMax` — the largest winsorised regular day — NOT by a
  percentile of order quantities and NOT by `ABQ × a multiplier`.** The old text said
  `Max = Min + P75(orders)` and `Max = ceil(Min × abqMult)`; neither exists in the code.

Winsorising: daily demand capped at `median × spikeCapMultiplier` before P95 to handle outlier days.

**⚠ Zone classification uses TOTAL NZD, but Min/Max use REGULAR orders only** — a mechanism this file
previously omitted entirely. Orders above `bulkThresholdMultiplier × cross-DS ABQ` (or ≥
`bulkMaxThreshold` outright) are classed **bulk**, excluded from DS stocking, and left to the DC.
`minOrdersForBulkFilter` is the minimum total orders across all DSes before the ABQ-based threshold is
trusted; below it only the hard floor applies. So a SKU can be Frequent by NZD and still have
`regularNZD = 0`, in which case it gets Min=Max=0.

**DC formula:** `DC = P95(direct-serving DSes) + ceil(Σ DS_Min × dcMult)`. Uses Σ DS_Min (not Σ(Max-Min)) so fast-movers get proportional DC buffer. **Floored SKUs:** DC result is floored to `max(network_dc, Σ DS_Min × skuFloorDCMultMin / Σ DS_Max × skuFloorDCMultMax)` — same global multipliers as non-network floored SKUs (defaults: 0.2/0.3).

**Config:** Plywood tab → ⚙ Network Design Configuration (admin; visible read-only to all). Stored in
`params/plywoodNetworkConfig` (separate from `params/global`). Saving auto-reruns engine.

**⚠ LIVE VALUES, read from the row 2026-08-05 — the code defaults in `engine/constants.js`
(`PLYWOOD_NETWORK_CONFIG_DEFAULT`) are STALE and deliberately left so; the live row wins. Quote the live
column, not the default:**

| key | live | code default |
|---|---|---|
| `lookbackDays` | **45** | 90 |
| `minPercentile` | 95 | 95 |
| `maxCap` | 20 | 20 |
| `spikeCapMultiplier` | **4** | 3 |
| `minNZD` | 2 | 2 |
| `sparseNZD` | 5 | 5 |
| `bulkThresholdMultiplier` | **1.5** | 2.0 |
| `minOrdersForBulkFilter` | 5 | 5 |
| `bulkMaxThreshold` | 10 | 10 |
| `thickBoundaryMm` | 9 | 9 |
| `capacityTolerancePct` | **1** | 2 |
| `sparseErraticThreshold` | 1.5 | 1.5 |
| `dcCapacity` | **`{thick:1200, thin:600}`** | `{thick:400, thin:400}` |
| per-brand `dcMultMin`/`dcMultMax` | **0.75 / 1.0** (all four brands) | — |

- **⚠ The key names are the LONG forms** — `spikeCapMultiplier`, not `spikeCapMult`. This file used to
  say `spikeCapMult=3` / `abqMult=1.5`, borrowing the abbreviated names from **`fixedUnitFloor`'s**
  namespace, where `spikeCapMult` *is* a real key. Different config, different spelling. A doc error, not
  a code one: the engine destructures the long names and the live values are in effect.
- **An earlier line here claimed `dcMultMin/dcMultMax` were "tuned to 0.3/0.5". Wrong** — live is
  0.75/1.0 on all four brands, which is what the brand-assignment paragraph above already said. That
  contradiction is resolved in favour of 0.75/1.0.
- **⚠⚠ `maxBufferPercentile` and `abqMultiplier` WERE DEAD KNOBS AND ARE NOW DELETED (2026-08-05).**
  Both were read from config and never used — by the engine *or* the tab — while remaining editable in
  the admin config UI, `maxBufferPercentile` under the hint "Max = Min + PXX of historical order
  quantities at this node", describing a calculation that never ran. Someone had moved them from their
  defaults (75→45 and 1.5→1.25) with **zero effect on stocking**, which is how the doc error above got
  believed. Removed from `plywoodNetwork.js`, `PlywoodNetworkTab.jsx` (locals, the trace field, and both
  UI fields) and `PLYWOOD_NETWORK_CONFIG_DEFAULT`. Engine output verified **byte-identical** after
  removal — `diff-headless-totargets.mjs`, 0 of 2,039 SKUs differing.
  - **eslint already knew.** Both were `no-unused-vars` entries inside the 79-problem lint baseline; the
    count dropped to **76** on deletion. A dead config knob is visible to the linter *before* anyone
    notices the docs are wrong — worth a glance at that baseline rather than treating it as noise.
  - **⚠⚠ WHERE THE WRONG FORMULA CAME FROM — CLAUDE.md WAS DOCUMENTING THE PLAN, NOT THE BUILD.**
    `docs/superpowers/plans/2026-04-27-plywood-brand-stocking.md:36` specifies, verbatim:
    `Max = min(Min + P{maxBufferPercentile}(individual order qtys across covered DSes), maxCap)`
    — which is exactly the sentence that sat in this file for three months. The plan also specified a
    `computeOrderBuffer()` helper, and **that helper exists in `plywoodNetwork.js` and is never called**
    (`no-unused-vars`, still flagged). So the feature was **half-built**: helper written, config key
    added, UI field added, hint written — and the call site never created. Nothing failed, because a
    coherent fallback (`winsorisedMax`) was already computing Max.
    - **This was never doc *drift*. It was wrong on day one and no measurement ever contradicted it**,
      because the doc, the plan, the UI hint and the live config value all agreed with each other. Four
      mutually consistent sources, none of them the code.
    - **Generalisable: after shipping from a plan, re-derive the doc from the BUILD.** A plan describes
      intent; a half-implemented plan leaves intent looking like fact. The check that catches it is
      cheap — read the function that computes the number, or grep the config key for a *use* rather
      than a declaration.
  - **The live row still carries the two orphan keys** (`maxBufferPercentile: 45`, `abqMultiplier: 1.25`).
    Deliberately NOT stripped — nothing reads them, and editing prod config to tidy a comment is a worse
    trade than leaving two inert keys. Expect to see them in the row; they do nothing.

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
  the last *complete* IST day. Trading ends 20:00 IST and ops POs start ~07:30 IST, so the night is
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
`DC=3915979000000118466`, `DS01=3915979000000054002`, `DS02=3915979000000054017`, `DS03=3915979000000054032`, `DS04=3915979000000054047`, `DS05=3915979000000054062`, `DS06=3915979000000118484`

**DS06 Kogilu (go-live ~2026-07-08):** sync layer is DS06-aware (stock/PO/TO data accumulates in Supabase). **Phase 2 (2026-07-06, now in `main`):** `DS_LIST` includes DS06 (Stock Health tab/KPIs/DC ROS/DS Req Covered follow automatically; 6th `DS_COLORS` entry added) + engine **DS Seed pass** gives DS06 Min/Max = avg(DS02, DS04) — see the DS Seed section. Both go-live steps are **done**: DS06 is in `newDSList`, and DS06 is in all four plywood brand matrices. **The DS Seed was sunset 2026-07-31** once pincode attribution gave DS06 a full 45-day catchment history — see the DS Seed section for the measurement and the reasoning. Review later: cluster assignment.

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
frontend push. (Lint baseline `npx eslint src/` is **75 problems** — measured 2026-08-15, re-confirmed
2026-09-17; this line has said 68 and 79 at different times, so **re-measure rather than trusting it**.
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
