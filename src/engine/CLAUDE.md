# CLAUDE.md — the engine

**You are reading this because you touched a file under `src/engine/`.** Everything here
used to sit in root `CLAUDE.md` and loaded on every session; it now loads when you are
actually in the engine. Nothing was rewritten — most of the ⚠ marks are production
failures that were paid for once already.

**Engine output is recomputed client-side on every page load** (`runEngine` in App.jsx's
load effects) — there is no stored-results blob. So a change here goes live for every user
on their next page load after deploy, with no "Apply & Re-run Model" needed. That is also
why a single malformed row can white-page the whole app for everyone.

**There are two writers of `params/toTargets`** — `applyAndRun` in `App.jsx` and the
nightly Vercel run (`api/run-engine.js`). They share `src/toTargets.js`, which is the only
thing keeping them from drifting.

**Read root `CLAUDE.md` too** (it loads automatically) for the cross-cutting data-safety
rules: `saveTeamData` / `BROWSER_OWNED_KEYS`, the params-row rule, the invoice upload
guards, and validate-at-the-boundary.

**Related:** `src/engine/strategies/plywoodV2/CLAUDE.md` is authoritative for v2;

> ⚠ **The OOS Simulation TAB was retired 2026-09-17** (`src/simWorker.js` deleted). Notes below that
> describe how the sim treated Supplier SKUs are history — the ENGINE is unchanged. The Plywood v2
> tab went too, but its engine under `strategies/plywoodV2/` REMAINS and is still imported by
> `runEngine.js`. See `docs/retired/README.md`.
`supabase/functions/CLAUDE.md` owns the syncs that produce this engine's inputs.

> ⚠ **A rule that only ever REDUCES a value belongs in ONE pass over the finished object,
> never inline in the branch that computed it.** `applyCeilingToStores`,
> `applyDeadStockToStores`, Active-only and Inventorised-At are all this shape. Dead Stock
> was the odd one out and it broke — see the Dead Stock section.

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

**Plywood Network Design** (the `network_design` strategy) is documented in
`src/engine/strategies/CLAUDE.md`, next to `plywoodNetwork.js`. v2 has its own
`src/engine/strategies/plywoodV2/CLAUDE.md`.
