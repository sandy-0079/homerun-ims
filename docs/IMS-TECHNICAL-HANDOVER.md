# HomeRun IMS & TO Tool — Technical Handover

**For:** the incoming Inventory Management Manager, taking the system over end-to-end.
**Written:** 2026-08-03. **Every live value in this document was read from production on that date** and
is marked `[live 08-03]`. Treat those as a snapshot; the mechanisms around them change rarely.

---

## How to read this, and what is authoritative

There are three layers of documentation. They disagree eventually, so know the order of authority:

| layer | what it is | trust it for |
|---|---|---|
| **The code** | `src/engine/` — ~3,200 lines | The formula. Always wins |
| **`CLAUDE.md`** (root, 1,300+ lines) | Engineering decision log: why each rule exists, and the incident behind it | *Why*. Denser and more honest than this document |
| **This document** | Structured orientation for the owner | Getting oriented, and knowing what you own |

**Where this document states a formula, it was read from the code on 2026-08-03**, not paraphrased from
`CLAUDE.md`. Where it states a number, it was read from the live Supabase row. File and line references
(`runEngine.js:397`) are given so you can verify anything yourself — please do; that habit is the single
best defence against this document going stale.

A companion document exists for plywood: `src/engine/strategies/plywoodV2/CLAUDE.md` (290 lines) is
authoritative for the v2 network engine and is not duplicated here.

> **⚠ This file contains no credentials.** The Supabase key and admin password are in `CLAUDE.md` and
> should reach you through a password manager, not a shared doc.

---

# Part A — Orientation

## A1. What the system actually decides

HomeRun runs **six dark stores, DS01–DS06, plus one DC at Rampura**. For every SKU at every one of those
seven locations, the tool computes a **Min** and a **Max**:

- **Min** = the reorder trigger. If closing stock ≤ Min at end of day, the location is restocked.
- **Max** = the target level restocked *to*. It is **not** a cap on selling, and not a storage limit.

That's it. Everything else in the system exists to compute those two numbers well, get them to the
people who act on them, and prove they were computed from current data.

**Two policy choices are deliberate and will look like bugs until you know them:**

1. **Cheap items are over-stocked on purpose; premium items are kept lean.** A ₹50 part sitting in
   excess costs almost nothing; a ₹5,000 one ties up capital. This is why the percentile chosen for the
   PCT strategy is *higher* (more aggressive) for cheap goods — see C6.
2. **A stockout costs ops chaos, not lost revenue.** We always fulfil the order — from another store or
   the DC. So the cost of being short is scrambling, extra transfers, and delay, not a lost sale. This
   is why the model leans toward holding stock rather than optimising it away.

## A2. The five surfaces

| surface | what it is | how it deploys |
|---|---|---|
| **IMS** (this repo) | React + Vite on Vercel. `homerun-ims.vercel.app` | `git push` → auto-deploy |
| **TO tool** | Separate repo `homerun-to`, own Vercel project. `homerun-to.vercel.app` | `git push` in that repo |
| **`api/run-engine.js`** | A **Vercel serverless function** in this repo — the headless nightly engine | Ships with the frontend |
| **Supabase Edge Functions** | 6 Deno functions doing all Zoho syncing | `supabase functions deploy <name>` |
| **Supabase Postgres** | `params` + `team_data` tables, and `pg_cron` for all scheduling | migrations / SQL |

**⚠ These deploy independently.** A `git push` updates IMS and `run-engine` but **not** the edge
functions; `supabase functions deploy` updates one function but not the frontend. `params/toTargets`
carries an `engineCommit` field precisely so you can see the skew.

## A3. Where the numbers live, and the one non-obvious thing about them

**IMS does not store Min/Max.** It recomputes the entire engine **client-side on every page load**, from
the invoice data in Supabase. Consequences you need to internalise:

- An engine code change goes live for everyone on their **next page load** after deploy. There is no
  "publish" step and no cache to clear.
- Two people can see different numbers if one has a tab open from before a data change.
- **The only *stored* Min/Max is `params/toTargets`**, which is what the TO tool reads. It has exactly
  two writers: the nightly `api/run-engine`, and the "Apply & Re-run Model" button.

So "the live Min/Max" is ambiguous and you should always ask *which surface*. On 2026-08-03 IMS showed
demand through 08-02 while `toTargets` still held 07-30 — both correct, describing different things.

| Supabase row | holds |
|---|---|
| `team_data/invoice_data` | All invoice line rows — the demand history. ~78,765 rows `[live 08-03]` |
| `team_data/global` | Everything else: SKU master, prices, floors, dead stock, stock, PO/TO |
| `params/global` | The Logic Tweaker parameters |
| `params/toTargets` | Serialized DC-inventorised Min/Max for the TO tool |
| `params/pincodeMap` | Pincode → DS attribution map (its own row — see C9) |
| `params/*SyncStatus` | One status row per nightly sync |

**⚠ `invoice_data` is a separate row for a hard reason.** Putting it back into `team_data/global` takes
that payload from ~1–2MB to ~7MB, and the hourly syncs then exhaust Supabase's Disk IO burst budget.
This was a real outage. Don't merge them.

## A4. The network: 6 dark stores + 1 DC

**All six dark stores are live** — DS01–DS06 — plus the DC at Rampura. `DS_LIST` is
`["DS01","DS02","DS03","DS04","DS05","DS06"]` (`constants.js:5`), hardcoded, and everything iterates it.
DS06 (Kogilu) went live ~2026-07-08 and is fully integrated: it is in `newDSList`, in all four plywood
brand matrices, and its own demand history is now long enough that the DS06 bootstrap seed was retired
(C10).

**⚠ `activeDSCount` is 4 `[live 08-03]`, but six stores are live — this looks like a leftover.**
What it does: divide the movement-interval thresholds when computing the **DC's** movement tag
(`runEngine.js:23`), on the logic that the DC sees demand aggregated across the stores, so its sales
interval is inherently shorter than any one store's.

- **It does not touch any Min or Max.** The DC quantities come from `sumDailyAvg`, lead time and the
  floor multipliers (C8) — never from the DC movement tag.
- **It does affect a number a human reads.** The DC movement tag appears on the Stock Health DC tab and
  in the CSV download's Movement Tag column, which ops use to judge reverse transfer orders. With
  `activeDSCount = 4` the thresholds are `[0.5, 1, 1.75, 2.5]` days; with 6 they would be
  `[0.33, 0.67, 1.17, 1.67]` — i.e. **the current setting makes it easier for a DC item to be tagged
  fast** than a six-store network warrants.

Changing it to 6 is a one-value edit, but it will visibly reshuffle DC movement tags, so make it a
conscious decision rather than a quiet fix. Listed in Part I.

---

# Part B — What you own

This is the part you cannot reconstruct from the app, and the part that breaks if nobody does it.

## B1. Inputs that are automatic (do not hand-edit these)

Every one has an unattended writer as of 2026-08-03. Times are IST.

| input | written by | when |
|---|---|---|
| SKU Master, Purchase Prices | `sync-catalogue` | 21:55–23:55, 5 attempts, first success wins |
| Invoice demand | `sync-invoices` | 00:35–04:00, 8 slots, atomic publish |
| SKU Floors (`newSKUQty`) | `sync-sku-floors` ← **the ops Google Sheet** | 04:35, 05:25 |
| `params/toTargets` | `api/run-engine` | 05:45, 06:15 |
| Stock, PO, TO | `sync-stock` ×4, `sync-orders` | hourly |

Then ops raise POs from ~06:00, and the DC team raises transfer orders at ~14:30 and ~20:30.

**⚠ The SKU-floors Google Sheet is authoritative and replaces `newSKUQty` wholesale every night.** Edit
the **sheet**, never the CSV. A CSV-only upload is silently reverted at 04:35, and the sync reports
success while doing it. If you must upload a CSV, download the sheet as CSV and upload *that*, so the
two cannot diverge.

## B2. Inputs that are yours, by design

| input | what it is | how |
|---|---|---|
| **`minReqQty`** | "Newly Launched Dark Store Floor Qty" — a per-SKU floor used only at new DSes | CSV upload, Upload Data tab |
| **`deadStock`** | SKUs to stop stocking entirely (Min=Max=0 everywhere) | CSV upload |
| **Category → strategy map** | Which algorithm each category uses | Logic Tweaker → Apply |
| **All Logic Tweaker params** | See Part E (in Part 2 of this doc) | Logic Tweaker → Apply |
| **Pincode routing map** | Which DS's catchment each pincode belongs to | Logic Tweaker upload |

