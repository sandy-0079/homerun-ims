import { describe, it, expect } from "vitest";
import { planNightDates, sliceToFetch, advance, type DateProgress } from "./invoiceCursor.ts";

const at = (iso: string) => Date.parse(iso);
const progress = (over: Partial<DateProgress> = {}): DateProgress => ({
  date: "2026-07-29",
  ids: ["a", "b", "c", "d", "e"],
  total: 5,
  offset: 0,
  retryIds: [],
  round: 0,
  ...over,
});

describe("planNightDates", () => {
  // The overnight window runs 19:05-22:20 UTC, i.e. 00:35-03:50 IST the next IST
  // day. The settled day is therefore "yesterday IST".
  it("pulls yesterday IST", () => {
    expect(planNightDates(at("2026-07-29T19:20:00Z"), 3)[0]).toBe("2026-07-29");
  });

  // An invoice counted as `sent` can be voided the next day, leaving us over-counted.
  // A FIXED lag re-fetches every day exactly once, which is uniform coverage without
  // needing a rotation: day D is pulled fresh on D+1 and rechecked on D+4.
  it("also re-fetches the day N days back, to catch late voids", () => {
    expect(planNightDates(at("2026-07-29T19:20:00Z"), 3)).toEqual(["2026-07-29", "2026-07-26"]);
  });

  it("gives every slot in the overnight window the same plan", () => {
    expect(planNightDates(at("2026-07-29T22:20:00Z"), 3))
      .toEqual(planNightDates(at("2026-07-29T19:05:00Z"), 3));
  });

  it("puts the fresh day first so it lands even if the night is cut short", () => {
    // Ordering is load-bearing: yesterday's data is what the model needs tonight,
    // the void recheck is a correction that can safely wait a day.
    expect(planNightDates(at("2026-07-29T19:20:00Z"), 3)[0]).toBe("2026-07-29");
  });

  it("omits the recheck when the lag is zero", () => {
    expect(planNightDates(at("2026-07-29T19:20:00Z"), 0)).toEqual(["2026-07-29"]);
  });
});

describe("sliceToFetch", () => {
  it("takes the first chunk at offset zero", () => {
    expect(sliceToFetch(progress(), 2)).toEqual(["a", "b"]);
  });

  it("takes only what remains near the end", () => {
    expect(sliceToFetch(progress({ offset: 4 }), 2)).toEqual(["e"]);
  });

  it("returns nothing once the list is consumed", () => {
    expect(sliceToFetch(progress({ offset: 5 }), 2)).toEqual([]);
  });
});

describe("advance", () => {
  it("moves the offset forward and reports more work when ids remain", () => {
    const r = advance(progress(), 2, [], 3);
    expect(r.status).toBe("more");
    expect(r.progress.offset).toBe(2);
  });

  it("reports complete when every id was fetched and none failed", () => {
    const r = advance(progress({ offset: 3 }), 2, [], 3);
    expect(r.status).toBe("complete");
  });

  // 429 exhaustion is the real failure mode: 15 of 564 detail calls on 2026-07-28.
  // Those rows were silently lost while the run reported ok:true.
  it("remembers failed ids instead of losing them", () => {
    const r = advance(progress(), 2, ["a"], 3);
    expect(r.progress.retryIds).toEqual(["a"]);
    expect(r.status).toBe("more");
  });

  it("starts a retry round for the failures once the first pass ends", () => {
    const r = advance(progress({ offset: 3, retryIds: ["a"] }), 2, ["e"], 3);
    expect(r.status).toBe("more");
    expect(r.progress).toMatchObject({ ids: ["a", "e"], offset: 0, retryIds: [], round: 1 });
  });

  it("reports complete when a retry round clears the failures", () => {
    const r = advance(progress({ ids: ["a"], offset: 0, round: 1 }), 1, [], 3);
    expect(r.status).toBe("complete");
  });

  it("reports exhausted rather than looping forever on a persistent failure", () => {
    // Without this the nightly window would retry the same dead id in all 8 slots.
    const r = advance(progress({ ids: ["a"], offset: 0, round: 3 }), 1, ["a"], 3);
    expect(r.status).toBe("exhausted");
  });

  it("carries the date's total invoice count into a retry round", () => {
    // A retry round replaces `ids` with just the failures, so anything measuring loss
    // against ids.length would see "1 of 3 lost = 33%" for what is really 1 of 564.
    // The caller's tolerance check depends on this being the day's total, not the round's.
    const r = advance(progress({ ids: ["a"], total: 564, offset: 0, retryIds: ["b"] }), 1, ["a"], 3);
    expect(r.progress.total).toBe(564);
  });

  it("never reports complete while failures are outstanding", () => {
    // The whole point: a date with lost rows must not be treated as pulled, because
    // the atomic swap would then publish a short day as if it were whole.
    const r = advance(progress({ offset: 4 }), 2, ["e"], 3);
    expect(r.status).not.toBe("complete");
  });
});
