import { describe, it, expect } from "vitest";
import {
  TO_LINE_CAP, splitParts, partReason, linesFingerprint, findCreatedParts, stampSnapshotParts,
} from "./toSplit.ts";

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("splitParts", () => {
  it("leaves a TO at or under the cap as ONE part — today's path, unchanged", () => {
    expect(splitParts(seq(1), 800)).toEqual([[0]]);
    expect(splitParts(seq(800), 800).map((p) => p.length)).toEqual([800]);
  });
  it("splits the 2026-09-30 DS07 TO into two equal halves", () => {
    expect(splitParts(seq(1258), 800).map((p) => p.length)).toEqual([629, 629]);
  });
  it("one line over the cap gives two near-equal parts, not 800 + 1", () => {
    expect(splitParts(seq(801), 800).map((p) => p.length)).toEqual([401, 400]);
  });
  it("three parts when needed, sizes within one of each other, larger first", () => {
    expect(splitParts(seq(1601), 800).map((p) => p.length)).toEqual([534, 534, 533]);
  });
  it("never produces a part over the cap", () => {
    for (const n of [799, 800, 801, 1599, 1600, 1601, 2400, 2401, 5000]) {
      for (const p of splitParts(seq(n), 800)) expect(p.length).toBeLessThanOrEqual(800);
    }
  });
  it("keeps the caller's order — contiguous slices of the pick path, nothing reordered or lost", () => {
    const parts = splitParts(seq(1258), 800);
    expect(parts.flat()).toEqual(seq(1258));
    expect(parts[1][0]).toBe(629);
  });
  it("empty in, empty out", () => expect(splitParts([], 800)).toEqual([]));
  it("defaults to the proven cap", () => expect(TO_LINE_CAP).toBe(800));
});

describe("partReason", () => {
  it("adds k/n only when split", () => {
    expect(partReason("Internal Transfer", 1, 2)).toBe("Internal Transfer 1/2");
    expect(partReason("Internal Transfer - TEST TO", 2, 2)).toBe("Internal Transfer - TEST TO 2/2");
  });
  it("a single TO keeps exactly today's reason — no 1/1", () => {
    expect(partReason("Internal Transfer", 1, 1)).toBe("Internal Transfer");
  });
});

describe("linesFingerprint", () => {
  const a = [{ sku: "A", qty: 1 }, { sku: "B", qty: 2 }];
  it("is stable for the same lines", () => expect(linesFingerprint(a)).toBe(linesFingerprint([...a])));
  it("changes with a quantity", () =>
    expect(linesFingerprint(a)).not.toBe(linesFingerprint([{ sku: "A", qty: 1 }, { sku: "B", qty: 3 }])));
  it("changes with order — parts are cut by position", () =>
    expect(linesFingerprint(a)).not.toBe(linesFingerprint([a[1], a[0]])));
  it("ignores SKU whitespace, same as create-to's trim", () =>
    expect(linesFingerprint([{ sku: " A ", qty: 1 }, { sku: "B", qty: 2 }])).toBe(linesFingerprint(a)));
});

describe("findCreatedParts", () => {
  const entry = (o: Record<string, unknown>) => ({
    requestId: "r1", linesHash: "h", parts: 2, part: 1,
    transfer_order_id: "id1", transfer_order_number: "TO-1", lineCount: 629, units: 900, ...o,
  });
  it("finds parts this request already created", () => {
    const { created, mismatch } = findCreatedParts([entry({})], "r1", "h", 2);
    expect(mismatch).toBe(false);
    expect(created.get(1)?.transfer_order_number).toBe("TO-1");
    expect(created.has(2)).toBe(false);
  });
  it("ignores other requests and pre-split entries (no requestId)", () => {
    const { created } = findCreatedParts(
      [entry({ requestId: "other" }), { transfer_order_number: "TO-0", toDsId: "DS07" }], "r1", "h", 2);
    expect(created.size).toBe(0);
  });
  it("flags a resume whose lines changed — never stitch old and new parts together", () => {
    const { created, mismatch } = findCreatedParts([entry({ linesHash: "OLD" })], "r1", "h", 2);
    expect(mismatch).toBe(true);
    expect(created.size).toBe(0);
  });
  it("flags a resume whose part count changed", () => {
    expect(findCreatedParts([entry({ parts: 3 })], "r1", "h", 2).mismatch).toBe(true);
  });
  it("no requestId (an older client) means nothing to resume", () => {
    expect(findCreatedParts([entry({})], undefined, "h", 2).created.size).toBe(0);
  });
  it("survives a malformed audit row", () => {
    expect(findCreatedParts(null, "r1", "h", 2).created.size).toBe(0);
    expect(findCreatedParts([null, 5, entry({ part: 9 })], "r1", "h", 2).created.size).toBe(0);
  });
  it("newest entry wins if a part were somehow recorded twice (entries are newest-first)", () => {
    const { created } = findCreatedParts(
      [entry({ transfer_order_number: "TO-NEW" }), entry({ transfer_order_number: "TO-OLD" })], "r1", "h", 2);
    expect(created.get(1)?.transfer_order_number).toBe("TO-NEW");
  });
});

describe("stampSnapshotParts", () => {
  const snap = { ds: "DS07", skus: [{ sku: "A", actual: 3 }, { sku: "B", actual: 2 }, { sku: "C", actual: 0 }] };
  it("a single TO's snapshot is returned untouched", () => {
    expect(stampSnapshotParts(snap, new Map([["A", 1]]), ["TO-1"])).toBe(snap);
  });
  it("stamps the part per sent SKU and every TO number", () => {
    const out = stampSnapshotParts(snap, new Map([["A", 1], ["B", 2]]), ["TO-1", "TO-2"]);
    expect(out.transfer_order_numbers).toEqual(["TO-1", "TO-2"]);
    expect(out.skus.map((r: any) => r.toPart)).toEqual([1, 2, undefined]);
    expect(snap.skus[0]).not.toHaveProperty("toPart"); // input not mutated
  });
  it("tolerates a legacy snapshot without skus", () => {
    const out = stampSnapshotParts({ ds: "DS07" }, new Map(), ["TO-1", "TO-2"]);
    expect(out.transfer_order_numbers).toEqual(["TO-1", "TO-2"]);
  });
});