These stay manual deliberately: they are commercial judgement, not Zoho data.

## B3. Five recurring responsibilities

**1. Assign a strategy to every new category.**
⚠ **An unmapped category silently falls through to Standard** (`resolveStrategy`, `runEngine.js:36-39` —
`categoryStrategies[category] || "standard"`). Nothing warns you. Measured 2026-07-30: of 384 SKUs on
Standard, only 259 were the *intended* Standard categories. Home Appliances (57) and Glass Hardware (31)
had never been consciously assigned — and premium slow-movers on averaging is precisely the profile PCT
exists to fix. **Audit:** diff `Object.values(skuMaster).category` against
`params/global.categoryStrategies`. Note the key is **`categoryStrategies`**, plural.
Currently **11 categories mapped** `[live 08-03]`: 8 PCT, 2 Fixed Unit Floor, plywood on Network Design.

**2. Keep the SKU-floors sheet honest.** A dry run reports floors that **can never take effect** — SKU
absent from the master, or not Active. Ops maintained 1,148 floors believing all were live; **39 were
not.** Read-only check:
```bash
npx vite-node scripts/dryrun-sku-floors.mjs
```

**3. Re-upload the pincode map whenever ops revise their routing sheet.** There is no sync. IMS keeps
attributing demand on the version last uploaded, and the only symptom of drift is a store quietly
stocked for the wrong catchment. `parsePincodeMapCsv` accepts the ops working sheet directly (the
per-DS 60/90/120-minute column blocks), so the file you upload *is* their sheet — no reformatting.

**4. Check the nightly chain each morning** — until alerting exists (Part I, item 17). One glance:
open IMS → Upload Data tab → the chip should read
`Last run: <today> 05:45 · demand through <yesterday>`. **Both halves matter.** The clock alone cannot
tell you the inputs are stale; see C11.

**5. Own the open decisions.** See Part I. Several are inherited, measured, and waiting.

## B4. What is safe to change, and what is a one-way door

| safe and reversible | dangerous |
|---|---|
| Any Logic Tweaker value — all local React state until you click Apply | **Invoice CSV upload REPLACES ENTIRELY.** A short file destroys history |
| Category strategy reassignment + Apply | Any Upload Data CSV writes production immediately |
| Uploading the pincode map | Plywood config Save; "Sync Now" |
| Re-running the engine (`toTargets` rebuilds in seconds) | — |

**⚠⚠ Three things that have each caused a real incident:**

1. **There is no staging.** `.env` points `VITE_SUPABASE_URL` at production, so `npm run dev` on
   localhost **reads and writes prod**.
2. **Invoice history before 2026-07-01 exists only in Supabase and three dated backups.** The Zoho org
   was migrated; the API cannot re-serve anything earlier. A full-window rebuild would destroy it
   permanently. This is why the invoice sync is enforced **append-only** in code
   (`_shared/invoiceMerge.ts`), not merely by intention.
3. **The tab-switch "unsaved changes" modal's first button is `▶ Apply & Continue` — that writes prod.**

---

# Part C — How Min and Max are computed

Entry point: `runEngine(inv, skuM, mrq, pd, deadStockSet, nsq, p)` in `src/engine/runEngine.js`.
Arguments: invoice rows, SKU master, `minReqQty`, price data, dead-stock set, `newSKUQty` (SKU floors),
params. It returns `res[sku] = { meta, stores: {DS01..DS06}, dc }`.

## C1. Order of operations (the whole pipeline)

```
0.  applyAttribution(inv, pincodeConfig)      ← FIRST. Rewrites which DS gets credit
1.  Window selection: last `overallPeriod` DISTINCT DATES
2.  Split into long / recent sub-windows
3.  Per-SKU ranking (T50/T150/T250) for the New DS Floor
4.  Plywood Network Design computed separately, then BYPASSES steps 5-8
5.  Per SKU × DS: pick a strategy, compute raw Min/Max          ← C5-C7
6.  Post-blend, strict order:
      a. New DS Floor  (per-field max)
      b. ceil()
      c. capture preFloorMin/Max for the audit trail
      d. SKU Floor     (per-field max, case-insensitive SKU lookup)
      e. Dead Stock    → 0/0
7.  DC calculation (per SKU)                                     ← C8
8.  DS Seed pass                                                 ← C10 (currently inactive)
9.  Active-only normalization  → non-active SKUs zeroed everywhere
10. Inventorised-At normalization → Supplier zeroed; DS-inv gets DC=0
```

**⚠ Note step 6 carefully — the rounding sits between the two floors.** `CLAUDE.md` describes the order
as "New DS Floor → SKU Floor → Dead Stock → Rounding"; the code (`runEngine.js:332-354`) actually does
New DS Floor → `ceil` → SKU Floor → Dead Stock. So a SKU floor is applied to an already-rounded value
and is not itself re-rounded (it is an integer from the sheet anyway). Harmless today, but if you change
the sheet to accept fractions, this is where it matters.

## C2. The demand window — dates, not days

```js
allDates = [...new Set(inv.map(r => r.date))].sort().slice(-op)   // runEngine.js:62-63
```

`op` = `overallPeriod` = **45** `[live 08-03]`.

**⚠ This counts DISTINCT DATES PRESENT IN THE DATA, not calendar days.** If a day has no invoices at
all, it does not consume a window slot. That is deliberate — it stops non-trading days from silently
shortening effective history — but it means "45 days" can span more than 45 calendar days. The same
convention is used by the retention trim.

The window then splits:

```js
rw     = min(recencyWindow, op - 1)     // recencyWindow = 15 [live 08-03]
split  = max(0, total - rw)
dLong  = allDates[0 .. split)           // oldest 30 dates
dRecent= allDates[split .. end]         // newest 15 dates
```

## C3. The four tags every SKU × DS gets

Everything downstream is driven by these.

**Movement tag** (`getMovTag`, `utils.js:122`) — from how *often* it sells:
```
avgInterval = windowDays / nonZeroDays
≤2 → Super Fast   ≤4 → Fast   ≤7 → Moderate   ≤10 → Slow   else → Super Slow
```
`movIntervals = [2,4,7,10]` `[live 08-03]`. NZD = 0 → Super Slow.

**Price tag** (`getPriceTag`, `utils.js:120`) — from purchase price:
```
≥3000 → Premium   ≥1500 → High   ≥400 → Medium   ≥100 → Low   >0 → Super Low   0 → No Price
```
`priceTiers = [3000,1500,400,100]` `[live 08-03]`.

**⚠ "No Price" is not neutral — it is the most aggressive setting.** A SKU with no purchase price gets
the 95th percentile under PCT, i.e. treated like a cheap item. So a *missing* price causes
over-stocking. This is why the price sync merges rather than replaces (see Part 2).

**Spike tag** (`getSpikeTag`, `utils.js:124`) — how often a day dwarfs the average:
```
spikeDay  = daily qty > spikeMultiplier × dailyAvg      // spikeMultiplier = 5 [live]
pct       = spikeDays / totalDays × 100
≥10% → Frequent   ≥5% → Once in a while   >0 → Rare   else → No Spike
```

**Volume rank** (`runEngine.js:81-87`) — SKUs sorted by total qty across all DSes:
`T50` (top 50), `T150`, `T250`, else `No`. Active SKUs with zero sales get `Zero Sale`. Used **only** by
the New DS Floor.

**Core statistics** (`computeStats`, `utils.js:126`):
```
dailyAvg    = totalQty / periodDays        ← divides by the WHOLE window, including zero days
abq         = totalQty / totalOrders       ← Average Buying Quantity
spikeMedian = median(spike day quantities), or maxDayQty if there were no spikes
```
**⚠ `dailyAvg` divides by the full window.** A SKU selling 10 units once in 45 days has
`dailyAvg = 0.22`, not 10. This is the whole reason the category strategies exist: **78.7% of SKU×DS
combos are Slow or Super Slow**, and for those an average produces a near-zero Min.

## C4. Strategy dispatch

