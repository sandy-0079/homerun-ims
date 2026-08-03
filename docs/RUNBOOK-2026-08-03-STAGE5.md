# RUNBOOK — Stage 5 cutover · Monday 2026-08-03, post 11:00 IST

**Temporary.** Delete this file, the Stage 5 section of `CLAUDE.md` To-Do 16, and the in-flight
block at the top of `CLAUDE.md` once this is done and Tuesday's verification passes.

**Goal:** point `sync-invoices` at the live row so that **Tuesday 2026-08-04 morning, Min/Max is
computed from demand data through Monday night (2026-08-03)** — with no manual CSV upload, ever again.

**Written Saturday 2026-08-01.** Every number below is an expectation to check, not a fact.

---

## Why a backfill is needed at all

`planNightDates` uses a **fixed 3-day lag** — day D is pulled fresh on D+1 and rechecked on D+4. So
dates pulled into the **shadow** row while Stage 4 was running are not in the live row and will not be
re-fetched for up to three more nights:

| date | auto-heals on live | in time for Tuesday? |
|---|---|---|
| `07-31` | Mon night (D-3 recheck of 08-03) | ✓ yes |
| `08-01` (Sat) | Tue night | ✗ too late |
| `08-02` (Sun) | Wed night | ✗ too late |

Leaving `08-01`/`08-02` as holes is worse than the ~3% row share suggests: `pctMinNZD`,
`fixedUnitFloor.minNZD` and the plywood Rare/Sparse boundary all gate on **NZD ≥ 2**, so a missing day
can drop a slow mover out of its strategy entirely. 78.7% of SKU×DS combos are Slow/Super Slow.

**Safety net if we get this wrong:** the fixed-lag recheck heals any hole within three nights, because
`mergeInvoiceRows` replaces a fetched date *wholesale*. A mistake costs a few days of slightly
understated demand, not a corrupted row.

---

## ⚠ Read before executing

- **The live row is exactly at the retention limit.** `RETENTION_DAYS = 90`; live holds exactly 90
  dates (`05-02 → 07-30`). Adding 4 dates trims the 4 oldest — **05-02 … 05-05, permanently**. They are
  pre-July, the Zoho API cannot re-serve them, and **Monday's backup is their last copy.** Immaterial
  to Min/Max (engine window is 45 days). Expected, not a fault.
- **IMS recomputes client-side on every page load.** The instant the backfill lands, anyone loading IMS
  sees demand through `08-02`. There is no "publish" step to wait for.
- **`params/toTargets` does NOT change until Tuesday 05:45**, unless you run the optional step 3d. So
  Monday afternoon IMS is fresher than the TO tool. Harmless, but tell the DC team if they ask.
- **Do NOT upload an invoice CSV to fix anything.** Invoice CSV upload **replaces entirely** — it would
  wipe `05-02 → 07-26` and destroy history Zoho cannot reproduce.

---

## Step 0 — morning checks (~11:00 IST)

```bash
B=https://rgyupnrogkbugsadwlye.supabase.co/rest/v1; K=<anon key from CLAUDE.md>
for r in engineRunStatus skuFloorSyncStatus invoiceSyncStatus catalogueSyncStatus; do
  echo "== $r"; curl -sS "$B/params?select=payload&id=eq.$r" -H "apikey: $K" | python3 -m json.tool
done
```

| row | expect |
|---|---|
| `invoiceSyncStatus` | `phase:"published"` · `publishedPlan:["2026-08-02","2026-07-30"]` · `merge.safe:true` · `coverage.unknownPct` < 1 |
| `engineRunStatus` | `ok:true` · `mode:"live"` · `reason:"ok"` · `inputs.invoiceDataThrough:"2026-07-30"` · `timing.totalMs` < 10000 |
| `skuFloorSyncStatus` | `lastOkNight:"2026-08-03"` · `change.reason:"ok"` |
| `catalogueSyncStatus` | `lastOkNight:"2026-08-02"` · `change.safe:true` · `invAtChanged.toSupplier: []` |

**Stop and reassess if** `invoiceSyncStatus.ok` is false, or `phase` is not `published` — a failed
weekend night means the shadow row is short and step 1 will tell you which date is missing.

---

## Step 1 — confirm the shadow row has Saturday and Sunday

```bash
node scripts/backfill-invoice-dates.mjs        # DRY RUN — read-only, writes nothing
```

Expect `dates to backfill: 2026-07-31, 2026-08-01, 2026-08-02`, roughly **1,100–1,300 rows each** at
**100% pin**, and `75,699 → ~79,400 rows / 90 → 93 dates`.

- A date **missing** from that list ⇒ that night's pull failed. Check `invoiceSyncStatus`. You can
  proceed without it (D-3 heals it) but say so out loud — it will be a hole on Tuesday.
- Row count wildly off (< 800 or > 1,600) ⇒ stop and investigate before writing.

Optional extra confidence, if you have a Zoho CSV export to hand:

