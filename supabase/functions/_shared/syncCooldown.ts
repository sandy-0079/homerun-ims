// Server-side minimum interval between fresh sync runs.
//
// WHY THIS EXISTS: on 2026-07-27, repeated manual invocations of sync-invoices
// pushed ~1,900 Zoho calls through the org in fifteen minutes. Throughput
// collapsed from 24 calls/s to under 4, and the 13:41 UTC stock-sync cron missed
// its cycle. `sync-stock` has had a 15-minute cooldown for exactly this reason;
// sync-invoices shipped without one.
//
// A nightly cron making ~1,000 calls once is fine. The same code called four
// times in fifteen minutes is not, and the function should refuse rather than
// rely on whoever is holding the curl command.
//
// ⚠ The cooldown must NOT block cursor drains. sync-invoices processes one date
// per invocation and the resume crons fire 6 and 12 minutes after the first —
// well inside any sane cooldown. Blocking those would strand half the window.

// ─────────────────────────────────────────────────────────────────────────────
// ONCE-PER-NIGHT GATE (added 2026-07-30)
//
// WHY THIS EXISTS: on 2026-07-29 an org-wide Zoho 429 window (17:35-18:30 UTC)
// killed every sync, including `catalogue-sync-nightly`'s single nightly fire.
// The catalogue went 24h stale. `sync-invoices` rode out the SAME event because
// it has twelve slots (eight until 2026-08-04); the catalogue had one.
//
// The fix is more slots — but `COOLDOWN_MS` is 15 minutes, far too short to act
// as a once-per-night gate: five slots 30 minutes apart would mean five full
// catalogue pulls and five writes to `team_data/global`, the row the hourly
// syncs already contend on. So slots need to know a run already SUCCEEDED
// tonight, the same way sync-invoices checks `already_published`.
//
// ⚠ Only a SUCCESS counts. A failed run must leave the gate open or the retry
// slots are pointless — which is the entire reason they exist.

const IST_OFFSET_MS = 5.5 * 3600_000;

/**
 * The key identifying "tonight's run", as an IST-ish `YYYY-MM-DD` string.
 *
 * Today's five catalogue slots run 21:55-23:55 IST and none crosses midnight, so
 * the plain IST calendar date would work. `offsetHours` is insurance, not a
 * correctness requirement — but the insurance is worth one line, because THIS is
 * what a post-midnight slot would do to a plain-date key:
 *   - a success at 23:55 IST stores `2026-07-29`
 *   - a 00:25 IST slot reads `2026-07-30`, doesn't match, and re-pulls
 *   - the NEXT night's 21:55 IST slot also reads `2026-07-30`, matches what that
 *     stray run stored, and SKIPS THE WHOLE NIGHT while reporting ok
 *
 * A silently skipped night that reports success is the exact failure class that
 * cost a morning of log archaeology on 2026-07-30. The schedule has already
 * changed twice in two days; assume it will change again.
 *
 * @param now         epoch ms (UTC)
 * @param offsetHours hours to shift back before taking the IST date, i.e. how far
 *                    past midnight IST a slot still counts as the previous night
 */
export function syncNightKey(now: number, offsetHours = 3): string {
  // Shift into IST, then back by the offset, then take the calendar date. The
  // 3h default covers any slot from 03:00 IST through 02:59 IST the next morning
  // — the whole idle window the nightly syncs live in — so a future 01:00 or
  // 02:00 IST slot still lands on the right night without touching this.
  return new Date(now + IST_OFFSET_MS - offsetHours * 3600_000)
    .toISOString().slice(0, 10);
}

/**
 * Has a run already succeeded for tonight? `force` always wins, so an operator
 * can still re-pull deliberately.
 */
export function alreadyRanTonight(opts: {
  lastOkNight: string | null | undefined;
  now: number;
  force: boolean;
  offsetHours?: number;
}): { skip: boolean; night: string } {
  const night = syncNightKey(opts.now, opts.offsetHours);
  if (opts.force) return { skip: false, night };
  return { skip: opts.lastOkNight === night, night };
}

export function shouldRun(opts: {
  lastRunAt: string | number | null | undefined;
  now: number;
  cooldownMs: number;
  hasPending: boolean;
  force: boolean;
}): { run: boolean; reason: string; waitSec: number } {
  const { lastRunAt, now, cooldownMs, hasPending, force } = opts;

  if (hasPending) return { run: true, reason: "draining_cursor", waitSec: 0 };
  if (force) return { run: true, reason: "forced", waitSec: 0 };

  const last = typeof lastRunAt === "number" ? lastRunAt : Date.parse(String(lastRunAt ?? ""));
  // Unparseable => treat as never run. A future timestamp (clock skew) must not
  // wedge the sync shut, so only a genuinely recent past run counts.
  if (!Number.isFinite(last) || last > now) return { run: true, reason: "no_recent_run", waitSec: 0 };

  const elapsed = now - last;
  if (elapsed >= cooldownMs) return { run: true, reason: "cooldown_elapsed", waitSec: 0 };
  return { run: false, reason: "cooldown", waitSec: Math.ceil((cooldownMs - elapsed) / 1000) };
}
