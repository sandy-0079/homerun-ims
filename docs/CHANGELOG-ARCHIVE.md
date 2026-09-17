# HomeRun IMS — shipped changelog (archive)

Lifted verbatim out of the root `CLAUDE.md` on 2026-09-17, when that file was
229,601 chars and warned on every session. Nothing here was edited: this is the
`## Shipped — changelog` section byte for byte as it stood at commit `cdc457c`.

**This file is not loaded automatically.** Root `CLAUDE.md` keeps the stable-ID
index — number, title, ship date, and where each entry's live documentation now
lives — so IDs can never be reused and you can find any entry from there. Come
here for the full text, usually when reconstructing why something was built the
way it was.

**The numbers are stable IDs.** They appear in commit messages and PRs, so they
are never renumbered or reused. See the index in root `CLAUDE.md` for which are
taken.

---

## Shipped — changelog

Kept because several entries carry durable knowledge (Stock Health's columns, dead-stock semantics, the
DS-Req-Covered formula, the whole Stage 4–8 design). Not a work list.

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
- **TWO download buttons since 2026-08-07** — `⬇ Download All SKUs` (the file above, unchanged
  behaviour and column order, renamed only) and **`⬇ Download Reverse TO list`** (DS tabs only; a
  reverse TO moves stock DS → DC, so it has no meaning at the DC). See item 26.

### 26. Reverse TO list — a count sheet, not a report ✅ Shipped (2026-08-07)
`⬇ Download Reverse TO list` on every DS tab. **10 columns, position-stable:**
`SKU · Item Name · Category · Brand · Movement Tag · Stock Health · SoH System · SoH Counted · Max ·
Reverse TO Qty`. Sorted **Category → Brand → Item Name** so the physical walk groups shelf-neighbours.
It is a **worksheet**: the DS team counts each SKU, types the count into `SoH Counted`, and
`Reverse TO Qty` computes itself.
- **⚠ ALWAYS BUILT ON ACCOUNTING STOCK, whatever the Accounting/Physical toggle says** — the DS teams
  only ever count against accounting. `reverseToRows` is deliberately **not** derived from
  `allSkuRows`, which follows the toggle. Taking the row SET from one basis and printing SoH from the
  other would be silently inconsistent, and the gap is large: on 2026-08-07 DS01 showed **448 Excess
  on Accounting vs 643 on Physical**, so ~195 rows would have sent people to shelves for stock that
  is not over target on the basis they are counting against. Verified byte-identical on both toggles.
  Falls back to physical only if accounting data is entirely absent.
- **⚠ IGNORES the category / brand / search / tag filters, on purpose.** This is a stock-return sweep;
  a filtered file would silently omit stock and nothing in the sheet would reveal the omission.
- **⚠ The formula is BLANK-GUARDED: `=IF(H{n}="","",MAX(0,H{n}-I{n}))`.** Both Excel and Sheets treat
  an empty cell as 0, so a bare `MAX(0,H-I)` renders **"0" on every row before anyone counts**, which
  reads as "return nothing". With the guard, **blank = not yet counted** and **0 = counted, nothing to
  return** — a distinction the sheet needs. `MAX(0,…)` stops a negative when a count comes in below Max.
- **⚠ The formula carries BOTH commas and quotes**, so it goes through the same `q()` escaper as the
  text fields — hand-escaping it would split the row and shift every column right of it. Verified by
  parsing the generated file with an RFC4180 reader: **0 of 448 rows had anything other than 10
  fields**, despite item names and categories containing commas.
- Filename `Reverse_TO_List_<DS>_Accounting_<YYYY-MM-DD>.csv` — `Accounting` is a **literal**, not the
  toggle, and the date is there because this gets run repeatedly and counts must not overwrite.
- Every row reads `Excess` in Stock Health (kept for consistency with the other file). The distinction
  that actually drives the decision is **`Max`**: `Max = 0` ⇒ not stocked here, return everything;
  `Max > 0` ⇒ return the surplus.

### 9. DC Stock indicator in DS tabs ✅ Shipped (2026-05-21)
DC Stock column added between Req Qty and Rep. Qty on DS tabs. Shows DC SoH for DC-inv SKUs, follows mode toggle, hidden on DC tab.

### 15. Pincode demand attribution ✅ Shipped & LIVE (2026-07-27, PR #13)
`src/engine/attribution.js` — see the Demand Attribution section. Flag flipped to `shippingCode` on
2026-07-27; network Max ₹7.81Cr → ₹7.68Cr. Pincode 560111 → DS03 **done** (128 pincodes mapped as of
2026-07-30).
**✅ Ops-routing question CLOSED 2026-08-03: routing follows this mapping, because the uploaded CSV *is*
the ops routing sheet** — `parsePincodeMapCsv` accepts their working sheet (the per-DS 60/90/120-min
column blocks) directly, so the map is a copy of operational truth rather than a modelling assumption.
That is what makes DS02 being stocked ₹16.4L lighter safe.
- **⚠ BUT IT IS A POINT-IN-TIME COPY WITH NO SYNC — the two drift silently.** Nothing notices if ops
  revise their sheet; IMS keeps attributing on the version last uploaded through Logic Tweaker, and the
  only symptom is a store quietly stocked for the wrong catchment. **So the durable rule is a process
  one: when ops change the routing sheet, re-upload it.** Worth a `pincodeMap`-age line beside the other
  freshness signals if this ever bites (there is no `uploadProvenance` entry for it today).

