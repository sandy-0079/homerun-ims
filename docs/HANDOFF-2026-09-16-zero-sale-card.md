# HANDOFF — Zero Sale SKUs card on the Tool Output Download tab

> ✅ **BUILT AND VERIFIED 2026-09-17.** Logic lives in `src/zeroSaleCsv.js` (+ 28 tests);
> the card is the fifth `DownloadCard` on the Tool Output tab. Verified by diffing the card's
> own browser downloads against this doc's oracle script while the two were still independent
> implementations — **three files, byte-identical** (547 / 529 / 517 SKUs on 2026-09-17). The
> script now imports the module, so the two cannot drift; that is why the diff was run first.
> Kept for the reasoning, not as a work item. **Its numbers were stale on the day it was
> written and are staler now — re-run the script.**
>
> Two things it did not predict: `const zeroSale` was already taken in `App.jsx` (an all-time
> Data Health count), which is a **parse error**, not a lint warning — and the banner copy was
> changed to say "every download on this tab" rather than the suggested "five", because a
> literal count goes stale at the sixth card.

**Written 2026-09-16 as scope + context, before anything was built.**
A proven reference implementation existed as a script (`scripts/adhoc-zero-sale-lists.mjs`);
the job was to move that logic into the app as a card. Read this whole file before writing code,
then re-derive the numbers (see **Do not trust the numbers in this file**).

---

## The ask

A fifth `DownloadCard` on the Tool Output Download tab, **same size as the others, directly below
the PO Team Download card**, carrying **three buttons: 60 Days / 75 Days / 90 Days**. Each
downloads the list of **Active SKUs with zero sales** in that trailing window.

Columns — the SKU Master download **minus `Top N`**, 9 in total:

```
Item Name · Inventorised At · SKU · Category · Status · Purchase · Move · Brand · Price Tag
```

Agreed with the operator on 2026-09-16: **Active only** (not inactive/confirmation_pending),
**nothing excluded** (Supplier, Dead Stock and DC-only SKUs all stay in — the `Inventorised At`
and `Status` columns let them filter in the sheet), **no extra columns**, **no new-SKU flag**.

---

## ⚠⚠ THE ONE BUG THIS TASK IS MOST LIKELY TO SHIP

**`results[sku].meta.t150Tag === "Zero Sale"` ALREADY EXISTS, and using it here would be wrong.**

That tag is computed in `runEngine.js:105-112` over `invSliced`, which is
`allDatesRaw.slice(-overallPeriod)` — and **`overallPeriod` is 45 live**. So the engine's
"Zero Sale" is an **L45D** verdict. Wiring three buttons to it produces three identical files
containing the 45-day answer, labelled 60/75/90. Every count would look plausible, every column
would be right, and the files would be wrong. Nothing would fail.

**The card must recompute its own window from raw invoice rows.** It cannot reuse `results`.

This is the same shape as the `maxBufferPercentile` post-mortem: a coherent-looking value already
in scope, which answers a *different* question than the one being asked.

---

## Window semantics — read before writing the filter

`runEngine` defines a window as **the last N *dates present in the data***, not a calendar
subtraction:

```js
const allDates = allDatesRaw.slice(-op);          // runEngine.js:77-78
const invSliced = inv.filter(r => allDates.includes(r.date));
```

Those two readings coincide **only while the invoice row is contiguous**. It is today (verified
2026-09-16: 90 distinct dates over a 90-day span, `2026-06-18 → 2026-09-15`), so "L90D" genuinely
means 90 days. A gap would silently stretch the window further back in calendar time while the
filename still said `L90D`.

**Do the same `slice(-N)`** (so the card agrees with the engine), and **name the resolved date
range in the file** — either in the filename or as a first-line comment — so the file states what
it actually covers rather than asserting a duration. The reference script asserts contiguity and
throws if it fails; the card can't throw at a user, so prefer showing the real range.

**`RETENTION_DAYS = 90`** (`supabase/functions/sync-invoices/index.ts:81`) is the ceiling — the
invoice row is trimmed to 90 dates nightly, so **90 is the largest window that will ever have
data**, and the L90D button is permanently at that edge. Handle `dates.length < 90` (a restore, a
bad night, a retention change): either disable the affected button or label it with the true span.
Do not silently emit a short window under a 90-day filename.

---

## ⚠ Attribution is irrelevant here — document it so nobody "fixes" it

CLAUDE.md says *"If you add a tab that reads `invoiceData`, pass it `attributedInvoice`."* **That
rule does not apply to this card, and the next reader will think it does.**

