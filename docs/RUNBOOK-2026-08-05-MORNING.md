# RUNBOOK — Wednesday 2026-08-05 morning check

**Temporary. Delete this file and its pointer in `CLAUDE.md` once the checks pass.**

Two things run unattended for the first time tonight. Neither has ever been proven.

1. **`nightly-digest`** — deployed and hand-invoked yesterday, but its **cron has never fired**.
2. **The invoice window on 12 slots** — widened from 8 yesterday (migration `20260804000002`).

> ⚠ **HOW TO READ THE EXPECTED VALUES BELOW.** The Stage 5 runbook asked for the chip to read
> `05:45` when the correct steady-state value was `06:15` — because it derived the expectation from
> the *schedule* rather than from *what actually writes last*. It nearly caused a healthy system to
> be reported as broken. So here: every number states its derivation, ranges are used wherever
> volume moves it, and checks are marked **CONFIRM** (we know the answer, prove it) or **DISCOVER**
> (nobody knows, find out). **If a value disagrees, suspect this document before suspecting prod.**

---

## The one-glance check

**An email should be in the inbox by ~06:35 IST.**

```
Subject: [IMS] ✅ nightly — demand through 2026-08-04
```

⚠ **Silence is the alarm.** No email by 06:40 means the digest cron did not fire or the send failed
— that property is the whole reason it is a heartbeat rather than an alert. Check spam first (the
Gmail impersonation banner is expected and accepted; see CLAUDE.md item 17).

Expected body differences from yesterday's hand-sent copy:

- `demand through 2026-08-04`
- **A new line:** `Inv Value (Max) ₹X.XXCr   — first reading, no prior day to compare`
  **CONFIRM.** Tonight's engine run is the first to stamp `invValue`, and `params/digestHistory` is
  empty, so the delta is legitimately absent. **A delta tomorrow (08-06), not today.**

---

## 11–13 · The invoice window on 12 slots

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w | sed 's/^go-keyring-base64://' | base64 -d)
Q() { printf '{"query":"%s"}' "$1" > /tmp/q.json; curl -sS -X POST \
  "https://api.supabase.com/v1/projects/rgyupnrogkbugsadwlye/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0" \
  -d @/tmp/q.json; }

Q "select to_char(d.start_time at time zone 'Asia/Kolkata','HH24:MI') as ist, d.status from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='invoices-sync-window' and d.start_time > now() - interval '14 hours' order by d.start_time;"
```

| # | check | expected | kind |
|---|---|---|---|
| 11 | firings | **12**: 00:35 00:45 00:55 · 01:35 01:45 01:55 · 02:35 02:45 02:55 · 03:35 03:45 03:55 | CONFIRM |
| 11b | invocations in `function_edge_logs` vs firings | **12 = 12** | **DISCOVER** |
| 12 | publish time | **earlier than 02:50** (yesterday's). ~01:55 if volume matches | **DISCOVER** |
| 13 | 429s | **zero** | CONFIRM |

**11b is real new information.** On the night of 08-03 the cron fired 8 times but only **7**
invocations appeared in the edge logs — `01:35` was missing. The arithmetic only closes if it ran,
so it is probably a logging artefact, but it has never been confirmed. Twelve firings is a second
sample.

**12 is the actual point of the change.** Do not check for `01:55` exactly — check that it is
**earlier than 02:50**. Tonight pulls **08-04 (Tue) + 08-01 (Sat)**; a lighter Saturday shifts the
time without meaning anything is wrong.

```bash
# invocation timings — each working chunk should be ~16-21s, late slots ~0.7s no-ops
URL="https://api.supabase.com/v1/projects/rgyupnrogkbugsadwlye/analytics/endpoints/logs.all"
SQL="select timestamp, m.execution_time_ms, resp.status_code from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.request) as req cross join unnest(m.response) as resp where req.url like '%sync-invoices%' order by timestamp asc limit 100"
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$SQL")
curl -sS "$URL?sql=$ENC&iso_timestamp_start=2026-08-04T19:00:00Z&iso_timestamp_end=2026-08-05T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0 (Macintosh) Chrome/126.0"
```

⚠ **If 429s appear, the gap reduction is the suspect and rollback is one statement:**

```sql
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'invoices-sync-window'),
  schedule := '5,20 19-22 * * *');