```js
strategy = categoryStrategies[meta.category] || "standard"      // runEngine.js:36-39
```
Then, if the category resolved to a plywood network mode but this SKU is not in a covered brand
(e.g. Merino), it falls to `plywoodNonNetworkStrategy` = `"percentile_cover"` `[live]`
(`runEngine.js:199`) — **not** Standard.

**Live assignment `[live 08-03]` — 11 categories:**

| strategy | categories |
|---|---|
| **Percentile Cover** (8) | Furniture & Architectural Hardware · Tiling · CPVC Pipes & Fittings · Switches & Sockets · Conduits & GI Boxes · Lighting · Sanitary & Bath Fittings · Kitchen Sinks & Faucets |
| **Fixed Unit Floor** (2) | Wires, MCB & Distribution Boards · Overhead Tanks |
| **Network Design** (1) | Plywood, MDF & HDHMR |
| **Standard** | everything unmapped — *including 88 SKUs nobody chose*, see B3 |

## C5. Standard — long/recent blend

`strategies/standard.js`. Computes Min/Max **independently** on the long and recent sub-windows, then
blends them, weighted toward recent.

Per sub-window (`calcPeriodMinMax`, `standard.js:7`):
```
base      = baseMinDays[movementTag]        // Super Fast 6, Fast 5, Moderate/Slow/Super Slow 3 [live]
baseMinQty= dailyAvg × base
bufQty    = maxDaysBuffer × dailyAvg        // maxDaysBuffer = 2 [live]

useRatio  = spikeTag is Frequent or No Spike,
            OR (Once in a while / Rare AND price is Low/Super Low/No Price)

min = useRatio ? ceil(max(baseMinQty, spikeMedian)) : ceil(baseMinQty)
max = useRatio ? ceil(max(baseMinQty + bufQty, spikeMedian + bufQty)) : ceil(baseMinQty + bufQty)
```
`useRatio` is the mechanism that lets a spiky-but-cheap item be stocked for its spike, while a spiky
*expensive* item is not.

**ABQ override** — for slow-moving cheap goods, stock at least one typical order:
```
if movement is Slow/Super Slow AND price is Medium/Low/Super Low AND abq > 0:
    if ceil(abq) ≥ min:  min = ceil(abq);  max = ceil(min × abqMaxMultiplier)   // 1.5 [live]
```

Then the blend (`standard.js:45-50`):
```
wt  = recencyWt[movementTag90]
min = ceil((minLong + minRecent × wt) / (1 + wt))
max = ceil((maxLong + maxRecent × wt) / (1 + wt))
```
`recencyWt = {Super Fast 5, Fast 5, Moderate 4, Slow 4, Super Slow 4}` `[live 08-03]`.

**This is one of the highest-leverage knobs in the system, so be clear what the number means.** `wt` is
the weight given to the recent sub-window relative to the long one, so the recent window's share is
`wt / (1 + wt)`:

| `wt` | recent 15 days carry | long 30 days carry |
|---|---|---|
| 1 | 50% | 50% |
| **4** (Moderate → Super Slow) | **80%** | 20% |
| **5** (Fast, Super Fast) | **83%** | 17% |

So the model is currently strongly recency-weighted across the board, and slightly more so for
fast movers. Raising `wt` makes Min/Max track the last two weeks more closely and become more volatile
week to week; lowering it makes them steadier and slower to react to a genuine change in demand.

## C6. Percentile Cover (PCT) — for erratic timing, predictable size

`strategies/percentileCover.js`. Built because averaging fails for items selling once every 10+ days.
Instead of an average, it uses a **high percentile of the non-zero daily quantities**.

```
nonZeroQtys = the daily quantities that were > 0, sorted
pctQty      = percentile(nonZeroQtys, percentileByPrice[priceTag])
min         = ceil(pctQty × coverDaysByMovement[movementTag])
max         = ceil(min + dailyAvg × maxDaysBuffer)
```

`[live 08-03]`:

| price tag | percentile | | movement | cover days |
|---|---|---|---|---|
| Low / Super Low / No Price | **95** | | Super Fast / Fast | 2 |
| Medium | 85 | | Moderate / Slow / Super Slow | 1 |
| High | 80 | | | |
| Premium | **75** | | | |

Cheap → 95th percentile (aggressive). Premium → 75th (lean). That is policy A1.1 made concrete.

**Two guards, both price-tag dependent:**

**NZD gate** (`runEngine.js:250-254`): Premium/High need `nonZeroDays ≥ pctMinNZD` (**2** `[live]`) —
one observation cannot establish a distribution. Below threshold → **falls back to Standard**, tagged
`strategyDetails.pctFallback`. Cheap tags use threshold 1.

**DOC cap** (`runEngine.js:258-272`): caps Min at a number of days of cover.
```
capDays = Premium/High ? pctDocCap (30) : pctDocCapLow (60)      [live]
if min > ceil(dailyAvg × capDays):
    min = ceil(dailyAvg × capDays)
    max = ceil(min + dailyAvg × maxDaysBuffer)
```
This is what stops one big order-day from parking 200 days of stock at a store.

## C7. Fixed Unit Floor (FUF) — for predictable order *size*

`strategies/fixedUnitFloor.js`. For Wires/MCB and Overhead Tanks: you cannot predict *when* someone
buys, but when they do it is a fairly standard quantity. So the Min is built from the distribution of
**individual order-line quantities**, not daily totals.

```
orderQtys = every individual line quantity for this SKU × DS in the window
            (collectOrderQtys, runEngine.js:42)

# winsorise: clip one contractor bulk-buy hiding among normal orders
if spikeCapMult > 0 AND orderQtys.length ≥ 3:
    cap = median(orderQtys) × spikeCapMult          # spikeCapMult default 5
    clip every qty to cap

min = ceil(percentile(clipped, orderQtyPercentile))     # P90 [live]
max = ceil(max(min + maxAdditive, min × maxMultiplier)) # +1, ×1.5 [live]
```
Returns `null` if there are no orders at all → caller falls back to Standard.

**Order-days gate** (`runEngine.js:285-293`), mirroring PCT's: Premium/High need
`nonZeroDays ≥ fixedUnitFloor.minNZD` (**2**), else fall back to Standard **floored at Min ≥ 1** —
because this path only runs for SKUs that *do* have demand. Cheap tags keep threshold 1.

**Both guards are live and both are editable.** Logic Tweaker → Fixed Unit Floor Params
(`App.jsx:4654-4662`) shows and edits them; the effective values are the order-days gate at **2** and the
spike cap at **5×**. `minNZD = 1` turns the gate off; `spikeCapMult = 0` turns the winsor off.

> **Note for whoever edits the engine code** (not an operational concern): the stored params row does not
> contain these two keys — `fixedUnitFloor = {maxAdditive:1, maxMultiplier:1.5, orderQtyPercentile:90}`
> `[live 08-03]` — because it predates them. They work because both the engine and the UI read them as
> `?? 2` / `?? 5`. This is invisible in behaviour, but it tells you the convention: **the params merge is
> shallow** (`{...DEFAULT_PARAMS, ...sbParams}` replaces a nested object wholesale), so **any new nested
> parameter must carry an inline `??` default** or it will read `undefined` in production while working
> perfectly on a fresh local default. Top-level params are unaffected.

**Known accepted gap:** a 2-order spike (e.g. quantities `[1, 20]` on two days) defeats both guards —
too many order-days for the gate, median too high for the winsor. Consciously accepted; raising `minNZD`
would over-gate genuine repeat demand.

## C8. The DC calculation

`runEngine.js:379-402`. Three branches, checked in this order:

```
1. Dead stock                  → DC Min = Max = 0
2. SKU has ANY manual floor     → Min = round(Σ DS Min × skuFloorDCMultMin)   // 0.2 [live]
   (i.e. nsq[sku] exists)         Max = round(Σ DS Max × skuFloorDCMultMax)   // 0.3 [live]
3. Everything else (rate-based) → Min = ceil(sumDailyAvg × (leadTime + 1))
                                  Max = Min + ceil(sumDailyAvg × 2)
```
where `sumDailyAvg` = sum of `dailyAvg` across all six DSes, and
`leadTime = brandLeadTimeDays[brand] ?? _default ?? 2`. `[live]`
`brandLeadTimeDays = {_default: 3, "Asian Paints": 4}`.