Zero-sale asks *"did this SKU sell anywhere?"* — the membership test is on `r.sku` alone and never
reads `r.ds`. `applyAttribution` only ever **relabels** `r.ds`; it drops no rows and creates none.
So raw and attributed inputs produce **byte-identical** output.

Use raw `invoiceData` (already in scope, `App.jsx:2863`) and **leave a comment saying why**, exactly
as `OverviewTab` does. Passing `attributedInvoice` would not be wrong, just misleading — it implies
a dependency that doesn't exist.

---

## Where it goes — the layout is free

`App.jsx:4388` opens the card grid:

```jsx
<div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,alignItems:"stretch"}}>
```

Four cards currently fill row 1, PO Team Download first. **Adding a fifth child makes it flow to
row 2, column 1 — directly below the PO card, at identical width.** No grid change, no wrapper, no
explicit placement. If you find yourself editing `gridTemplateColumns` or adding a second grid, stop:
the requirement is already satisfied by append order.

---

## ⚠ `DownloadCard` takes ONE button — this is the only real structural decision

`App.jsx:132` — `React.memo(({title,accent,blurb,shape,cta,footnote,primary,disabled,onClick,hint})`.
A single `cta` + `onClick`. Three buttons need a change to a component **shared by the four existing
cards**.

**Recommended: add an optional `actions` prop**, `[{label, onClick, hint}]`, rendered as a row when
present; fall back to the existing single-button path when absent. The four current call sites stay
untouched and must render **byte-identically** — that is the acceptance bar for the change, and it is
cheap to eyeball against a screenshot.

Rejected alternative: a separate `MultiDownloadCard` component. It duplicates the card chrome
(border, accent, blurb, shape, footnote, disabled styling), and the two would drift the first time
anyone restyles a card — the duplicated-Stock-Health-filter shape.

Sizing note: the three buttons share one row, so keep labels short (`60 Days`, `75 Days`, `90 Days`).
At 1/4 grid width with `gap:12`, full-width `⬇ Download 60 Days` triplets will not fit.

---

## Where the logic lives

New module **`src/zeroSaleCsv.js`**, mirroring `src/poTargetsCsv.js` — header constant + a pure
builder, importable by tests and by the script. **Do not inline this in `App.jsx`.** The invoice
`⬇ Data` round-trip bug happened precisely because a writer in `App.jsx` sat ~3,000 lines from its
reader with an unasserted invariant between them.

**Reuse the real formatters. Never reimplement them:**

| value | source | why |
|---|---|---|
| `Status` | `normaliseStatus` — `src/skuStatus.js` | four spellings are live in `skuMaster`; a sheet formula on `="Active"` matches zero raw rows |
| `Purchase` / `Move` | `normalisePolicy` — `src/skuPolicy.js` | the two Zoho fields speak **different** vocabularies (`ON`/`OFF` vs `Yes`/`No`) |
| `Price Tag` | `getPriceTag` — `src/engine/utils.js:120` | needs `params.priceTiers`, live `[3000,1500,400,100]` |

`Price Tag` is **window-independent** (derived from `priceData`, not demand), so it is identical
across all three files. Only the row set varies.

**Active filter:** `(s.status || "active").toLowerCase() === "active"`. A **missing** status counts
as active — the established convention for a master row that omits the field, and distinct from a
SKU absent from the master entirely.

**Sort:** Category → Brand → Item Name, matching the Reverse TO list, so a reviewer walks the
catalogue in coherent groups rather than by SKU code.

**Escaping:** quote every text field and double embedded quotes. Item names carry commas *and*
apostrophes (`Ashirvad CPVC Brass Female Threaded Adaptor FABT, 11, 2''`). One unescaped comma
shifts that row alone, which no eyeball catches in a 548-row file.

**This column set is NOT a frozen contract** — unlike `PO_CSV_HEADERS`, nobody's sheet formulas key
on its positions. Pin the order in a test for regression safety, but do not carry the PO file's
append-only ceremony into it.

---

## Freshness gating

All four existing cards pass `disabled={!results||outputFreshness.blocked}`. **Gate this one the
same way**, for consistency and because the amber banner says "downloads are disabled" — one live
button under that banner reads as a bug.

Note the gate is genuinely weaker here: zero-sale depends on `invoiceData`, not on the engine's
computed targets, so a stale tab degrades more gracefully than it does for PO targets. That is an
argument for keeping the gate (no downside), not for dropping it.

