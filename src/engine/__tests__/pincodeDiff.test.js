// diffPincodeMap — the review gate on a replace-entirely write.
//
// `params/pincodeMap` is replaced wholesale on Apply, exactly like the invoice CSV.
// A short sheet raises no error: the pincodes it omits stop being mapped, their
// demand falls back to whichever store invoices it, and every donor silently
// re-inflates. The distinction this has to get right is MOVED vs REMOVED — a remap
// moves pincodes between stores, so anything removed is a row that went missing.

import { describe, it, expect } from "vitest";
import { diffPincodeMap, describePincodeDiff } from "../attribution.js";

const before = { 560001: "DS01", 560002: "DS01", 560003: "DS02", 560004: "DS02" };

describe("diffPincodeMap", () => {
  it("classifies a go-live remap as moves, not as adds and removes", () => {
    // The Monday shape: a catchment changes hands and the total is unchanged.
    const d = diffPincodeMap(before, { ...before, 560002: "DS07", 560003: "DS07" });
    expect(d.moved).toEqual([
      { pin: "560002", from: "DS01", to: "DS07" },
      { pin: "560003", from: "DS02", to: "DS07" },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.beforeCount).toBe(4);
    expect(d.afterCount).toBe(4);
  });

  it("nets per store, so a gain with no matching loss is visible", () => {
    const d = diffPincodeMap(before, { ...before, 560002: "DS07" });
    expect(d.net.DS07).toEqual({ gained: 1, lost: 0 });
    expect(d.net.DS01).toEqual({ gained: 0, lost: 1 });
  });

  it("⚠ flags a pincode that VANISHED rather than moved", () => {
    // The failure this exists for: a short upload. No error, no conflict, no clue —
    // 560004's demand just silently reverts to the fulfilling store.
    const { 560004: _gone, ...short } = before;
    const d = diffPincodeMap(before, short);
    expect(d.removed).toEqual([{ pin: "560004", from: "DS02" }]);
    expect(d.afterCount).toBeLessThan(d.beforeCount);
  });

  it("treats a first-ever upload as all-added, never as a mass removal", () => {
    const d = diffPincodeMap({}, before);
    expect(d.removed).toEqual([]);
    expect(d.added).toHaveLength(4);
    expect(d.beforeCount).toBe(0);
  });

  it("reports an unchanged re-upload as entirely inert", () => {
    const d = diffPincodeMap(before, { ...before });
    expect([d.moved.length, d.added.length, d.removed.length]).toEqual([0, 0, 0]);
  });

  it("handles null/undefined on either side without throwing", () => {
    expect(diffPincodeMap(null, undefined).afterCount).toBe(0);
    expect(diffPincodeMap(undefined, before).added).toHaveLength(4);
  });
});

describe("describePincodeDiff", () => {
  it("leads with the count change, which is the number that decides", () => {
    const text = describePincodeDiff(diffPincodeMap(before, { ...before, 560002: "DS07" }));
    expect(text).toContain("4 → 4 pincodes");
    expect(text).toContain("1 moved · 0 added · 0 removed");
    expect(text).toContain("DS07 +1");
    expect(text).toContain("DS01 -1");
  });
});