**⚠ Branch 2 is gated on having a manual floor, NOT on strategy.** This is the source of a persistent
misreading: it *looks* as though PCT and Fixed Unit Floor already use the `Σ DS Min` approach, and for
many SKUs they do — but only because those SKUs happen to be floored. Measured `[live 08-03]`, of 2,019
DC-inventorised active SKUs:

| strategy | on rate-based DC | already `Σ DS Min` (via floors) |
|---|---|---|
| Fixed Unit Floor | **406** | 186 (30%) |
| Percentile Cover | **233** | 714 (75%) |

Those **639 SKUs** are exactly the scope of open item 8 (Part I).

**DC movement tag** (`getDCStats`, `runEngine.js:19-31`) is computed differently from the DS tags: the
interval thresholds are **divided by `activeDSCount`** (4 `[live]`), and `Fast` is then collapsed into
`Super Fast`. Consequence: a bare "Fast" never appears on the DC tab. Only used for display.

## C9. Demand attribution — which store gets credited

`src/engine/attribution.js`, and it is the **first thing** `runEngine` does (`runEngine.js:53`).

**The problem it solves:** when a store is out of stock, the whole order is invoiced from a *different*
store. That inflates the fulfilling store's apparent demand and hides the real need at the customer's
own store. Measured: **~11% of demand lines misattributed** in steady state.

Two modes in `params/pincodeMap`:
- `"location"` — credit the store that physically invoiced it (`row.ds`). Historical default.
- `"shippingCode"` — credit the store whose catchment owns the customer's pincode (`row.pin` → map).
  **Currently active `[live 08-03]`.**

```js
applyAttribution(inv, cfg) {
  if (cfg.mode !== "shippingCode") return inv;        // off-path is a literal no-op
  return inv.map(r => map[r.pin] && map[r.pin] !== r.ds ? {...r, ds: map[r.pin]} : r);
}
```

**Design decisions you should not casually reverse:**

- **Resolved at engine time, not at CSV-parse time.** The stored rows keep the raw pincode, so switching
  modes is a **re-run, not a re-upload**.
- **The current map is applied to ALL history, deliberately.** It answers "what would demand be if
  today's catchment had always existed" — the right counterfactual for setting future Min/Max. There is
  no date-versioning even though ops do reassign pincodes.
- **Unmapped pincodes fall back to the fulfilling store**, never dropped.
- **A pincode claimed by two stores is rejected at upload**, not silently resolved.

Measured effect of the flip: network Max **₹7.81Cr → ₹7.68Cr (−1.7%)**; DS02 −₹16.4L, DS05 −₹6.2L,
DS03 +₹5.1L, DS04 +₹5.9L, DS06 +₹3.9L, DC −₹6.6L; 1,120 SKUs moved. **DS02 is now deliberately stocked
~₹16.4L lighter** — which is safe only because routing genuinely follows this map (the uploaded CSV *is*
the ops routing sheet).

**⚠ A trap that lasted five weeks:** `invoiceData` in React state stays **raw**, so any tab computing
its own demand by grouping `r.ds` was still on fulfilling-location behaviour while the engine used
pincodes. SKU Detail contradicted the Min/Max printed beside it. Fixed by one shared
`attributedInvoice` memo in `App.jsx`. **If you add anything that reads `invoiceData`, pass it
`attributedInvoice`.** `runEngine` still receives raw rows and attributes internally — double-applying
is harmless (idempotent) but keep the two paths distinct.

## C10. DS Seed — currently inactive, and that was a decision

`src/engine/dsSeed.js`. Seeds a new store's Min/Max from the equal-weight average of source stores:
`target = max(existing, ceil(mult × avg(sources)))`, with per-category damping
(`dsSeedCategoryMult = {"Plywood, MDF & HDHMR": 0.6}` `[live]`).

**`dsSeed = {}` — inactive `[live 08-03]`.** It was built for DS06 (avg of DS02, DS04) and **sunset
2026-07-31**. The reasoning is worth knowing because it generalises:

Under `shippingCode` attribution, DS02's and DS04's historical orders *from DS06 pincodes have already
been moved to DS06*. Seeding DS06 from their averages then adds back their **remaining** demand — which
belongs to other catchments. The decisive measurement: of the 431 SKUs that lost DS06 stocking when the
seed was removed, **417 (97%) had zero DS06-attributed demand in 45 days**, and ₹18.8L of the ₹19.5L the
seed added sat on zero-demand SKUs.

**⚠ The generalisable lesson:** a bootstrap justified by "no data" must be re-tested when the
**definition** of the data changes, not when a calendar reminder fires. The original note set a 90-day
review; what actually obsoleted the seed was the attribution flip four days later, which changed what
"DS06 demand" *means*. Re-enabling it needs a fresh measurement, not a rollback.

## C11. The two final overrides

**Active-only** (`runEngine.js:437-445`): only SKUs `active` in the SKU Master get non-zero targets.
```js
if (String(r.meta?.status ?? "Active").trim().toLowerCase() === "active") return;   // else zero it
```
- An allowlist of exactly `"active"` is the only safe rule — Zoho's vocabulary already includes
  `confirmation_pending` and can grow.
- A **missing** status counts as active (the `(status || "Active")` convention for a master row that
  omits the field) — deliberately different from a SKU **absent** from the master, which is fabricated
  with `status: "Unknown"` at `runEngine.js:190` and therefore zeroed.
- The entry is **kept, not deleted** — consumers iterate `Object.keys(res)`, and the Upload tab's
  "in Invoice but not Active" warning needs them visible.

**Inventorised-At** (`runEngine.js:453-464`), from `meta.inventorisedAt`:
- **Supplier** → Min = Max = 0 at every DS **and** the DC. Never stocked in our network.
- **DS** → DC Min = Max = 0, store values kept. Replenished directly, bypasses the DC.
- **DC** → untouched.

**⚠ Zoho now owns `inventorisedAt`**, and it is the highest-consequence field in the master: setting one
SKU to Supplier zeroes it everywhere. The nightly guard watches for a >5% shift in the mix, which catches
a mass change but **not a handful**. The real check is `invAtChanged.toSupplier` in
`params/catalogueSyncStatus`, which lists every SKU that became Supplier.

---

## C12. Stale parameters — ignore these, they need removing

Four stored parameters are **read by no calculation** (verified 2026-08-03 by searching for every
`p.<name>` / `params.<name>` read across `src/`). They are not documented in Part E because there is
nothing to learn about them — they need deleting from the code and the UI:

| param | state |
|---|---|
| `dcMult` | Stored and change-tracked; no reads. Superseded by the DC branches in C8 |
| `dcDeadMult` | No reads — **and it still has editable inputs in Logic Tweaker** (`App.jsx:4912-4925`), so it can be tuned with no effect. Superseded by Dead Stock = 0/0 everywhere |
| `brandBuffer` | Stored and change-tracked; no reads. Superseded by `brandLeadTimeDays` |
| `pctDocCapPriceTags` | Orphaned in the production row; no reads, no UI. The DOC-cap price tiers are hardcoded in `runEngine.js:250-251` |

**Cleanup task:** remove the four from `DEFAULT_PARAMS`, the `dcDeadMult` UI block, and the dirty-check
list at `App.jsx:3034`, then drop the keys from `params/global`. Low risk (nothing reads them) but it
touches the Apply path, so do it as its own change with a params backup taken first. Tracked in Part I.

---

---

# Part D — The nightly chain

## D1. The schedule

All scheduling is `pg_cron` inside Supabase. **10 jobs.** Verify with
`select jobname, schedule from cron.job order by jobname;`

| IST | UTC | job | writes |
|---|---|---|---|
| 21:55, 22:25, 22:55, 23:25, 23:55 | `25,55 16,17 *` + `25 18 *` | `catalogue-sync-earlier` / `-nightly` | `skuMaster`, `priceData` |
| 00:35 – 04:00, 8 slots | `5,20 19-22 *` | `invoices-sync-window` | `invoice_data` |
| 04:35, 05:25 | `5,55 23 *` | `sku-floors-sync` | `newSKUQty` |
| 05:45, 06:15 | `15,45 0 *` | `engine-run-nightly` | `params/toTargets` |
| hourly :05 :08 :11 :14 | `:35 :38 :41 :44` | `stock-sync-1..4` | `stockData`, `stockDataAccounting` |
| hourly :20 | `:50` | `orders-sync-hourly` | `poData`, `toData` |

