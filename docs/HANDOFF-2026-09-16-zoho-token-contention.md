# HANDOFF — Zoho token contention: why stock sync keeps losing cycles

**Written** 2026-09-16 · **Status: RCA COMPLETE, root cause CONFIRMED, nothing executed.**
**Blocked on:** answers from the Zoho team + whether IMS can get its own OAuth client.

> **Read this first.** The investigation is finished and the root cause is *confirmed, not
> hypothesised*. Do **not** re-run the RCA. What remains is a decision and a ~15-minute change
> that needs **no code deploy**. Everything below is measured from prod logs unless flagged
> otherwise.
>
> ### 🛑 FIRST ACTION IN A NEW SESSION — ask before doing anything else
>
> **Ask the operator these two questions and wait for the answers:**
>
> 1. **"Do you have the answers back from your Zoho team?"** (the questions are in §5; there is a
>    table there to fill in)
> 2. **"Can IMS get its own Self Client or Server-based Application?"** — ⚠️ **this is the decisive
>    branch.** If **yes** → Option 0, and the whole plan proceeds as written. If **no** → Option 0 is
>    dead and the plan changes materially to Options 1 + 2 (see §5b).
>
> If the operator has neither answer yet, **do not start implementing anything.** The only useful
> work without them is re-measuring the baselines in §8 to see whether the failure rate has moved.

---

## 1. One-paragraph summary

`sync-stock` loses ~3.75 location-group cycles per day to **HTTP 500s from Zoho's OAuth token
endpoint** (`"You have made too many requests continuously"`). The `sync-stock` v40 singleflight
deployed 2026-09-11 (commit `e3ecbf5`) **worked as designed but did not fix the outage** — it cut
mints-per-token-death from 2.62 to 1.31 while the token **death rate stayed flat (32/day → 29/day)**.
Root cause: **multiple of the operator's projects share one Zoho refresh token**, and Zoho's OAuth
limits (10 token requests / 10 min, and 10 active access tokens) are **per refresh token** — so the
sibling projects both *evict our live tokens* and *consume the mint budget before we arrive*.
**The fix is to give IMS its own Zoho OAuth client. That requires no code change — only three
Supabase secrets.**

---

## 2. How we got here

The session began as a verification run of
`docs/runbooks/2026-09-11-zoho-token-singleflight-verification.md` (the day-after check for the v40
deploy), which had never been executed. Mid-session the operator reported *"DS06 keeps failing to
sync more frequently"* and asked for a deep RCA before any fix.

### 2.1 Runbook verification result (5 days of data, not 1)

| Check | Result |
|---|---|
| 1. Versions + liveness | ✅ PASS — `sync-stock` **40**, `create-to` **13**, `sync-orders` **8**; cooldown probe returned `{"ok":true,"skipped":true,...}` (zero Zoho calls) |
| 2. Did the 5xx stop? | ❌ **FAIL** — see table below |
| 3. Is the fix engaging? | ✅ PASS, **definitively — not inconclusive** (tokens died 29× on 09-15 alone, so the fix was heavily exercised) |
| 4. All 7 locations current | ⚠️ intermittent — DS06 was 1h55m stale at first reading, current on re-read |
| 5. Performance | ✅ PASS — medians 27.6–33.0s vs the 31.8s reference; nothing near the 150s wall |

**`Zoho auth failed` per day (all functions, UTC):**

| Window | count |
|---|---|
| 09-11 **pre-deploy** (10.9h) | **4** ← runbook baseline |
| 09-11 post-deploy (13.1h) | 0 |
| 09-12 | 3 |
| 09-13 | 4 |
| 09-14 | 0 |
| 09-15 | **8** |
| 09-16 (to 04:40) | 1 |

Post-deploy full days average **3.75/day** vs ~4.9/day across the three pre-deploy samples.
**Inside the noise. The target was 0.**

⚠️ `Zoho API: 429 after 3 attempts` (the *inventorysummary* limit) was **0 on every day measured**.
Every failure is the **token endpoint**. Do not confuse the two — the runbook warns about this.

### 2.2 What the singleflight did and did not do

| | 09-10 pre-fix (v39) | 09-15 post-fix (v40) |
|---|---|---|
| Token deaths (401 bursts) | 32 | **29** |
| Mints | 84 | 38 |
| Joins | 0 | **43** |
| **Mints per token death** | **2.62** | **1.31** |

