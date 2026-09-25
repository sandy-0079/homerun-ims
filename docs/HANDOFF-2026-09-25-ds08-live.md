# HANDOFF — DS08 Rajajinagar live on IMS (2026-09-25)

**Written 2026-09-25 ~19:00 IST. TRANSIENT — delete this file once every check below has passed
once.** The durable record is `docs/HANDOFF-2026-09-18-ds07-ds08.md` and the root `CLAUDE.md`.

DS08 was made **live on IMS at 18:32 IST on Fri 2026-09-25** (one Apply: `openingDSList` → `[]`,
`newDSList` gained DS08, pincode remap). It is **not trading yet: that starts Wed 2026-09-30.** It went
live early so the DC can stock it on attributed pincode demand first. DS07 did the same.

The same evening DS08 got its **own stock cron, `stock-sync-5` at :47 UTC (:17 IST)**, because until
then nothing synced its stock on a schedule (Open Work 39). Pushed: IMS `c7df52e`, TO tool `4579e31`.

---

## ⚠⚠ THE ONE RULE FOR THIS FILE

**Every number below is a READING taken at ~19:00 IST on 09-25, recorded so you can DIFF against it.
None of it is an expectation.** This system has had four go-live expectations go stale before anyone
read them. Derive at run time; the two scripts below exist so there is no table to go stale.

---

## Run these, in this order

```
node scripts/nightly-readback.mjs          # exit 0 clean · 1 issues · 2 STOP
node scripts/check-new-store.mjs DS08      # read-only; prints DS08's whole go-live state
```

`nightly-readback.mjs` now judges DS08 like any other store. It used to exempt `"DS08"` **by name**
from the stale-stock check, which would have hidden a real `stock-sync-5` outage; the exemption is now
derived from `openingDSList`. `check-new-store.mjs` is new and works for any store.

### 1. Did `stock-sync-5` fire on its own? ← the one thing no one has watched happen

In `check-new-store.mjs`, the STOCK line prints the **UTC minute** the stamp was written.
- **`:47` = the cron wrote it.** That is the proof.
- **Anything else = a manual pull** (Sync Now, the TO tool, or by hand). The only stamp at 19:00 IST
  was **`:07`**, from the one-off manual pull at 18:37 IST, so the cron had not yet been seen.
- In `nightly-readback.mjs`, DS08 should read ✅ like the rest. ⚠ It flags a store only after **90 min**,
  so a single missed hour will not show.
- Also confirm the four older slots still land on :35 / :38 / :41 / :44 UTC (DC…DS07). Nothing about
  them changed, but they are what a mistake here would have broken.

If DS08 is stale and every stamp is at a non-:47 minute, the cron is not firing. **Rollback** is one
statement in the Supabase SQL editor, and it touches no other job:
```sql
select cron.unschedule('stock-sync-5');
```

### 2. First nightly with DS08 live (06:15 IST, Sat 09-26), and the Inv Value step

`nightly-readback.mjs` prints night-on-night Inv Value with the drift context derived from history.
**Expect a step, not a flat night.** DS07's go-live night moved +5.9% and was healthy. For DS08, a replay
of the 09-25 inputs with only the gate toggled measured:
- DS08 costs **~₹0.63Cr Max** (₹11.09Cr gated → ₹11.72Cr live), about +5.7%.
- The DC carries **+2,566 Min / +4,131 Max** for it, and **0 donor cells changed**.

