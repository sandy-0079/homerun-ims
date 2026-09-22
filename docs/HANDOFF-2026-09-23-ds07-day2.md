# HANDOFF — DS07 day 2 (2026-09-23)

**Written 2026-09-22 ~16:00 IST, end of go-live day. TRANSIENT — delete this file once the
checks below have passed once.** The durable record is `docs/HANDOFF-2026-09-18-ds07-ds08.md`
(Step 7 = what actually happened) and the root `CLAUDE.md`.

DS07 HAL went live **Tuesday 2026-09-22 ~11:55 IST**. Tomorrow is the **first nightly run with
DS07 as a trading store**, and the first carrying two inputs that have never been through the
chain: DS07 floors (if ops added them tonight) and the DS07 plywood capacity.

---

## ⚠⚠ THE ONE RULE FOR THIS FILE

**Every number in the table below is YESTERDAY'S READING, recorded so you can DIFF against it.
None of it is an expectation.** Do not assert any of it. This system has now had four separate
occasions where a written-down expectation was stale before anyone read it and would have had a
healthy run reported as broken — the `refreshedAt 05:45` trap, the `G9NYZ DS01 = 0/0` ceiling
runbook, the ₹7.99Cr Inv Value band, and the "Inv Value roughly flat" go-live prediction that
was out by 5.2%.

**Derive at run time.** `scripts/nightly-readback.mjs` exists precisely so there is no table to
go stale; if you want a new check, add it to the script rather than writing it here.

---

## State at end of 2026-09-22 (anchors to diff against, NOT expectations)

`params/toTargets`, written 11:55 IST by a browser Apply:

| | SKUs | ΣMin | ΣMax |
|---|---|---|---|
| DS01 | 2196 | 22659 | 27568 |
| DS02 | 2196 | 19990 | 24260 |
| DS03 | 2195 | 20852 | 25044 |
| DS04 | 2196 | 19195 | 23018 |
| DS05 | 2196 | 20224 | 24188 |
| DS06 | 2195 | 19698 | 23603 |
| **DS07** | **963** | **13465** | **14731** |

`digestHistory` invValue: 09-20 ₹10.53Cr · 09-21 ₹10.53Cr · 09-22 ₹10.58Cr Max.
**Post-Apply (not yet in digestHistory): ₹11.13Cr Max / ₹7.91Cr Min** — measured offline, the
+5.2% go-live step. Tonight's nightly is the first to stamp it.

Also true at 16:00 on 09-22, and each one is a question for tomorrow:
- **DS07 floors in `newSKUQty`: 0.** Ops intended to add them tonight.
- **DS07 TOs raised, ever: 0.** The 14:30 run covered DS01–DS06 only.
- **DS07 stock: 2,948 SKU keys, 3 with stock > 0.** Effectively empty.
- `params/networkConfigs.DS07` = thick 300 / thin 150, set 12:49 — **after** the 11:55 Apply, so
  the published row does not reflect it. Measured inert on the day (0 of 25,965 cells).

---

## The checks, in order

### 1. The nightly chain — one command, derives everything

```
node scripts/nightly-readback.mjs        # exit 0 clean · 1 issues · 2 STOP
```

Covers the gate (DS08 must still carry no target — that is the STOP), `engineRunStatus`,
`invoiceDataThrough`, night-on-night Inv Value drift against `digestHistory`, all four syncs,
the digest, and stock freshness per store.

⚠ **Assert on `params/engineRunStatus.at`, never `toTargets.refreshedAt`.** The latter has two
writers and any browser Apply overwrites it — it cried wolf on a healthy system on 2026-09-19.
The readback already does this correctly.