Then ops raise POs from ~06:00 IST; the DC team raises transfer orders ~14:30 and ~20:30.

**⚠ Rules for touching this schedule:**
- **Free minutes each hour are `:00–:34` and `:51–:59` UTC.** `:35 :38 :41 :44` and `:50` are taken, and
  `:50` writes the same `team_data/global` row — concurrent writers there caused a Postgres statement
  timeout that left two stores 74 minutes stale.
- **A retry slot must clear 15 minutes from the end of the previous attempt.** The cooldown
  (`COOLDOWN_MS`) is stamped on **failure** too, so a closer retry is silently refused.
- **Post-midnight-IST slots are safe only because `syncNightKey()` shifts 3h before taking the IST
  date.** Re-read that helper before adding any slot at or past 00:00 IST — a naive calendar date would
  re-pull *and* poison the following night's gate while reporting success.

## D2. Why invoices run overnight, and why the write is atomic

The original design pulled invoices at 21:30 IST on the premise that "invoices are complete by 20:30".
**That premise was wrong and it cost 27.7% of a day's quantity.** Invoices are *raised* by ~20:30 but not
*settled* until hours later. Measured at ~12:00 IST over 224 in-flight invoices: **paid 50%,
partially_paid 38%, sent 12%.** The finish line for invoice data is settlement, not the trading close.

So the window is 00:35–04:00 IST: idle (trading ends 20:00, POs start ~06:00) and clear of the hourly
syncs.

**Atomic publish is the load-bearing safety property.** Chunks accumulate in
`team_data/invoice_sync_buffer`; the target row is written **exactly once**, only when every planned date
is fully pulled and both guards pass. Because IMS recomputes the engine on every page load, a partially
written invoice row would instantly show wrong Min/Max to everyone — and TOs are occasionally raised as
late as ~02:00 IST. **Timing alone cannot give that guarantee; atomicity can.** Any failure leaves the
previous complete pull in place.

**Two write guards, both fail closed:**
- `assessCoverage` — unknown-SKU rate > 1% ⇒ refuse
- `mergeInvoiceRows.report.safe` — any date loss the retention trim doesn't explain ⇒ refuse
  (`safe = datesAfter >= datesBefore − datesTrimmed`)

**D-3 re-fetch:** each night also re-pulls the date 3 days back, correcting invoices that were counted
while `sent` and later voided (~0.9%). A *fixed* lag, not a rotation, so every day gets exactly one
recheck.

**Retention:** `RETENTION_DAYS = 90`, counted in **distinct dates present**, not calendar days.

## D3. Invoice status: a blocklist, not an allowlist

`_shared/invoiceMap.ts` rejects `{void, draft}` and accepts everything else.

It was originally an allowlist of `{paid, overdue}`, derived from a 7-day probe of **settled** history —
which by construction contains only terminal statuses. **No amount of historical sampling can observe an
intermediate state.** A live invoice passes through `partially_paid` and `sent` first, so the allowlist
silently deleted live demand and still reported `ok: true`.

The reasoning that replaced it: **the model measures DEMAND.** If the goods left the shelf that is
demand, whatever the payment state. An allowlist fails *closed* on demand — expensive and silent. A
blocklist fails *open* — over-counts, visibly, and is correctable by the D-3 re-fetch. A **missing**
status is still rejected: absent data is not evidence of a sale.

## D4. What each sync guards against

| sync | guard | on failure |
|---|---|---|
| `sync-catalogue` | `assessMasterChange` — row count, `inventorisedAt` mix, **and active share** | Refuses; night gate stays open so a later slot retries |
| `sync-invoices` | coverage + merge safety (D2) | Target untouched; `ok:false` |
| `sync-sku-floors` | `keyDropPct` **and** `floorDropPct`, both >20% ⇒ refuse | Refuses |
| `api/run-engine` | `assessTargetsChange` — >20% fall in target count | Writes status row only; `toTargets` untouched |

**⚠ `sync-sku-floors` needs two dimensions for a real reason.** Ops remove a floor either by deleting the
row *or* by setting it `0,0`. The second leaves the SKU key present, so a key-count guard alone sees a
**0% drop** and would wave through a broken formula that zeroed every value column — 1,148 rows in,
1,148 out, every floor gone. `floorDropPct` counts SKUs actually *carrying* a floor.

**⚠ `force` overrides policy, never correctness.** It bypasses the night gate, the cooldown and the guard
*threshold* — never parse validation. A header-only sheet parses "successfully" to `{}`, so
`parseFloorSheet` refuses zero SKUs outright.

## D5. Reading the status rows

One row per sync in `params`. This is the entire observability surface today.

```bash
B=https://rgyupnrogkbugsadwlye.supabase.co/rest/v1; K=<anon key>
for r in engineRunStatus invoiceSyncStatus catalogueSyncStatus skuFloorSyncStatus; do
  echo "== $r"; curl -sS "$B/params?select=payload&id=eq.$r" -H "apikey: $K" | python3 -m json.tool
done
```

| row | healthy looks like |
|---|---|
| `invoiceSyncStatus` | `phase:"published"`, `merge.safe:true`, `coverage.unknownPct` < 1, `degradedDates:[]` |
| `catalogueSyncStatus` | `lastOkNight` = tonight, `change.safe:true`, **`invAtChanged.toSupplier: []`** |
| `skuFloorSyncStatus` | `lastOkNight` = tonight, `change.reason:"ok"` |
| `engineRunStatus` | `ok:true`, `mode:"live"`, `reason:"ok"`, `inputs.invoiceDataThrough` = yesterday |

**⚠ `ok:true` is not sufficient — check the derived value.** The night that lost 27.7% of quantity
reported `ok:true`, because `assessCoverage` measures the unknown-SKU rate *among rows that arrived*, so
a dropped invoice contributes none (it actually **improves** the metric). Always read
`inputs.invoiceDataThrough`.

**⚠ Status codes:** `546` = Supabase killed the function (wall clock). `500` = the function caught an
error and returned. `504` = the gateway gave up — **but the isolate may keep running and still write.**
`504` together with `ok:true` is the signature of a silently truncated run.

**⚠ A skipped invocation logs nothing.** Cooldown skips and `busy` exits `return json(...)` with no
console output, so they look identical to a crash in `function_logs`. Distinguish them by duration in
`function_edge_logs`: a `sync-stock` skip is ~1,100ms, real work is ~12,000–14,000ms.

## D6. Zoho constraints you will eventually hit

- **`inventorysummary` tolerates ~8 calls/minute.** Max 4 calls per invocation — that is why the stock
  sync is 4 staggered crons rather than one job.
- **Browser-triggered syncs need explicit 90-second pacing.** Sequencing groups back-to-back is *not*
  pacing: on a fast-Zoho morning that put 12 calls in ~15s and drew a ~60-minute penalty that also killed
  a cron cycle.
- **A per-call backoff makes a concurrency problem worse.** At concurrency 8 the invoice sync generated
  its own 429s continuously and spent ~960 worker-seconds asleep, blowing the 150s wall clock. Fix
  concurrency and pacing, not the backoff. It now runs at **concurrency 4, chunks of 250, an hour apart**.
- **⚠ Zoho goes down org-wide, and a function can be a victim rather than a cause.** Twice (2026-07-29,
  07-30) every Zoho consumer failed identically with 429s for ~50 minutes and recovered on its own. **The
  diagnostic is: did it die on the first call?** If yes, you walked into someone else's penalty — retry
  later in time. If it degraded progressively, you tripped the limit yourself — reduce concurrency. A
  second signal: if two *different* rate-limit buckets fail within minutes (`inventorysummary` **and**
  `/purchaseorders`), it is not your pacing.
- **A single browser "Sync Now" can block all four stock crons for a cycle** — the session lease is 12
  minutes and the crons sit 3 minutes apart. If the tab then goes away, nothing retries and those
  branches stay stale for the hour, with no signal.

---

# Part E — The live parameters

All in `params/global` unless noted. Edited in **Logic Tweaker**, applied with **Apply & Re-run Model**.

**⚠ Apply writes only the `params` table** — `params/global`, `paramsBackup`, `pincodeMap`, `toTargets`.
It cannot touch `team_data`, so it can never disturb invoice or stock data. Useful when isolating which
write moved a value.

