# DS07 HAL + DS08 Rajajinagar — wiring two dark stores ahead of opening

**Date:** 2026-09-18 · **Shipped ID:** 37 · **Status:** implemented locally, **not deployed**

DS07 HAL opens ~Wed 2026-09-23 (first TO ~Mon 2026-09-21); DS08 Rajajinagar roughly a week later.
The constraint that shaped every decision: **nothing on prod may move — crons or Min/Max at any
trading location, in IMS or the TO tool — until the operator flips a store live.**

---

## The idea

Two requests from the operator turned out to be one mechanism:

1. the PO team's download should gain DS07 columns only when DS07's pincodes are mapped;
2. show DS07/DS08 as "Opening Shortly" so nothing changes until then.

Both ask *is this store real yet?*, so they read **one flag**. Separate mechanisms could disagree,
and a store live in one and not the other is a silent wrong number.

This also inverts the deploy risk. Without it, adding a store is a big-bang: constants, five edge
functions, a cron, two repos and the PO file landing together on the day it matters. With it, the
wiring ships early and proves itself for days against a store with no stock, and go-live is a
one-line param change.

## Design

**`params/global.openingDSList`** — stores that exist everywhere and trade nowhere. Default
`["DS07","DS08"]` via `OPENING_DS_DEFAULT`.

- **An OPENING list, not a LIVE list.** If the key vanishes, the fallback names only stores that never
  traded, so absence cannot dark a store that is. A live-list defaults to "nothing is live".
- **Read with `??`, never `||`.** `[]` is the legitimate end state; `[] || DEFAULT` would silently
  re-gate both stores the day the last one opened.
- The fallback is not theoretical: prod's `params/global` predates the key and the merge is shallow,
  so `p.openingDSList` really is `undefined` on the first nightly run after deploy. Both writers
  (`App.jsx`, `api/run-engine.js`) merge over `DEFAULT_PARAMS`, so the gate is live from deploy with
  no Apply. Same idiom as `fixedUnitFloor.minNZD ?? 2`.

**`applyOpeningToStores`** (`src/engine/openingStores.js`) — applied to the finished `stores` map at
both sites that build one, mirroring `applyDeadStockToStores`.

- *Finished-map*, because `runEngine` writes `stores[dsId]` from five places; three inline copies plus
  one omission is exactly the Dead Stock (2026-08-26) and SKU Ceiling (2026-08-15) bugs.
- *Before the DC sums*, because `sumMin` feeds the floored DC. Applied after, a store in `newDSList`
  takes the New DS Floor, lands ~250 targets, and the DC absorbs them — **0/0 on screen, real
  inventory in the warehouse.**
- `dsDailyAvgs` is **not** zeroed: attribution relabels rows, so the donors have already lost that
  demand; removing it from the rate-based DC too would delete it from the network.

**`liveDsList(p)`** — the single definition of "which stores are real", shared by the gate, the PO CSV
header, `buildToTargets` and Stock Health. Four hand-rolled copies of that filter is the
`paramConfigRows` / `toTargets` lesson repeating.

**PO CSV** — `buildPoCsvHeaders(dsList)`. The contract didn't weaken, it became precise: positions
change only when a store opens, an announced day rather than a silent one.

**TO tool** — `DS_LIST` deleted from that repo. Order from `DS_ORDER`, membership from the published
targets, so a new store appears the day it opens with **no deploy in that repo**.

**DS Seed deleted.** Confirmed inert (`dsSeed: {}`). The new pass is its inverse: DS Seed had to
*invent* numbers for a store with no history (DS06 opened three weeks before attribution shipped);
attribution is retroactive, so the problem is now holding a wired store at zero.

## Evidence

Frozen snapshot of live inputs (100,820 invoice rows, skuMaster 2,784), engine dumped before and
after, diffed offline:

