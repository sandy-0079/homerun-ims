# HomeRun IMS — open work (full entries)

Lifted verbatim out of the root `CLAUDE.md` on 2026-09-17, unchanged. Root keeps a
one-line index of every item — what it is, and how urgent — so the outstanding work stays
visible on every session. This file holds the reasoning: the measurements, the rejected
alternatives, and the ⚠ marks explaining why the obvious fix is wrong.

**Read this before picking anything up.** Several entries exist specifically to stop
someone re-deriving a conclusion that was already measured and rejected — item 25's
"fetch only modified invoices" and item 31's hysteresis are both recorded as decisions,
not oversights.

**Numbers are stable IDs.** They appear in commit messages and PRs, so they are never
renumbered or reused. Highest used is 36; 33 was never used; next is 37. The full index,
including everything shipped, is in root `CLAUDE.md`.

---

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
**Verified still open 2026-08-03:** `PUBLIC_TABS` (`App.jsx:2420` as of 2026-09-17 — grep, do not trust
the number) lacks `logic` and `overrides`, so
non-admins cannot see them at all. Plan: add both to `PUBLIC_TABS` and disable every input with
`disabled={!isAdmin}`. Upload Data stays admin-only. Plywood Network Design Config is already done this
way (visible to all, inputs disabled, Save hidden) — copy that pattern.
- **⚠ THIS NOW INTERACTS WITH ITEM 35, which proposes REMOVING the Overrides tab (2026-09-17).**
  Do not action them independently: making `overrides` publicly visible and deleting it are
  opposite moves on the same tab. Item 35 option (c) — keep the tab, make it read-only — IS this
  item for that half, so settle 35 first and then apply 7 to whatever survives (`logic` at minimum).

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

### 35. Remove the Manual Overrides tab — decide editor-only vs the whole feature
Queued 2026-09-17 alongside the tab retirement, to be looked at **before** item 36.
`OverridesTab` (`App.jsx`, admin-only, `tab==="overrides"&&isAdmin`) reads and writes the
Supabase **`overrides`** table (`overrides/global`), the third table beside `params` and
`team_data`.
- **Live `coreOverrides` count is 0** (measured 2026-09-17 via `snapshot-engine-inputs.mjs`).
  So removing the tab today would be provably inert for targets — but **re-measure at the
  time rather than trusting this number**, since a non-empty row changes the answer.
- **⚠⚠ THE TAB IS THE EDITOR, NOT THE FEATURE — and this is the whole decision.**
  `mergeCoreOverrides` (`src/toTargets.js:38`) is called by **both** `toTargets` writers:
  `applyAndRun` in App.jsx **and `api/run-engine.js:128`, the nightly Vercel run**. Separately
  `buildPoTargetsCsv` (`src/poTargetsCsv.js:83`) applies overrides to the PO Team Download.
  Deleting the tab leaves all three paths intact.
- **⚠ That leaves a real hazard worth naming.** With the editor gone, a non-empty
  `overrides/global` would still move published targets and the PO file, with **no UI to
  inspect or clear it** — a writer with no reader, the shape this codebase keeps getting bitten
  by. Either also remove the merge, or keep the tab visible read-only.
- So the decision is explicit: **(a)** remove only the editor and leave the merge, **(b)** remove
  the merge too — a larger change touching the nightly engine path, `poTargetsCsv` and their
  tests, needing the inertness proof — or **(c)** make the tab read-only for everyone, the
  pattern already used for the Plywood Network Design config.
- **⚠ Settle this BEFORE item 7**, which proposes the opposite: adding `overrides` to `PUBLIC_TABS`
  so non-admins can see it read-only. Option (c) here IS item 7 for this tab. Two open items
  pointing opposite ways at one tab is exactly the kind of thing that gets actioned twice.
- Same treatment as the 2026-09-17 retirement: `docs/retired/README.md` gains an entry, no code
  is copied, and the restore SHA is recorded.

### 36. The Plywood v2 engine is still in the tree with no way to reach it
Its **tab** was retired 2026-09-17; the **engine was deliberately kept**, because removing it
edits the file that computes every Min/Max and deserves its own change and its own proof.
Footprint: `src/engine/strategies/plywoodV2/` — **21 files, 184 KB**, plus a **32,909-char
`CLAUDE.md`** and its own `__tests__/`.
- **Inert today, verified:** no category maps to `network_design_v2` (live 2026-09-17 —
  Plywood/MDF is on `network_design`, v1), so it computes nothing. **Re-verify at the time.**
- **Every site that must change together** — grep rather than trusting these line numbers:
  `runEngine.js:17` (import) · `runEngine.js:138` (dispatch) · `runEngine.js:270` (the
  `network_design || network_design_v2` fallback) · `src/engine/index.js:7` (re-export) ·
  **`App.jsx:3424` `<option value="network_design_v2">Network Design v2</option>`** and the
  conditional at `3429` · `params/plywoodNetworkV2Config` and its entry in
  `loadParamConfigRows()` · the tests under `plywoodV2/__tests__/`.
- **⚠⚠ THE LOGIC TWEAKER OPTION MUST GO IN THE SAME CHANGE.** Leave it and an admin can select
  a strategy whose implementation no longer exists — and because `resolveStrategy` falls back
  silently, the symptom would be Plywood quietly computing on the wrong strategy rather than an
  error.
- **⚠ Decide the config row separately from the code.** Dropping `plywoodNetworkV2Config` from
  `loadParamConfigRows()` is the `pincodeConfig` trap in reverse — safe here only because
  nothing would read it, but it is a params own-row and those have bitten before. Leaving two
  inert keys in a row is the cheaper trade (precedent: `maxBufferPercentile`/`abqMultiplier`).
- **Proof required:** `snapshot-engine-inputs.mjs` → `dump-engine-output.mjs` (both sides) →
  `diff-engine-dumps.mjs`, expecting **0 of ~19,500 cells differing**, plus build, tests, lint
  with the problem count read, and the app actually loaded.
- **Context to preserve:** the 32,909-char `plywoodV2/CLAUDE.md` is the design record and does
  not rot. Move it to `docs/retired/` rather than deleting, and extend
  `docs/retired/README.md` — which already documents why the *code* is not copied anywhere.

### Later, not urgent
- **IMS reads the canonical stored result** instead of recomputing client-side — makes divergence
  structurally impossible and page loads much faster. Costs the "engine changes go live on next page
  load" property, and Impact Preview still needs client-side compute.

### 38. `sync-stock` with an EMPTY body syncs every branch
Chunks into pairs sequentially: 8 branches = 4 pairs ≈ 128s vs a 150s wall clock at ~200 req/min —
the 2026-07-09 storm shape. **Latent:** both callers send explicit branch lists. DS07/DS08 worsened
an existing foot-gun, not a new one. ⚠ Left alone 2026-09-18 so the go-live's "0 cells differ" proof
stayed clean. Fix: reject an empty body, or cap it to one group.

### 39. DS08 has no stock cron
`stock-sync-4` carries `DS06,DS07`. **⚠ Do NOT add DS08 to it** — 3 branches in one invocation 429s
after one group (2026-07-06, re-confirmed on the Inventory API). ⚠ Nor compress the 3-min stagger:
it holds the duty cycle near 35%. Prefer **`per_page` > 200** — untested, but ~14 pages becomes ~3
and both burst rate and the ~4,400 req/day fall ~4×. Fallback: a 5th slot at :47. Settle before DS08
opens; see `docs/HANDOFF-2026-09-16-zoho-token-contention.md`.
