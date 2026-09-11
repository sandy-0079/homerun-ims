# Verify: Zoho token singleflight (sync-stock v40)

**Deployed** 2026-09-11 10:52 UTC · **Change** `_shared/zohoToken.ts` mint singleflight · **Commit** `e3ecbf5`

Run this the day after the deploy, then again after ~3 days. It answers one question:
**did the daily `Zoho auth failed` 5xx stop, without breaking anything else?**

---

## ⚠ Read this before judging anything

1. **Absence of `joined in-flight mint` is NOT failure.** The fix only engages when a cached
   token dies mid-run. On a day where no token dies, the correct result is: zero mints, zero
   joins, zero 5xx. **Success is the absence of `Zoho auth failed`, not the presence of joins.**
2. **Two different Zoho ceilings look alike and are not.** `Zoho auth failed: "You have made
   too many requests continuously"` is the **token endpoint** (`accounts.zoho.in`) — what we
   fixed. `Zoho API: 429 after 3 attempts` is the **inventorysummary** rate limit — a
   different problem, untouched by this change. Do not report one as the other.
3. **Do NOT trigger manual syncs to "test" this.** Rate-limit recovery takes 60+ min and a
   burst can poison a cron cycle. The hourly crons generate all the evidence needed. The only
   safe manual probe is the cooldown-skip in Check 1 (zero Zoho calls).
4. **Never redeploy `create-to`.** It must stay on **v13**. It runs byte-identical code to
   before this change, which is the entire safety argument — see CLAUDE.md, 2026-07-15.

---

## Baseline — measured 2026-09-11 (the day of the fix)

`function_logs` counts, all functions, UTC. "Before" = 00:00–10:52 (10.9h, pre-deploy).

| Log line | Before deploy | What it means |
|---|---:|---|
| `Zoho auth failed` | **4** | **The failures. Target: 0.** Each one is an HTTP 500 and a lost cron group. |
| `401 — force-refreshing` | **36** | 401s seen. Not itself a fault — the self-heal working. |
| `force-refreshed (after 401)` | **20** | Mints that completed. 36 − 20 = 16 that did not, i.e. the throttled burst. |
| `joined in-flight mint` | **0** | Did not exist before the fix. |
| `cache hit` | 2,203 | Normal traffic volume, for scale. |

Dashboard for the same day: **36 invocations / 5.6% 5xx** over 3h, error `Zoho auth failed …`
count **4** in 24h. The worst single burst (08:38:01 UTC, stock-sync-2) logged
`×20 cache hit`, `×16 401 — force-refreshing`, `×2 Zoho auth failed` → HTTP 500, DS02+DS03
lost that cycle.

---

## Setup — querying the logs

The CLI has **no `functions logs`** subcommand. Use the Management API.

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w | sed 's/^go-keyring-base64://' | base64 -d)
REF=rgyupnrogkbugsadwlye

q() {  # q "<sql>" <iso_start> <iso_end>
  curl -s -G "https://api.supabase.com/v1/projects/$REF/analytics/endpoints/logs.all" \
    --data-urlencode "sql=$1" \
    --data-urlencode "iso_timestamp_start=$2" \
    --data-urlencode "iso_timestamp_end=$3" \
    -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0"
}
```

- **Both** `iso_timestamp_start` and `iso_timestamp_end` are required. Omit the end and you
  get `{"result":[]}` — which looks exactly like "no events". (CLAUDE.md documents only the
  start; this is the correction.)
- **Send a browser `User-Agent`** or Cloudflare answers `403 error code: 1010`.
- Prefer `count(*)` with a `like` filter, so a zero is a real zero rather than a row cap.
- `function_logs` is complete and counts invocations; `function_edge_logs` classifies them
  but **silently drops rows** — never read a missing row there as proof something did not run.

---

## Check 1 — the function is alive and on v40 (zero Zoho calls)

```bash
/opt/homebrew/bin/supabase functions list --project-ref rgyupnrogkbugsadwlye \
  | grep -E "NAME|sync-stock|create-to|sync-orders"