```bash
node <scratch>/iso-dates.mjs "~/Downloads/Invoice.csv" /tmp/iso.csv   # asserts DD>12 before converting
node scripts/compare-csv-vs-shadow.mjs /tmp/iso.csv
```

---

## Step 2 — PO team downloads FIRST

Monday's POs should be raised on the numbers you briefed, before anything changes.

**IMS → `Tool Output Download` tab** (no admin password needed):
- ⬇ **Tool Output DS Level** → `IMS_Output_DS.csv` (DS01–DS06 Min/Max)
- ⬇ **Tool Output DC** → `IMS_Output_DC.csv` (DC Min/Max)

⚠ **They must hard-reload first** (Cmd-Shift-R / Ctrl-Shift-R). Those buttons serialise a
**client-side recompute from page load** — a tab open since Friday downloads Friday's Min/Max in a file
that looks entirely normal. This is the known stale-tab gap.

⚠ Both files contain all ~2,120 SKU Master rows including inactive and Supplier SKUs, which appear as
`0/0`. Filter them out; they are not "stock nothing" decisions.

**Confirm the download is done before step 3.**

---

## Step 3 — execute

### 3a. Backup + backfill (one command; takes the backup itself and verifies it first)

```bash
node scripts/backfill-invoice-dates.mjs --apply
```

Writes `team_data/invoice_data_backup_20260803`, verifies it row-for-row and date-for-date against
live, and only then writes `invoice_data`. It refuses on: a non-ISO date (the 2026-07-29 outage), a
malformed row, any date that would be lost, or the live row changing under it.

Expect a final `verified: ~79,400 rows, 93 dates (2026-05-02 -> 2026-08-02)`.

### 3b. Flip the target row

`supabase/functions/sync-invoices/index.ts` **line 48**:

```diff
-const TARGET_ROW = "invoice_data_shadow";  // ⚠ Stage 5 flips this to "invoice_data"
+const TARGET_ROW = "invoice_data";
```

Also update the file-header comment at lines 3–6, which still says the target is the shadow row.

### 3c. Deploy

```bash
git status                                    # ⚠ confirm _shared/* is not unexpectedly modified
supabase functions deploy sync-invoices
```

⚠ `supabase functions deploy` bundles whatever `_shared/*` is on disk. Check `git status` first — a
stale `functions download` can leave `_shared/zoho.ts` reverted.

### 3d. Align the TO tool the same afternoon

Without this, `toTargets` updates on its own at Tuesday 05:45 and the TO tool runs Monday on
`07-30` demand.

⚠ **`↻ Refresh` in the TO tool is NOT sufficient on its own.** It genuinely re-reads
`params/toTargets` (its tooltip is accurate), but the TO tool **computes nothing and writes nothing** —
so it will re-read a row that nobody has rewritten and show identical numbers. Something must
recompute and WRITE `toTargets` first.

⚠⚠ **And the TO tool will not warn you.** Its footer clock reads `toTargets.refreshedAt` and flags
stale as "not from today IST". That row was written at **05:45 this morning**, so it renders
`Min/Max computed 03 Aug 05:45` with **no ⚠** — fresh by its own definition, computed from Thursday's
demand. The clock measures when the engine RAN, not what it ran ON. (`inputs.invoiceDataThrough` is
stamped in the same row but displayed nowhere — fold it into that footer when doing the IMS freshness
pill.)

**Preferred — no stale-tab exposure:**

```bash
curl -sS -X POST https://homerun-ims.vercel.app/api/run-engine \
  -H "Content-Type: application/json" -H "x-engine-secret: <ENGINE_RUN_SECRET>" \
  -d '{"mode":"live"}' | python3 -m json.tool
```

Identical code path to the nightly cron, verified byte-identical to a browser Apply, touches only
`params/toTargets`. `assessTargetsChange` blocks a >20% fall in target count, so it cannot silently
empty the row. Expect `inputs.invoiceDataThrough: "2026-08-02"`.

**Alternative — buttons:** hard-reload IMS (**mandatory**, not advisory — Apply recomputes client-side
from whatever the tab loaded, and also writes `params/global`, `paramsBackup`, `pincodeMap`), then
**Apply & Re-run Model**.

**Then** click `↻ Refresh` in the TO tool and confirm the footer timestamp is minutes old.

---

## Step 4 — verify immediately after

```bash
curl -sS "$B/params?select=payload&id=eq.invoiceSyncStatus" -H "apikey: $K" | python3 -m json.tool
```

- Hard-reload IMS. Overview KPIs should move slightly (three extra days of demand).
- Nothing else should change until 00:35 IST.

---

## Step 5 — Tuesday 2026-08-04 morning (the real verification)

**This is the first morning the whole chain has run unattended with `sync-invoices` writing the live
row.** Nothing before today has proven that.

### 5a. One glance first — the Data Inputs chip

Open IMS → **Upload Data** tab (admin). The chip reads:

> `Last run: 2026-08-04 05:45 · demand through 2026-08-03`