```

The command is never touched by `alter_job`; `md5(command)` must stay `894e3d026f14f156401e492f31b04110`.

---

## 14–15 · The chain itself

```bash
B=https://rgyupnrogkbugsadwlye.supabase.co/rest/v1
K=<anon key from CLAUDE.md>
for r in invoiceSyncStatus engineRunStatus catalogueSyncStatus skuFloorSyncStatus digestStatus; do
  echo "== $r"; curl -sS "$B/params?select=payload&id=eq.$r" -H "apikey: $K" | python3 -m json.tool
done
```

| # | check | expected | derivation |
|---|---|---|---|
| 14 | `digestStatus` | `ok:true · level:"green" · sent:"<…mailin.fr>" · recorded:**true**` | `recorded` flips true today — first night with `invValue` to store |
| 14b | `toTargets.inputs.invoiceDataThrough` | `2026-08-04` | the point of the whole chain |
| 14c | `toTargets.invValue` | present, `{min,max}` | first stamped by tonight's run |
| 15 | `invoiceSyncStatus.merge` | `datesTrimmed: **1**` · `datesReplaced: 1` · `datesAfter: 90` | row sits at 90; +08-04 = 91; retention trims 1 |
| 15b | live row range | **`05-07 → 08-04`**, 90 dates | 05-06 is the date trimmed |
| 15c | live row rows | **~78,200 ± 400** | 77,642 − 646 (05-06) + 08-04's rows, ± the 08-01 recheck |

⚠ **The trim of `05-06` is expected and permanent.** It is pre-July, so the Zoho API cannot re-serve
it. **One pre-July date will now be lost every night** until the retention window starts after
2026-07-01 — around **28 Sep 2026** at 90-day retention. This is by design, not a fault, and
`team_data/invoice_data_backup_20260803` is the last copy of the earliest ones.

Derive 15b/15c from the rows themselves rather than trusting `merge.*`:

```bash
curl -sS "$B/team_data?select=payload&id=eq.invoice_data" -H "apikey: $K" | python3 -c "
import sys,json
rows=json.load(sys.stdin)[0]['payload']['invoiceData']
d={}
for r in rows: d[r['date']]=d.get(r['date'],0)+1
k=sorted(d)
print(f'{len(rows):,} rows · {len(k)} dates · {k[0]} -> {k[-1]}')
print('last 3:', [(x,d[x]) for x in k[-3:]])"
```

---

## Do NOT, whatever the checks say

- **Do not re-run the engine mid-day.** POs are raised ~07:30 off the morning's numbers; a mid-day
  `toTargets` rewrite puts the afternoon's 14:30/20:30 TOs on a different demand basis.
- **Do not upload an invoice CSV.** It replaces entirely, and the Zoho export locale still emits
  `DD/MM/YYYY` so the date guard refuses it anyway (Open Work 19).
- **Do not redeploy `sync-invoices`.** Its source header changed yesterday but only a comment; the
  deployed bundle is version 6 and should stay there.

## If a check fails

`invoiceSyncStatus.reason` and `digestStatus` say why. Min/Max being one day stale is **amber, not
red** — the D-3 recheck heals a single missed night, and nothing is unrecoverable until lag 5. See
CLAUDE.md item 17 for the full threshold table.

## When it passes

1. Delete this file and the 🚧 pointer at the top of `CLAUDE.md`.
2. Record in CLAUDE.md: the measured publish time, whether 12 firings produced 12 invocations, and
   the answer to the 01:35 logging-gap question.
3. Open Work 25 (the D-3 waste) is the next thing, and its phase 1 is measurement, not code.
