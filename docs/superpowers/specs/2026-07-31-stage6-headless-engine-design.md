# Stage 6 — headless engine run keeps `params/toTargets` fresh

**Status:** built, not deployed. Agreed with Sandy 2026-07-31 in plain terms; this
document is the durable record, not the approval gate.

## The problem, precisely

Three inputs now refresh unattended every night: catalogue (`sync-catalogue`),
invoices (`sync-invoices`), floors (`sync-sku-floors`, live from 2026-07-31).

IMS recomputes the engine **client-side on every page load**, so IMS itself is
already correct each morning. The TO tool is different — it *reads* a stored slice,
`params/toTargets`, and **`App.jsx` `applyAndRun` is its only writer.** So the DC
team can work from targets computed days ago while IMS shows today's numbers.

Stage 6 is therefore narrow: **give `toTargets` the automatic refresh the rest of
the chain already has.** It is not "automate the model" — the model is already
automatic everywhere except this one row.

## Decisions

**Always run; never block on a stale input.** Every input sync already fails closed
*atomically* — invoices publish atomically, catalogue and floors refuse on a guard
failure — so **there is no such thing as a half-updated input.** Each is either
fresh-and-coherent or stale-and-coherent. A failed sync therefore degrades the
answer by about a day, and refusing to run would leave the TO tool on data that is
older still. So: run, and record how old each input was.

**A clock, not an event chain.** The original design chained the engine off each
sync's success so `toTargets` could not be stale relative to its inputs. The
always-run decision **removes the need for completion detection entirely** — if we
run regardless of input state, we only need to run after the last input slot:

```
catalogue ends 18:25 UTC · invoices 22:20 UTC · floors 23:55 UTC
  -> engine at 00:15 UTC = 05:45 IST, before ops POs at ~06:00 IST
```

This also needs **zero edits to the five deployed Supabase functions**, which
matters given the standing rule that the redeploy is the risk, not the diff.

**Runs on Vercel, scheduled by pg_cron.** The function imports `src/engine/`
directly, so there is exactly **one** engine implementation — a Deno port would be
a second copy of ~2,900 lines whose drift surfaces as wrong transfer quantities
found by ops. Verified headless-safe: no `window`/`document`/`localStorage` usage
in the engine (all 20 "window" hits are the word in prose). Scheduling stays in
`cron.job` beside the other jobs, so the whole schedule is visible in one query and
rollback is `select cron.unschedule('engine-run-nightly')`.

Rejected: a Supabase edge function (`functions deploy` bundles only within
`supabase/functions/`, so importing the engine is fragile or forces a second copy);
Vercel Cron (works, but splits scheduling across two systems and depends on plan
tier).

**Freshness is derived from the DATA, not from a report that a job ran.**
`toTargets` carries `inputs.invoiceDataThrough` (max date in the actual rows), per
input counts, the attribution mode, and `engineCommit`. A run timestamp says a
computer did something; `invoiceDataThrough` says whether the answer is current.

## Components

| Piece | Role |
|---|---|
| `src/toTargets.js` | `mergeCoreOverrides`, `buildToTargets`, `assessTargetsChange` — pure, 24 tests |
| `api/run-engine.js` | Vercel Node function: load → run → guard → write. `mode` defaults to `dry` |
| `scripts/diff-headless-totargets.mjs` | Read-only acceptance test / drift detector |
| `params/engineRunStatus` | Status row; every non-dry exit path records itself |
| `params/toTargets_shadow` | Rollout target before the live row |

`api/run-engine.js` **writes only the `params` table**, exactly like `applyAndRun`,
so it cannot disturb `team_data` (stock, PO/TO, catalogue).

### What a headless run must reproduce

Read from `applyAndRun` (App.jsx:3389) — five inputs and two post-steps:

1. `params/global` merged **shallowly** over `DEFAULT_PARAMS` (the nested-key trap)
2. own-row configs re-attached via **`loadParamConfigRows`** — ⚠ hand-rolling this
   is what silently reverted attribution to `location` on every page load when two
   of three call sites missed `pincodeConfig`
