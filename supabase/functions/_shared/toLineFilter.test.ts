import { describe, it, expect } from "vitest";
import { partitionInactive, skipSetGrew, isTransferable } from "./toLineFilter.ts";

describe("isTransferable", () => {
  it("accepts active", () => expect(isTransferable("active")).toBe(true));
  it("is case-insensitive — the CSV path writes Active, Zoho writes active", () => {
    expect(isTransferable("Active")).toBe(true);
  });
  it("rejects inactive", () => expect(isTransferable("inactive")).toBe(false));
  it("rejects confirmation_pending — the allowlist is exactly 'active'", () => {
    // Zoho's vocabulary grows (confirmation_pending appeared after the first
    // integration). Anything but active is refused rather than guessed at.
    expect(isTransferable("confirmation_pending")).toBe(false);
  });
  it("rejects a missing status outright", () => {
    expect(isTransferable(undefined)).toBe(false);
    expect(isTransferable("")).toBe(false);
  });
});

describe("partitionInactive", () => {
  const map = {
    GOOD: { name: "Good Thing", status: "active" },
    DEAD: { name: "LOCTITE General Purpose Sealant, White", status: "inactive" },
    PEND: { name: "Pending Thing", status: "confirmation_pending" },
    OLD: { name: "Cached Before Status Existed" },   // no status key at all
  };

  it("sends active SKUs", () => {
    expect(partitionInactive(["GOOD"], map).send).toEqual(["GOOD"]);
  });

  it("skips an inactive SKU and reports its Zoho NAME — the error only ever names that", () => {
    const r = partitionInactive(["GOOD", "DEAD"], map);
    expect(r.send).toEqual(["GOOD"]);
    expect(r.skipped).toEqual([
      { sku: "DEAD", name: "LOCTITE General Purpose Sealant, White", status: "inactive" },
    ]);
  });

  it("catches ALL inactive SKUs in one pass — Zoho names only one per 400", () => {
    // The reason this beats parsing the error: four bad SKUs would otherwise cost
    // four sequential create attempts.
    const many = { ...map, D2: { name: "Two", status: "inactive" }, D3: { name: "Three", status: "inactive" } };
    const r = partitionInactive(["GOOD", "DEAD", "D2", "D3"], many);
    expect(r.send).toEqual(["GOOD"]);
    expect(r.skipped.map((s) => s.sku)).toEqual(["DEAD", "D2", "D3"]);
  });

  it("skips confirmation_pending too", () => {
    expect(partitionInactive(["PEND"], map).skipped.map((s) => s.sku)).toEqual(["PEND"]);
  });

  it("⚠ FAILS OPEN on a missing status — sends it, and says so", () => {
    // An item map cached before `status` existed must behave exactly like today:
    // send the line, let Zoho decide. Failing closed here would silently drop a
    // good line on no evidence, which is worse than the bug being fixed.
    const r = partitionInactive(["OLD"], map);
    expect(r.send).toEqual(["OLD"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual(["OLD"]);
  });

  it("⚠ leaves a SKU absent from the map ALONE — badSkus owns that, and refuses", () => {
    // Two owners for one fact is how the Stock Health filter and the TO deep link
    // both drifted. This function must not have an opinion on unresolvable SKUs.
    const r = partitionInactive(["NOPE"], map);
    expect(r.send).toEqual(["NOPE"]);
    expect(r.skipped).toEqual([]);
    expect(r.unknown).toEqual(["NOPE"]);
  });

  it("preserves the caller's order, so lines can be filtered positionally", () => {
    const r = partitionInactive(["GOOD", "DEAD", "OLD"], map);
    expect(r.send).toEqual(["GOOD", "OLD"]);
  });

  it("handles an empty request without throwing", () => {
    expect(partitionInactive([], map)).toEqual({ send: [], skipped: [], unknown: [] });
  });

  it("survives a null map — a cold cache must not crash the TO path", () => {
    expect(partitionInactive(["A"], null as any).send).toEqual(["A"]);
  });
});

describe("skipSetGrew — the retry condition", () => {
  const s = (sku: string) => ({ sku, name: sku, status: "inactive" });

  it("true when a re-check found something new", () => {
    expect(skipSetGrew([], [s("DEAD")])).toBe(true);
  });

  it("⚠ FALSE when the fresh data agrees — so a numbering or location 400 never retries", () => {
    // The retry must be self-limiting WITHOUT parsing Zoho's English error. A 400
    // about anything other than an inactive item produces no new skips, so the
    // original error is surfaced untouched and no extra write is attempted.
    expect(skipSetGrew([s("DEAD")], [s("DEAD")])).toBe(false);
    expect(skipSetGrew([], [])).toBe(false);
  });

  it("true when the set grew on top of an existing skip", () => {
    expect(skipSetGrew([s("DEAD")], [s("DEAD"), s("D2")])).toBe(true);
  });

  it("false when the set SHRANK — a reactivation is not a reason to retry", () => {
    expect(skipSetGrew([s("DEAD"), s("D2")], [s("DEAD")])).toBe(false);
  });

  it("tolerates null on either side", () => {
    expect(skipSetGrew(null as any, null as any)).toBe(false);
  });
});