```
**Pass:** `sync-stock` ≥ **40**, `create-to` = **13**, `sync-orders` = **8**.
**Fail:** `create-to` ≠ 13 → someone redeployed it; say so loudly, it invalidates the isolation argument.

Then a free liveness probe — pick a DS synced <15 min ago so it must cooldown-skip:
```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/sync-stock" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"branches":["DS06"]}'
```
**Pass:** `{"ok":true,"skipped":true,"reason":"... cooldown active"}`. Proves it boots and the
new module loads. **Spends no Zoho calls.** Anon key + URL are in `homerun-to/.env`.

## Check 2 — THE headline: did the 5xx stop?

```bash
q "select count(*) as n from function_logs where event_message like '%Zoho auth failed%'" \
  "<yesterday>T00:00:00Z" "<today>T00:00:00Z"
```
**Pass: 0** over a full 24h. Baseline was 4/day.
**Fail: ≥1** → the fix did not hold. Pull the surrounding lines and report the burst shape
(how many `force-refreshing` in that second). If mints are now 1 per burst but Zoho still
throttles, the first 401 has an external cause and the singleflight is not the whole story —
that is a finding, not a regression.

## Check 3 — is the fix engaging, and is the burst collapsed?

```bash
for pat in '%force-refreshing%' '%force-refreshed (after 401)%' '%joined in-flight mint%'; do
  q "select count(*) as n from function_logs where event_message like '$pat'" "<start>" "<end>"
done
```
Read the **ratio**, not the totals. The fix converts N force-refreshes into 1 mint + (N−1) joins.

| Pattern | Healthy after the fix |
|---|---|
| `force-refreshing` : `force-refreshed` | was ~36:20 — should now be many-to-few |
| `joined in-flight mint` | >0 on any day a token died; **0 is fine if `Zoho auth failed` is also 0** |

**Inconclusive** (say so, don't guess): all three are 0 → no token died in the window. Re-run
after more days rather than declaring victory.

## Check 4 — crons still complete all 7 locations

```bash
curl -s "$SUPABASE_URL/rest/v1/team_data?id=eq.global&select=payload->stockUploadedAtPerDS" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
```
Crons fire at **:35 / :38 / :41 / :44 UTC** (= :05/:08/:11/:14 IST) and the timestamp is
stamped at handler **start**, so each lands ~1s after its cron minute.
**Pass:** all 7 present, none older than ~75 min, groups ~3 min apart.
**Fail:** a location stuck an hour+ behind the others → that group is failing.

Also confirm the lock is released: `params/syncLock` should read `lockedAt: null`.

## Check 5 — performance did not regress

```sql
select timestamp, req.url, resp.status_code, m.execution_time_ms from function_edge_logs
cross join unnest(metadata) as m cross join unnest(m.request) as req
cross join unnest(m.response) as resp order by timestamp desc
```
Reference durations for `sync-stock`: **cooldown skip ≈ 1.1–1.2s**; **real 2-branch group
≈ 12–32s** (measured 2026-09-11: DC+DS01, 2,704 SKUs, **31.8s**).
**Pass:** real groups still ≲ 40s, status 200.
**Fail:** durations climbing toward the 150s wall time, or 500/504 appearing.

The singleflight should if anything make this *faster* (1 token mint instead of 16). A
slowdown is unexpected and worth reporting.

---

## Rollback

```bash
cd ~/Documents/GitHub/homerun-ims
git revert e3ecbf5          # or: git checkout e3ecbf5^ -- supabase/functions/_shared/zohoToken.ts
/opt/homebrew/bin/supabase functions deploy sync-stock --project-ref rgyupnrogkbugsadwlye
```
Deploy **`sync-stock` only**. Reverting restores the 2026-07-15 behaviour (self-heal without
the singleflight), i.e. the stampede returns but nothing else changes.

## Report back

State plainly: the 5xx count vs the baseline of 4/day, whether any token died in the window at
all, and any check that was **inconclusive** rather than passing. Do not report "verified" off
a window in which no token died — that proves the fix was never exercised.