**Both halves must agree with the date.** The clock alone cannot tell you the inputs are current — see
the Stage 6 notes in CLAUDE.md. If it reads `demand through 2026-08-02`, the invoice night did not
publish; if `Last run` is yesterday's date, the engine did not run. Either way the row below says why.

### 5b. The four status rows

```bash
B=https://rgyupnrogkbugsadwlye.supabase.co/rest/v1; K=<anon key from CLAUDE.md>
for r in invoiceSyncStatus engineRunStatus catalogueSyncStatus skuFloorSyncStatus; do
  echo "== $r"; curl -sS "$B/params?select=payload&id=eq.$r" -H "apikey: $K" | python3 -m json.tool
done
```

| check | expect |
|---|---|
| `invoiceSyncStatus.publishedPlan` | `["2026-08-03","2026-07-31"]` |
| `invoiceSyncStatus` | `phase:"published"` · `merge.safe:true` · **`merge.datesTrimmed: 4`** · `datesReplaced: 1` · `datesAfter: 90` |
| `toTargets.inputs.invoiceDataThrough` | **`"2026-08-03"`** ← the whole point |
| `toTargets.inputs.invoiceRows` | **~77,660 ±200** |
| `engineRunStatus` | `ok:true` · `mode:"live"` · `reason:"ok"` · `change.dropPct` ~0 |
| live row dates | **`05-06 → 08-03`**, 90 dates |
| `catalogueSyncStatus` | `lastOkNight:"2026-08-03"` · `invAtChanged.toSupplier: []` |
| `skuFloorSyncStatus` | `lastOkNight:"2026-08-04"` · `change.reason:"ok"` |

**⚠ `datesTrimmed` is 4, not 3, and the range starts 05-06.** The backfill left the row at 93 dates
(05-02 → 08-02); Monday night *adds* 08-03 making 94, so `RETENTION_DAYS = 90` trims **four**:
**05-02, 05-03, 05-04, 05-05 — 2,354 rows, permanently and un-refetchably** (pre-July; the API cannot
serve them). `team_data/invoice_data_backup_20260803` is their last copy. Expected, not a fault.
*(An earlier version of this table said 3 / `05-05`, written before the backfill scope was known.)*

### 5c. The PO download still works

```bash
npx vite-node scripts/verify-po-csv.mjs      # read-only
```
Then click **⬇ PO Team Download** in the Tool Output tab. Expect
`PO_Targets_2026-08-04_demand-thru-2026-08-03.csv`.
- **If all four download buttons are disabled with an amber banner, that is the freshness gate working**
  — the tab was open across the nightly publish. Click `↻ Reload now`. See the Tool Output Download
  section in CLAUDE.md.

### If it did not publish

`invoiceSyncStatus.reason` says why. Min/Max is then **one day stale, not wrong**, and the fixed-lag D-3
re-fetch heals the hole within three nights. Do **not** reach for a manual CSV upload: it replaces
entirely, and the Zoho export locale still emits `DD/MM/YYYY` so the date guard will refuse it anyway
(Open Work item 19).

⚠ `scripts/compare-invoice-shadow.mjs` is **no longer the right tool** — `invoice_data_shadow` has been
frozen since the cutover, so it now compares the live row against a stale snapshot and its verdict is
noise. Drop that row once this step passes.

---

## Rollback

| if | then |
|---|---|
| Bad backfill | Restore `team_data/invoice_data_backup_20260803` → `invoice_data` (read-merge-write, never partial PATCH) |
| Invoice sync misbehaves on live | Revert `TARGET_ROW` to `"invoice_data_shadow"` + redeploy, **or** `select cron.unschedule('invoices-sync-window');` |
| Engine auto-publish misbehaves | `select cron.unschedule('engine-run-nightly');` then click Apply in IMS — `toTargets` rebuilds in seconds |
| Everything is wrong and ops is blocked | Manual CSV upload still works exactly as before. It is a full replace — use a **full-window** export, never a 5-day one |

---

## After it's done

**Done on 2026-08-03 (cutover day) — do not redo:**
- ~~`CLAUDE.md`: mark Stage 5 shipped, drop the in-flight block, record `TARGET_ROW`~~ ✅
- ~~Delete `docs/HANDOFF-2026-07-31.md`~~ ✅
- ~~The freshness chip: `invoiceDataThrough` now shows beside `refreshedAt`~~ ✅ (`ec7e8b8`) —
  `Last run: … · demand through …`. Also fixed two stale `autoAtFor` entries and the hardcoded pill
  notes that were suppressing "Auto-sync has missed a night". See CLAUDE.md.

**Still to do, once Step 5 above passes — in this order:**

1. **Delete this file** and the second paragraph of the block at the top of `CLAUDE.md`.
2. Drop the now-frozen `team_data/invoice_data_shadow` row.

Everything else has moved to **`CLAUDE.md` → `## Open Work`** (items 17–24), so deleting this file
loses nothing. There is deliberately no second copy here: the follow-ups outlive the runbook, and two
lists would drift. The one to do first is **17 — nothing tells anyone when a night fails.**