Every healthy burst now reads `4 × 401 → 1 MINT_FORCED + 3 JOIN`. **The mechanism works.**
It simply addressed amplification, not the trigger.

---

## 3. Root cause (CONFIRMED)

### 3.1 Two distinct failure paths — they hit opposite ends of the cron cycle

Classified across 09-13, 09-15, 09-16: **6 Path A, 8 Path B.**

| Path | Log signature | Trigger | Who loses the cycle |
|---|---|---|---|
| **A** | bare `AUTHFAIL`, **no `Fetching stock:` line, no 401** | our scheduled hourly re-mint is refused | **:35 + :38 UTC — always as a pair** (DC+DS01, then DS02+DS03) |
| **B** | `Fetching stock:` → 401s → `AUTHFAIL` | a live token was **revoked early** | mostly **:44 UTC / DS06** |

Path A occurrences (all three identical): 09-13 06:35+06:38, 09-13 07:35+07:38, 09-16 05:35+05:38.
**Exactly two groups lost, recovery at :41. Never DS04/DS05, never DS06.**

**Why the split happens.** The mint sits on the critical path of a stock sync (`sync-stock/index.ts`,
`await getZohoToken(supabase)` — the token warm-up, *before* the `Fetching stock:` log line). So:
- **Natural hourly expiry** → the first caller after the cache goes stale is always **:35** → it eats
  the refusal, and :38 three minutes later eats it too. DS06 is *immune* to this path.
- **Early revocation of a live token** → whoever next touches Zoho. Since :35 mints fresh and
  :38/:41 validate it, the group left to discover a late revocation is usually **:44 / DS06**,
  which is then healed by `sync-orders` at :50.

⚠️ **DS06 is NOT uniquely cursed.** It is the sole victim of Path B and immune to Path A. An earlier
reading in this session over-generalised "DS06 is structurally the victim" from a Path-B-dominated
sample. The operator's own observation (a cycle where DC+DS01 and DS02+DS03 failed while DS04+DS05
and DS06 succeeded) is textbook **Path A**.

### 3.2 The actual root cause

**Zoho's documented OAuth limits — verified against official docs:**

| Limit | Value | Scope |
|---|---|---|
| Access-token requests | **10 per 10 minutes** (rolling) | **per refresh token** |
| Active access tokens | **10** — the 11th mint **invalidates the oldest** | **per refresh token** |
| Refresh tokens | 20 | per client, per user |

Exceeding the first returns *verbatim* our error:
`"You have made too many requests continuously. Please try again after some time."`

**The operator confirmed (2026-09-16): multiple of their projects use the same Zoho credentials —
i.e. the same refresh token.** Therefore both budgets are **shared across all those projects**:

- **Path B explained** — a sibling project mints; once 10 tokens are active Zoho invalidates the
  oldest, which is often ours. That is exactly "our token died 9 minutes after we minted it, with no
  mint of ours in between."
- **Path A explained** — siblings consume the 10-per-10-minutes budget before our hourly mint
  arrives, so ours is refused.

**This closes the long-standing CLAUDE.md question.** The 2026-09-11 entry guessed *"we were our own
other consumer."* **We were not** — the other consumers are the operator's other projects.

### 3.3 Two anomalies that this model explains and the earlier one could not

An intermediate hypothesis in this session was "Zoho refuses mints that come too soon after a
previous mint (~9 min bad, ~15 min fine)". **Discard it.** It failed on two measured cases:
- a refusal after a **44.9-minute** gap
- **four mints at a 0.0-second gap that all succeeded** (`sync-invoices` at 20:25 on 09-15)

Both are explained by the rolling shared window: the budget was consumed — or free — because of
*other projects'* requests, which are invisible in our logs. **"Time since our last mint" was never
the governing variable.** Likewise the "3–6 minute lockout" figure quoted mid-session was an
artifact of three samples; the real mechanism is a rolling 10-minute budget we do not control.

---

## 4. Options, with recommendation

### ⭐ Option 0 — give IMS its own Zoho OAuth client  *(RECOMMENDED — do this alone, first)*
- Register a new client for IMS; generate its own refresh token
- Update three Supabase secrets: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- **No code change. No function deploy. `create-to` stays v13** — Supabase secrets are runtime env
  vars, not bundled at deploy time
- IMS then owns a private budget: **~1 mint/hour against 10 per 10 min**, and **1–2 active tokens
  against a cap of 10**
