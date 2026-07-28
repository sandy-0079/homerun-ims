import { describe, it, expect } from "vitest";
import { shouldRun } from "./syncCooldown.ts";

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