**⚠ A full params backup is written to `params/paramsBackup` on every Apply.** That is your undo.

## E1. Window and blending

| param | live | what it does | raise it → |
|---|---|---|---|
| `overallPeriod` | **45** | Demand window, in **distinct dates present** | More history, steadier, slower to react |
| `recencyWindow` | **15** | Size of the "recent" sub-window | Larger recent block, less distinct from long |
| `recencyWt` | **{SF 5, F 5, M 4, S 4, SS 4}** | Weight on recent vs long (C5) | Tracks last two weeks harder; more week-to-week volatility |
| `movIntervals` | **[2,4,7,10]** | Day-interval cutoffs for Super Fast / Fast / Moderate / Slow | Wider bands ⇒ items classed faster |
| `priceTiers` | **[3000,1500,400,100]** | ₹ cutoffs for Premium / High / Medium / Low | Shifts which items are treated as premium |

## E2. Spikes and Standard

| param | live | what it does |
|---|---|---|
| `spikeMultiplier` | **5** | A day is a "spike" if qty > 5 × dailyAvg |
| `spikePctFrequent` | **10** | ≥10% spike days ⇒ Frequent |
| `spikePctOnce` | **5** | ≥5% ⇒ Once in a while |
| `baseMinDays` | **{SF 6, F 5, M 3, S 3, SS 3}** | Days of cover in the Standard Min |
| `maxDaysBuffer` | **2** | Extra days of cover added for Max (used by Standard **and** PCT) |
| `abqMaxMultiplier` | **1.5** | Max = Min × this when the ABQ override fires (C5) |

## E3. Percentile Cover

| param | live | what it does |
|---|---|---|
| `percentileCover.percentileByPrice` | **Premium 75 · High 80 · Medium 85 · Low/Super Low/No Price 95** | Which percentile of non-zero daily qty becomes the base |
| `percentileCover.coverDaysByMovement` | **Super Fast/Fast 2 · rest 1** | Multiplier on that percentile |
| `pctMinNZD` | **2** | Premium/High need this many order-days, else fall back to Standard |
| `pctDocCap` | **30** | Days-of-cover cap on Min for Premium/High |
| `pctDocCapLow` | **60** | Same for cheaper tags |

## E4. Fixed Unit Floor

| param | live | what it does |
|---|---|---|
| `fixedUnitFloor.orderQtyPercentile` | **90** | Percentile of individual order sizes → Min |
| `fixedUnitFloor.maxMultiplier` | **1.5** | Max = Min × this … |
| `fixedUnitFloor.maxAdditive` | **1** | … or Min + this, whichever is larger |
| `fixedUnitFloor.minNZD` | **2** *(effective)* | Order-days gate for Premium/High; `1` = off |
| `fixedUnitFloor.spikeCapMult` | **5** *(effective)* | Winsorise cap = median × this; `0` = off |

## E5. DC, floors and stores

| param | live | what it does |
|---|---|---|
| `brandLeadTimeDays` | **{_default: 3, Asian Paints: 4}** | Lead time in the rate-based DC formula |
| `skuFloorDCMultMin` / `Max` | **0.2 / 0.3** | DC = Σ DS Min × 0.2 / Σ DS Max × 0.3 for floored SKUs |
| `newDSList` | **[DS04, DS05, DS06, DS03]** | Stores that get the New DS Floor |
| `newDSFloorTopN` | **250** | Only SKUs ranked in the top N by volume are eligible for that floor |
| `activeDSCount` | **4** | Divides DC movement-tag thresholds — see A4, **probably should be 6** |
| `plywoodNonNetworkStrategy` | **percentile_cover** | Strategy for plywood brands outside the network matrix (e.g. Merino) |
| `dsSeed` | **{}** — inactive | New-store bootstrap (C10) |
| `dsSeedCategoryMult` | **{Plywood: 0.6}** | Per-category damping if the seed is re-enabled |
| `categoryStrategies` | **11 categories** | The strategy map (C4). **Unmapped ⇒ silently Standard** |

## E6. Configs that live in their OWN params row

**⚠ This is a rule, not a convention: new config belongs in its own `params` row, never in
`params/global`.** `params/global` is written wholesale on every Apply and loaded with a **shallow** merge
(`{...DEFAULT_PARAMS, ...sbParams}`), so a new **nested** key is silently dropped. Top-level keys are
safe; nested ones need inline `??` defaults (see C7).

| row | holds |
|---|---|
| `params/pincodeMap` | Attribution mode + pincode → DS map |
| `params/plywoodNetworkConfig` | v1 Network Design (brands, nodes, zones) |
| `params/plywoodNetworkV2Config` | v2 (dormant) |
| `params/networkConfigs` | Saved network scenarios |
| `params/toTargets` | Serialized Min/Max for the TO tool |
| `params/binLocations` | SKU → DC bin, for TO pick-path ordering |

**Use `src/paramConfigRows.js` — do not hand-roll this.** `loadParamConfigRows()` is the single list of
which configs live in their own row; all three load sites call it, and `applyAndRun` strips them before
writing `params/global`. It exists because three separate places rebuilt the params object by hand and
**two of them forgot `pincodeConfig`** — so every page load silently reverted attribution to
"location" (₹7.95Cr vs ₹7.81Cr) while `toTargets` stayed correct. The symptom was "the radio button
resets on reload"; the cause was the engine reverting too.

---

# Part F — Plywood

Plywood is the one category with its own engine. `categoryStrategies["Plywood, MDF & HDHMR"]` selects it:
`"network_design"` (**live**), `"network_design_v2"` (built, dormant), or any normal strategy.

## F1. Why it is different

Plywood is sold in sheets that are **shelf-expensive** — physical capacity, not demand, is often the
binding constraint. So instead of computing each store independently, brands are stocked at specific
**nodes**, and each node covers a set of stores it serves.

## F2. v1 Network Design — live

`src/engine/strategies/plywoodNetwork.js`, config in `params/plywoodNetworkConfig`. It runs **before** the
main SKU loop and its results **bypass** strategy dispatch and the New DS Floor entirely
(`runEngine.js:121-181`). Dead Stock and SKU floors still apply — but floors only at **stocking nodes**
(`covers.length > 0`), since a floor at a non-stocking store would be a data-entry error.

**Live brand assignment (verified 2026-07-31):** Action Tesa, CenturyPly, ArchidPly, GreenPly — all four
stocked at **every DS, each node covering only itself**, no cross-DS coverage and no DC direct-serve
nodes. Per-brand `dcMultMin/dcMultMax` = **0.75 / 1.0**. Merino is excluded and uses PCT. **The defaults
in `constants.js` are stale — read the live config row, not the code.**

**Bulk/regular split (phase 0).** Contractor bulk-buys are separated out before anything is computed:
```
per DS with ≥ minOrdersForBulkFilter (5) orders:  threshold_ds = ceil(2.0 × ABQ_ds)
threshold = min( max(all threshold_ds), bulkMaxThreshold − 1 )      # universal floor: ≥10 is always bulk
orders ≤ threshold → "regular"   ·   orders > threshold → "bulk"
```
Zone classification uses **total** NZD (bulk included); Min/Max use **regular orders only**. If every
order at a node is bulk, the node gets Min = Max = 0 — deliberately freeing the shelf.

**Three zones per SKU × node**, from total NZD in the lookback:
```
NZD < minNZD (2)              → rare      Min = Max = 0, not stocked
minNZD ≤ NZD < sparseNZD (5)  → sparse    Min = ceil(ABQ of regular orders)
                                          Max = min( max(winsorisedMax, Min+1), maxCap )
NZD ≥ sparseNZD               → frequent  Max = min( max(winsorisedMax, P95+1), maxCap )
                                          Min = min( P95, Max−1 )
```
`winsorisedMax` = the largest regular daily total after clipping at `median × spikeCapMultiplier (3)`.
`P95` = `minPercentile` of that winsorised series. `maxCap` = **20**.

**Capacity trim (phase 2)** — only if `params.dsCapacities` is set. If a node's Σ Max for a thickness
group exceeds capacity (+2% tolerance), it trims in four escalating passes, always worst-spread first
(`spreadRatio = max(orders) / P25(orders)`): sparse-erratic → frequent-erratic → all sparse → frequent at
progressively lower percentiles (85, then 75). Trimmed rows carry `trimTag: 'Cap Trim'` plus
`originalMin`/`originalMax`, so the audit trail survives.