Last digested night (09-25) was ₹11.19Cr Max / ₹7.99Cr Min. **Derive, don't copy:** to re-measure the
DS08 share on current data, snapshot the inputs, dump once as-is and once with `openingDSList` set to
`["DS08"]` in a scratch copy, then diff. That is what `snapshot-engine-inputs.mjs` + `dump-engine-output.mjs`
are for.
- `toTargets.invValue` is **absent** right now. A browser Apply strips it (Open Work #28); the nightly
  re-stamps it before the 06:30 digest.

### 3. Plywood capacity: set late, and measured inert

`networkConfigs.DS08` (thick 300 / thin 150) was saved at **18:53 IST**, ~20 min AFTER the 18:32 Apply,
so the published row does not reflect it; tonight's nightly bakes it in. **Measured inert on the day:
0 published cells differ** when the engine is replayed with it. Same shape as DS07 on 2026-09-22.
⚠ Read capacity from `networkConfigs`, never `params/global.dsCapacities` (an orphan copy the engine
never reads).

### 4. Did DS08's first TO reach Zoho? ← unproven for this branch

`check-new-store.mjs` lists DS08 entries in `params/toAudit`. **At 19:00 IST on 09-25: zero, ever.**
`create-to`'s Zoho write is proven for DS07 (TO-06515), not DS08. A bad `to_location_id` returns 400
and creates nothing; `dryRun: true` does NOT test it.
- **Expect the first TO to be enormous**: stock is empty (0 on hand at 19:00), so every SKU requests its
  full Max (DS07 on its first day: ~800 lines in one POST).
- **Overlapping drafts to DS08 are normal.** A draft is a pick list; what the DC couldn't pick comes back
  in the next run's draft. Don't total drafts against Max.
- ⚠ `create-to` never retries a 5xx/timeout (a TO may still have been created), so a timeout at that
  size means checking Zoho by hand before clicking again.

### 5. The two widened CSVs: tell both sets of recipients

A store going live silently shifts columns in **two** position-keyed files:
- **PO CSV: 24 → 26 columns.** `DS08 Min`/`Max` at **W/X**, `Purchase` → **Y**, `Move` → **Z**. All
  contract checks pass (`npx vite-node scripts/verify-po-csv.mjs`). **The PO team needs telling** before
  their next run reads it.
- **TO tool Fill Summary CSV** widens too, since its column count is derived from the trading stores.
  Tell its recipients.

### 6. Floors, then first invoices

- **Floors:** the sheet's `DS08 Min`/`Max` columns (and DS07's) were **empty** at 19:00. For DS07 this
  was deliberate (stock on demand first, floors after). When floors go in, run
  `npx vite-node scripts/dryrun-sku-floors.mjs` and check that `floors per DS` shows a DS08 count and
  GUARD `added` is 0. A typo'd header is silently ignored, and a new SKU **row** flips that SKU's DC
  formula.
- **Invoices:** DS08 trades from **Wed 09-30**, so its first invoices sync on the night of 09-30 → 10-01.
  `check-new-store.mjs` counts DS08-fulfilled invoice rows. The mapping comes from the first word of
  Zoho's location name (`DS08 Rajajinagar`), so it should read `DS08`. It just hasn't been seen.

---

## State at ~19:00 IST 2026-09-25 (anchors to diff against, NOT expectations)

| | value |
|---|---|
| DS08 targets | 944 SKUs · ΣMin 12,690 · ΣMax 13,837 (written by the 18:32 Apply) |
| DS08 plywood | 56 SKUs · ΣMax 287 · capacity 300/150 (set 18:53) |
| DS08 pincodes | 27 of 128 |
| DS08 stock | 3,043 SKU keys · 0 on hand · 0 in transit |
| DS08 TOs / invoices | 0 / 0 |
| DS07 targets (for comparison) | 966 SKUs · ΣMin 13,167 · ΣMax 14,327 |

## Operator answers (2026-09-25 ~19:15 IST)

1. **PO team and Fill Summary recipients: told** about the widened files. Check 5 is informational only.
2. **DS08 floors: deferred**, like DS07's (stock on attributed demand first). Empty DS08 floor columns
   are expected, not a fault.
3. **First DS08 TO: tonight (the 20:30 run).** So check 4 should find a DS08 entry in `toAudit`. If
   there is none, ask whether the run happened before concluding the Zoho write failed.

## Not in scope

`per_page` and the ~10-minute stock cycle: Open Work #40. Deliberately not tried on go-live day.
