# Nightly digest — one email that says whether the chain worked

**Open Work item 17.** Status: **SHIPPED 2026-08-04** — function deployed, cron scheduled at 06:30 IST,
one email delivered by hand. ⚠ The cron's **first unattended firing is the morning of 2026-08-05**;
until that is verified, nothing here has been proven to work without a human.

---

## The problem, precisely

`invoiceSyncStatus`, `catalogueSyncStatus`, `skuFloorSyncStatus` and `engineRunStatus` are written
every night and **nobody reads them**. On the Stage 5 cutover morning (2026-08-03) and the first
unattended morning (2026-08-04) they were checked by hand. From 2026-08-05 nobody will.

The chain is automatic but **not self-reporting**. That is the whole gap between "it runs every night"
and "you will know if it didn't".

The Data Inputs chip closed part of this — it shows `Last run … · demand through …` — but it is a
**pull**: it needs a human to open the app and look. This spec adds the **push**.

---

## Decisions

### 1. Heartbeat, not alert-only

One email every morning, green or red. **Not** "email only when something is wrong."

⚠ **The reason is that alert-only shares a failure mode with the thing it watches.** If the alerter
dies, silence reads as success — which is precisely the defect being fixed. With a fixed-time daily
heartbeat, **"no email by 06:40 IST" is itself the signal**, and that property holds regardless of
which platform the watchdog runs on.

This is also what makes the scheduler choice low-stakes (see Decision 6).

### 2. Keyed on derived freshness, never on `ok:true`

The 2026-07-28 invoice run reported `ok: true` over a day missing **27.7% of its quantity**. A status
flag records what a function believed about itself; a date records what actually landed.

Every threshold below is a **lag in days against a date carried in the data** — `invoiceSyncStatus.dates`,
`lastOkNight`, `toTargets.refreshedAt` — never a boolean.

### 3. Per-input thresholds, because the inputs are not alike

A uniform "red after 2 days" is wrong in both directions. The governing principle:

> **Alert aggressiveness scales inversely with the rate of benign failure.**

| input | healthy lag | amber | red | why this line |
|---|---|---|---|---|
| **Invoice demand** | 1 (through yesterday) | 1 night missed | **2 nights missed** | Self-heals — but only just. See below. |
| **SKU floors** | 0 (`lastOkNight` = today) | — none — | **1 night missed** | No self-heal, near-zero benign failure rate, trivial remedy. |
| **Catalogue** | 1 (`lastOkNight` = yesterday) | 1 night | **2 nights** | ~10–20 new SKUs/night go invisible; 5 retry slots make one miss unremarkable. |
| **Engine run** | 0 (`refreshedAt` = today IST) | 1 night | **2 nights** | Only the TO tool is affected; remedy is one Apply click. |

⚠ **The healthy lag differs per input and it is NOT an off-by-one.** Catalogue runs 21:55–23:55 IST, i.e.
*before* midnight, so on the morning of D+1 its `lastOkNight` is correctly `D`. Floors run 04:35 IST,
*after* midnight, so its `lastOkNight` is correctly `D+1` — today. Deriving one baseline for all four
would report a healthy catalogue as a day late, every single day. Encoded explicitly per input, with the
reason, rather than computed.

#### Why invoice red sits at 2 missed nights

`planNightDates` is purely clock-derived — `[yesterday, yesterday−3]` — with **no memory of what was
missed**. A given date therefore gets exactly two chances: the night after it, and one recheck three
nights later.

| lag | meaning | state |
|---|---|---|
| 1 | normal | green |
| 2 | one night missed | amber |
| 3 | two nights missed | **red** |
| 5 | the D−4 recheck for the first missed date has passed unseen | **permanently lost** — needs a manual backfill |

Red at lag 3 leaves two full nights of margin before anything becomes unrecoverable. The line is placed
at "the self-healing window is closing", not at "the number is old".

#### Why floors go red on the first miss

`sync-sku-floors` is one HTTP GET to a published Google Sheet — no Zoho, ~1s, two slots. It cannot be
caught in a 429 window, cannot time out, cannot be starved. **A missed floors night is anomalous by
construction**, so a red will essentially never fire spuriously — which is exactly what earns it the
right to fire on the first miss.

It also does not self-heal: the sheet is read wholesale each night, so a floor added Monday and missed
Monday night is simply absent until a run succeeds. And the remedy is trivial.