### 16. Nightly model refresh from Zoho — Stages 4-8 ✅ ALL LIVE (2026-07-29 → 2026-08-03)
Automates the whole input chain so the model refreshes overnight without a manual CSV. **Stage 5 landed
last, on 2026-08-03, completing the chain.** Kept in full below: this is the design record for six
deployed surfaces, and most of the ⚠s are the reasons the current shape is what it is.
- **Stage 4 (REWORKED + DEPLOYED 2026-07-29; target flipped to the live row by Stage 5 on 2026-08-03
  — read the Stage 5 entry below for what that changed):** `sync-invoices` → **`team_data/invoice_data`**
  (`TARGET_ROW`, `index.ts:58`). Migration `20260729000001` **applied**: one cron
  `invoices-sync-window` at **`5,15,25 19-22 * * *` UTC = 00:35–03:55 IST**, twelve slots
  (eight until 2026-08-04). Replaces the
  16:00/:06/:12 UTC jobs, which were built on the false "invoices complete by 20:30 IST" premise.
  - **Why overnight:** the day must be **settled**, not merely closed (see the Zoho INVOICES API
    section — a 21:30 pull lost 27.7% of quantity to `partially_paid`/`sent`). The window is idle
    (trading ends 20:00 IST, POs start ~07:30 IST) and clear of `:35–:50`.
  - **ATOMIC PUBLISH — the load-bearing safety property.** Chunks accumulate in
    `team_data/invoice_sync_buffer`; the target row is written **exactly once**, only when every planned
    date is fully pulled and both guards pass. IMS recomputes the engine client-side on every page load,
    so a partial invoice row would immediately show wrong Min/Max — and TOs are sometimes raised as late
    as ~02:00 IST. Any failure leaves the target holding the previous complete pull. **Timing alone
    cannot give this; atomicity can.**
  - **CONCURRENCY 4, chunks of 250, one hour apart** — reverted from 8. See "the 429 cascade": 8 drew
    429s continuously and its own backoff sleeping blew the 150s wall clock. With twelve slots there is
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
  - Exit criteria (met; Stage 5 shipped 2026-08-03). `compare-invoice-shadow.mjs` was **deleted
    2026-08-04** along with the shadow row it read.
  - **⚠ RECONCILING A DIFF: THE DIAGNOSTIC IS *DIRECTION*, NOT SIZE** (learned 2026-07-30, night 1).
    A **leak subtracts only** — 07-28 lost 27.7% of quantity one-directionally, 146 whole orders, all
    missing. A **freshness gap goes both ways**: the shadow both over- and under-counts, because the CSV
    export is taken hours after the pull. Night 1 showed 9 differences, every one traced to a named
    invoice whose Zoho state changed after the pull, and the arithmetic closed exactly
    (`+5 −2 −1 = +2` rows, `+5 −3 −1 = +1` qty). Three causes, all expected: an invoice **voided** after
    the pull (the documented ~0.9% residual), one **created** after it, and a **line item added** to an
    existing one. So do not read "0 SKU×DS differences" literally against a same-day export — check that
    every difference resolves to an invoice and that losses are not one-directional.
  - **⚠ A CUMULATIVE ROW MAKES ANY "do they agree?" VERDICT UNTRUSTWORTHY** (learned from the
    now-deleted `compare-invoice-shadow.mjs`; the lesson outlives the tool).
    It compares every overlapping date, including dates fetched by *older, buggier* code that were never
    re-fetched. Night 1 printed "❌ 3 of 4 dates disagree — do NOT proceed to Stage 5" while 07-27
    (0.6%) and 07-28 (25.5%) were simply stale pre-fix rows and only 07-29/07-26 were the new code's
    work. Cross-check `invoiceSyncStatus.publishedPlan` for which dates a run actually touched. The D-3
    re-fetch overwrites a stale date wholesale, so they heal on their own schedule.
  - **The D-3 re-fetch is verifiably doing its job:** on 07-26 the only difference from the CSV-uploaded
    row was one invoice present in the CSV (exported 07-29) and absent from the re-fetch (run 07-30) —
    voided in between. **The shadow was the more correct of the two.**