**DC (phase 3):**
```
DC Min = P95(regular demand of DC direct-served stores) + ceil(Σ node Mins × dcMultMin)
DC Max = max( same with dcMultMax , DC Min )
```
Uses **Σ node Min**, not Σ(Max−Min), so fast movers get a proportional buffer. Floored SKUs then get the
same `Σ DS × 0.2 / 0.3` floor applied on top (`runEngine.js:161-168`).

## F3. v2 — built, dormant

A capacity-aware successor in `src/engine/strategies/plywoodV2/` that stocks every SKU at every store
sized to fit shelf capacity, with a lean-reorder + one-bulk-order DC buffer. **Shipped to production
dormant** (2026-06-18): there is an admin-only "Plywood v2" tab with Locations / Assortment-Keep-Score /
Settings / OOS-Sim views, but the live engine stays on v1 until an admin selects **Network Design v2** in
the Logic Tweaker and clicks Apply. Reversible.

**`src/engine/strategies/plywoodV2/CLAUDE.md` (290 lines) is authoritative for v2** — read it before any
v2 work. Not summarised here, because a second-hand summary of a dormant engine is exactly the kind of
documentation that goes wrong.

---

# Part G — The TO tool

Separate repo `~/Documents/GitHub/homerun-to`, separate Vercel project, separate login.
**`homerun-to/CLAUDE.md` (389 lines) is authoritative.** Live at `homerun-to.vercel.app`.

## G1. Isolation, deliberately

Own repo, own build, own Vercel project, own Supabase Auth. **A bug or bad deploy there cannot touch
IMS.** Chosen over a shared multi-entry build specifically for failure isolation. It shares only prod
Supabase data, read-only, and in Phase 1 writes nothing there — the one write path is creating draft
Zoho TOs via the `create-to` edge function.

## G2. What it reads

| value | source | basis |
|---|---|---|
| Min / Max | `params/toTargets` — DC-inventorised **Active** slice only, ~1,565 SKUs | — |
| **CS DS** | `stockDataAccounting[sku][ds].stock_on_hand` | **Accounting** (Bills & Invoices) |
| **CS DC** | `stockData[sku].DC.stock_on_hand` | **Physical** (Shipments & Receives) |
| **In Transit** | `stockDataAccounting[sku][ds].in_transit` | Zoho `quantity_in_transit`, from the **stock** sync |

**⚠ The two stock bases are different on purpose** — accounting at the stores, physical at the DC. And In
Transit comes from the *stock* sync, not orders-sync, so orders-sync timing is irrelevant to TO
quantities.

## G3. The allocation solver

`homerun-to/src/solver.js` — pure and unit-tested.

```
trigger:  CS DS ≤ Min                                  (strict parity with the IMS rule)
Req    =  max(0, round(Max − CS DS − In Transit))      (net of in-transit)
```
Then the DC allocates **100% of its stock for that SKU** across the stores that need it. If short,
allocation is **proportional by need with largest-remainder rounding** — the biggest fractional part
wins the leftover unit. It never over-sends: `cap = floor(dcAvail)`.

**Fill states:**

| state | meaning |
|---|---|
| **Full** | TO = Req |
| **Partial** | 0 < TO < Req |
| **No DC Stock** | Req > 0, DC empty |
| **Unfilled** | Req > 0, DC had stock, but this store rationed to 0 |
| **—** | Not triggered, or fully covered by in-transit |

Partitions reconcile exactly: SKUs Needed = Full + Partial + None; Units Needed = Sending + Short.

## G4. Generating a TO

**Draft-only.** `create-to` (an edge function in *this* repo) creates draft Zoho transfer orders.
⚠ Zoho trap: `is_intransit_order:false` means *instant full transfer*, **not** draft — the real draft
mechanism is the undocumented `status:'draft'` body field. Non-draft responses are auto-deleted in the
same invocation.

Flow: **Generate TO → DSxx (draft)** → dryRun validate → confirm (server-verified line/unit counts, plus
stale, filter and duplicate warnings) → create → View-in-Zoho link. A 60-minute duplicate guard reads
`params/toAudit`. Line order follows the **DC pick path** (Tiling → Cement → binned items → unbinned →
Plywood last), from `params/binLocations`.

**Side effect to expect:** tool-created drafts appear as **"Picking" pills** in IMS Stock Health within
the hour, because orders-sync reads draft TOs. Drafts do **not** change `quantity_in_transit`, so the TO
tool's own table never sees them — hence the duplicate guard.

## G5. Fill Summary

A second view reading **persisted snapshots only** (`params/toSnapshots`), captured at Generate time.
There is deliberately **no live mode**: fill rate is only meaningful *as of TO time*, since a live view
three hours later reflects post-TO sales rather than what you acted on. Batch-centric (date +
Afternoon/Evening, IST split at 17:00), Category × DS matrix of Req · TO · %, drilling into short SKUs.

## G6. Gotchas that will bite