⚠ The banner copy at `App.jsx:4367` says **"ALL FOUR downloads"** in both the comment and, in
effect, the user-facing text. **Update it to five**, or it becomes the next stale-doc entry.

---

## Reference implementation — already written and verified

`scripts/adhoc-zero-sale-lists.mjs` (read-only, re-runnable, `npx vite-node`). It does exactly what
the card must do and its output was validated on 2026-09-16:

- counts reproduced by two independent implementations;
- every row parses at exactly 9 fields under a strict RFC4180 reader, all three files;
- nesting asserted in-script — **L90D ⊆ L75D ⊆ L60D**, both passed;
- 0 duplicate SKUs, 0 blank item names, `Status` uniformly `Active`.

Output: `validation-out/zero-sale-2026-09-16/` (gitignored).

**Use it as the oracle.** Build the card, download all three files, and diff them against a fresh
script run. Identical bytes (modulo any filename/date-range choice) is the completion bar.

---

## ⚠⚠ DO NOT TRUST THE NUMBERS IN THIS FILE

As of the 2026-09-16 data (90 dates through 09-15): **L60D 548 · L75D 533 · L90D 521**, from 2,392
active SKUs of 2,777 in the master.

**These will be different by the time you build this.** The invoice window slides nightly and the
catalogue syncs nightly, so the counts move every single day — and a SKU that sells tomorrow leaves
the list. Treat the figures above as *shape* (~520-550, ~22% of the active catalogue), never as
expected values, and **never hardcode them in a test**.

This is the `G9NYZ DS01 = 0/0` lesson: a runbook expectation drawn from data a human or a cron can
change is stale before anyone reads it, and nothing about it looks wrong. Re-run
`scripts/adhoc-zero-sale-lists.mjs` to get current truth at build time.

Tests must assert **invariants**, not counts: column order and header text; a SKU with a row inside
the window is excluded; a SKU with a row only *outside* it is included; inactive SKUs never appear;
a missing status counts as active; the three windows nest; blank vs zero handling; comma-bearing
item names survive a round-trip parse.

---

## Known caveat, accepted by the operator

**`skuMaster` has no created-date field** — the fields are exactly
`sku, name, category, brand, status, inventorisedAt, purchase, move`. So a SKU created last week is
indistinguishable from one dead for a year; both read "zero sale in 90 days". The master grew
2,573 → 2,777 between 2026-09-07 and 2026-09-16, so genuinely-new SKUs **will** be in these lists.

Decided to ship without a flag. **Surface it in the card blurb** so whoever downloads it knows —
a delisting decision made from an unqualified list is the failure mode.

If it later needs solving, the only proxy we hold is diffing against
`team_data/catalogue_backup_20260729` (one snapshot, ~7 weeks old) to add a `Present 2026-07-29`
column.

---

## Worth knowing about what's in the list

From the 2026-09-16 L90D run — useful for writing an honest blurb, not for assertions:

- **54% are unpriced** (281 of 521). That compounds: under PCT, `No Price` sits at the **95th
  percentile**, so these are the most aggressively stocked tier in the model *and* have sold nothing
  in 90 days. They are also invisible to any rupee-denominated check — the ₹0.00-while-161-cells-
  zeroed trap. This is the highest-value slice in the output.
- Concentrated in General Hardware 131 · Wires/MCB 102 · Sanitary & Bath 83 · Painting 75 ·
  Glass Hardware 30.
- Only **27 SKUs** separate L60D from L90D, so the three windows say nearly the same thing. If the
  three-button UI ever feels like overkill, that is why — but the operator asked for three, and the
  narrow band is itself the interesting signal (SKUs that woke up in the older 30 days).

---

## Verification checklist

- [ ] `npx vitest run` green, including new `src/zeroSaleCsv.test.js`
- [ ] `npx eslint src/ | grep no-undef` — **clean**. A green `npm run build` proves nothing about
      undefined identifiers; esbuild does not resolve them. Three bugs in the 2026-08-03 rebuild of
      this exact tab all built cleanly and would each have white-screened it.
- [ ] `npx eslint src/` total is not worse than the **75**-problem baseline (re-measure; this number
      has drifted)
- [ ] **Load the page and click all three buttons.** Same reason as above.
- [ ] Diff all three downloads against a fresh `scripts/adhoc-zero-sale-lists.mjs` run
- [ ] The four existing cards render unchanged after the `DownloadCard` edit
- [ ] Each file parses at exactly 9 fields per row under a strict CSV reader
- [ ] Banner copy no longer says "four"
- [ ] Nothing written to prod — this is a pure read/download feature, no Supabase writes at all
