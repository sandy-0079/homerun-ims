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

HomeRun operates **8 dark stores (DS01–DS08) + one DC** (Rampura), of which **7 are trading** (DS07 HAL joined 2026-09-22; DS08 is wired but gated). This
tool computes Min/Max inventory levels for every SKU at every location so ops knows how much stock to
hold. `DS_LIST` in `constants.js` has eight entries and everything iterates it.

> ⚠⚠ **`DS_LIST` IS THE STORE UNIVERSE, NOT THE TRADING SET — use `liveDsList(params)` for anything
> a human or another system consumes.** **DS07 HAL went live 2026-09-22**; **DS08 Rajajinagar is
> still gated** and is now the only entry in `params/global.openingDSList` (see the Opening Shortly
> section in `src/engine/CLAUDE.md`). A gated store is fully present — Zoho branch, stock sync, floor
> and ceiling columns, plywood node — and contributes nothing: no `toTargets` rows, no PO CSV columns,
> no TO tool tab. **Going live is removing the store from `openingDSList` and nothing else** — that
> claim held: on 2026-09-22 the untick, the pincode remap and the `newDSList` edit were one Apply,
> and no other code changed.
>
> ⚠ **The go-live signature was NOT "Inv Value roughly flat" — it was +5.2%, and that was correct.**
> Measured 2026-09-22: ₹10.58Cr → ₹11.13Cr Max. Toggling only the gate moved exactly two locations
> (DS07 +14,358 Min, DC +2,727) and **no donor cell**, so nothing double-counted. The prediction came
> from reasoning about *demand* — attribution relocates it — but Inv Value is dominated by *floors and
> base minimums*, which barely shrink when marginal demand leaves a donor. Donors gave back only
> ~₹0.085Cr against DS07's ₹0.633Cr. **A new location costs a location's worth of floors.** Expect
> the same shape when DS08 opens; do not treat it as a fault.
>
> ⚠ **Backend is FULLY DEPLOYED as of 2026-09-19** — four edge functions, the `stock-sync-4` cron
> migration (`DS06,DS07`), and DS07/DS08 branch reachability all proven. DS07 syncs hourly. The
> floors sheet and ceilings csv carry DS07/DS08 columns. **DS08 has no stock cron by design**
> (Open Work #39) and must not join `stock-sync-4` — three branches in one invocation 429s.


---

## Where everything is documented

**This file is deliberately small and holds only what is cross-cutting or destructive.**
Everything scoped to one part of the codebase lives beside that code in a `CLAUDE.md`
that Claude Code loads **on demand** — when a file in that directory is read — rather than
on every session. Verified 2026-09-17, not assumed.

| file | covers | loads when |
|---|---|---|
| `CLAUDE.md` (this) | orientation, credentials, cross-cutting data-safety rules, open-work index, stable IDs | always |
| `src/engine/CLAUDE.md` | strategies, post-blend + DC ladders, Dead Stock, SKU Ceiling, attribution, DS Seed, Active-only, Inventorised-At, Purchase/Move | touching `src/engine/` |
| `src/engine/strategies/CLAUDE.md` | Plywood Network Design v1 | touching `src/engine/strategies/` |
| `src/engine/strategies/plywoodV2/CLAUDE.md` | Plywood v2 — ENGINE only; its tab was retired 2026-09-17 | touching that directory |
| `supabase/functions/CLAUDE.md` | Zoho API contracts, rate limits, token singleflight, crons, `create-to`, row inventory, deploy hazards, log recipes | touching `supabase/functions/` |
| `src/tabs/CLAUDE.md` | Stock Health + Tool Output UI, CSV contracts, freshness gate | touching `src/tabs/` |
| `docs/HANDOFF-2026-09-18-ds07-ds08.md` | DS07/DS08 go-live — what is deployed, what is not, and the order | **read before any DS07/DS08 work** |
| `docs/OPEN-WORK.md` | full open-work entries | read deliberately |
| `docs/CHANGELOG-ARCHIVE.md` | everything shipped | read deliberately |
| `docs/retired/README.md` | tabs removed 2026-09-17 (OOS Simulation, Plywood v2) + how to restore | read deliberately |

> ⚠⚠ **NEVER write a path as `@docs/foo.md` in any of these files.** `@`-imports resolve
> **eagerly at session launch**, so a path written in prose silently re-inlines the whole
> file into every session while the referencing file still looks small on disk — invisible,
> and the exact failure this split exists to avoid. **Always wrap paths in backticks**; the
> import parser skips code spans. `scripts/check-claude-md.mjs` asserts zero `@`-imports.

> ⚠ **`src/App.jsx` is 3,921 lines and is NOT in `src/tabs/`.** Overview, SKU Detail,
> Upload Data, Logic Tweaker and Manual Overrides live inline there, so editing them loads
> **no** directory file. Read `src/tabs/CLAUDE.md` deliberately when working in App.jsx.

### Keeping these files small

They reached 229,601 chars in one file because every incident appended and nothing was
ever removed. Two rules:

1. **Each file has a char budget**, asserted by `node scripts/check-claude-md.mjs`. Over
   budget is not a failure — it is the prompt to do rule 2.
2. **Promote the lesson, archive the incident.** The generalisable rule goes in the body;
   the blow-by-blow narrative goes to `docs/` with a date. A post-mortem is worth keeping;
   it is not worth keeping in the file that loads on every session.

Run the check after editing any of them — it proves nothing was lost against the frozen
`cdc457c` baseline, and refuses `@`-imports.

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
- **The full Supabase row inventory** — every `team_data` and `params` row, who owns it,
  and which backups are the only surviving copy of pre-July history — is in
  `supabase/functions/CLAUDE.md`. ⚠ For the params own-rows specifically, verify against
  `loadParamConfigRows()` rather than any written list: that list has been wrong before
  (it omitted `dsCapacities` until 2026-09-07).
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
  - **⚠ A two-writer field cannot carry an assertion about one writer. Ask who OWNS the
    field before checking it.** `toTargets.refreshedAt` looks like "when did the nightly
    run" and is not — any browser Apply overwrites it. A 2026-09-19 check asserting
    `refreshedAt == 06:15` passed all morning and then cried wolf the moment an operator
    clicked Apply at 14:39, on a completely healthy system. The nightly's own signal is
    **`params/engineRunStatus.at`**, which only the nightly writes. Same shape as the
    `invoiceSyncStatus.at` vs `.publishedAt` trap (`.at` is stamped on failures too) and
    the `autoAtFor` provenance bug. **The fix is never a better threshold — it is a
    single-writer field.** Report a shared field; assert on an owned one.

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

**`create-to` — the edge function that raises the draft Zoho TOs — is documented in
`supabase/functions/CLAUDE.md`.** It is the only write path into Zoho in this project.
Two things worth knowing without opening it: it sends `cf_to_type: "Mid Mile"` as a
server-side constant, and it **drops inactive SKUs from a TO rather than failing the whole
transfer** — Zoho refuses an entire TO if any line names an inactive item.

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

## Open Work — index

**Full entries in `docs/OPEN-WORK.md`** — the measurements, the rejected alternatives, and
the ⚠ marks saying why the obvious fix is wrong. Read that file before picking anything
up: several items exist specifically to stop a conclusion being re-derived that was
already measured and rejected.

Listed in **priority order, not numeric order**. IDs are stable — see the index below for
which numbers are taken.

| # | open item | one-line |
|---|---|---|
| 19 | Zoho export locale still `DD/MM/YYYY` | the documented rollback path is unusable until a Zoho *setting* changes; not code |
| 8 | DC calc for PCT + Fixed Unit Floor | 639 SKUs understocked; ⚠ **looks fixed and is not** — the adjacent floored and network paths got `Σ DS Min`, this branch did not |
| 25 | D-3 recheck re-fetches ~585 invoices to change ~2 rows | ratio stable over two nights; ⚠ the recheck is **not** optional and the two obvious fixes are both wrong — do the measurement phase first |
| 18 | `lastOkAt` written by each sync | a failed night can claim to be the source of the current value; `catalogueAt` still has the flaw |
| 20 | Pin the provenance invariant with a test | extract `autoAtFor` from `App.jsx`; literally the 2026-08-03 bug |
| 21 | `demand through …` in the TO tool footer | repo `homerun-to`; consequence there is transfer quantities |
| 22 | Stale-tab gap | a long-lived tab can no longer clobber, but still computes from a stale catalogue; download half closed, **Apply** half open |
| 7 | Read-only config visibility for non-admins | add `logic` + `overrides` to `PUBLIC_TABS`, disable inputs; copy the Plywood config pattern |
| 23 | DS06 cluster assignment | live since 2026-07-08, never assigned a cluster |
| 24 | Day-of-week-aware invoice row-count floor | a flat floor false-alarms every Sunday; a guard that cries wolf on schedule gets ignored |
| 27 | `params/binLocations` is rot | 1,148 entries, **20 joinable**; either rebuild against current SKU codes or delete the row — check the join rate before believing it |
| 28 | Browser Apply strips `toTargets.invValue` | digest loses its ₹ line until the next nightly run; one line in `applyAndRun` |
| 29 | SKU Ceiling follow-ups | sheet sync, outlier discovery report, the rate-based DC gap (81 SKUs), a DOC cap for Fixed Unit Floor |
| 30 | ✅ closed 2026-09-07 — floor-sheet reader gaps | kept for the reasoning |
| 31 | Purchase/Move follow-ups | hysteresis on `status` (operator's call), dropping absent SKUs from `res`, the `Sell` flag |
| 34 | ✅ closed 2026-09-08 — two dry-run scripts had drifted | kept for the shape: a diagnostic drifting from its subject is worse than no check |
| 35 | Remove the **Manual Overrides** tab | live `coreOverrides` is **0**, but the tab is the EDITOR not the feature — `mergeCoreOverrides` stays in the nightly engine path and the PO CSV |
| 36 | The **Plywood v2 engine** is still in the tree | tab retired 2026-09-17, engine kept; 21 files / 184 KB, reachable from nothing. ⚠ the Logic Tweaker option must go in the SAME change |
| 38 | `sync-stock` empty-body path syncs every branch | 8 branches = 4 sequential pairs ≈ 128s against a 150s wall clock; latent (no caller does it) but our change made it worse |
| 39 | DS08 has no stock cron | ⚠ do NOT add it to `stock-sync-4` — 3 branches in one invocation 429s after one group. Needs a 5th slot or the untested `per_page` lever |
| — | *Later, not urgent* | IMS reads the canonical stored result instead of recomputing client-side |


---

## Shipped — stable ID index

**Full text lives in `docs/CHANGELOG-ARCHIVE.md`** (not auto-loaded; open it when you
need to reconstruct why something was built the way it was). This index stays here for
one reason: **the numbers are stable IDs that appear in commit messages and PRs, so they
are never renumbered or reused** — and an index that left the file with the entries would
let the next feature silently reuse a taken number.

**Highest used: 39. `33` was never used (a gap, not a free slot — leave it). Next: 40.**

| # | what | shipped | live documentation |
|---|---|---|---|
| 1 | Category Network Analysis (Baskets + Plywood tabs) | 2026-04-18 | archive only |
| 2 | OOS Simulation — revived as a real backtest | 2026-06-18 | **retired 2026-09-17** — `docs/retired/README.md` |
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
| 35 | Remove the Manual Overrides tab | **open** | Open Work § |
| 36 | Remove the dormant Plywood v2 engine | **open** | Open Work § + `docs/retired/README.md` |
| 37 | DS07 HAL + DS08 Rajajinagar wired ahead of go-live; DS Seed retired | wired 2026-09-18 · backend 2026-09-19 · **DS07 LIVE 2026-09-22** (DS08 still gated) | Opening Shortly § in `src/engine/CLAUDE.md` · `docs/HANDOFF-2026-09-18-ds07-ds08.md` · spec in `docs/superpowers/specs/` |
| 38 | `sync-stock` empty-body path syncs every branch | **open** | Open Work § |
| 39 | DS08 has no stock cron | **open** | Open Work § |


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
**`newDSList=["DS06","DS07"]`** (2026-09-22 — DS03/DS04/DS05 were REMOVED in the same Apply that
added DS07, deliberately: they have traded long enough that the New DS Floor no longer applies.
Measured cost 130 units of Min ≈ ₹26k, and 179 of the 183 affected cells were caught by their sheet
floor at the same number), `brandLeadTimeDays={_default:3,"Asian Paints":4}`,
`pctDocCap=30`, `pctDocCapLow=60`, `pctMinNZD=2`, **`openingDSList=["DS08"]`** (⚠ read it with
`??`, never `||` — `[]` means "all trading"; see Opening Shortly in `src/engine/CLAUDE.md`).
⚠ `params/global.dsCapacities` is an **orphan copy the engine never reads** — plywood capacity is
DERIVED from `params/networkConfigs[ds].thick/thin.capacity` by `loadParamConfigRows`. Reading the
`global` copy gave a confidently wrong answer on 2026-09-22 (it said DS07 was 0/0 an hour after ops
had set 300/150). Query `networkConfigs`.
**`dsSeed`/`dsSeedCategoryMult` were deleted 2026-09-18** with the DS Seed pass; the orphaned keys
still sitting in prod's `params/global` are inert and deliberately not migrated away. Category strategies:
**11** — 8 PCT + 2 Fixed Unit Floor + Plywood=NetworkDesign (`Kitchen Sinks & Faucets` → PCT added 2026-07-30).
**A reload→Apply round trip is verified lossless** (2026-07-30: fresh Incognito load, Apply, all 7 params
rows byte-identical bar `_backedUpAt`/`refreshedAt`) — the historic "a reload changed my params" was the
`loadParamConfigRows` bug, now fixed. The write is always an Apply, never the reload itself. `fixedUnitFloor` defaults `{orderQtyPercentile:90, maxMultiplier:1.5, maxAdditive:1, minNZD:2, spikeCapMult:5}` — note prod Supabase `params/global.fixedUnitFloor` predates minNZD/spikeCapMult, so the engine reads them via inline `?? 2`/`?? 5` (shallow param-merge drops keys prod lacks).
