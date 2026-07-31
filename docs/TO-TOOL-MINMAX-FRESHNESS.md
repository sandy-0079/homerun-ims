# Brief: show "Min/Max computed at …" in the TO tool

**For:** `~/Documents/GitHub/homerun-to` · **written** 2026-07-31 from the IMS side,
which owns the row · **delete once shipped.**

## Goal

One line in the TO tool showing **when the Min/Max it is using were last computed**.
Date + time. Nothing else.

Deliberately **not** showing `inputs.invoiceDataThrough` (how current the underlying
demand data is). Sandy's call, and it is right: the DC team cannot act on stale
invoice data from this tool, so it would be noise. That field stays in the row for
admins.

## The data is already loaded — no new fetch

`params/toTargets.refreshedAt` — ISO 8601 UTC string, e.g. `2026-07-31T10:33:59.027Z`.

The whole row is already in state: `targetsRow` (`src/App.jsx:213`, set at `:324`
from `loadRow("params", "toTargets")`). So this is `targetsRow?.refreshedAt` and a
formatter. No data-layer work.

## ⚠ Four traps

**1. Do NOT use `isFresh()` with its default.** `src/sync.js:35` defaults to
`FRESH_MINS` (15 min), which is correct for STOCK because it matches the sync
cooldown. Min/Max refreshes **once a day at 05:45 IST**, so `isFresh(refreshedAt,
now)` would report stale all day, every day. Either pass a much larger `freshMins`,
or better use a **day-based rule**: stale when `refreshedAt` is not from today IST.
A ~26h threshold also works and tolerates the 06:15 retry slot plus clock skew.

**2. The field is UTC; render in IST.** `10:33Z` is `16:03 IST`. Getting this wrong
makes a fresh row look ~5.5h old.

**3. Tolerate it being absent.** Show `—`, never `undefined` or `Invalid Date`.
Rows written before 2026-07-31 have `refreshedAt` but no `inputs`/`engineCommit`; a
much older row might lack `refreshedAt` too.

**4. Demo mode fakes it.** `src/App.jsx:314` stamps `refreshedAt: new
Date().toISOString()` for `DEMO_DATA`, so demo always reads "just now". Expected —
just don't debug against it.

## Who writes the row, so the expected values make sense

| Writer | When |
|---|---|
| `engine-run-nightly` (pg_cron → Vercel `/api/run-engine`) | **05:45 and 06:15 IST daily**, live from 2026-07-31 |
| A human clicking **Apply & Re-run Model** in IMS | any time |

**So from 2026-08-01 the normal state is "computed 05:45 today".** The signal is
therefore *not* "is it recent" — it will almost always be recent — but **"is it
today?"** If it says yesterday, the nightly engine run failed and
`params/engineRunStatus` will say why.

Before Stage 6 this row only moved when someone clicked Apply, which is exactly the
problem it solved: the DC team could be raising transfers against targets computed
days earlier with no way to tell.

## Suggested treatment

```
Min/Max computed   31 Jul, 05:45      ← normal, today
Min/Max computed   30 Jul, 05:45  ⚠   ← stale: nightly run did not land
Min/Max computed   —                  ← field absent
```

Put it beside the existing stock-freshness display so there is one place people look
for "how current is what I am seeing". Two different clocks — stock is hourly,
Min/Max is daily — so label both rather than merging them.

## Before you start

⚠ **`homerun-to` has one unpushed commit**, `d051dd0` ("docs(CLAUDE): Zoho TO
'number already exist' …", 10 days old, docs-only). Push it first so you are not
committing on an unpushed base.

## Verify against the real row

```bash
curl -sS "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1/params?select=payload->refreshedAt,payload->engineCommit&id=eq.toTargets" \
  -H "apikey: <anon key from CLAUDE.md>"
```

Selecting the sub-keys keeps it small — the full payload is ~693KB.
