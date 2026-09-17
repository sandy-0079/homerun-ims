# CLAUDE.md — Plywood Network Design (v1)

**You are reading this because you touched a file under `src/engine/strategies/`.** This
documents the `network_design` strategy in `plywoodNetwork.js` — brand-level stocking,
the three zones, the DC formula, and the live config values.

**v2 (`network_design_v2`) has its own authoritative doc:**
`src/engine/strategies/plywoodV2/CLAUDE.md`. It shipped DORMANT in June 2026 — the live
engine stays on v1/PCT until an admin selects "Network Design v2" in the Logic Tweaker.

**The rest of the engine** — strategy dispatch, the post-blend ladder, Dead Stock, the SKU
Ceiling, attribution, Active-only, Inventorised-At, Purchase/Move — is in
`src/engine/CLAUDE.md`.

> ⚠ **The code defaults in `engine/constants.js` (`PLYWOOD_NETWORK_CONFIG_DEFAULT`) are
> STALE and deliberately left so — the live Supabase row wins.** Quote the live column in
> the table below, never the default.

---

## Network Design — Plywood Stocking

**Activated via:** Logic Tweaker → Category Strategy Map → "Plywood, MDF & HDHMR" → "Network Design". Off by default; PCT runs unchanged when inactive.

**v2 — capacity-aware successor (`network_design_v2`):** a separate engine in `src/engine/strategies/plywoodV2/` that stocks every SKU at every DS sized to fit shelf capacity, with a lean-reorder + one-bulk-order DC buffer (replaces v1's brand-node matrix). **Shipped to prod DORMANT 2026-06-18 (PR #11)** — admin-only "Plywood v2" tab (Locations / Assortment-Keep-Score / Settings / OOS-Sim views); the live engine stays on v1/PCT until an admin selects "Network Design v2" in the Logic Tweaker + Apply (reversible). Config in `params/plywoodNetworkV2Config` (own row). **Authoritative doc: `src/engine/strategies/plywoodV2/CLAUDE.md` — read it for v2 work.** v1 (below) is unchanged.

⚠ **The v2 TAB was retired 2026-09-17** — there is no admin-only "Plywood v2" tab any more, and
no UI writes `params/plywoodNetworkV2Config`. The ENGINE remains and the Logic Tweaker still
offers the strategy, so selecting it would still work. Removing it is open-work item 36.

**Concept:** Brand-level assignments — each brand is stocked at specific DS nodes which aggregate demand from multiple DSes. Non-stocking DSes get Min=Max=0 (fulfilled from stocking node or DC).

**Current brand assignments (live Supabase config, re-verified 2026-08-05 — code defaults in constants.js are stale):**
- All four brands (Action Tesa, CenturyPly, ArchidPly, GreenPly) stocked at **every DS, each node covering only itself** (no cross-DS coverage, no DC direct-serve nodes — the engine also `continue`s on any `DC` node key). Per-brand dcMultMin/dcMultMax = **0.75/1.0**, identical across all four.
- Merino: excluded from this tab, uses PCT.
- **DS06 IS in all four brand matrices** (verified live 2026-07-31 — added at go-live, superseding an
  earlier note here that said it was absent and relied on the DS Seed to fill it). With the seed now
  sunset, DS06's plywood stocking is entirely organic: **75 SKUs vs 107 under the seed**, and the 32
  difference are Rare-zone by the network's own `minNZD` rule (NZD < 2), i.e. correctly not stocked
  rather than a gap.

**3-zone stocking per SKU (NZD = non-zero demand days in lookback). ⚠ Re-derived from
`plywoodNetwork.js` on 2026-08-05 — the formulae here were WRONG for both stocked zones:**
- **Rare** (total NZD < minNZD=2): Min=Max=0, not stocked
- **Sparse** (2 ≤ NZD < sparseNZD=5): `Min = ceil(ABQ)` · **`Max = min(max(winsorisedMax, Min+1), maxCap)`**.
  ABQ = total qty ÷ orders, from **regular** orders only.
- **Frequent** (NZD ≥ 5): **`Max = min(max(winsorisedMax, P95+1), maxCap)`**, then
  **`Min = min(P95, max(0, Max−1))`** — note Min is derived *from* Max and can be pulled BELOW P95 to
  keep Max > Min. P95 is of winsorised **regular** daily demand.
- **⚠ Both Maxes are driven by `winsorisedMax` — the largest winsorised regular day — NOT by a
  percentile of order quantities and NOT by `ABQ × a multiplier`.** The old text said
  `Max = Min + P75(orders)` and `Max = ceil(Min × abqMult)`; neither exists in the code.

Winsorising: daily demand capped at `median × spikeCapMultiplier` before P95 to handle outlier days.

**⚠ Zone classification uses TOTAL NZD, but Min/Max use REGULAR orders only** — a mechanism this file
previously omitted entirely. Orders above `bulkThresholdMultiplier × cross-DS ABQ` (or ≥
`bulkMaxThreshold` outright) are classed **bulk**, excluded from DS stocking, and left to the DC.
`minOrdersForBulkFilter` is the minimum total orders across all DSes before the ABQ-based threshold is
trusted; below it only the hard floor applies. So a SKU can be Frequent by NZD and still have
`regularNZD = 0`, in which case it gets Min=Max=0.

**DC formula:** `DC = P95(direct-serving DSes) + ceil(Σ DS_Min × dcMult)`. Uses Σ DS_Min (not Σ(Max-Min)) so fast-movers get proportional DC buffer. **Floored SKUs:** DC result is floored to `max(network_dc, Σ DS_Min × skuFloorDCMultMin / Σ DS_Max × skuFloorDCMultMax)` — same global multipliers as non-network floored SKUs (defaults: 0.2/0.3).

**Config:** Plywood tab → ⚙ Network Design Configuration (admin; visible read-only to all). Stored in
`params/plywoodNetworkConfig` (separate from `params/global`). Saving auto-reruns engine.

**⚠ LIVE VALUES, read from the row 2026-08-05 — the code defaults in `engine/constants.js`
(`PLYWOOD_NETWORK_CONFIG_DEFAULT`) are STALE and deliberately left so; the live row wins. Quote the live
column, not the default:**

| key | live | code default |
|---|---|---|
| `lookbackDays` | **45** | 90 |
| `minPercentile` | 95 | 95 |
| `maxCap` | 20 | 20 |
| `spikeCapMultiplier` | **4** | 3 |
| `minNZD` | 2 | 2 |
| `sparseNZD` | 5 | 5 |
| `bulkThresholdMultiplier` | **1.5** | 2.0 |
| `minOrdersForBulkFilter` | 5 | 5 |
| `bulkMaxThreshold` | 10 | 10 |
| `thickBoundaryMm` | 9 | 9 |
| `capacityTolerancePct` | **1** | 2 |
| `sparseErraticThreshold` | 1.5 | 1.5 |
| `dcCapacity` | **`{thick:1200, thin:600}`** | `{thick:400, thin:400}` |
| per-brand `dcMultMin`/`dcMultMax` | **0.75 / 1.0** (all four brands) | — |

- **⚠ The key names are the LONG forms** — `spikeCapMultiplier`, not `spikeCapMult`. This file used to
  say `spikeCapMult=3` / `abqMult=1.5`, borrowing the abbreviated names from **`fixedUnitFloor`'s**
  namespace, where `spikeCapMult` *is* a real key. Different config, different spelling. A doc error, not
  a code one: the engine destructures the long names and the live values are in effect.
- **An earlier line here claimed `dcMultMin/dcMultMax` were "tuned to 0.3/0.5". Wrong** — live is
  0.75/1.0 on all four brands, which is what the brand-assignment paragraph above already said. That
  contradiction is resolved in favour of 0.75/1.0.
- **⚠⚠ `maxBufferPercentile` and `abqMultiplier` WERE DEAD KNOBS AND ARE NOW DELETED (2026-08-05).**
  Both were read from config and never used — by the engine *or* the tab — while remaining editable in
  the admin config UI, `maxBufferPercentile` under the hint "Max = Min + PXX of historical order
  quantities at this node", describing a calculation that never ran. Someone had moved them from their
  defaults (75→45 and 1.5→1.25) with **zero effect on stocking**, which is how the doc error above got
  believed. Removed from `plywoodNetwork.js`, `PlywoodNetworkTab.jsx` (locals, the trace field, and both
  UI fields) and `PLYWOOD_NETWORK_CONFIG_DEFAULT`. Engine output verified **byte-identical** after
  removal — `diff-headless-totargets.mjs`, 0 of 2,039 SKUs differing.
  - **eslint already knew.** Both were `no-unused-vars` entries inside the 79-problem lint baseline; the
    count dropped to **76** on deletion. A dead config knob is visible to the linter *before* anyone
    notices the docs are wrong — worth a glance at that baseline rather than treating it as noise.
  - **⚠⚠ WHERE THE WRONG FORMULA CAME FROM — CLAUDE.md WAS DOCUMENTING THE PLAN, NOT THE BUILD.**
    `docs/superpowers/plans/2026-04-27-plywood-brand-stocking.md:36` specifies, verbatim:
    `Max = min(Min + P{maxBufferPercentile}(individual order qtys across covered DSes), maxCap)`
    — which is exactly the sentence that sat in this file for three months. The plan also specified a
    `computeOrderBuffer()` helper, and **that helper exists in `plywoodNetwork.js` and is never called**
    (`no-unused-vars`, still flagged). So the feature was **half-built**: helper written, config key
    added, UI field added, hint written — and the call site never created. Nothing failed, because a
    coherent fallback (`winsorisedMax`) was already computing Max.
    - **This was never doc *drift*. It was wrong on day one and no measurement ever contradicted it**,
      because the doc, the plan, the UI hint and the live config value all agreed with each other. Four
      mutually consistent sources, none of them the code.
    - **Generalisable: after shipping from a plan, re-derive the doc from the BUILD.** A plan describes
      intent; a half-implemented plan leaves intent looking like fact. The check that catches it is
      cheap — read the function that computes the number, or grep the config key for a *use* rather
      than a declaration.
  - **The live row still carries the two orphan keys** (`maxBufferPercentile: 45`, `abqMultiplier: 1.25`).
    Deliberately NOT stripped — nothing reads them, and editing prod config to tidy a comment is a worse
    trade than leaving two inert keys. Expect to see them in the row; they do nothing.

Brand-DS assignments editable in config matrix (brand×DS checkboxes + covers). Brand matching is case-insensitive.