3. `team_data/global`: `skuMaster`, `minReqQty`, `priceData`, `deadStock` (as a
   `Set`), `newSKUQty`
4. `team_data/invoice_data`: `invoiceData`
5. `overrides/global`: `coreOverrides`
6. `runEngine(...)`
7. `mergeCoreOverrides` per-field max, **then** the DC + active slice

## Guards

- **Refuse to run** if `invoiceData` is empty or `skuMaster` is empty.
- **`assessTargetsChange`** blocks a >20% fall in target count against the live
  row. `toTargets` is replace-entirely and the TO tool has no fallback if it
  arrives empty; the realistic failure is an input that failed to load, and nothing
  legitimately takes this row to zero. Ordinary churn is a fraction of a percent of
  ~2,030. Baseline is **always the live row**, even on a shadow run, so a shadow run
  reports what a live write *would* have done.
- `mode` defaults to `dry`; a live write needs an explicit `{"mode":"live"}`.
- The Vercel route is a **public URL** (unlike an edge function, which verifies the
  anon JWT), so it requires an `x-engine-secret` header matching
  `ENGINE_RUN_SECRET`.

## Verification already done (2026-07-31, read-only)

`scripts/diff-headless-totargets.mjs` against live prod, compared with the
`toTargets` Sandy's Apply wrote at 07:12:54Z:

```
LOAD    1361ms · invoiceData 74,381 rows · skuMaster 2105 · coreOverrides 0
        own-row configs: plywoodNetworkConfig, plywoodNetworkV2Config,
                         pincodeConfig, dsCapacities
        attribution mode: shippingCode
ENGINE  1000ms · 2110 SKUs
DIFF    headless 2030 · browser 2030 · only-headless 0 · only-browser 0 · differing 0
TIMING  2361ms total
```

- **0 of 2,030 SKUs differ, both directions** — the acceptance test the docs asked
  for, passed before any endpoint existed.
- **~2.4s end to end**, so the Vercel wall clock is not a constraint (5× headroom
  even on Hobby's 10s).
- The first harness run used an **independent** re-implementation of the
  serialization and also measured 0 differing; that is what earned the extraction
  into `src/toTargets.js`. Same order as the SKU-floor parser.

⚠ **`coreOverrides` is empty in prod, so the live diff never exercised the override
merge.** That path is covered by unit tests instead (8 of the 24), including that an
override is a floor and can never lower a value.

## Known gaps, recorded deliberately

- **App.jsx still has its own inline copy** of the serialization. Deferred on
  purpose: switching it is a frontend deploy, and it should ride with the
  `toTargets` cutover rather than be a separate risk. Until then
  `diff-headless-totargets.mjs` is the **drift detector** between the two — it uses
  the shared builder and compares against the row App.jsx wrote.
- **The page-load path does not merge `coreOverrides`.** `applyAndRun` and
  `triggerModel` do; the load path calls `setResults(raw)`. So IMS-on-load and
  `toTargets` would disagree for any overridden SKU. Currently zero overrides, so
  dormant — but it becomes visible the moment the Overrides tab is used.

## Rollout

1. Push + deploy the Vercel function. **Only after 14:30 IST and Sandy's
   confirmation that the TO cycle has run** — this adds `api/`, the first
   serverless function in the repo, so it changes what Vercel deploys.
2. Invoke `{"mode":"dry"}` by hand. Confirm it matches the local harness.
3. Invoke `{"mode":"shadow"}`. Diff `toTargets_shadow` against `toTargets` per SKU.
4. Only then `engine-run-nightly` cron at `15 0 * * *` UTC with `{"mode":"shadow"}`,
   accruing clean nights the way Stage 4 did.
5. Flip the cron body to `{"mode":"live"}`, and switch App.jsx onto the shared
   builder in the same change.

**Not in scope:** having IMS read the stored result instead of recomputing. That is
the end state which makes divergence structurally impossible, but it costs the
"engine changes go live on next page load" property and Impact Preview still needs
client-side compute. Decide separately once `toTargets` is auto-written.
