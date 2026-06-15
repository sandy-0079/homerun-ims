# CLAUDE.md — Plywood Network v2

Capacity-aware plywood Min/Max engine. Replaces v1 Network Design (`../plywoodNetwork.js`,
brand-node stocking). **Status: feature-complete on the engine + tune UI; not yet activated
in prod. Next step is Keep Score → category discontinuation → re-run, then prod cutover.**

- **Branch:** `feature/plywood-network-v2` — NEVER push or PR without explicit user instruction. Local testing only.
- **Spec:** `docs/superpowers/specs/2026-06-11-plywood-network-v2-design.md` (read for full rationale).
- **Tests:** `npx vitest run` — 59 passing as of last session. vitest is a devDependency; `npm test` also works.
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

## DC Min/Max — `sizeDCOrderBulk` + `trimDCComponents` (dc.js)

```
DC Min = Repl + Bulk
DC Max = DC Min + Cycle
  Repl  = P[dcReplPercentile=98] of rolling (leadDays+1)-day TO-DRAIN sums
          (drain = replay the PUBLISHED DS plans with infinite DC → daily TO qty per SKU)
  Bulk  = P[dcBulkOrderPct=90] of the SKU's per-order bulk sizes   (NOT scaled by α — see below)
  Cycle = mean daily drain × dcCoverDays   (PO cadence: Max−Min ≈ days of supply per supplier PO)
```

**α (`bulkDcServedShare`) routes ORDERS, not sheets.** In `replay`, (1−α) of bulk orders go
supplier-direct (deterministic order-id hash, assumed served, excluded from DC bulk metric). It must
NOT shrink the bulk buffer — a DC-routed order needs its full quantity. (This was a bug, now fixed:
α=0.7 lifts DC bulk service ~67→75%.) α is **user-owned** (encodes the ops SOP), never auto-swept.

**Component-aware DC trim** (`trimDCComponents`): when DC rack over capacity, trim (1) cycle stock
first, (2) bulk on fewest-bulk-order SKUs first, (3) **repl NEVER** (it backs the published DS service).

**DC service is measured as TO FULFILMENT RATE** — % of DS replenishment requests (TO lines) the DC
ships IN FULL, daily. This is the *only* tracked DC target (user decision). Bulk is *stocked* (its
component is in the footprint, `dcBulkOrderPct` tunes it) but **not a tracked goal** — supplier-direct
is the worst-case fallback. Bulk % shows in tooltip only.

---

## The 75/15 operating workflow & publish lifecycle

1. Upload latest ~90d. Tab previews the plan **fitted on the first 75 days**, scored out-of-window on the **last 15 days** (the honest report card: per-DS service, OOS-per-SKU column).
2. Diagnose misses by pattern (NZD bucket / DS / class). Don't hand-patch numbers.
3. **Auto-tune** sweeps knobs → Pareto frontier; click any point to apply. The model turns the knobs (user found manual tuning = whack-a-mole; knobs interact).
4. **Publish** (admin) → engine refits the SAME formula on the FULL window — test-window misses self-correct by entering the fit.

**Lifecycle lock (current UX):** each location (DS01–05 + DC) is independently **published (LOCKED)** or **tuning (unlocked)**:
- Published → frozen summary strip (live service + sheets + knobs), no chart/knobs. "Unpublish & tune" to edit; "Keep published plan" re-locks unchanged.
- Tuning → unlocked frontier chart + knobs + Publish/Revert.
- NO Eval/Live toggle — basis is derived from lock state, shown as LIVE/TUNING badge.
- Publishing a location auto-locks it. Per-DS publish materializes that DS's *effective* knobs into saved `dsKnobs[loc]` (other DSes untouched); DC publish saves the global `dc*` fields. Capacity edits flow through publish/compare too.

