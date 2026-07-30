import { describe, it, expect } from "vitest";
import { shouldRun, syncNightKey, alreadyRanTonight } from "./syncCooldown.ts";

const MIN = 60_000;
const now = Date.parse("2026-07-27T16:00:00Z");
const base = { now, cooldownMs: 15 * MIN, hasPending: false, force: false };

describe("shouldRun", () => {
  it("runs when nothing has run before", () => {
    expect(shouldRun({ ...base, lastRunAt: null }).run).toBe(true);
  });

  it("runs once the cooldown has elapsed", () => {
    expect(shouldRun({ ...base, lastRunAt: now - 16 * MIN }).run).toBe(true);
  });

  it("blocks a fresh run inside the cooldown", () => {
    // The gap this closes: on 2026-07-27 repeated manual runs put ~1,900 calls
    // through the org in 15 minutes and starved a stock-sync cron of its quota.
    const r = shouldRun({ ...base, lastRunAt: now - 2 * MIN });
    expect(r.run).toBe(false);
    expect(r.reason).toBe("cooldown");
  });

  it("ALWAYS allows draining a pending cursor, cooldown or not", () => {
    // The resume crons fire 6 and 12 minutes after the main one — well inside
    // any sane cooldown. Blocking them would strand half the window unfetched.
    expect(shouldRun({ ...base, lastRunAt: now - 1 * MIN, hasPending: true }).run).toBe(true);
  });

  it("lets an operator force a run past the cooldown", () => {
    expect(shouldRun({ ...base, lastRunAt: now - 1 * MIN, force: true }).run).toBe(true);
  });

  it("reports how long is left, so the caller can say something useful", () => {
    expect(shouldRun({ ...base, lastRunAt: now - 5 * MIN }).waitSec).toBe(600);
  });

  it("treats an unparseable timestamp as no previous run rather than blocking forever", () => {
    expect(shouldRun({ ...base, lastRunAt: "not a date" }).run).toBe(true);
  });

  it("is not fooled by a timestamp in the future", () => {
    // Clock skew must not wedge the sync shut indefinitely.
    expect(shouldRun({ ...base, lastRunAt: now + 60 * MIN }).run).toBe(true);
  });
});

// The five catalogue slots, as UTC instants. 2026-07-29, 21:55 -> 23:55 IST.
// Crons are `25,55 16,17 * * *` (catalogue-sync-earlier) + `25 18 * * *`
// (catalogue-sync-nightly). IST = UTC + 5:30. No slot crosses midnight IST.
const SLOTS = {
  ist2155: Date.parse("2026-07-29T16:25:00Z"),
  ist2225: Date.parse("2026-07-29T16:55:00Z"),
  ist2255: Date.parse("2026-07-29T17:25:00Z"),
  ist2325: Date.parse("2026-07-29T17:55:00Z"),
  ist2355: Date.parse("2026-07-29T18:25:00Z"),
};

// A slot that does NOT exist today. Kept because the schedule has already changed
// twice in two days, and this is the edit that would break the gate silently.
const HYPOTHETICAL_IST_0025 = Date.parse("2026-07-29T18:55:00Z");

describe("syncNightKey", () => {
  it("gives every slot of one night the SAME key", () => {
    const keys = Object.values(SLOTS).map((t) => syncNightKey(t));
    expect(new Set(keys).size).toBe(1);
  });

  it("gives consecutive nights DIFFERENT keys", () => {
    // If it didn't, the second night would read as already-done and skip
    // silently while reporting ok — the failure mode that cost us 2026-07-29.
    const tonight = syncNightKey(SLOTS.ist2155);
    const tomorrow = syncNightKey(SLOTS.ist2155 + 24 * 3600_000);
    expect(tomorrow).not.toBe(tonight);
  });

  it("names the night by its IST evening, not the UTC date", () => {
    expect(syncNightKey(SLOTS.ist2155)).toBe("2026-07-29");
    expect(syncNightKey(SLOTS.ist2355)).toBe("2026-07-29");
  });

  it("rolls over for a run early the next evening", () => {
    expect(syncNightKey(Date.parse("2026-07-30T16:25:00Z"))).toBe("2026-07-30");
  });

  it("would still hold if a post-midnight IST slot were ever added", () => {
    // NOT a slot we run today — this is the guard rail. A plain-IST-date
    // implementation passes every test above and fails only this one, then fails
    // in production as a silently skipped night months later.
    expect(syncNightKey(HYPOTHETICAL_IST_0025)).toBe("2026-07-29");
  });
});

describe("alreadyRanTonight", () => {
  it("skips a slot once tonight has already succeeded", () => {
    const r = alreadyRanTonight({ lastOkNight: "2026-07-29", now: SLOTS.ist2325, force: false });
    expect(r.skip).toBe(true);
    expect(r.night).toBe("2026-07-29");
  });

  it("skips the LAST slot of the night after the first one succeeded", () => {
    // The real saving: four of the five slots must cost one Supabase read and
    // zero Zoho calls, or five pulls a night hit the row the hourly syncs share.
    expect(alreadyRanTonight({ lastOkNight: "2026-07-29", now: SLOTS.ist2355, force: false }).skip).toBe(true);
  });

  it("RUNS when the only recorded success was a previous night", () => {
    expect(alreadyRanTonight({ lastOkNight: "2026-07-28", now: SLOTS.ist2155, force: false }).skip).toBe(false);
  });

  it("RUNS when nothing has ever succeeded", () => {
    expect(alreadyRanTonight({ lastOkNight: null, now: SLOTS.ist2155, force: false }).skip).toBe(false);
    expect(alreadyRanTonight({ lastOkNight: undefined, now: SLOTS.ist2155, force: false }).skip).toBe(false);
  });

  it("RUNS after a FAILED run — a failure must not consume the night", () => {
    // The retry slots exist precisely because 2026-07-29's single fire hit an
    // org-wide 429. If a failure closed the gate they would be decorative.
    // A failure writes `at` but never `lastOkNight`, so the gate stays open.
    expect(alreadyRanTonight({ lastOkNight: "2026-07-28", now: SLOTS.ist2255, force: false }).skip).toBe(false);
  });

  it("lets an operator force a re-pull on a night that already succeeded", () => {
    expect(alreadyRanTonight({ lastOkNight: "2026-07-29", now: SLOTS.ist2325, force: true }).skip).toBe(false);
  });
});