| check | result |
|---|---|
| min/max changes, DC + DS01–DS06 | **0** |
| tag/branch-only changes | **0** |
| Inv Value delta | **+₹0.0000Cr** (₹7.3291Cr / ₹10.2920Cr both runs) |
| cells removed | **0** |
| new cells | 5,578 = 2,789 × DS07 + 2,789 × DS08, all 0/0 |
| `toTargets` | 2,342 SKUs, `perDS` = DS01–DS06, no DS07/DS08 |
| PO CSV header | 22 columns, **byte-identical** to the pre-DS07 contract |
| tests | IMS 707 pass · TO tool 133 pass |

**The gate proven, not merely unexercised.** DS07 has no data, so an inert gate would pass every
assertion above. Simulating Monday on the snapshot — 19 pincodes remapped to DS07, 2,327 DS07 floors,
DS07 added to `newDSList`:

| | DS07 non-zero SKUs | DS07 ΣMin | DC total Min |
|---|---|---|---|
| gated | **0** | 0 | **24,547** |
| open | 2,056 | 22,238 | 28,516 |

The DC column is the ordering proof: applied after the sums it would have read 28,516.

## What this could not fix

Remapping a catchment to a **gated** store moved 179 live-store cells and 132 DC values. The
rate-based DC is conserved; the **floored** branch sums `stores[ds].min`, which the gate zeroed, while
the donors have already given the demand away. Nothing in the gate can fix that — it is the cost of
the misconfiguration itself. **Map a catchment and open the store in the same Apply.** The Logic
Tweaker warns on both halves; that warning is load-bearing.

## Decisions taken, with the reasoning

- **Both stores now, DS08 dormant** — one deploy, one PO-sheet disruption, one cron migration.
- **DS07 joins `stock-sync-4`** rather than a 5th cron. That slot was the only single-branch group, so
  this restores parity; a 5th group would cost ~1,200 Zoho req/day for an empty store. **DS08 must
  not join it** — 3 branches 429s after one group.
- **Floors + pincodes + flip in one Monday Apply.** The operator overruled a proposed split. Their
  reasoning held: stock must physically move DC→DS07 Mon/Tue regardless, and holding donors at full
  strength while filling a seventh store strains the DC more, not less. The split's other argument —
  cleaner verification — dissolved once the component deltas could be computed offline beforehand.
  Residual: donors replenish ~10–20% leaner Mon–Tue against an unchanged sell rate; watch
  DS01/DS02/DS05 on Tuesday and top up by hand at the 14:30 run if needed.
- **`activeDSCount` left at 4** though six stores trade. Pre-existing, not caused by this work;
  changing it would move DC targets for unrelated reasons and destroy the go-live's attributability.
  Logged, not fixed.
- **Clusters left open** (#23) — zero code representation in either repo; prose only.
- **Plywood config untouched.** DS07/DS08 are not nodes in `params/plywoodNetworkConfig`, so
  `plywoodNetwork.js` zero-fills them. Creating the node is a go-live UI action, not a deploy, so
  shipping early cannot change a plywood number. Tab defaults mirror DS06 (300 thick / 150 thin).

## Go-live sequence

| when | who | what |
|---|---|---|
| before deploy | operator | **confirm the two branch ids** — a swapped pair sends real stock to the wrong store and both systems would agree with each other |
| deploy | — | code + migration + both Vercel projects |
| verify | — | PO CSV byte-identical · `toTargets` still 6 stores · DS07/DS08 0/0 · stock sync returns both branches |
| after deploy | ops | floor-sheet DS07/DS08 columns (**never before** — `unknown_ds` hard-stop) · ceiling cells **blank, never 0** · plywood node + capacity |
| before Monday | operator | tell the PO team their file gains two columns |
| Monday | operator | upload pincode remap (review the diff) → untick DS07 → Apply |
| Monday | — | verify: DS07 up, donors down, network Inv Value roughly flat |
| +1 week | operator | same two steps for DS08, plus its cron (Open Work #39) |

## Open items created

- **#38** `sync-stock` empty-body path syncs every branch (latent; deliberately untouched).
- **#39** DS08 has no stock cron; prefer the untested `per_page` lever over a 5th slot.