**Two scorecards** (don't confuse):
- **Evaluation** (tuning view): 75d fit scored on unseen last 15d. The HONEST forward number — use to *choose* configs.
- **Live** (locked view): full-window fit scored on last 15d (in-sample). A health reading of what's running — always reads higher.

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
| `replay.js` | deterministic day-by-day sim: TO/PO timing, order-level OOS, α-routing of bulk, TO-fill tracking, drain series |
| `dc.js` | `sizeDCOrderBulk` (Repl+Bulk+Cycle), `trimDCComponents`; legacy `sizeDC`/`trimDCToCapacity` kept for old export |
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
DC (auto-tuned): `dcReplPercentile=98`, `dcBulkOrderPct=90`, `dcCoverDays` (2/4/7 in sweep). User-owned: `bulkDcServedShare` (α).
Per-DS: `dsKnobs={}`. Keep Score: `{grossMarginPct:0.06, carryRateQuarterly:0.05, opsBuffer:1.5, serviceNZDThreshold:5}`.

Note: `V2_DEFAULTS` still carries legacy `dcBulkPercentile` (rolling-window, superseded by `dcBulkOrderPct`) and greedy/tiered/empirical-mode knobs — harmless but prune if those alt allocators are dropped. (The old duplicate `deadFloorMode` key is now fixed — single `'abq'`; tiered's internal else-branch is unaffected.)

---

## Validation numbers (L90D, 11 Mar–8 Jun 2026, 122 SKUs, out-of-window unless noted)

- Unified default (P90/P90, no per-DS leaning): regular ~92.6% OOS-svc.
- v1 live plan on identical scoring: regular 81.1%, bulk 26.6% (333/610 combos at Min=Max=0).
- DC (current published lean config, real DC plan): TO fulfilment ~93.6%, regular ~89.1%, DC bulk ~71%.
- α=1.0 → no DC config fits 1000/500 (~1.65–2.4× needed); α=0.7 sheds the unpredictable share.
- Bulk plateau ~65–75%: ~29% of test bulk orders are novel (no fit history / biggest-ever) ≈ the 30% supplier-direct SOP share. DC stocks predictable bulk; suppliers absorb novelty.

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
summary cards + capacity-impact panel + sortable/filterable table + editable knobs (admin) + CSV export.
**Recommend-only** — cutting happens via discontinuation → SKU master, then the plan re-runs on survivors.
Validated: ~27–30 cuts, ~1–1.7% sales, ~₹6–9L holding freed; cuts flip DS thin nodes green but NOT
DS04/DS05 thick (those need deeper cuts or racking — consistent with the capacity wall).

## Open items / NEXT SESSION

1. **Capacity decision** (parked, business): is `dcCapacity` 1000/500 real or can Rampura hold ~2000 thick? Is DS04/05 thick rack expandable? The charts price both levers; the answer picks the operating point.
2. **Bulk SOP / α**: get the DC-vs-supplier routing rule written so α stops being an estimate.
3. **Prod cutover**: only after sim regular ≥ target, DC TO-fill ≥ target, capacity reconciled, cut-list reviewed with category team. Then switch `categoryStrategies` to `network_design_v2`.
4. **Cleanup**: prune legacy knobs (`dcBulkPercentile`, greedy/empirical/tiered knobs if those modes are dropped). `deadFloorMode` dedupe DONE.
5. **Keep Score knobs → Supabase (shared persistence):** currently the 4 Keep Score knobs (margin, carry, ops buffer, service threshold) persist only to `localStorage["plywoodV2KeepScore"]` — per-browser, not shared across users/devices. They're a business decision driving the cut list, so they should also write to the Supabase `params/plywoodNetworkV2Config` row (e.g. fold a `keepScore` slice into a publish path or add a dedicated save) so every viewer sees the same verdict. Precedence to decide: localStorage (in-progress edits) vs saved config.
6. **Keep Score knobs reset control:** add a small "reset to defaults" link next to the knobs (clears the localStorage key + restores `V2_DEFAULTS.keepScore`).

---

## Gotchas

- Local dev talks to PROD Supabase. v2 is dormant in prod config, and the tune UI only writes on explicit Publish (admin). Never click Publish casually — it saves to prod `params/plywoodNetworkV2Config` and triggers a model re-run. Verify network tab shows only GETs during eyeballing.
- The offline harness (`node scripts/validate-plywood-v2.mjs`) is read-only and caches to `.cache/` (gitignored) — safe to re-run freely.
- `replay` is fully deterministic (incl. α-routing hash) — same inputs → same numbers. No `Date.now()`/`Math.random()`.
- When testing on localhost the user's published config already has per-DS `dsKnobs` for all 5 DSes + DC published — so global knob changes won't move a DS unless you clear its override (✕ chip) or unpublish it.