Contrast invoices, which have twelve slots *precisely because* Zoho is flaky. One miss there is
unremarkable; one miss in floors is not.

### 4. Green carries composition, not just volume

⚠ **Volume metrics are largely redundant with the guards.** `assessCoverage`, `mergeInvoiceRows.report.safe`,
`assessMasterChange`, `floorDropPct` and `assessTargetsChange` all fail closed on counts moving too far —
so a row count in the email mostly restates something a guard would already have refused on.

What is **under**-guarded is composition:

| number | why it belongs |
|---|---|
| `invAtChanged.toSupplier` | Supplier ⇒ Min=Max=0 **everywhere**. The guard only trips above a 5% mix shift, so ~20 SKUs flipped in Zoho passes silently. Raises **amber** when non-empty and names every SKU. |
| `coverage.unknownPct` | Leading indicator for a SKU re-code. The 2026-07-01 event hit 39.6% and cost ₹1.08Cr of network Max. The guard refuses at 1% — the value is watching it *approach* 1%. Amber above 0.5%. |
| active SKU count | Reported, **not** gated: a large shift already fails `active_share_shift`, which stops the write, which surfaces as catalogue lag. A small shift is genuinely small. |
| `ineffective.total` (floors) | Catches the coupling in Decision 5. Reported so its drift is visible across days. |

### 5. The coupling worth surfacing: a stale catalogue silently disables new floors

A floor on a SKU absent from `skuMaster` **can never take effect** — the engine's active-only pass zeroes
it. `sync-sku-floors` already measures this (`ineffective.absentFromMaster`, 4 SKUs on 2026-08-03).

So the failure that actually costs money is the *combination*: ops adds a floor for a brand-new product,
floors sync succeeds, catalogue sync failed — and the floor does nothing while every status row looks
fine. `ineffective.total` is a first-class line in the email for this reason.

### 6. Scheduler: pg_cron + a new Supabase edge function

Decision 1 already covers "the watchdog died", so scheduler independence buys less than it first appears.
What remains favours pg_cron:

- **Exact firing.** The email must land before POs start (~07:30 IST, confirmed by the operator
  2026-08-04; an earlier note said ~06:00, which was their own buffer rather than the real start).
- **Existing operational tooling** — `cron.job_run_details` and the Management API log queries are already
  how this chain gets debugged.
- **A new edge function gets its own bundle**, so adding one cannot disturb the six that are running.
- Service-role Supabase access is local; no credential plumbing.

Residual gap, accepted: if pg_cron stops firing entirely the digest stops with it — covered by silence.

### 7. ⚠ `send` defaults to TRUE — deliberately inverting the house convention

`sync-sku-floors` defaults `dryRun` to **true**, which is why its cron body **must** carry
`{"dryRun": false}` or it no-ops nightly while reporting `ok:true`. `api/run-engine.js` has the same shape
with `mode: "dry"`.

For a watchdog that trap is fatal: **a digest that silently never sends is precisely the failure this
exists to catch.** So `send` defaults to true and dry runs pass `{"send": false}`.

Same reasoning as the tri-state download gate — pick the default by which failure direction is survivable.

### 8. The inventory value line is STAMPED BY THE ENGINE RUN, not derived by the digest

Measured on live data, 2026-08-04:

```
Overview card (all 2,141 results, DS + DC)   Max ₹7.9289Cr   ← "7.93"
  of which DC                                    ₹2.1425Cr   (27.0%)
Derivable from params/toTargets alone        Max ₹5.2896Cr   short by 33.3%
```

`buildToTargets` keeps **DS columns only** and DC-inventorised Active SKUs only. A
digest computing value from the row it can cheaply read would mail ₹5.29Cr every
morning beside an app reading ₹7.93Cr. So `api/run-engine.js` stamps
`invValue: {min,max}` onto `params/toTargets`, computed by the shared
`src/invValue.js` that App.jsx's `kpis` also uses — one implementation, so the email
and the card cannot drift.

- **Non-fatal by construction.** The computation is wrapped in try/catch; a failure
  degrades to "no value line", never to a missing `toTargets` write. It is a reporting
  nicety riding on the row that feeds transfer orders.
- **Additive and provably invisible to the guard.** SKUs live nested under `targets`,
  so a new top-level key cannot shadow one, and `assessTargetsChange` is called with
  `live: liveTo?.targets ?? {}` — it never counts top-level keys.
