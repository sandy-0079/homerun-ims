import { describe, it, expect } from "vitest";
import { keepRecentDays } from "./snapshotRetention.ts";

const e = (ds: string, extra: Record<string, unknown>) => ({ ds, ...extra });

describe("keepRecentDays", () => {
  it("keeps every snapshot of the N most recent days, in their original order", () => {
    const entries = [
      e("DS01", { day: "2026-11-05", group: "bags" }),
      e("DS02", { day: "2026-11-05", group: "ply" }),
      e("DS01", { day: "2026-11-04", group: "all" }),
      e("DS01", { day: "2026-11-03", group: "bin" }),
    ];
    expect(keepRecentDays(entries, 2).map((x: any) => x.day)).toEqual(["2026-11-05", "2026-11-05", "2026-11-04"]);
  });
  it("counts older Afternoon/Evening snapshots by `date`, on the same calendar", () => {
    const entries = [
      e("DS01", { day: "2026-11-05", group: "bags" }),
      e("DS01", { date: "2026-11-04", window: "Evening" }),
      e("DS02", { date: "2026-11-04", window: "Afternoon" }),
      e("DS01", { date: "2026-11-03", window: "Evening" }),
    ];
    expect(keepRecentDays(entries, 2)).toHaveLength(3);
  });
  it("24 snapshots a day still keeps all 7 days (a count of 48 would keep 2)", () => {
    const entries = [];
    for (let d = 9; d >= 1; d--) for (let i = 0; i < 24; i++) entries.push(e(`DS0${i % 8}`, { day: `2026-11-0${d}` }));
    const kept = keepRecentDays(entries, 7);
    expect(new Set(kept.map((x: any) => x.day)).size).toBe(7);
    expect(kept).toHaveLength(168);
  });
  it("drops entries with no day at all, and honours the hard cap", () => {
    expect(keepRecentDays([e("DS01", {}), e("DS01", { date: "2026-11-01" })], 7)).toHaveLength(1);
    const many = Array.from({ length: 10 }, () => e("DS01", { day: "2026-11-05" }));
    expect(keepRecentDays(many, 7, 4)).toHaveLength(4);
  });
});
