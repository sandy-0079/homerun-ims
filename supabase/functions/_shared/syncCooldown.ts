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