- **Computed from `raw`, not `built`** — the same basis as `kpis`. Overrides are empty
  today so the two coincide; matching the card is the tie-breaker if they diverge.

### 9. History lives with the digest, and the value never changes the alert level

Nothing snapshots `toTargets` (`toSnapshots` is `create-to`'s TO records). So the
digest keeps its own `params/digestHistory`, appended once daily, idempotent by IST
date, trimmed to 60 days.

⚠ **It must NOT live with the engine run.** `engine-run-nightly` fires **twice**
(05:45 and 06:15 IST); an engine-side append would record the same day twice every
night and make every delta read zero.

⚠ **The value is informational only — it never raises amber or red.** Min/Max moves
every night as the 45-day window slides, and nobody has measured the normal variance.
A guessed threshold is the Sunday-row-count mistake, and here it would discredit the
reds sharing the email. Once history accumulates, a data-derived "unusual move" flag
becomes possible; not before.

Asking for a **delta and a %** rather than a highlight is what removed the need to
know the variance at all — the number reports itself and the reader judges it.

### 10. Unknown resolves to RED here — the opposite of the download gate

`assessOutputFreshness` resolves uncertainty to `unknown` and **downloads freely**, because blocking a
download at 06:00 stops purchasing for the day.

Here the asymmetry runs the other way: the action is *sending an email*, and a spurious red costs thirty
seconds of reading. A missing or malformed status row is itself evidence something is wrong with the
chain. So **absent data raises red**, and says which row it could not read.

---

## Components

| file | role |
|---|---|
| `src/invValue.js` + `.test.js` | **New, pure.** `computeInvValue()` — one implementation for App.jsx's card and the engine stamp. 6 tests. |
| `supabase/functions/_shared/nightlyDigest.ts` | **Pure.** `assessNight()` + `renderDigest()` + `appendHistory()`. No I/O, no clock — `now` is injected. |
| `supabase/functions/_shared/nightlyDigest.test.ts` | Pins every threshold above. 50 tests. |
| `scripts/dryrun-nightly-digest.mjs` | Read-only. Imports the **real** module, prints the exact email. `--demo` for synthetic failures, `--with-value` runs the engine locally to preview the ₹ line. |
| `supabase/functions/nightly-digest/index.ts` | Reads six params rows, calls the module, records history, posts to Resend. |
| `supabase/migrations/20260804000001_nightly_digest_cron.sql` | **Applied 2026-08-04.** One cron at `0 1 * * *` UTC = 06:30 IST. ⚠ Its header still reads "DO NOT APPLY UNTIL THE FUNCTION HAS BEEN DEPLOYED" — left deliberately: that is a **replay** precondition, still correct on a fresh database, and applied migration files are not edited. |
| `api/run-engine.js` *(modified)* | +26 lines: stamps `invValue`, wrapped in try/catch. |
| `src/App.jsx` *(modified)* | −14/+6: the inline KPI loop becomes a `computeInvValue` call. |

The dry-run script imports the same `_shared` module the edge function will use — same reasoning as
`dryrun-sku-floors.mjs` and `compare-csv-vs-live.mjs`. A dry run that re-implements the logic proves
nothing about the thing that will actually send.

---

## Safety — what this must never touch

| constraint | why |
|---|---|
| **Zero Zoho calls** | Cannot contribute to an org-wide 429 window. |
| **Reads only the small `params` rows** | Never `team_data/invoice_data` (~7MB) or `team_data/global`. Row counts come from `invoiceSyncStatus.merge.rowsAfter` and `toTargets.inputs`, which are already stamped. |
| **Writes only its OWN two rows** | `params/digestHistory` and `params/digestStatus`. No other writer touches either. Per the params-row rule, never `params/global`. |
| **`digestStatus` written on every exit path** | Including the catch. A total failure that records nothing is indistinguishable from a cron that never fired — exactly what happened to `sync-catalogue` on 2026-07-29. |
| **No frontend change** | The app cannot be affected. |
| **Cron at `0 1 * * *` UTC** | `:00` is a documented free minute and hour 01 UTC has no other job. `:35–:44` (stock) and `:50` (orders) stay clear. |
| **Deploy the function BY NAME** | A bare `supabase functions deploy` redeploys all six with whatever `_shared/*` is on disk. This is the single real hazard in the whole task. |

---

## Rollout — a consent gate at each step

| stage | action | prod contact | status |
|---|---|---|---|
| 0 | This spec | none | ✅ |
| 1 | `scripts/dryrun-nightly-digest.mjs` — prints the real email from live data | reads only | ✅ |
| 1b | Build everything: module, tests, edge function, migration, `invValue` stamp | none — all local | ✅ |
| 2 | Brevo account + verified sender; four secrets set | secrets only | ✅ |
| 4 | `supabase functions deploy nightly-digest` — **BY NAME** | one new function | ✅ v2, other six untouched |
| 4b | Invoke `{"send": false}`; re-verify the four nightly rows | no email | ✅ unchanged |
| 5 | Invoke `{"send": true}` | one email | ✅ delivered to the Inbox |
| 3 | `git push` — the `invValue` stamp (Vercel) | **prod deploy** | ✅ `3f5a878` |
| 3b | Confirm `invValue` via `{"mode":"dry"}` | reads only | ✅ ₹7.9289Cr, matches the card |
| 6 | Apply the cron migration | scheduled | ✅ `0 1 * * *` UTC |
| **7** | **First unattended firing** | — | ✅ **2026-08-05 06:30:02 IST** — green, Inbox, 2,611ms, HTTP 200 |

**Step 7 passed.** `digestStatus`: `ok:true · level:"green" · recorded:true · recipients:1`, all four
checks green at their per-input healthy lags (invoices 1, catalogue 1, floors 0, engine 0) — confirming
the per-input thresholds were right and that one shared baseline would have mislabelled the catalogue.
The value line rendered as designed on its first outing: `Inv Value (Max) ₹7.99Cr — first reading, no
prior day to compare (Min ₹5.60Cr)`, matching `toTargets.invValue` exactly, and `digestHistory` now
holds one day so the delta begins 2026-08-06. The morning runbook that tracked this has been deleted;
the durable findings are in CLAUDE.md.

⚠ **Deployed in a different order than planned, deliberately.** The new function went first, so the
whole email pipeline was proven end-to-end while touching nothing that already existed; only then was
prod code changed. The digest degrades gracefully when `invValue` is absent, which is what made the
reordering safe.

The first email will read **`— first reading`**: the delta needs a prior day in `digestHistory`, and
the digest writes that only after computing the verdict. A real delta appears 2026-08-06.

**Rollback:** `select cron.unschedule('nightly-digest');` — one statement, instant, complete. An
unscheduled function does nothing.

**Pre-flight verified 2026-08-04:** migration ledger clean (21 local / 21 remote, zero pending, zero
drift), working tree clean at `81e6e65`, which matches `toTargets.engineCommit`.

---

## Provider and recipients

**Brevo**, chosen after Resend turned out to require a verified **domain** (DNS records on
`home-run.co`, where change is a managed process — the SPF is flattened through
`_spfm.home-run.co`). Brevo verifies a single **sender address** by email + mobile, no DNS.
Verified 2026-08-04.

`POST https://api.brevo.com/v3/smtp/email`, header `api-key`, **201** on success — an HTTPS API
rather than SMTP because Supabase's own email guide only ever demonstrates `fetch` and raw
outbound TCP is unconfirmed on Edge Functions. Swapping providers is one block in `index.ts`.

`sandeep.kumar@home-run.co` to start. The list lives in an **env secret** (comma-separated), not in code,
so adding the other four is a secret update rather than a deploy.

⚠ **Expect the spam folder, not a bounce.** Measured 2026-08-04: `home-run.co` publishes
`v=DMARC1; p=none` and an SPF ending `~all` (softfail), MX on Google. Brevo will fail SPF/DKIM
alignment for the From domain — the spoofing signature, made sharper by From and To being the
same address — but with `p=none` there is no policy action, so mail is delivered rather than
rejected. Fix at the receiving end, which needs no DNS: a Gmail filter on the sender →
**"Never send it to Spam"**. Check the spam folder after the first send.

---

## Known gaps, recorded deliberately

- **Inv Value Max (₹7.93Cr)** is the single most interpretable number and is *not* included — it lives in
  no status row and would mean stamping it during the engine run. Worth doing later; not v1.
- **`newSkusDefaulted`** (19 on 2026-08-03) is omitted on purpose. It is a to-do counter, not a health
  signal; leaving it in the email at a permanently non-zero value trains the reader to skip lines.
- **No trend memory.** Each email is a point-in-time read. Drift in `ineffective.total` or `retained`
  becomes visible by scanning the inbox, not by the digest computing a delta. Deliberate — storing history
  means another writer and another row.
