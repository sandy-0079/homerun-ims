import { describe, it, expect } from "vitest";
import { resolveBranches, EXPLICIT_ONLY } from "./stockBranches.ts";

const BRANCHES: Record<string, string> = {
  DC: "1", DS01: "2", DS02: "3", DS03: "4", DS04: "5", DS05: "6", DS06: "7", DS07: "8", DS08: "9",
  HYDS01: "10",
};
const TODAY = ["DC", "DS01", "DS02", "DS03", "DS04", "DS05", "DS06", "DS07", "DS08"];

describe("resolveBranches", () => {
  it("empty body gives exactly today's 9 keys, never HYDS01", () => {
    expect(resolveBranches([], BRANCHES, EXPLICIT_ONLY)).toEqual(TODAY);
    expect(resolveBranches(undefined, BRANCHES, EXPLICIT_ONLY)).toEqual(TODAY);
    expect(resolveBranches("DS01", BRANCHES, EXPLICIT_ONLY)).toEqual(TODAY);
  });
  it("[DS08, HYDS01] returns both", () => {
    expect(resolveBranches(["DS08", "HYDS01"], BRANCHES, EXPLICIT_ONLY)).toEqual(["DS08", "HYDS01"]);
  });
  it("[HYDS01] returns [HYDS01]", () => {
    expect(resolveBranches(["HYDS01"], BRANCHES, EXPLICIT_ONLY)).toEqual(["HYDS01"]);
  });
  it("unknown names are dropped", () => {
    expect(resolveBranches(["XX"], BRANCHES, EXPLICIT_ONLY)).toEqual([]);
    expect(resolveBranches(["DS01", "XX"], BRANCHES, EXPLICIT_ONLY)).toEqual(["DS01"]);
  });
  it("EXPLICIT_ONLY is exactly HYDS01", () => {
    expect([...EXPLICIT_ONLY]).toEqual(["HYDS01"]);
  });
});
