# CLAUDE.md — Plywood Network v2

Capacity-aware plywood Min/Max engine. Replaces v1 Network Design (`../plywoodNetwork.js`,
brand-node stocking). **Status: MERGED TO PROD (dormant) 2026-06-18 via PR #11 — admin-only "Plywood v2"
tab, engine still on v1; the deploy changed NO live Min/Max or any Supabase params/team_data state.
Activation (the cutover) is still pending the capacity/SOP business decisions + category-team cut-list
review — see Open items.**

- **Merged:** squash-merged to `main` (PR #11, commit `053cd85`, 2026-06-18); `feature/plywood-network-v2` deleted. Further work: branch off `main` — never push/PR without explicit user instruction.
- **Spec:** `docs/superpowers/specs/2026-06-11-plywood-network-v2-design.md` (read for full rationale).
- **Tests:** `npx vitest run` — 68 passing as of 2026-06-18. vitest is a devDependency; `npm test` also works. `npm run build` clean; eslint 0 errors (1 pre-existing `modeOos` exhaustive-deps warning).
- **Activation:** dormant until `categoryStrategies["Plywood, MDF & HDHMR"] === "network_design_v2"` in prod config. v1 (`network_design`) untouched and still the live strategy.
- **Config row:** `params/plywoodNetworkV2Config` (separate Supabase row, like v1's `plywoodNetworkConfig`). 406 errors for this row are EXPECTED until first admin publish.

---

## The problem & the core idea

HomeRun stocks 4 plywood brands (Action Tesa, CenturyPly, ArchidPly, GreenPly; Merino excluded → PCT) at 5 DSes + DC. v1 left ~half of SKU×DS combos at Min=Max=0 → regular orders to those combos became cross-location scrambles. v2 stocks **every active SKU at every DS**, sized so the *regular* order (qty < 10) is served off-shelf at a target service level, within shelf capacity.

**Bulk = order-level.** Any order containing a line ≥ `bulkOrderThreshold` (10) sheets is a bulk order, routed from DC (ops SOP), excluded from DS sizing. But **DS demand sizing is line-level**: a small line (<10) riding inside a bulk order still counts toward DS demand (the same need could arrive standalone). The two coexist in `prepareDemand`: `regularDaily` (line-level, DS) vs `bulkDaily`/`collectBulkOrderQty` (order-level, DC).

---

## DS Min/Max — the UNIFIED two-branch formula (default, user-confirmed)

`allocateUnified` in `allocator.js`. Per SKU × DS, regular lines only, fit window:

```
NZD ≥ 1 (active):
  Min = max( P[minLocalDayPercentile=90] of local selling-day totals,
             P[minNetOrderPercentile=90] of NETWORK order sizes )
        then DOC-capped: Min = min(Min, max(velocity×minDocCapDays, local order ABQ, 1))
  Max = max( worst local selling day, Min+1 )          [maxMode='worstDay']
        OR  Min+1                                        [maxMode='minPlus1']
NZD = 0 (dead at node):
  Min = network ABQ (qty÷orders; 1 if no network history)   [deadFloorMode='abq']
        OR 1                                                  [deadFloorMode='lean1']
  Max = Min+1
```

**Why these branches** (each settled empirically against out-of-window service, don't re-litigate):
- Local P90 alone is noise at low NZD → the **network-order P90 floor** rescues sparse combos (they drove 57% of misses without it). `max()` lets a hot local signal still win.
- **DOC cap** (velocity × days) trims slow-movers carrying a fast-mover's network floor — biggest inventory-reduction lever found. Floored at local order ABQ so one typical order stays coverable.
- Network ABQ for dead combos = "hold a typical order" since there's no local signal.

**Three alternative allocators exist** (`allocMode`), kept for A/B but unified won:
- `empirical` — network order-size *tails* (P95) on Max everywhere. +service, +much more capacity.
- `tiered` — frequency-tiered (frequent/moderate/sparse/dead) τ-service. Legible but ~same frontier.
- `greedy` — capacity-budgeted floors→depth→buffer. The original v1-style; only mode that *enforces* capacity in the allocator itself.

Unified/empirical/tiered are **capacity-UNCONSTRAINED** in the allocator; capacity is handled by the separate trim pass (below). Frontier insight: every logic sits on ≈ the same curve — **~+1pt out-of-window service per +10–15pts capacity**. Formula choice is second-order; **shelf budget is first-order.**

---

## Capacity trim — `capacityFit: 'maxTrim'`

After Min/Max, per DS × thickness class (thick >9mm / thin), if ΣMax > rack capacity:
trim Max → Min+1 on the **lowest-local-NZD SKUs first** (ties: bigger slack first, then SKU id).
**Min is never touched** (it carries service); only Max buffer is surrendered. Trimmed combos get
`plan[sku][ds].maxTrimmed` (UI shows "Max −n" badge). Residual overflow (Σ(Min+1) > cap) is reported, not hidden.

**HARD FACT:** no config fits DS04/DS05 thick capacity (225/200) — even Min=1 floors for ~79 thick SKUs need ~230. Green there requires Keep Score cuts (frees ~53 thick sheets at those nodes — flips both green) or more racking. The tune chart surfaces this honestly ("closest to green" / "no config fits").

---

## DC Min/Max — `sizeDCSS` + `trimDCDepth` (dc.js)  [final model, 2026-06-17]

```
DC Min = P[dcServicePct=98] of rolling (leadDays)-day TO-DRAIN sums
         (drain = replay the PUBLISHED DS plans with infinite DC → daily TO qty per SKU)
         — the LEAN reorder point; protects DS replenishment; NEVER trimmed.
DC Max = DC Min + max( oneBulkOrder , leadBatch )
  oneBulkOrder = P[dcBulkServicePct=90] of the SKU's per-order bulk sizes   (NOT scaled by α)
  leadBatch    = mean (leadDays)-day TO-drain — a reorder-batch FLOOR so non-bulky SKUs get a
                 sane cycle (Min ≠ Max) instead of thrashing at the reorder point.
```

**Why this shape (settled by measurement — don't re-litigate):**
- The DC has exactly **two real jobs** (replenish DSes; serve bulk) and **one phantom** (TO qty-fill).
- **DS regular service is ~flat (~93–97%) across DC depth** — the DC barely moves it; the lever for
  higher DS service is the **DS plans**, not DC stock. So Min is sized lean (reorder cover only).
- **Bulk is the only thing DC depth actually buys.** The buffer above Min = one typical bulk order, so
  a single order is served off-shelf; clustered/bigger orders spill to supplier-direct (accepted).
  The buffer is **one order**, which is what structurally prevents the old 24-day-cover blow-up.
- **TO qty-fill is a misleading proxy** — it measures "restock the DS all the way to Max" and
  double-counts re-requested shortfalls, so chasing it ≥90% nearly tripled inventory for ~1pt of real
  customer service. **Demoted to a diagnostic** (tooltip / DC-card sub-line), not a target.

**α (`bulkDcServedShare`) routes ORDERS, not sheets.** In `replay`, (1−α) of bulk orders go
supplier-direct (deterministic order-id hash, assumed served). It does NOT shrink the buffer — a
DC-routed order needs its full quantity. α is **user-owned** (encodes the geographic ops SOP: far
customer + closer supplier → supplier-direct), never auto-swept. At α=0.7 the ceiling for bulk-from-DC
is 70% of all bulk (30% is geographically supplier-bound regardless of stock).

**Depth trim** (`trimDCDepth`): when a DC rack class is over capacity, surrender the buffer (Max→Min)
on the **least TO-active SKUs first** (ties: larger buffer first). The reorder floor (Min) is NEVER
trimmed. Residual overflow (Σ Min > cap) is reported.

**Zero-drain SKUs (no DS stocks them — policy A, confirmed 2026-06-18):** Min = P98(zero drain) = **0**
(no DS replenishment to protect, so no reorder floor). If the SKU has **bulk** orders, Max = **one-bulk-order
buffer** (`bulkUnit`) — the DC still serves a single bulk order off-shelf. With **no** bulk either, it's not
in `dcPlan` at all → **0/0** (the `|| {min:0,max:0}` default in index.js — correct, no DC demand). Under
capacity pressure these are trimmed **first** (drain-NZD = 0 = least-active), so a bulk-only SKU's buffer is
the first to drop to 0 (its bulk then spills supplier-direct). Deliberate priority — DC rack favours SKUs
that serve both DS replenishment *and* bulk; not changed.

**Proportional TO rationing** (`replay`): when the DC is short, competing DS TO requests for a SKU are
filled **proportionally** (largest-remainder rounding, bigger requester gets the leftover sheet) — not
first-come. Removes the DS-iteration-order bias. Qty-fill is invariant to the split (total shipped =
min(stock, Σrequests)); only the per-DS distribution (and thus DS service) changes.

**Metrics:** the DC card headline is **bulk served from DC %** (the DC's distinctive output); DS
regular service shows on the DS cards + as a flat reference line on the DC frontier; TO qty-fill is a
small "diag" sub-line. The DC sweep frontier plots **bulk-served % (Y) vs DC rack ΣMax (X)** over the
`dcBulkServicePct` scenarios — the only real DC choice (bulk vs inventory); click a point to apply.

---

## The 75/15 operating workflow & publish lifecycle

1. Upload latest ~90d. Tab previews the plan **fitted on the first 75 days**, scored out-of-window on the **last 15 days** (the honest report card: per-DS service, OOS-per-SKU column).
2. Diagnose misses by pattern (NZD bucket / DS / class). Don't hand-patch numbers.
3. **Auto-tune** sweeps knobs → Pareto frontier; click any point to apply. The model turns the knobs (user found manual tuning = whack-a-mole; knobs interact).
4. **Publish** (admin) → engine refits the SAME formula on the FULL window — test-window misses self-correct by entering the fit.

**Lifecycle lock (current UX):** each location (DS01–05 + DC) is independently **published (LOCKED)** or **tuning (unlocked)**:
- Published → **slim locked bar**: location name + `✓ locked` pill + a (blue-outlined, deliberately visible) **Unpublish & tune** button, no chart/knobs. "Keep published plan" re-locks unchanged. Service %, plan size and inventory are NOT repeated here — they live on the strip card + the stat-cards row above (the bar used to duplicate them; stripped 2026-06-17). Raw knobs are NOT shown here either — see "knobs are admin-only" below.
- Tuning → unlocked frontier chart + Publish/Revert.
- **Per-card live/forecast basis** (replaces the old single global Eval/Live flip): each card derives its own basis. A location shows **LIVE** (full-window refit, scored on last 15d) if it is published & not currently being tuned; otherwise it shows the **out-of-window forecast** (75d fit on unseen 15d, amber `forecast` tag). The tuned card reads e.g. `90.8% / forecast → ~97% live`. Network card reflects the in-progress edit. LIVE/TUNING badge derives from lock state. DC live bulk uses the `dcLive`/`dcResFull` memos (finite-DC full-window replay; the extra engine pass is gated to run only while a DS is being tuned — otherwise the live view reuses `dcRes`).
- A **tuning banner** (tuning view only) explains: out-of-window forecast → publish refits on the full 90d; only the tuned DS moves.
- Publishing a location auto-locks it. Per-DS publish materializes that DS's *effective* knobs into saved `dsKnobs[loc]` (other DSes untouched); DC publish saves the global `dc*` fields. Capacity edits flow through publish/compare too.

**Model owns the knobs; user picks scenarios + a few set-once facts (rebuilt 2026-06-17).** A location's tuning view is just the **frontier graph + a 2–3 line plain-language "What the model chose" narrative** (`modelNarrative` — describes the sizing, e.g. "Min = the P50 local selling-day quantity, floored by the P90 network order…"; NO editable knob fields, no value grid). The model's knobs are set ONLY by clicking a frontier point (DS → `dsKnobs[loc]`; DC → the `dc*` fields). **Per-location publish lives on the graph header** (`Publish {loc} only` / `Keep published plan` / `Revert`); the old global "Global knobs & publish" section and its big publish button were removed. Set-once **network facts** (bulk threshold, supplier lead days, thick boundary, lookback) + **α** moved to a separate **Settings** view (`SettingsView` — third tab beside Locations / Assortment) with one *dirty-gated* **Save & refit all locations** button — the only path that commits an assumption change (changing one re-fits every location). The "Selected" chip on the frontier carries the **inventory story** (`Selected: 673 sheets · ₹12.8L max inventory`); Max Inv ₹ is an *estimate* = footprint × `valuePerSheet` (avg ₹/sheet of the current location's plan).

**Two scorecards** (don't confuse):
- **Evaluation** (tuning view): 75d fit scored on unseen last 15d. The HONEST forward number — use to *choose* configs.
- **Live** (locked view): full-window fit scored on last 15d (in-sample). A health reading of what's running — always reads higher.

**DS service is a DS-shelf metric (infinite DC).** Every DS-side figure — strip DS cards, the Overall Network card, and the table's OOS column — is scored assuming the DC always fulfils replenishment TOs (infinite DC). The DS plan and DC plan are independent levers, so a DC shortfall is the DC's failure and surfaces on the **DC card** (bulk-served % + TO-fill diag, from the real-DC `dcStats`/`dcLive` replays), never charged against DS service. (Until 2026-06-17 a separate finite-DC `liveCheck` replay fed the locked bar + OOS column, which disagreed with the infinite-DC cards on the capacity-pinched nodes DS04/DS05 — a confusing mismatch. Resolved by making the whole DS side infinite-DC and deleting `liveCheck` + the now-dead `svcColor`/`fp`/`planFootprint`.)

**Top location strip** (both views): **"Overall Network"** is a separate filled, non-clickable summary card (uppercase label, black left-accent, no hover) showing **two columns: network regular service % | plan inventory ₹** (Σ Min – Σ Max across all DS + DC, at cost — the `netInv` memo, exact per-SKU price; *target* Min/Max levels, NOT live stock). `netInv` sums the **live full-window plan** (`ev.fullPlan` + `dcResFull`), NOT the preview (`modePlan`/`dcRes`), so it stays put when you tune a single DS instead of flipping the whole network to the 75-day-fit basis — consistent with the network service %. DS01–DS05 + DC are ONE continuous segmented picker bar (hover highlight + selected top-bar). DS cards show 15d regular service (**infinite-DC DS-shelf basis** — see the DS-service note above); **DC card shows bulk-served-from-DC %** (headline) with **TO qty-fill % as a small "diag" sub-line** (real-DC replay over the 15d window — `dcStats` memo, not the infinite-DC number). All strip %'s use the **90/80 band** (`pillColor`: ≥90 green / ≥80 amber / <80 red). Selected location pill is visually distinct (tint + 2px yellow border + ● marker). Clicking a DS/DC segment selects that location. Header: one status chip (LIVE/TUNING basis; publish + "engine not switched on" folded into a hover); fit/score dates inline & labeled (`Fit: 18 Mar – 15 Jun`).

**Hovers:** the `Hint` component = a dotted-underlined word whose popover drops **downward** (avoids nav-bar clipping), `cursor:default`. (The old circled-`i` / `cursor:help` read as a "?" and was removed.)

**Frontier charts (DS + DC):** custom hero tooltip (service%/bulk% hero, then `sheets | ₹ max inv`, then "click to apply"). Axis titles are HTML captions BELOW the chart (not in-SVG Recharts `label` — `insideBottom` fought the tick height). Dual X-tick via `sheetTick(valuePerSheet)` = sheet count on top, ₹ value beneath. The DC chart Y = bulk-served vs rack with a flat grey DS-service reference line (DS service is ~flat in DC depth).

**The tab is kept mounted** (App.jsx lazy-mounts on first open via `v2Mounted`, then never unmounts) so all draft/tuning state survives tab switches. Keep Score knobs additionally persist across reloads via `localStorage["plywoodV2KeepScore"]`.

**Locations SKU table:** sticky header (the `sh` cells are `position:sticky;top:0`) inside a bounded-scroll box whose `maxHeight` offset is **`locked`-aware** (`calc(100vh/0.85 - {290 published / 470 tuning}px)` — the tuning header is taller because of the frontier chart; eyeball-tune these if rows gap at the bottom or overflow), mirroring the Assortment table. DC tab columns: `SKU · Item Name · Thickness · Brand · Net NZD · Bulk Days · Qty/NZD · DC Min · DC Max` (DS tab: `… · NZD · Qty/NZD · Min · Max · OOS`). **`Qty/NZD`** (renamed from "ABQ" everywhere — old name implied per-order; it's actually per selling-day) = total qty ÷ NZD = avg qty on a day it sells, NOT a daily average; **DS scopes it to regular orders / local**, **DC to all orders / network**. **Net NZD** (DC) = distinct network selling days incl. bulk — reuses the engine's `networkNZD` so it matches the Assortment table; **Bulk Days** = `Object.keys(bulkDaily[sku]).length`.

---

## OOS Simulation view (4th tab — DONE 2026-06-18)

A backtest: upload a real invoice CSV for a period **outside** the original 90-day fit window and see
how the **published** plan would have performed. Lives as the 4th view (`Locations | Assortment | Settings
| OOS Sim`). `OOSSimView` in the tab; `simulateOOS` in `oosSim.js`; CSV via the shared `parseInvoiceCsv`
(utils.js — same format as Upload Data). **Spec:** `docs/superpowers/specs/2026-06-17-plywood-v2-oos-simulation-design.md`.

- **Model (matches the 75/15 eval):** each location starts at the SKU's **Max**, depletes on orders, and
  a TO refills it to Max **next day**. **DS regular OOS uses `infiniteDC:true`** (DC always replenishes —
  the DS-shelf metric). **Bulk** (any order with a line ≥ `bulkOrderThreshold`) routes entirely to the DC
  and is served from the **finite published DC stock** (α forced to 1). Two `replay` passes.
- **Published plan** = `computePlywoodNetworkV2Results(originalInvoice, savedCfg)` (memoized on savedCfg).
- **Summary strip:** `Plywood orders: N | Regular: R · Service level S% (served/R) | Bulk: B · Served from DC D% (served/B)`.
- **5 DS + 1 DC cards** (service/served % + counts) → click to drill; default = worst location (`oosWorstLoc`).
- **Detail = line-item table** for the selected location: `Date · Order# · SKU · Item Name · Ordered · SOH ·
  Short · Min · Max · Serviced(✓/✗)`, **red = missed / green = served**, sorted Short desc. Rows = every line
  of orders that missed ≥1 item there (so green order-mates show too). CSV download of the same.
- **Unplanned bucket** = uploaded SKUs not in the universe (new/out-of-scope) — computed but not shown
  (dropped from the strip per the all-plywood framing); still in the `simulateOOS` return.
- **Ephemeral & prod-safe:** the upload + selection live in `PlywoodNetworkV2Tab` state (`oosUpload`/`oosSel`),
  lifted out of `OOSSimView` so they survive v2-view + top-level tab switches (the tab is display-hidden,
  never unmounted); **lost on reload**. No Supabase / localStorage / engine writes — pure in-memory what-if.

---

## Per-DS tuning

`dsKnobs[ds]` overrides global knobs for one DS (set by clicking that DS's frontier point). Network
signals (network ABQ/order tails) stay global; only knobs localize. Each DS gets its own frontier
chart (X = that DS's footprint, Y = that DS's 15d service, own capacity line). Lets DS01 run
service-rich while DS05 runs lean — they have very different rack pressure.

---

## File map

| File | Responsibility |
|---|---|
| `demand.js` | `buildUniverse`, `prepareDemand` (regular line-level + bulk order-level streams), `collectBulkOrderQty`, `medianOrderQty` |
| `allocator.js` | `allocateUnified` (default) + `allocateEmpirical`/`allocateTiered`/`allocate`(greedy) + `maxTrim` pass; `thicknessClass` |
| `replay.js` | deterministic day-by-day sim: TO/PO timing, **proportional TO rationing**, order-level OOS, α-routing of bulk, TO-fill tracking, drain series. `cfg.infiniteDC` → DC always honours TOs / bulk; `cfg.captureLines` → emit a `lineEvents[]` record for **every** line (served + short, with on-hand) — for the OOS-Sim table (off by default, so the eval pays nothing) |
| `oosSim.js` | `simulateOOS(uploadedInvoice, publishedPlan, skuMaster, params)` — backtests the published plan against an uploaded out-of-window invoice. Two replays: **DS regular OOS at `infiniteDC:true`** (DS-shelf basis), **bulk at finite DC + α=1** (all bulk → DC). Returns per-DS/DC service + line-item tables (failed orders' lines, red short / green served, sorted Short desc) + unplanned bucket. Pure/testable |
| `dc.js` | `sizeDCSS` (Min = lean reorder; Max = Min + max(one bulk order, lead batch)), `trimDCDepth`. Band-model `sizeDCOrderBulk`/`trimDCComponents` removed; legacy `sizeDC`/`trimDCToCapacity` still present (unused, old export) |
| `keepScore.js` | `computeKeepScores` — Rent/Service ratios. Wrapped by `keepScoreAnalysis` in index.js (real-plan holding + capacity-freed); surfaced as the Assortment view. |
| `evaluate.js` | `evaluatePlan` (75/15), `autoTune` (240-config sweep, Pareto, presets, bucket gate), `dcEvaluate`/`dcSweep`, `deriveNZDBuckets`, `planFootprint`, `fitPlan` |
| `index.js` | `computePlywoodNetworkV2Results` (runEngine-compatible assembly), `V2_DEFAULTS`, barrel exports |
| `../../runEngine.js` | dispatch: `plyMode === 'network_design_v2'` → `computePlywoodNetworkV2Results` |
| `../../../tabs/PlywoodNetworkV2Tab.jsx` | the whole UI (SKU view + per-DS/DC tune panels + modal) |
| `scripts/validate-plywood-v2.mjs` | offline harness: real Supabase data → CSVs in `validation-out/` (READ-ONLY, caches in `.cache/`) |

Result shape (matches v1 network bypass in runEngine ~L100–167):
`{ [sku]: { brand, storeResults: { [ds]: {min,max,nonZeroCount,covers:[ds],v2:{...}} }, dcResult:{min,max}, v2:{...} } }`

---

## Config / knobs (`params/plywoodNetworkV2Config`, defaults in `V2_DEFAULTS`)

Universe/demand: `lookbackDays=90`, `bulkOrderThreshold=10`, `excludedBrands=['Merino']`, `thickBoundaryMm=9`, `leadDays=3`.
Unified knobs (auto-tuned): `minLocalDayPercentile=90`, `minNetOrderPercentile=90` (0=off), `minDocCapDays=45` (0=off), `deadFloorMode`, `maxMode`.
Capacity: `capacityFit='maxTrim'`, `dsCapacities` (per DS thick/thin — editable in UI), `dcCapacity` (thick/thin — editable).
DC: `dcServicePct=98` (Min reorder-point percentile), `dcBulkServicePct=90` (the "one bulk order" buffer dial — swept 50/60/75/90/95 in `dcSweep`). User-owned: `bulkDcServedShare` (α). `dcCapacity` (thick/thin — editable; can grow per ops). DS regular service is ~flat in DC depth, so the sweep's only axis is bulk-served vs rack.
Per-DS: `dsKnobs={}`. Keep Score: `{grossMarginPct:0.06, carryRateQuarterly:0.05, opsBuffer:1.5, serviceNZDThreshold:5}`.

Note: `V2_DEFAULTS` still carries legacy DC knobs (`dcReplPercentile`, `dcBulkPercentile`, `dcCoverDays`) used only by the old `sizeDC` export, plus greedy/tiered/empirical-mode knobs — harmless but prune if those alt paths are dropped.

---

## Validation numbers (L90D, 11 Mar–8 Jun 2026, 122 SKUs, out-of-window unless noted)

- Unified default (P90/P90, no per-DS leaning): regular ~92.6% OOS-svc.
- v1 live plan on identical scoring: regular 81.1%, bulk 26.6% (333/610 combos at Min=Max=0).
- DC (final model `sizeDCSS`, default P90, real DC plan, α=0.7): **DS regular service ~93–97% (flat in DC depth)**, bulk-served-from-DC ~50% (of DC-routed) at ~2,550 sheets, ~40% at ~1,900. TO qty-fill (diagnostic) tracks ~the same as line-fill and is *not* a target. Key finding: pushing TO qty-fill 75→90% triples DC inventory for ~1pt of DS customer service — that's why it was dropped as a target.
- α=1.0 (every bulk order to DC) needs far more rack than α=0.7; α caps bulk-from-DC at 70% of all bulk (the other 30% is geographically supplier-bound). DC capacity is now treated as expandable (Rampura) — the frontier reports the rack each bulk-service point needs rather than forcing a fixed cap.
- Bulk: most single orders are servable from the one-bulk-order buffer; clustered/novel/biggest-ever orders (~29% of test bulk) spill to supplier-direct ≈ the 30% supplier SOP share. DC stocks predictable bulk; suppliers absorb novelty.

---

## Keep Score / Assortment view (DONE 2026-06-15)

`keepScoreAnalysis(inv, skuM, priceData, cfg)` in index.js → `{ rows, summary, nodes }`.
Grades every SKU on the REAL effective plan: holding = Σ (Min+Max)/2 × PP across 5 DS + DC.
Sales & network NZD are **total** (regular + bulk); the NZD≥2 rent gate uses total NZD.
`KeepScore = max(Rent, Service)` — Keep ≥1.3 / Watch 1.0–1.3 / Cut <1. **gm = Profit/Sales (margin on
sale price)** → Sales ₹ = SoldQty × PP / (1−gm) [true revenue]; gross profit = Sales × gm. **Rent reduces
to a turnover test** (PP cancels: `turns × [gm/(1−gm)]/(carry·buffer)` = turns × 0.85 at defaults; Rent≥1 ⟺
~1.18 turns/qtr; turns = 90d sheets sold ÷ avg sheets held). Reproducible from the table:
`Rent = (Sales ₹ × gm)/(Holding ₹ × carry × buffer)`. Holding ₹ = avg (Min+Max)/2 × PP (at cost).
**Service = networkNZD ÷ threshold(5)**. `nodes` carries the capacity-freed consequence of cutting
(per DS/DC × class: before→after, flips-green) — **capacity is shown, never a score factor.**
Surfaced as the **Assortment / Keep Score** view (header toggle, network-level, alongside Locations):
summary cards (Keep/Watch/Cut, sales-at-risk, holding freed, capacity-impact panel) + sortable/filterable
table + editable knobs (admin) + CSV export. **Table columns:** SKU (with copy icon), Item Name, Brand,
Class, Net NZD, Max Hol Qty (ΣMax peak shelf), Sold Qty (total reg+bulk), Holding ₹ (avg, cost), Sales ₹
(revenue), Rent Ratio, Service Ratio, Keep Score, Flag. Sticky header + viewport-fill scroll (pinned
cards/filters/knobs, only rows scroll). Default sort: Keep Score ascending (cuts first).
**Recommend-only** — cutting happens via discontinuation → SKU master, then the plan re-runs on survivors.
Validated: ~27–30 cuts, ~1–1.7% sales, ~₹6–9L holding freed; cuts flip DS thin nodes green but NOT
DS04/DS05 thick (those need deeper cuts or racking — consistent with the capacity wall).

**Other UI notes:** copy-SKU icon on both the Locations and Assortment tables (mirrors Stock Health).
Locations table default sort = **descending NZD**; numeric sort comparators are `(a−b)×sortDir`
(arrow ↓ = descending) — same convention as the Assortment table.

**Locations ↔ Assortment parity (2026-06-18):** the two tabs are kept visually consistent. Both header
helpers (`sh` Locations / `th` Assortment) render a muted **ⓘ** on any column with a `tip`, hover →
the shared `Hint` popover (same as the publish ⓘ; native `title` removed). SKU column hugs content
(`width:1%`), Item Name cap 420. Assortment summary is **one full-width strip** (filled + black accent,
`minHeight:40` matching the config strip) with inline sections: Verdict (`N Keep · N Watch · N Cut`),
Sales-at-risk, Holding-freed, **Capacity = `Σ freed sheets reduced overall across the network`** (per-node
detail on a ⓘ); the old description paragraph moved onto column ⓘ tooltips; admin config (Keep-Score knobs)
sits above the search/filter row. Row tint matches Locations' NZD palette: **Keep `#F0FDF4` (green) /
Watch `#FFFBEB` / Cut `#FEF2F2`**.

## Open items / NEXT SESSION

0. **Commit the branch** — the 2026-06-17 UI polish (header/strip/per-card basis/Hint hovers/frontier charts/knob-exposure removal in `PlywoodNetworkV2Tab.jsx`) is signed off but uncommitted. Commit locally; NEVER push without explicit instruction. Remaining optional polish: the per-loc `Σ Min/Max qty · inventory value` cards row, the SKU table, and the Assortment/Keep Score header for consistency.
1. **DC capacity** (user: expandable): DC rack can grow (Rampura), so the DC frontier reports the rack each bulk-service point needs rather than forcing a fixed cap. Pick a `dcBulkServicePct` point → provision its thick/thin rack. DS04/05 thick rack expandability still open (separate DS-side capacity wall).
2. **Bulk SOP / α**: get the DC-vs-supplier routing rule written so α stops being an estimate (it encodes the geographic far-customer→closer-supplier rule).
3. **Prod cutover**: only after sim DS regular service ≥ target, bulk-served-from-DC at the chosen point, capacity provisioned, cut-list reviewed with category team. Then switch `categoryStrategies` to `network_design_v2`. (Note: DS "near-100%" is a DS-plan lever, NOT DC depth — the DC barely moves DS service.)
4. **Cleanup**: prune legacy DC knobs (`dcReplPercentile`, `dcBulkPercentile`, `dcCoverDays`) + the unused `sizeDC`/`trimDCToCapacity` exports + greedy/empirical/tiered knobs if those alloc modes are dropped. `deadFloorMode` dedupe DONE.
5. **Keep Score knobs → Supabase (shared persistence):** currently the 4 Keep Score knobs (margin, carry, ops buffer, service threshold) persist only to `localStorage["plywoodV2KeepScore"]` — per-browser, not shared across users/devices. They're a business decision driving the cut list, so they should also write to the Supabase `params/plywoodNetworkV2Config` row (e.g. fold a `keepScore` slice into a publish path or add a dedicated save) so every viewer sees the same verdict. Precedence to decide: localStorage (in-progress edits) vs saved config.
6. **Keep Score knobs reset control:** add a small "reset to defaults" link next to the knobs (clears the localStorage key + restores `V2_DEFAULTS.keepScore`).
7. **DC SKU modal** ✅ DONE (2026-06-17): DC rows open `SKUModalV2` with the (final-model) formula — Min = P[dcServicePct] lead-time drain; Max = Min + max(one bulk order P[dcBulkServicePct], lead-time batch) — a Min+buffer breakdown bar (colours whichever term wins), trim note, the TO-drain timeline vs Min/Max, and a **daily bulk-order-qty timeline vs Min/Max** (amber bars by date over the window, own y-scale, + an α-routing caption). `drainSeries` memo (tab-level, infinite-DC replay) feeds the TO timeline; the bulk timeline reads `d.bulkDaily[sku]` directly. (Replaced the earlier bulk-order-size *histogram* + the tab's `collectBulkOrderQty` import on 2026-06-17 — `collectBulkOrderQty` still exists as an engine helper.)

### DC model redesign ✅ DONE (2026-06-17)
The whole DC sizing was reworked this session (band model → lean reorder + capped bulk buffer). See the **DC Min/Max** section above for the final logic and rationale. Key arc: drop bulk from Min → discover TO qty-fill is a phantom metric (DS service is flat ~96% at any DC depth) → reframe DC as (a) lean replenishment cover + (b) a one-bulk-order buffer, with bulk-served-vs-rack as the only real choice. Proportional TO rationing added to `replay`. `scripts/measure-dc-bulk.mjs` is the read-only diagnostic that drove these decisions.

---

## Gotchas

- Local dev talks to PROD Supabase. v2 is dormant in prod config, and the tune UI only writes on explicit Publish (admin). Never click Publish casually — it saves to prod `params/plywoodNetworkV2Config` and triggers a model re-run. Verify network tab shows only GETs during eyeballing.
- The offline harnesses (`node scripts/validate-plywood-v2.mjs` and `node scripts/measure-dc-bulk.mjs` — the DC bulk-served-vs-rack diagnostic) are read-only and cache to `.cache/` — safe to re-run freely.
- `replay` is fully deterministic (incl. α-routing hash) — same inputs → same numbers. No `Date.now()`/`Math.random()`.
- When testing on localhost the user's published config already has per-DS `dsKnobs` for all 5 DSes + DC published — so global knob changes won't move a DS unless you **unpublish it** (the per-card override "✕ chip" was removed in the 2026-06-17 polish; unpublish is now the only way to drop a DS's localized knobs).
- **Env (macOS TCC, 2026-06-17):** dev server died with `EPERM … index.html` / `uv_cwd`. Not a code issue — `~/Documents` is macOS TCC-protected and the terminal lost access. Fix: grant the terminal **Full Disk Access** (System Settings → Privacy & Security) and fully quit/reopen it, or move the repo out of `~/Documents`. Do NOT `sudo npm run dev` (creates root-owned files).
- **2026-06-17 UI polish is UNCOMMITTED** on `feature/plywood-network-v2` (per "commit once UI is polished"). New helpers/memos added: `Hint`, `dotted`, `fmtD`, `sheetTick`, `valuePerSheet`, `dcResFull`, `dcLive`; removed now-unused `pillBox`, `svc`, `ceiling`, `InfoHover`, `liveSvc`, `dcKnobLabel`. Commit before further edits (local only — never push without explicit instruction).