- **Stage 5 (✅ LIVE 2026-08-03):** `TARGET_ROW` in `sync-invoices/index.ts:58` is now `"invoice_data"`.
  CSV upload stays as a manual override. Commit `e9640ea`.
  - **The cutover evidence, because it is the template for verifying this kind of flip.** The shadow row
    was reconciled against a Zoho export covering 07-27…08-02 with the **real `parseInvoiceCsv` on both
    sides** (`scripts/compare-csv-vs-live.mjs`, then pointed at the shadow row), so a parser difference
    could not masquerade as a sync
    bug: **8,028 of 8,028 sellable CSV rows present, `in CSV but MISSING from shadow: 0` on all seven
    dates**, identical qty and SKU×DS aggregates on six of seven. The one difference (07-31, shadow +2
    rows) was invoice `HC/26/015391`, **voided after the pull** — the documented ~0.9% over-count
    residual of the `{void,draft}` blocklist, corrected by the D-3 re-fetch.
  - **⚠ THE LEAK METRIC IS `in CSV but MISSING from shadow`, AND IT MUST BE ZERO ON EVERY DATE.** That
    single line is what would have caught 07-28's 27.7% loss. Six-of-seven-identical was a *stronger*
    result than seven-perfect would have been: the CSV is a snapshot hours after each pull, so some
    drift is physically expected, and what matters is that every difference resolves to a named invoice
    and that losses are never one-directional.
  - **The live row was BACKFILLED from the shadow first** (07-30…08-02 via
    `scripts/backfill-invoice-dates.mjs --apply` — **deleted 2026-08-04**, a one-shot helper that would
    be actively wrong to re-run), because `planNightDates`' fixed 3-day lag would not
    have reached 08-01/08-02 for three more nights, and `pctMinNZD` / `fixedUnitFloor.minNZD` / the
    plywood Rare-Sparse boundary all gate on **NZD ≥ 2** — so a missing day can drop a slow mover out of
    its strategy entirely. 75,699 → **78,765 rows, 93 contiguous dates**.
    - 07-30 was **replaced**, not just appended: live held a pre-void-correction 1,220 rows where both
      the CSV and the shadow said 1,214, and that date's single D-3 recheck had already fired, so
      nothing would ever have corrected it. 0.008% and immaterial to Min/Max — done because we had
      proof of the right value and no second chance.
  - **⚠ A ROW-COUNT SANITY FLOOR MUST BE DAY-OF-WEEK AWARE.** The runbook's "< 800 rows ⇒ stop and
    investigate" fired on 08-02 (752 rows) and cost a morning. **Sundays are structurally ~40% lighter:**
    13 Sundays in the window measured min 382 / median 522 / max 760, vs non-Sunday median 866. At 752
    rows / 349 orders, 08-02 was the *second-busiest Sunday on record*. Compare against the same
    weekday's median, never a global floor — a guard that cries wolf on schedule gets ignored.
  - **⚠ AN OUT-OF-BAND SCRIPT WRITE IS INVISIBLE TO THE PROVENANCE UI.** `uploadProvenance` assumes
    exactly two writers (browser, and each sync's own status row). The backfill script was a third and
    stamped neither, so for ~14 hours the Data Inputs chip read `✓ Model up to date` while `toTargets`
    held 07-30 and the row held 08-02. Deliberately **not** patched by stamping `uploadProvenance` —
    that would have planted a "click Apply & Re-run Model" prompt for an action consciously deferred
    (see the ops-cycle note in Stage 6). If you hand-write an input row, either accept the gap for one
    night or re-run the engine.
  - **Backups:** `team_data/invoice_data_backup_20260803` — 75,699 rows, 90 dates, verified row-for-row
    and date-for-date **before** live was touched. Restore = copy that payload back into `invoice_data`
    (read-merge-write, never a partial PATCH). The older `invoice_data_backup_20260728` (73,178 rows)
    is still there. Take a fresh dated backup before any change of this shape; it turns a one-way door
    into an undo.
  - **`team_data/invoice_data_shadow` is GONE (deleted 2026-08-04)** once Step 5 passed. It had been
    frozen since the cutover — a stale 07-26…08-02 snapshot nothing read. The three dev scripts that
    read it were dealt with in the same commit, because **a script that reads a missing row produces a
    confident wrong answer** — the `diag-items` / `categoryStrategy` lesson: `compare-invoice-shadow.mjs`
    and `backfill-invoice-dates.mjs` **deleted**, `compare-csv-vs-shadow.mjs` **renamed to
    `compare-csv-vs-live.mjs` and repointed at `invoice_data`**. That one is worth keeping: it reconciles
    a Zoho CSV against live demand using the REAL `parseInvoiceCsv`, which is the check that would have
    caught 2026-07-28. The **rollback** noted in `sync-invoices/index.ts` is unaffected — reverting
    `TARGET_ROW` upserts the shadow row back into existence.
  - **⚠ The retention trim bites for real from the first live night.** The row sat at 93 dates, so
    adding 08-03 makes 94 and `RETENTION_DAYS = 90` trims **four**: 05-02…05-05, 2,354 rows,
    **permanently and un-refetchably** (pre-July, and the API cannot serve them).
    `mergeInvoiceRows`' guard is `datesAfter >= datesBefore - datesTrimmed`, which computes to
    90 ≥ 89 — verified safe before the flip. The 2026-08-03 backup is those four dates' last copy.
  - **⚠ APPEND-ONLY IS A DATA-SAFETY RULE, NOT AN OPTIMISATION.** The current Zoho org has no invoices
    before **2026-07-01** (org migrated; the old Books org is retired and we are not wiring it up).
    Everything earlier exists ONLY in the Supabase payload, hand-uploaded from CSV — the API cannot
    reproduce it, so a full-window rebuild would destroy it permanently. Enforced by
    `mergeInvoiceRows`, not merely intended.
  - Self-sufficiency arrives once the retention window starts on/after 2026-07-01: **~14 Aug 2026** at
    45-day retention, **~28 Sep 2026** at 90-day.
- **Stage 6 (✅ LIVE 2026-07-31):** headless engine run → `params/toTargets`, so the TO tool no longer
  depends on a human clicking Apply. **`api/run-engine.js` — a VERCEL serverless function, not a
  Supabase edge function**, scheduled by pg_cron (`engine-run-nightly`, 05:45 + 06:15 IST, body
  `{"mode":"live"}`). Status in `params/engineRunStatus`. Design doc:
  `docs/superpowers/specs/2026-07-31-stage6-headless-engine-design.md`.
  - **⚠ `toTargets` NOW HAS TWO WRITERS** — `applyAndRun` in App.jsx and the nightly run. They share
    `src/toTargets.js` (`mergeCoreOverrides` + `buildToTargets` + `buildInputsStamp`, 31 tests), which
    is the only thing keeping them from drifting. An earlier note here said App.jsx was the *only*
    writer; that is no longer true.
  - **`invValue: {min,max}` — a top-level key on the row since 2026-08-04**, for the nightly digest's
    directional line. Computed by **`src/invValue.js`**, shared with App.jsx's `kpis` so the email and
    the Overview card cannot disagree.
    - **⚠ IT CANNOT BE DERIVED FROM `toTargets` ITSELF, which is why the engine stamps it.** Measured
      2026-08-04: `buildToTargets` carries **DS columns only** and DC-inventorised Active SKUs only, so
      a value computed from that row came out **₹5.29Cr against the card's ₹7.93Cr — 33.3% short**,
      because the DC alone is **27.0%** of network Max. Mailing that beside an app reading 7.93 would
      be worse than mailing nothing.
    - Computed from **`raw`, not `built`** — the same basis as `kpis`, which sums **every** entry in
      `results` over DS_LIST **+ DC**. Overrides are empty today so raw and merged coincide; matching
      the card is the tie-breaker if they ever diverge.
    - **⚠ Wrapped in try/catch, deliberately.** It is a reporting nicety riding on the row that feeds
      transfer orders and must never be able to stop that write — same `(non-fatal)` pattern as
      `create-to`'s `toSnapshots`. A null degrades the email to "no value line".
    - Safe to add because SKUs live nested under `targets`, so a top-level key cannot shadow one, and
      `assessTargetsChange` is called with `live: liveTo?.targets ?? {}` — it never counts top-level
      keys. **Check that before adding any further key here.**
  - **WHY VERCEL:** it imports `src/engine/` DIRECTLY, so there is exactly one engine implementation. A
    Deno port would be a second copy of ~2,900 lines whose drift surfaces as wrong transfer quantities
    found by ops. Verified headless-safe — no `window`/`document`/`localStorage` in the engine (all 20
    hits for "window" are the word in prose). `"type": "module"` in package.json is what lets a Node
    function import it.
  - **⚠ WHY A CLOCK, NOT THE EVENT CHAIN THIS ENTRY USED TO SPECIFY.** Event-driven existed to
    guarantee `toTargets` was never computed from stale inputs. Once we decided to **ALWAYS RUN and
    stamp freshness** — safe because every input sync already fails closed ATOMICALLY, so there is no
    half-updated input — completion detection became unnecessary, and running after the last input slot
    was enough. It also needs **zero edits to the deployed Supabase functions**.
  - **⚠ MODE DEFAULTS TO `"dry"`**, deliberately unlike the edge functions, because it replaces the row
    wholesale. So a cron sending `{}` would report `ok:true` nightly and never write.
  - **Guard:** `assessTargetsChange` blocks a >20% fall in target count against the live row (baseline
    is always the LIVE row, even on a shadow run, so a shadow run reports what a live write *would*
    have done). The realistic failure is an input that failed to load, and nothing legitimately takes
    this row to zero.
  - **Writes ONLY the `params` table**, exactly like `applyAndRun` — it cannot disturb `team_data`.
  - **Freshness is DERIVED FROM THE DATA:** `inputs.invoiceDataThrough` (max date in the rows),
    per-input counts, attribution mode, plus `engineCommit`. ⚠ `refreshedAt` alone is the weak signal —
    on the first run it read "just now" while `invoiceDataThrough` was three days stale. A run timestamp
    says a computer did something; `invoiceDataThrough` says whether the answer is current.
  - **✅ BOTH ARE NOW ON SCREEN (2026-08-03, `ec7e8b8`)** — the Data Inputs chip reads
    `Last run: 2026-08-04 05:45 · demand through 2026-08-03`. Fetched with `loadPayloadKey(…,"inputs")`
    so it costs a few hundred bytes, not the ~693KB row; falls back to the clock alone if a row predates
    Stage 6's shared inputs stamp.
    - **⚠ WHY THE CLOCK ALONE CAN NEVER BE ENOUGH, precisely.** If the invoice sync fails for three
      nights while `engine-run-nightly` keeps succeeding at 05:45, `refreshedAt` reads fresh every
      morning and `✓ Model up to date` is **TRUE** — targets really are newer than their inputs. "Up to
      date" is a **relative** claim and is structurally silent on the inputs being old. Only
      `invoiceDataThrough` exposes that. Demonstrated live on 2026-08-03: a perfectly accurate
      `Last run: 06:15` sat beside demand through 07-30 while the row held 08-02.
    - **Still missing: the same line in the TO tool footer**, where the consequence is transfer
      quantities rather than a label. Its clock reads `toTargets.refreshedAt` and flags stale only as
      "not from today IST", so it renders no ⚠ while running on days-old demand.
  - **⚠ Intra-day: do NOT push a fresh Min/Max into `toTargets` just because it exists.** POs are raised
    ~06:00 IST off the morning's numbers; re-running mid-day puts that afternoon's 14:30/20:30 TOs on a
    different demand basis than the POs. `overallPeriod` is a **sliding** 45-day window, so advancing
    the latest date a few days slides it rather than adding demand — the gain is low single-digit %,
    the confusion is real. Default to letting the nightly run take it. (Done deliberately on 2026-08-03
    at 12:01 IST *because* the operator wanted TO and IMS to match on cutover day, which is the
    exception, not the rule.)
  - **`engineCommit` is stamped by BOTH writers** — the browser via `__ENGINE_COMMIT__`
    (`vite.config.js` define, from `VERCEL_GIT_COMMIT_SHA`, falling back to `"local"`). Vercel and
    Supabase deploy separately, so this makes a skew visible in the row. A row stamped `"local"` was
    written from somebody's laptop. ⚠ Note the define changes bundle content, so a Vercel build's asset
    hash will NOT match a local `npm run build` — that is expected, not a deploy problem.
  - Verified before going live: headless run reproduced a browser Apply **exactly, 0 of 2,030 SKUs
    differing** — twice (a local harness with an independent re-implementation, then the deployed
    function writing `toTargets_shadow`) — plus one attended live write verified byte-identical.
    Timing on Vercel **4.9–5.6s**; `vercel.json` raises `maxDuration` to 60s because Hobby's 10s default
    left only ~2× headroom (a local measurement of 2.4s had suggested 5×).
  - **⚠ TO CALL IT BY HAND YOU NEED `ENGINE_RUN_SECRET`, AND `vercel env pull` WILL NOT GIVE IT TO YOU.**
    Vercel treats it as sensitive and writes `ENGINE_RUN_SECRET=""` — an **empty value under the right
    key**, so `grep -c '^ENGINE_RUN_SECRET='` returns 1 and looks like success. *Grep the value, not the
    key.* Get the working one from the cron that already calls the endpoint nightly (provably the one in
    use) via the Management API:
    `{"query":"select command from cron.job where jobname = 'engine-run-nightly';"}` → the
    `x-engine-secret` value in the `net.http_post` headers jsonb (64 chars). Extract it in the **same**
    shell command that uses it so it never lands in a transcript, and build that SQL with a **heredoc** —
    `''` inside a single-quoted shell string collapses to nothing and silently produces invalid SQL.
    Body **must** carry `{"mode":"live"}`; mode defaults to `"dry"`, which reports `ok:true` and writes
    nothing. A successful live run answers in ~6s with `wroteTo:"toTargets"`.
  - Regression check: `node --experimental-strip-types` is not needed —
    `npx vite-node scripts/diff-headless-totargets.mjs` re-runs the whole comparison read-only, and is
    the **drift detector** between the shared builder and anything that diverges.
  - End state worth aiming at: IMS reads the canonical stored result too, making divergence
    structurally impossible and page loads much faster. Costs the "engine changes go live on next page
    load" property, and Impact Preview still needs client-side compute. Not urgent.
- **Stage 8 — SKU floors from the ops Google Sheet (✅ LIVE 2026-07-31):** `sync-sku-floors` →
  `team_data/global.newSKUQty`, replacing the manual SKU-Floors CSV upload. ONE HTTP GET to the
  published sheet plus two Supabase reads, ~1s, **no Zoho at all** — so it cannot contribute to a 429
  window. Status in `params/skuFloorSyncStatus`. Cron `sku-floors-sync`, 04:35 + 05:25 IST.
  - **⚠ `dryRun` DEFAULTS TO TRUE** (`body.dryRun !== false`) — the cron body must carry
    `{"dryRun": false}` or it no-ops nightly while reporting `ok:true`.
  - Parse + guard are pure and tested: `_shared/skuFloorSheet.ts` (26 tests). Output shape mirrors
    `App.jsx handleFloors` EXACTLY — `max` floored at `min`, DSes at 0/0 omitted, an all-zero SKU kept
    as a **present-but-empty** object. Proven, not assumed: `changed: 0` across all 1,148 SKUs on the
    first run.
  - **Stricter than the browser on purpose:** `2.5`, `-1`, `abc` are REJECTED, not coerced —
    `parseFloat` turning a typo into `0` is indistinguishable from ops deliberately removing a floor.
    A blank cell is still `0`. An unknown DS column (DS07 before `DS_LIST` gains it) is a **hard stop**.
  - **⚠⚠ DUPLICATE SKU ROWS FOLLOW THE OPS APPEND RULE — LAST ROW WINS (changed 2026-08-15). It used
    to be a hard stop, and that cost two nights.** `duplicate_sku` refused the nights of 08-14 and
    08-15; ops downloaded the sheet, re-uploaded it through Upload Data, and it **worked** — because
    `App.jsx handleNSQ` does `nsq[s]={}` per row, so a duplicate silently overwrites and the last
    occurrence wins. Verified: `S8UHR` sat at sheet lines 125/1383/1566 with three different value
    sets, and the stored row was exactly line 1566.
    - **The defect was never the parser's strictness — it was TWO WRITERS DISAGREEING ABOUT AN
      AMBIGUOUS INPUT.** They agreed perfectly on every clean sheet. Worse, the disagreement ran the
      wrong way: the **fallback** path (browser, no guards) succeeded on a sheet the **primary** path
      refused, which reads as "the sync is broken" and trains everyone toward the unguarded path.
      **Generalisable: when two writers share a key, make them agree on the AMBIGUOUS inputs, not just
      the clean ones** — and prefer aligning the guarded writer to the fallback's behaviour over making
      the emergency path harder to use.
    - Ops revises a floor by **appending a row, not editing in place** (confirmed with the operator
      2026-08-15), so the last occurrence is genuinely current. Every one of the 95 duplicated SKUs had
      *conflicting* values; **zero were exact copies** — the newer row generally raising a `0,0` to a
      real floor. So last-row-wins is ops intent, not a coin toss.
    - ⚠ **The duplicates live in the SHEET ONLY.** `newSKUQty` is an object keyed by SKU (**1,800**
      keys live 2026-08-26), so anything built from the stored row is deduped by construction — don't
      go looking for a dedupe step that cannot exist.
    - **It grows fast: 1 duplicated SKU on 08-14 was 95 (96 rows) by 08-15.** Reported, never fixed
      automatically: `skuFloorSyncStatus.duplicates = {rows, skus (capped 60), skuTotal}`, and the
      digest names them. **The sync has NO write access to the sheet and deliberately never will** —
      the URL we hold is a `/d/e/2PACX-1v…/pub` *publish token*, not a spreadsheet ID, and there are no
      Google credentials in the project at all. Deleting rows would need a service account, Editor
      access to an ops-owned document, and an unattended destructive write at 04:35 IST. Considered and
      **rejected 2026-08-15**; the email is the cleanup mechanism.
    - `invalid_value`, `unknown_ds`, `empty` and `header_mismatch` remain hard stops, so `force` still
      overrides POLICY and never CORRECTNESS.
  - **⚠ THE GUARD NEEDS TWO DIMENSIONS.** Ops removes a floor either by deleting the row OR by setting
    it `0,0`; the second leaves the SKU key in place, so a key-count guard alone reads a **0% drop** and
    would wave through a bad formula that zeroed every value column — 1,148 rows in, 1,148 out, every
    floor gone. `floorDropPct` tracks SKUs actually CARRYING a floor. Either falling >20% fails closed.
  - **⚠ `force` OVERRIDES POLICY, NEVER CORRECTNESS.** It bypasses the night gate, the cooldown and the
    guard *threshold* — never parse validation. A header-only sheet (empty tab, or a filter hiding every
    row) parses "successfully" to `{}`, and with the guard widened to 100% that would have been written
    over every live floor; `parseFloorSheet` refuses zero SKUs outright.
  - Dry run any time, read-only: `npx vite-node scripts/dryrun-sku-floors.mjs`. It also reports floors
    that **can never take effect** (SKU absent from `skuMaster`, or not Active) — the most useful output
    and nothing to do with syncing: ops maintained 1,148 floors believing all were live; 39 were not.
  - ⚠ The sheet is AUTHORITATIVE and replaces `newSKUQty` wholesale, so **update the SHEET first**. A
    CSV-only upload is reverted at 04:35 with `ok:true`. Download the sheet as CSV and upload *that*, so
    the two cannot diverge.
- **Stage 7 (LIVE 2026-07-29; hardened 2026-07-30 after its first run failed):** `sync-catalogue` →
  SKU Master + Purchase Prices into `team_data/global` (read-merge-write, fresh read immediately before
  writing). ~30 calls, ~16s. See the Zoho ITEMS + PRICES section for the ⚠s, including status ownership.
  - **FIVE attempts, 21:55–23:55 IST**, first success wins — `catalogue-sync-earlier`
    (`25,55 16,17 * * *` UTC, migration `20260730000001`) + `catalogue-sync-nightly`
    (`25 18 * * *`, `20260729000002`, deliberately left untouched so rollback is one `unschedule` and
    there is no window with no catalogue cron at all). All before `invoices-sync-window` so the invoice
    coverage guard checks a fresh master; the last slot leaves a **40-minute buffer**.
  - **Five slots ≠ five pulls.** `alreadyRanTonight()` (`_shared/syncCooldown.ts`) gates on
    `lastOkNight` in `params/catalogueSyncStatus`: the first SUCCESS closes the night and later slots
    return `already_ran_tonight` after one Supabase read and zero Zoho calls — same shape as
    `sync-invoices`' `already_published`. **A FAILED run does not close the gate**, which is the entire
    point. `COOLDOWN_MS` (15 min) remains a separate anti-hammering guard and does not block the 30-min
    slot spacing. ⚠ A manual daytime run consumes that night's slot — by design. **A `dryRun` does
    NOT**: every write in the function sits behind `if (!dryRun)` and `lastOkNight` is set only on a
    successful live write, so `{"dryRun": true}` is a free, safe way to see exactly what tonight would
    do. Verified 2026-08-29 — after a dry run, `at`, `lastOkNight`, `skuMaster` and `priceData` were all
    byte-unchanged. **It is also the only way to prove a deploy actually RUNS**: the tests transpile
    with esbuild under vitest, which is not Deno.
  - **⚠ PRICES ARE WRITTEN EVEN WHEN THE MASTER GUARD REFUSES (2026-08-29).** They do not share the
    master's failure mode — `mergePrices` merges over the STORED set and only takes
    `average_price > 0`, so it can add or update but never lose a SKU, and a short or broken pull
    degrades to "no change" rather than data loss. The coupling was pure collateral damage: on
    2026-08-28 a master rejection silently discarded **253 price updates and 11 price-tag moves, 10 of
    them `No Price → priced`** — and `No Price` sits at the **95th percentile** in PCT, so each was
    over-stocking a SKU for as long as it was held back. `lastOkNight` stays unset on that path, so the
    master still retries and prices may be written up to 5× on a rejection night; the merge is
    idempotent, and the catalogue slots (`:25`/`:55`) never collide with the stock (`:35`–`:44`) or
    orders (`:50`) writers of `team_data/global`. Reported as `pricesWritten`.
  - **⚠⚠ `statusChanged` IS STORED IN FULL, NOT `slice(0, 25)` (2026-08-29) — and the 25-row version
    cost a real investigation.** On 2026-08-28, 349 changes were recorded as a count plus 25 names; by
    the morning ops had reverted the flip in Zoho, so **no later pull could name the other 324 and they
    existed nowhere else** — not in the status row, not in `function_logs` (the guard-failure line dumps
    `change`, which holds only percentages). **The report said how big the change was and refused to say
    what it was**, which is the one fact needed to act on it. Cost of fixing: **47 bytes an entry —
    +16 KB that night, ~118 KB if every SKU flipped**, on a row written 1–5× a *night*, against
    `team_data/global` at 4.3 MB written ~12× an *hour*. Now carries `count`, `byTransition`,
    `toInactive` (broken out — it is the consequential direction) and `all`. **Generalisable: sample a
    report only when the full thing is expensive AND reproducible later. This was neither.**
    Same principle as `invAtChanged.toSupplier`, which was already in full.
  - **`syncNightKey()` shifts 3h before taking the IST date rather than using the plain calendar date.**
    No slot crosses midnight IST today, so it is insurance — but a post-midnight slot on a plain-date
    key would re-pull AND then poison the FOLLOWING night's gate into skipping entirely while reporting
    ok. A test pins that case; a plain-date implementation passes every other test and fails only in
    production, months later. **Re-read it before adding any slot at or past 00:00 IST.**
  - **⚠ Why the retries exist: its first real run (2026-07-29, 18:25 UTC) returned 500 and wrote NOTHING
    to `params/catalogueSyncStatus`** — the row simply did not exist, so a total failure was
    indistinguishable from "the cron never fired". Caught only because `skuMaster` was still 2,092;
    confirming it needed a Management API dig through `function_logs`. **Every exit path now writes the
    status row** through one `setStatus()` helper (`reason:"exception"` on the catch), which also carries
    `lastOkNight` forward — an upsert replaces the whole payload, so a bare `{ok:false, at}` would erase
    the gate's own state. Cause was the org-wide Zoho 429 window; see the sync-constraints section.
  - **⚠ NOT `:50`** — `orders-sync-hourly` occupies :50 of every hour and writes the same
    `team_data/global` row; concurrent writers there caused the statement timeout that left DC+DS01
    74m stale. Free minutes: `:00–:34` and `:51–:59`. (An earlier note here suggested 15:20 UTC and
    another suggested 18:50 — both superseded.)
  - Backup: `team_data/catalogue_backup_20260729` (skuMaster 2,092 · priceData 1,822), verified
    byte-identical. Restore = read-merge-write those two keys back into `team_data/global`. Keep taking a
    dated one before any change to this function: `inventorisedAt` decides whether a SKU is stocked
    anywhere at all, and Zoho now owns it, so there is no local safety net.
  - **First successful run 2026-07-30 14:36 IST** (the 07-29 cron run died — see above): 2,100 items
    fetched, guard `safe`, skuMaster 2,092 → **2,105**, prices 1,833 → **1,858** (259 updated, 25 added,
    **330 retained**), **`invAtChanged: 0` / `toSupplier: []`**, exactly **1** status change —
    `GHT_C-…-VVN3G` Active → Inactive, the SKU deleted from Zoho, correctly **retained and marked
    inactive rather than dropped**. 29 price re-tiers, 21 of them `No Price → priced` (all *reducing*
    stock, since `No Price` sat at the 95th percentile).
  - **⚠ The delta drifts within the hour — do not act on a stale dry run.** A dry run at 13:47 IST
    measured 2,101 items / 8 new SKUs; the real run 49 minutes later saw **2,105 / 12** because ops kept
    creating SKUs. The guard plus the status row are the protection, not a preview. (And since every exit
    path now records the run, a second dry run before a real one buys little.)
  - **A new SKU with no `cf_inventorised_at` defaults to DC and is reported in `master.newSkusDefaulted`.**
    12 such SKUs on 07-30. Safe default, but the default is making the decision — worth setting in Zoho.
  - Floors (`minReqQty`, `newSKUQty`) and Dead Stock stay manual — ops judgement, not Zoho data.

> **4** (rethink the Tool Output tab) and **5** (full UI polish pass) were **dropped 2026-08-03** — open
> since April with no specifics. Numbers retired, not reused.
>
> ⚠ **4 then got done anyway, later the same day** — the tab was rebuilt as four download cards with the
> table removed, and gained the PO Team Download. So the item was not wrong, just unspecified; a concrete
> need ("the PO team wants one CSV") produced in an afternoon what an open-ended "rethink" had not in four
> months. See the **Tool Output Download Tab** section for what it is now.

### 17. Nightly digest — one email that says whether the chain worked ✅ Shipped (2026-08-04)
`supabase/functions/nightly-digest` + cron `0 1 * * *` UTC = **06:30 IST**. Reads the four status rows
plus `toTargets`, mails one summary, green or red. Pure logic in `_shared/nightlyDigest.ts` (50 tests);
`scripts/dryrun-nightly-digest.mjs` renders the real email read-only (`--demo` for synthetic failures,
`--with-value` runs the engine locally to preview the ₹ line). Spec:
`docs/superpowers/specs/2026-08-04-nightly-digest-design.md`.
- **HEARTBEAT, NOT ALERT-ONLY.** Alert-only shares a failure mode with what it watches: if the alerter
  dies, silence reads as success. With a fixed-time daily send, **"no email by 06:40 IST" is itself the
  signal** — which is also what made the scheduler choice low-stakes.
- **⚠ THRESHOLDS ARE PER-INPUT, and the healthy lag DIFFERS — it is not an off-by-one.** Catalogue runs
  *before* midnight IST so its `lastOkNight` is correctly **yesterday**; floors run 04:35 IST so theirs
  is correctly **today**. One shared baseline would report a healthy catalogue as late every day.

  | input | healthy lag | amber | red |
  |---|---|---|---|
  | invoices | 1 | 1 night missed | **2** |
  | catalogue | 1 | 1 | **2** |
  | floors | 0 | — none — | **1 (first miss)** |
  | engine | 0 | 1 | **2** |

  - **Invoice red at 2 missed nights is set by the recovery mechanics, not by taste.** `planNightDates`
    is purely clock-derived (`[yesterday, yesterday−3]`) with **no memory of misses**, so a date gets
    exactly two chances and becomes **permanently unrecoverable at lag 5**. Red at lag 3 leaves two
    nights of margin.
  - **Floors red on the FIRST miss** because *alert aggressiveness scales inversely with the rate of
    benign failure*: one HTTP GET to a Google Sheet, no Zoho, so it cannot be 429'd or starved — a miss
    is anomalous by construction and will essentially never fire spuriously. It also never self-heals.
- **⚠ UNKNOWN RESOLVES TO RED — the opposite of `assessOutputFreshness`, and the difference is the
  action.** There, uncertainty must not block a download because that stops purchasing. Here the action
  is sending an email: a spurious red costs thirty seconds, silence costs a night.
- **⚠ `send` DEFAULTS TO TRUE**, deliberately inverting `sync-sku-floors` (`dryRun`) and `run-engine`
  (`mode`). For a writer a silent no-op is safe; for a watchdog it is the exact failure being fixed.
  Dry runs pass `{"send": false}`.
- **⚠⚠ THE SUMMARY LINE MUST DESCRIBE THE STORED CATALOGUE, NOT THE ATTEMPTED PULL — fixed 2026-08-29.**
  It read `catalogue.change.after` / `statusMix.after.active`, which are what the sync *wanted* to
  write; on a night the guard refuses, that write is **discarded and the stored master is untouched**.
  Measured that morning: the email said **`master 2,473 (1,971 active)`** while the live master was
  **2,463 / 2,306** — i.e. it reported 334 deactivations that **had not happened**, on precisely the
  night a reader most needs the truth. Now `after` when the run wrote, `before` when it refused.
  **Same class as the `refused: ok` bug below: a convenient field standing in for the true one, and
  the two diverge on exactly the case the report exists to catch.** Pinned by tests both ways.
- **A deactivation count is appended to that line, reported GREEN, and never moves the alert level**
  (2026-08-29). Ops flips `status` in bulk as an operational lever — 334 on 2026-08-28, reverted the
  same day — and **nobody has measured what a normal night looks like**, so any amber threshold would
  be a guess that fires on routine work and discredits the reds beside it. Identical reasoning to
  floor-sheet duplicates and to the inventory value never setting a level; the phrase is **omitted
  entirely** when the count is zero rather than printing "0 deactivated". Revisit once `digestHistory`
  has a few weeks of it.
- **TO lines skipped as inactive are named here, and ONLY here** (2026-08-29). `summariseToSkips`
  reads `params/toAudit` — the one row the digest borrows rather than owns, so every access is
  defensive and a malformed row degrades to "no line", never throws. Deduped by SKU across TOs, capped
  at 12 names, **green and never in the subject**. ⚠ `scripts/dryrun-nightly-digest.mjs` had to learn
  to read `toAudit` too, or the preview tool could never preview the block it exists to preview.
- **⚠⚠ THE REFUSAL REASON LIVES IN TWO PLACES AND BOTH MUST BE READ — `reasonOf()`, fixed 2026-08-15.**
  It read `row.change.reason` only, but **only a change-guard rejection has a `change` object at all**;
  a parse failure, a fetch failure or an exception has none. So on the nights of 08-14 and 08-15 the
  email printed `refused: reason not stated` while `reason: "duplicate_sku"` — the word naming the ops
  sheet exactly — sat in the row. **Two mornings lost to a field the email declined to read.**
  `change.reason` is still preferred (sync-catalogue stamps a generic top-level `change_guard_failed`
  and puts the real verdict in `change`), with the top level as fallback. Same class as `autoAtFor`:
  **a reader that knows only one of a value's two homes fails silently on exactly the case it exists
  to catch.**
- **Floor-sheet duplicates are reported GREEN and never move the alert level** (2026-08-15). Since the
  append rule resolves them they cannot change what the engine gets — housekeeping, not a fault — and
  nobody has measured how often ops legitimately appends, so any threshold would be guessed (the
  Sunday-row-count mistake). A note that goes amber every morning until a spreadsheet is tidied would
  discredit the reds beside it. Names are truncated to **12** with `+N more`; **rendering the real
  email is what caught that** — 60 codes joined into one line is an unreadable wall in Gmail, and every
  test passed. ⚠ A green flag must also be **filtered out of the subject line**, or it rides into an
  amber subject caused by something else and reads as a second fault.
- **⚠ "Refused" is judged on `ok === false`, NEVER on how recent the row is.** A cron that never fired
  leaves the PREVIOUS successful row in place — recent *and* `ok:true` — so a recency test printed
  `refused: ok` and pointed at the wrong remedy. Same class as the `autoAtFor` bug: a proxy signal
  standing in for the real one, which diverges on exactly the input the thing exists to catch.
- **The green line carries COMPOSITION, not volume** — volume is what the guards already refuse on.
  `invAtChanged.toSupplier` (Min=Max=0 everywhere; the guard only trips above a 5% mix shift) and
  `coverage.unknownPct` (>0.5% ⇒ amber; the guard refuses only at 1%) both raise amber. `ineffective`
  floors is reported because a stale catalogue **silently disables new floors** — a floor on a SKU
  absent from `skuMaster` can never take effect.
- **⚠ The inventory value NEVER changes the alert level.** Min/Max moves every night as the 45-day
  window slides and nobody has measured the normal variance; a guessed threshold is the
  Sunday-row-count mistake and would discredit the reds sharing the email. Asking for a **delta and a
  %** instead of a highlight removed the need to know the variance at all. Revisit once
  `digestHistory` has a few weeks in it.
- **Provider is Brevo, not Resend.** Resend requires a verified **domain** (DNS on `home-run.co`, a
  managed process — the SPF is flattened through `_spfm.home-run.co`); Brevo verifies a single **sender
  address** by email + mobile. `POST https://api.brevo.com/v3/smtp/email`, header `api-key`, **201** on
  success — test `r.ok`, not `status === 200`. HTTPS rather than SMTP because Supabase's own email guide
  only demonstrates `fetch` and raw outbound TCP is unconfirmed on Edge Functions. Secrets:
  `BREVO_API_KEY`, `DIGEST_RECIPIENTS`, `DIGEST_FROM_EMAIL`, `DIGEST_FROM_NAME`.
- **⚠ Gmail shows a "Be careful with this message" impersonation banner, and it is EXPECTED.** Measured
  2026-08-04: `home-run.co` publishes `v=DMARC1; p=none` with SPF `~all` and MX on Google, so
  unauthenticated mail is **delivered, not rejected** — it reaches the Inbox. But `From` and `To` are
  the same address and Brevo signs as `brevosend.com`, which trips Gmail's *self*-impersonation check.
  Accepted deliberately for a single recipient. **⚠ It does NOT survive adding the other four** — four
  people seeing "someone might be impersonating your account" daily ends with one reporting it as
  phishing. Fix then, by authenticating `ims.home-run.co` (a subdomain, so the root SPF carrying
  Workspace mail is never touched).
- **⚠ Monospace layout does not survive a plain-text email.** Stage labels were aligned with
  `padEnd(15)`; Gmail renders `text/plain` in a proportional font and collapses runs of spaces, so the
  columns dissolved. Now a colon separator. **This class of bug cannot be caught locally** — a terminal
  dry run is monospace, so it looked perfect until it was delivered.
- **Three of this build's defects were found by reading rendered output, not by tests** (`refused: ok`,
  an empty `WHAT TO DO` heading, the collapsed columns). All passed every assertion, because the tests
  checked the logic intended rather than the text a person reads. **Render the artifact.**

### 32. Purchase / Move — commercial policy ✅ Shipped (2026-09-07)
Two item-level Zoho dropdowns (`cf_purchase_status` ON/OFF, `cf_move` Yes/No) make three things
expressible that nothing could say before: **buy at the DC and sell only from the DC**, **stop buying
but sell till stock lasts**, and **withdrawn**. Full design, all the ⚠s and the measured numbers are in
the **Purchase / Move** section above — this entry exists only so the number is not reused.

Shipped **provably inert**: 0 of 18,046 cells differing, four times, because every flag is blank and
both new CSV columns empty. 20 files, 658 tests (+48), lint unchanged at the 75 baseline.

Also closed while in the code: **item #30** (both floor-sheet reader gaps) and the `DC Cap` half of
**item #29**. New follow-ups are **item #31**.

### 6. Plywood Network Design ✅ Shipped (2026-04-28)
Network Design strategy in engine (`src/engine/strategies/plywoodNetwork.js`). Full UI in PlywoodNetworkTab.jsx — unified SKU table with zone colouring, DC tab, brand assignment editor, compact modal with zone-aware formula display and lookback-period charts.

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