⚠ DS08 stock will read badly stale. **That is correct** — DS08 has no cron by design
(Open Work #39) and must not join `stock-sync-4`; three branches in one invocation 429s.

### 2. Did DS07 floors land? (only if ops added them last night)

```
npx vite-node scripts/dryrun-sku-floors.mjs
```

Read the **`floors per DS`** line for a DS07 count. ⚠ **A typo'd header is SILENTLY IGNORED**,
not an error — `parseFloorSheet` matches by regex, so `DS7 Floor` or a stray space yields no
DS07 column and no complaint. Yesterday the line read `DC=39 DS01=2349 … DS06=2349` with no DS07.

⚠ **Check `added` in the GUARD block is 0.** A new SKU **row** (as opposed to a filled cell on an
existing row) creates the `nsq` key that `isFlooredSKU` tests and flips that SKU's DC from the
rate formula to the floored one — a live change to DC, gate or no gate. Yesterday: 2374 → 2374,
added 0. If the SKU count grew, find out which rows and whether that was intended.

### 3. Did DS07's assortment change, and does the DC cover it?

Diff DS07's published row against the anchor above (963 SKUs / ΣMin 13465). If floors landed,
expect it to grow substantially — ops' reference point was DS06's 2,349 floors — but **do not
assert a number**; ops chooses how many rows to fill. Check the DC moved with it: the DC is
what supplies DS07, and `applyOpeningToStores` runs before the DC sums for exactly that reason.

### 4. Did DS07's first TO reach Zoho? ← THE UNPROVEN LINK

Read `params/toAudit` for any entry with `toDsId: "DS07"`. Yesterday: **zero, ever.**

This is the one thing in the whole launch that has never been exercised. `DS_ONLY` and `BRANCHES`
carry DS07 and the TO tool offers it automatically, but what is proven for DS07 is
`inventorysummary` — a **READ**, on a different endpoint. If Zoho rejects `to_location_id` on
`POST /transferorders` it returns **400**, its validation layer, so **nothing is created** and the
error surfaces cleanly. ⚠ `dryRun: true` does **not** test this — it returns before the POST.

If it has still not been attempted, the safe proof is a **1-line draft to DS07, checked in Zoho,
then deleted**. Everything `create-to` makes is a draft: zero stock movement, deletable.

⚠ **Expect DS07's first TO to be enormous.** Empty stock means every SKU trips `CS DS ≤ Min` and
`Req = Max`. Measured 09-22: 963 SKUs / 14,731 units requested, **811 lines in a single POST** —
`buildLines` does not chunk. TO-00892 went through at 514 lines so there is headroom, but note
`create-to` never retries a 5xx/timeout (a TO may exist), so a timeout at that size means checking
Zoho by hand rather than clicking again.

### 5. Donors, and DS07's shelves

The accepted residual from 2026-09-18: donors **DS01/DS02/DS05** replenish ~10–20% leaner against
an unchanged sell rate, because they lost the HAL catchment before DS07 opens. Watch them in Stock
Health; the 14:30 TO run can top up by hand. Separately, DS07 itself will read short across the
board until its first TOs arrive — that is an empty store, not a data fault.

### 6. First PO run on 24 columns

Tomorrow ~07:30 is the first PO run where the file has been 24 columns for a full day
(`DS07 Min`/`Max` at U/V, `Purchase`→W, `Move`→X). The PO team was told on 09-22. If anything
looks wrong in their sheet, `npx vite-node scripts/verify-po-csv.mjs` checks the contract against
live data in one command.

---

## Open questions to put to the operator

1. **Were DS07 floors added last night?** If not, DS07 stays on its 974-SKU opening assortment
   (784 Base Logic from attributed HAL demand + 134 New DS Floor + 56 plywood).
2. **Did the 20:30 run include DS07, and did it land in Zoho?**
3. **Is DS07 actually trading today?** The plan said open ~Wednesday; the flip was Tuesday.
4. **Anything from the PO team or the Fill Summary recipients** about the widened files.

## Not in scope

DS08 — parked, gated, no date. No stock cron **by design**. Do not add it to `stock-sync-4`.
