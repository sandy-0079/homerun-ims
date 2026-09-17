# Retired tabs — what was removed, and how to get it back

**2026-09-17.** The **OOS Simulation** tab and the **Plywood v2** tab were removed from IMS
because the team was not using them. Their code is not copied anywhere, deliberately —
see "Why there is no retired-code folder" below. This file is the recovery map.

**Restore point: commit `84852cb`** — the last commit before the removal. Everything below
exists there intact.

---

## What was removed

| | OOS Simulation | Plywood v2 |
|---|---|---|
| visible to | **all users** (`PUBLIC_TABS`) | admins only |
| tab component | inline in `App.jsx`, ~1,266 lines | `src/tabs/PlywoodNetworkV2Tab.jsx` (113 KB) |
| worker | `src/simWorker.js` | — |
| engine code | none | **`src/engine/strategies/plywoodV2/` — KEPT, still imported by `runEngine.js`** |
| config row | none | **`params/plywoodNetworkV2Config` — KEPT in Supabase, untouched** |

Removed from `App.jsx`: the `SimulationTab` component and its 16 exclusive helpers
(`SimSummaryCards`, `SimSKUTable`, `RankTable`, `OrderTable`, `ProblematicSKUs`,
`OverriddenSKUsSection`, `WhatIfUploadPanel`, `SimOrgLevel`/`CategoryLevel`/`BrandLevel`,
`buildGroupRows`, `calcInvValueDelta`, `downloadWhatIfCSV`, `DayStrip2`, `MovTag2`,
`DSBadgeSim`), the sim state block, the `v2Mounted` lazy-mount, the
`handleSavePlywoodNetworkV2Config` handler, both tab panels, both nav entries, and two
helpers orphaned by the cut (`oosColor`, `parseOverrideCSV`). App.jsx 5,285 → 3,921 lines.

**⚠ The Plywood v2 ENGINE was deliberately left in place.** Only the tab went. Removing
`src/engine/strategies/plywoodV2/` would mean editing `runEngine.js` and `src/engine/index.js`
— an edit to the file that computes every Min/Max — and that is a separate change needing
its own inertness proof. It is dormant either way: **no category was mapped to
`network_design_v2`** (verified live 2026-09-17; Plywood/MDF is on `network_design`, v1).
If it is ever removed, the `Network Design v2` **option must leave the Logic Tweaker too**,
or someone selects a strategy whose implementation no longer exists.

## Proof it changed nothing

Engine output was dumped before and after against **one frozen input snapshot** (100,582
invoice rows · 90 dates · 2,781 SKUs), because prod inputs move nightly and two live dumps
would differ from the *clock*, not the code:

```
min/max changes: 0 · tag/branch-only: 0 · cell shape: 0
DS01 0v/0t · DS02 0v/0t · DS03 0v/0t · DS04 0v/0t · DS05 0v/0t · DS06 0v/0t · DC 0v/0t
Inv Value  Min ₹7.2782Cr → ₹7.2782Cr  ·  Max ₹10.1902Cr → ₹10.1902Cr
✓ IDENTICAL — 0 of 19502 cells differ.
```

Reproduce: `npx vite-node scripts/snapshot-engine-inputs.mjs` → `dump-engine-output.mjs`
(once per side) → `diff-engine-dumps.mjs`. Also verified: build ✓, 705/705 tests, lint
75 → 58 problems, zero `no-undef`.

## How to get it back

```sh
# Plywood v2 tab
git checkout 84852cb -- src/tabs/PlywoodNetworkV2Tab.jsx

# OOS Simulation worker
git checkout 84852cb -- src/simWorker.js

# The App.jsx wiring — read it, do not check the whole file out:
git show 84852cb:src/App.jsx | sed -n '345,1610p'   # SimulationTab + its helpers
git show 84852cb:src/App.jsx | sed -n '3050,3080p'  # handleSavePlywoodNetworkV2Config
git show 84852cb:src/App.jsx | sed -n '4377,4391p'  # Plywood v2 panel
git show 84852cb:src/App.jsx | sed -n '4609,4617p'  # OOS Simulation panel
```

**⚠ Do not check `src/App.jsx` out wholesale** — it has moved on since. Lift the blocks.

**⚠ Expect the restored code to need adapting, and check these first.** This is why the
code was not kept as a parallel copy: a copy looks current and silently is not.
- `runEngine`'s signature — it gained an 8th positional arg (`ceilings`) in Aug 2026, and
  a call site that forgets it silently publishes uncapped targets.
- `DS_LIST` — `simWorker.js` **cannot import it** (it is a Web Worker), so it carries a
  duplicated six-store literal that will be wrong the day a DS07 exists.
- Anything reading `invoiceData` must be passed `attributedInvoice`, not raw rows.

## Where the context lives (not moved — it is still where it belongs)

- **Plywood v2 design, in full:** `src/engine/strategies/plywoodV2/CLAUDE.md` (32 KB).
  Still accurate for the engine, which remains; its UI sections now describe a removed tab.
- **Specs:** `docs/superpowers/specs/2026-06-11-plywood-network-v2-design.md`,
  `2026-06-17-plywood-v2-oos-simulation-design.md`, `2026-04-13-oos-simulation-redesign.md`
- **Plans:** `docs/superpowers/plans/2026-06-11-plywood-network-v2.md`,
  `2026-04-13-oos-simulation-redesign.md`
- **Changelog entries 1 and 2:** `docs/CHANGELOG-ARCHIVE.md`

## Why there is no retired-code folder

Git already is one — `git show 84852cb:<path>` returns any file exactly, forever — so a
`retired-tabs/` directory would be a second copy of something already kept, and it would
cost more than it gives:

1. **It rots invisibly.** It would not be updated when `runEngine` gains an argument or
   `DS_LIST` gains a store, so "restore it quickly" becomes false at exactly the moment
   someone tries. A stale copy that *looks* current is worse than no copy.
2. **It pollutes the checks.** Dead JSX under `src/` is still linted, which moves the lint
   baseline and makes the problem count meaningless — and that count is the thing that
   caught a parse error in Sept 2026 that a grep had missed.
3. **It is a second source of truth.** This repo has been bitten by that repeatedly: the
   duplicated Stock Health filter, the TO deep link fixed in one repo and not the other,
   and `docs/homerun-ims-v2-CLAUDE.md` — deleted the same day as this removal for describing
   a project that no longer existed.

What was genuinely at risk was never the code, which would need rewriting against today's
interfaces anyway. It was the **reasoning** — why capacity-aware stocking was designed that
way, why the OOS sim replays two passes. That is markdown, it does not rot, and it is all
listed above.