- Eliminates **both** Path A and Path B at the root

### Option 1 — per-group retry cron slots  *(defence-in-depth; likely unnecessary after Option 0)*
Adds four slots; **does not change any existing timing**. Each is 10–13 min after its primary, so the
15-minute cooldown makes it a **~1.1s no-op with zero Zoho calls** on a healthy hour.

| New job | UTC | IST | Branches | Gap after primary |
|---|---|---|---|---|
| retry-1 | :45 | :15 | DC + DS01 | 10 min |
| retry-2 | :48 | :18 | DS02 + DS03 | 10 min |
| retry-3 | :54 | :24 | DS04 + DS05 | 13 min |
| retry-4 | :57 | :27 | DS06 | 13 min |

⚠️ The gap must stay **under 15 min** or the cooldown won't skip and we'd double the real sync load.
⚠️ **Do not use :51 UTC / :21 IST** (an earlier draft did). `sync-orders` runs at :50 UTC, writes the
same `team_data/global` row, and **does not take `syncLock`** (verified by grep). That is the
unprotected concurrent-writer shape that left DC+DS01 74 min stale in July. The :48 UTC slot has only
a ~2-minute margin ahead of it — decide deliberately; alternatives are giving `sync-orders` the lock,
or raising `COOLDOWN_MINS` (both become function deploys).

### Option 2 — token-warmer cron before :35
Refresh the cache off the sync path. Kills Path A only. Largely redundant after Option 0.

### Option 4 — singleflight `sync-invoices` (v6)
It still stampedes — **4 mints in one millisecond**, measured 20:25 on 09-15. That is 40% of a
10-per-10-min budget in one burst. After Option 0 it is the one thing that could still eat *our own*
budget. Low urgency, needs a deploy of a nightly-critical function.

### Option 5 — reorder the manual pull so DS06 isn't last
`homerun-to/src/sync.js`, `PULL_GROUPS`. Only moves which location absorbs the failure. Cosmetic.

### Option 6 — raise `per_page` on inventorysummary
Unrelated to tokens, but an independent **~4× request reduction** (~14 pages/branch → ~3). Blocked on
whether Zoho allows >200. Already an open item in CLAUDE.md.

### Ruled out by measurement — do not revisit without new data
- **Retry inside the invocation** — the budget is a rolling 10-minute window consumed by other
  projects; a retry within the 150s wall clock cannot reliably outlast it.
- **A single all-branch sweep cron** — the cooldown skip is all-or-nothing, so it would re-sync all
  7 branches (~180 requests, ~4.5 min) and blow the 150s wall.
- **A DS06-only retry slot** — too narrow. Would not have prevented the Path A failures at all.

---

## 5. Open questions for the Zoho team — **fill this in before implementing**

Paste answers into the right-hand column as they arrive. `—` means still outstanding.

| # | Question | Answer |
|---|---|---|
| **Q1** | **Can IMS have its own OAuth client?** ⚠️ *decisive — see §5b* | — |
| Q2 | How many of our projects share these credentials today? | — |
| Q3 | **Do any of them mint a token per invocation instead of caching?** At 10 requests / 10 min, one uncached caller burns the whole budget alone — very likely the main antagonist. | — |
| Q4 | Is there a cap on how many client applications we can register in the API Console? *(Not publicly documented — checked.)* | — |
| Q5 | Is **Self Client** limited to one per account? *(One unconfirmed community report says yes.)* | — |
| Q6 | Does each registered client get its own API **concurrency** budget, or is concurrency pooled org-wide? | — |
| Q7 | Does `inventorysummary` accept `per_page` above 200? What is the max? | — |
| Q8 | What is the per-org request limit, and does the token endpoint count against the same budget? | — |

### 5b. What each answer changes — act on this, don't re-derive it