- **Zoho's TO auto-numbering: the API does not skip a taken number, but the UI does.** If Zoho's "Next
  Number" counter falls behind the highest existing TO, manual creation works while the tool hard-blocks
  with `400 Transfer Order Number already exist`. Fix: bump Next Number in Zoho settings (New TO → gear
  by the TO# field → Configure Preferences). A permanent self-heal is still on the list.
- **Zoho TOs have no `reason` API field** — the UI/PDF "Reason" section renders `description`.
- **Deep links need the `/inventory` route segment**:
  `inventory.zoho.in/app/{org}#/inventory/transferorders/{id}`.
- **`↻ Refresh` re-reads `toTargets`; it computes nothing.** If nobody has rewritten that row, you will
  see identical numbers. Something must recompute and write it first.
- **The footer clock measures when the engine RAN, not what it ran ON**, and flags stale only as "not
  from today IST". It will read fresh while running on days-old demand. `inputs.invoiceDataThrough` is
  deliberately not shown there (the DC team can't act on it) — which is why the IMS-side chip carries it.
- Ghost SKUs persist in `stockData` (the sync merges and never deletes), but none are in `toTargets`, so
  they cannot reach a TO.

---

# Part H — Tried and rejected, with numbers

Do not re-propose these without new data. Each was measured.

| idea | why it was rejected |
|---|---|
| **CV-based demand shaping** | **96.3% of SKU×DS combos have CV > 2.0** — the variation is sparsity, not signal. No segmentation power |
| **Movement-based periods** (different windows per movement tier) | Simulated **worse: +8 OOS and +₹38.5L**. A flat 45-day window beats it |
| **+1 base min day for Slow/Super Slow** | Only **0.1%** OOS reduction. Not worth the added stock |
| **ROP (reorder point) modelling** | **86.5% of OOS is a single order exceeding Max**, not a restock-timing failure. Wrong lever |
| **DS Seed for DS06** | Sunset 2026-07-31. **417 of 431 SKUs (97%)** it added had *zero* DS06-attributed demand; ₹18.8L of ₹19.5L sat on zero-demand SKUs (C10) |
| **Invoice status allowlist `{paid, overdue}`** | Lost **312 rows / 27.7% of a day's quantity**. Now a blocklist (D3) |
| **Invoice sync at concurrency 8** | Generated its own 429s; ~960 worker-seconds of backoff blew the 150s wall clock (D6) |

**Two standing policy positions**, both deliberate and both easy to mistake for bugs:
- **Cheap items over-stocked, premium lean** (A1).
- **A stockout costs ops chaos, not lost revenue** — we always fulfil (A1).

**One parked engine item:** `sumDailyAvg × (leadTime+1)` understocks the DC for erratic demand. That is
open item 8, not a rejected one — see Part I.

---

# Part I — The open decisions you inherit

Tracked in `CLAUDE.md → ## Open Work` with stable IDs. Priority order.

| # | decision | state |
|---|---|---|
| **17** | **Nothing tells anyone when a night fails.** Four status rows written, none read. The chain is automatic but not self-reporting | Highest value. Key it on `invoiceDataThrough`, not `ok:true` |
| **19** | **Zoho export locale is still `DD/MM/YYYY`** — so the manual-CSV rollback that every plan points at is currently unusable | Not code; a Zoho setting |
| **8** | **DC calc for PCT + Fixed Unit Floor** — 639 SKUs (406 FUF + 233 PCT) still on the rate-based DC | Measured. Its old blocker was satisfied 2026-04-28 |
| — | **`activeDSCount` = 4 with six stores live** (A4) | Display-only effect, but feeds reverse-TO judgement |
| — | **Unmapped categories** — Home Appliances (57 SKUs), Glass Hardware (31) fell to Standard by default (B3) | Never consciously decided |
| — | **Four stale params to delete** from code, UI and the params row (C12) | Low risk, own change |
| **18** | `lastOkAt` per sync, so a failed night can't claim to be the source of the current value | |
| **20** | Pin the provenance invariant with a test; `src/freshness.js` has no test file | |
| **21** | `demand through …` in the TO tool footer, where the consequence is transfer quantities | |
| **22** | Stale-tab gap — a long-lived tab computes from a stale catalogue and can publish stale `toTargets` | Habit meanwhile: reload before Apply |
| **7** | Read-only Logic Tweaker / Overrides for non-admins | `PUBLIC_TABS` lacks both |
| **23** | **DS06 has never been assigned a cluster** (C1 = DS01+DS05, C2 = DS02+DC, C3 = DS03+DS04) | Live since ~2026-07-08 |
| **24** | Make the invoice row-count sanity floor day-of-week aware — Sundays run ~40% lighter | |
| later | IMS reads the stored result instead of recomputing client-side | Makes divergence structurally impossible |
| deferred | Cluster fulfilment — tool or ops process? | |

---

# Part J — Disaster recovery

## J1. What is reproducible, and what is not

| asset | recoverable? |
|---|---|
| All application code | **Yes** — git, both repos |
| Edge functions | **Yes** — committed under `supabase/functions/` |
| Engine parameters | **Yes** — `params/global` + `params/paramsBackup`, rewritten on every Apply |
| SKU master, prices, `inventorisedAt` | **Yes** — `sync-catalogue` re-pulls from Zoho nightly |
| SKU floors | **Yes** — the ops Google Sheet is authoritative |
| Stock, PO, TO | **Yes** — re-pulled hourly |
| Invoice demand **from 2026-07-01** | **Yes** — the Zoho API can re-serve it |
| **Invoice demand BEFORE 2026-07-01** | **NO. This is the one irreplaceable asset.** |

**⚠⚠ The Zoho org was migrated on ~2026-07-01 and the old Books org is retired.** Everything before that
date exists only in the Supabase payload and its dated backups. It was hand-uploaded from CSV and the API
cannot reproduce it. **A full-window rebuild would destroy roughly three months of demand history
permanently.**

This is why append-only is **enforced in code** (`_shared/invoiceMerge.ts`), not merely intended: a sync
may only ever lose dates to the retention trim, and `report.safe` is false otherwise.

**Self-sufficiency arrives when the retention window starts on/after 2026-07-01:** ~**14 Aug 2026** at
45-day retention, ~**28 Sep 2026** at 90-day. Until then, keep taking dated backups.

## J2. The backups that exist

| row | contents |
|---|---|
| `team_data/invoice_data_backup_20260803` | 75,699 rows / 90 dates — the Stage 5 cutover backup, verified |
| `team_data/invoice_data_backup_20260729` | earlier snapshot |
| `team_data/invoice_data_backup_20260728` | 73,178 rows / 90 dates |
| `team_data/catalogue_backup_20260729` | `skuMaster` 2,092 + `priceData` 1,822 |
| `params/paramsBackup` | Rewritten on every Apply |

**⚠ Take a fresh dated backup before any change to invoice data or the catalogue sync.** It converts a
one-way door into an undo. The catalogue backup matters more than it looks: Zoho now owns
`inventorisedAt`, so there is no local safety net for the field that decides whether a SKU is stocked at
all.

## J3. Restore procedures

**⚠ Always read-merge-write the whole payload. Never a partial `PATCH`** — a direct PATCH once wiped
every other field in a `team_data` row.

| to restore | do |
|---|---|
| Invoice data | Copy `invoice_data_backup_<date>` payload into `invoice_data` |
| Catalogue | Read-merge-write `skuMaster` + `priceData` back into `team_data/global` |
| Parameters | Copy `params/paramsBackup` into `params/global` |
| `toTargets` | Nothing to restore — re-run the engine, it rebuilds in seconds |
| Stop a misbehaving sync | `select cron.unschedule('<jobname>');` |
| Revert the invoice target | `TARGET_ROW` → `"invoice_data_shadow"` in `sync-invoices/index.ts`, redeploy |

**Emergency manual override:** the invoice CSV upload path still works exactly as before. It is a **full
replace**, so use a **full-window** export, never a five-day one. And note item 19 — the Zoho export
locale currently makes this path unusable until fixed.

## J4. Migration safety

**Never run `supabase db push` after executing a migration by hand in the SQL editor.** The CLI doesn't
know it already ran and will run it again. Use
`supabase migration repair --status applied <version>`. **Fix the ledger; never delete the migration
file** — the files are the replayable schema definition, and a fresh project or DR restore would
otherwise have no way to create the table.

Check `supabase migration list` before any `db push`: an unapplied-but-already-run migration couples
unrelated changes into one aborting transaction.

---

# Part K — Glossary and where to go next

## K1. Terms

| term | meaning |
|---|---|
| **NZD** | Non-Zero Days — days with at least one sale |
| **ABQ** | Average Buying Quantity = total qty ÷ number of orders |
| **DOC** | Days of Cover = stock ÷ daily average |
| **TO** | Transfer Order — stock movement DC → DS |
| **PO** | Purchase Order — supplier → DC or → DS |
| **SoH / AFS** | Stock on Hand / Available For Sale. **ECS = max(0, SoH)** — SoH, not AFS, because stale sales orders depress AFS and produce false shortages |
| **Dead Stock** | SKU with Min = Max = 0 everywhere; no replenishment, filtered out of Stock Health |
| **Inventorised At** | Supplier (never stocked) · DS (direct, bypasses DC) · DC (flows through DC) |
| **Winsorise** | Clip outliers to a cap before taking a percentile |
| **Zone** (plywood) | rare / sparse / frequent, from NZD |
| **Movement tag** | Super Fast → Super Slow, from sales *frequency* |
| **Price tag** | Premium → No Price, from purchase price |

## K2. Where to read next

| for | read |
|---|---|
| Why any rule exists, and the incident behind it | **`CLAUDE.md`** (root) — dense, and the best thing in the repo |
| Plywood v2 | `src/engine/strategies/plywoodV2/CLAUDE.md` |
| The TO tool | `homerun-to/CLAUDE.md` |
| Original design rationale | `docs/superpowers/specs/` — 8 design docs |
| The formulas | `src/engine/` — `runEngine.js` is the orchestrator |

## K3. Read-only commands worth knowing

```bash
# What can never take effect: floors on SKUs that are inactive or absent from the master
npx vite-node scripts/dryrun-sku-floors.mjs

# Reproduce the nightly engine run read-only and diff it against the live toTargets
npx vite-node scripts/diff-headless-totargets.mjs

# Compare stored invoice data against a Zoho CSV export on disk.
# The metric that matters is "in CSV but MISSING from live" — it must be zero on
# every date. Blocked until the Zoho export locale stops emitting DD/MM/YYYY.
npx vite-node scripts/compare-csv-vs-live.mjs <path-to-csv>

# What the nightly digest would mail right now, read-only, no send
npx vite-node scripts/dryrun-nightly-digest.mjs          # --demo for failure examples

# Verify the PO Team Download CSV against live data
npx vite-node scripts/verify-po-csv.mjs

# Tests: 485 across 37 files
npx vitest run
```

## K4. A suggested first two weeks

1. **Shadow a 14:30 TO run** with the DC team, end to end.
2. **Sit through one PO cycle** at ~06:00 with ops.
3. **Read `CLAUDE.md` cover to cover.** It is long and worth it.
4. **Do the morning check by hand** for a week (D5) — you will learn the chain's normal shape, and item
   17 will stop being abstract.
5. **Make one deliberately small change and watch it land**: adjust a single Logic Tweaker value, Apply,
   see `toTargets.refreshedAt` move, then see it in the TO tool. Then revert it from `paramsBackup`.

You will trust the system more from watching one number move end-to-end than from any chapter here.