| Answer | Effect on the plan |
|---|---|
| **Q1 = YES** (IMS gets its own client) | ✅ **Proceed with Option 0 exactly as written in §7.** Nothing else changes. This is the expected path. |
| **Q1 = NO** (blocked, or Q4 says the cap is exhausted) | 🔄 **Option 0 is dead — the plan changes materially.** Fall back to **Option 1 (per-group retry slots) + Option 2 (token warmer)** as the best available mitigation, and escalate **Q3**: if a sibling project is minting per-invocation, fixing *that* project becomes the highest-value action available to us. Expect to live with residual failures — without isolation we cannot control a budget we share. |
| **Q3 = YES**, some project mints per-invocation | Names the antagonist. Doesn't change Option 0 for IMS, but the sibling projects will keep colliding *with each other* until it's fixed — worth telling those owners. If Q1 = NO, this becomes the primary fix. |
| **Q5 = YES**, Self Client capped at 1 | Register IMS as a **Server-based Application** instead (throwaway redirect URI). No plan change — runtime behaviour is identical. |
| **Q6 = per-client concurrency** | Bonus: isolation also relieves the ~100 req/min ceiling our 4 concurrent chains sit against. No plan change. |
| **Q6 = org-wide concurrency** | Isolation fixes tokens only, not request concurrency. Raises the value of **Q7 / Option 6**. |
| **Q7 = `per_page` > 200 allowed** | **Option 6 jumps in priority** — ~14 pages/branch → ~3, cutting ~4,400 requests/day to ~1,100. Independent of the token fix; do it either way. |
| **Q2 = many projects** | Sizes the contention and argues for isolating *every* project eventually, not just IMS. Doesn't change the IMS fix. |
| **Q8** | Informational. Feeds the CLAUDE.md rate-limit section (already corrected once on 2026-09-11 — the "8/min" figure was ~13× off because it counted fetch chains, not HTTP requests). |

---

## 6. Self Client vs Server-based Application — for the registration decision

Both yield the **same three values our code reads**; `refreshFromZoho` cannot tell them apart. The
difference is only in how the initial grant code is obtained.

| | Self Client | Server-based Application |
|---|---|---|
| Built for | Backend jobs on **your own** Zoho data, no user interaction | Web apps where **end users** grant access to their data |
| Redirect URI | **Not needed** | **Required** (a throwaway like `https://localhost` is fine) |
| Consent screen | None | One-time browser round-trip |
| Grant code | Generated with a click in the API Console | Returned to the redirect URI after consent |
| Multiple instances | Possibly capped at 1/account (unconfirmed) | Register as many as you like |

**Path:** try a second **Self Client** first (correct semantics for IMS — headless crons, own org).
If the console refuses, register a **Server-based Application**; it behaves identically at runtime.

### ⚠️⚠️ TRAP — pick the right grant type
Self Client offers two grants:
- **Authorization Code** → issues a **refresh token**. ✅ **This is the one we need.**
- **Client Credentials** → issues **no refresh token**; Zoho's docs say you must request a new access
  token every time. Against 10 requests/10 min that would be **catastrophically worse than today**.

Also confirm at setup: scope **`ZohoInventory.fullaccess.all`**, org **`60075214606`**. The grant code
is short-lived (minutes) — exchange it promptly.

---

## 7. Execution checklist for Option 0 (when approved)

> **Precondition: Q1 in §5 must be answered YES.** If IMS cannot have its own OAuth client, stop —
> this checklist does not apply and the plan branches to Options 1 + 2 per §5b.

1. Register the new client in the Zoho API Console (see §6; authorization-code grant, correct scope/org).
2. Exchange the grant code for a **refresh token**; keep it out of shell history and transcripts.
3. **Dry-run before the crons hit it.** `sync-catalogue` is the safe prover — every write sits behind
   `if (!dryRun)` and `lastOkNight` is only set on a successful live write, so
   `{"dryRun": true}` is free and non-mutating. It is also the only way to prove a deploy/secret
   actually *runs* (the unit tests run under vitest/esbuild, not Deno).
4. Set the three secrets:
   `supabase secrets set ZOHO_CLIENT_ID=… ZOHO_CLIENT_SECRET=… ZOHO_REFRESH_TOKEN=… --project-ref rgyupnrogkbugsadwlye`
5. **Clear the `zoho_auth_cache` row** (`id = 'zoho'`) so the first call mints cleanly under the new
   client. The old cached access token stays valid until expiry, so this is hygiene, not a breakage risk.
6. Watch one full cron cycle (:35/:38/:41/:44 UTC) and confirm `cache hit` lines plus a clean
   `sync-stock complete` for all four groups.
7. Measure for 3–4 days against the baselines in §2 before deciding on Option 1.

**Rollback:** set the three secrets back to the old values and clear the cache row again. No deploy
is involved in either direction, so rollback is seconds.

---

## 8. How to re-measure (read-only)

Logs are reachable via the Management API; the CLI has no `functions logs`.

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w | sed 's/^go-keyring-base64://' | base64 -d)
REF=rgyupnrogkbugsadwlye
curl -s -G "https://api.supabase.com/v1/projects/$REF/analytics/endpoints/logs.all" \
  --data-urlencode "sql=$SQL" \
  --data-urlencode "iso_timestamp_start=2026-09-16T00:00:00Z" \
  --data-urlencode "iso_timestamp_end=2026-09-17T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0"
```

**Gotchas learned the hard way this session:**
- **Both** `iso_timestamp_start` and `iso_timestamp_end` are required.
- Send a browser `User-Agent` or Cloudflare returns `403 error code: 1010`.
- **The endpoint throttles.** Pace queries ~20s apart or you get
  `{"message":"ThrottlerException: Too Many Requests"}`.
- ⚠️ **A multi-day window silently under-reports.** A 5-day `count(*)` returned 25/branch when the
  true figure was ~97/day. **Always query day-by-day and sum.**
- `cross join unnest(metadata)` on a large unaggregated result returns a backend error — aggregate,
  or drop the unnest.
- Use one `countif(...)` query per day to get all patterns at once (12 patterns, 1 query).

**Useful discriminator:** `Fetching stock:` is logged *after* the token warm-up, so
**AUTHFAIL with no preceding `Fetching stock:` line = Path A; with one plus 401s = Path B.**

Per-DS freshness (anon key + URL are in `homerun-to/.env`):
```bash
curl -s "$URL/rest/v1/team_data?id=eq.global&select=payload->stockUploadedAtPerDS" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

---

## 9. Guardrails — carry these into the next session

- **Never redeploy `create-to`. It must stay v13.** Running byte-identical code is the entire
  isolation argument for the 2026-09-11 change.
- **Never run `supabase functions deploy` without naming a function** — a bare deploy redeploys all
  seven with whatever `_shared/*` is on disk.
- **Do not trigger manual syncs to "test"** — rate-limit recovery takes 60+ min and can poison a cron
  cycle. The only safe probe is the cooldown-skip (pick a DS synced <15 min ago; it returns
  `{"ok":true,"skipped":true}` and spends zero Zoho calls).
- Manual pulls from the TO tool are **normal traffic** since 2026-09-11 (commit `33d55f0`,
  17:25 IST). Off-schedule invocations, off-cron stock timestamps, and bursts of six invocations
  (sessionStart + 4 groups + sessionEnd, two sub-second with zero Zoho calls) are **expected**.
  Compare failure rows, not volume rows.

---

## 10. CLAUDE.md corrections pending (NOT yet applied)

Deliberately left unwritten so the operator can review first. All three are in the
**Zoho OAuth token-endpoint throttle** section:

1. **The claim that the singleflight "likely also answers why tokens die before expiry — we were our
   own other consumer" is REFUTED.** Token deaths held at ~30/day while our mints fell 84 → 38. The
   other consumers are the operator's other projects sharing the refresh token.
2. **The fix did not stop the daily 500s.** It removed a 4× amplification (2.62 → 1.31 mints per
   death) — real and worth having, but the outage persists at ~3.75/day.
3. **New knowledge to record:** Zoho's limits are **10 token requests / 10 min** and **10 active
   access tokens, per refresh token**, with the 11th mint evicting the oldest — and both are
   **shared by every project using that refresh token.** This is the governing constraint for the
   whole Zoho integration, not just stock sync.

Also worth adding: the analytics-API measurement gotchas in §8, especially that a multi-day window
silently truncates counts.

---

## 11. Reference

- Runbook: `docs/runbooks/2026-09-11-zoho-token-singleflight-verification.md`
- Code: `supabase/functions/_shared/zohoToken.ts` (singleflight, `mintOnce`),
  `_shared/zohoClient.ts` (401/429 retry), `sync-stock/index.ts` (cooldown, lock, warm-up, fan-out)
- Commit under verification: `e3ecbf5` — *"singleflight the Zoho token mint"*
- Zoho token limits: <https://www.zoho.com/accounts/protocol/oauth/token-limits.html>
- Self Client overview: <https://www.zoho.com/accounts/protocol/oauth/self-client/overview.html>
- Client types: <https://help.zoho.com/portal/en/community/topic/kaizen-116-client-types-in-zoho-developer-console>
