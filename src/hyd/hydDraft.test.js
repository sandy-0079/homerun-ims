import { describe, it, expect, vi } from "vitest";
import { hydDraftValue, isHydDraftDirty, guardHydDraft, hydOnlyChangelog, HYD_DISCARD_PROMPT, isAnyHydDraftDirty } from "./hydDraft.js";

const base = { overallPeriod: 45, floorsOnly: { HYDS01: true }, orderCycleDays: 3 };

describe("hydDraftValue / isHydDraftDirty", () => {
  it("no draft → the saved params, clean", () => {
    expect(hydDraftValue(null, base)).toBe(base);
    expect(isHydDraftDirty(null, base)).toBe(false);
  });
  it("a draft started from these params → its value; dirty only when it differs", () => {
    expect(hydDraftValue({ base, value: { ...base, overallPeriod: 60 } }, base).overallPeriod).toBe(60);
    expect(isHydDraftDirty({ base, value: { ...base, overallPeriod: 60 } }, base)).toBe(true);
    expect(isHydDraftDirty({ base, value: { ...base } }, base)).toBe(false);
  });
  it("a draft from an older hydParams object (e.g. after Apply) is discarded", () => {
    const old = { ...base };
    expect(hydDraftValue({ base: old, value: { ...old, overallPeriod: 60 } }, base)).toBe(base);
    expect(isHydDraftDirty({ base: old, value: { ...old, overallPeriod: 60 } }, base)).toBe(false);
  });
  it("tolerates null params (failed load)", () => {
    expect(isHydDraftDirty(null, null)).toBe(false);
  });
});

describe("guardHydDraft — unsaved Hyderabad draft on tab / city switch", () => {
  it("clean: no prompt, allowed, nothing discarded", () => {
    const confirm = vi.fn(), discard = vi.fn();
    expect(guardHydDraft({ dirty: false, confirm, discard })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
  it("dirty + Cancel: stays put, draft kept", () => {
    const confirm = vi.fn(() => false), discard = vi.fn();
    expect(guardHydDraft({ dirty: true, confirm, discard })).toBe(false);
    expect(confirm).toHaveBeenCalledWith("You have unsaved Hyderabad settings. Discard them?");
    expect(discard).not.toHaveBeenCalled();
  });
  it("dirty + OK: allowed, draft discarded", () => {
    const confirm = vi.fn(() => true), discard = vi.fn();
    expect(guardHydDraft({ dirty: true, confirm, discard })).toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
  });
  it("prompt text is the brief's", () => {
    expect(HYD_DISCARD_PROMPT).toBe("You have unsaved Hyderabad settings. Discard them?");
  });
});

describe("hydOnlyChangelog — Hyderabad-only keys Bangalore's changelog does not know", () => {
  it("none when unchanged", () => expect(hydOnlyChangelog(base, { ...base })).toEqual([]));
  it("the switch, the order cycle and a reset", () => {
    const next = { ...base, floorsOnly: { HYDS01: false }, orderCycleDays: 5, copiedFromBangaloreAt: "2026-11-10T10:00:00Z" };
    const out = hydOnlyChangelog({ ...base, copiedFromBangaloreAt: "2026-11-01T10:00:00Z" }, next);
    expect(out).toContain("Pati: Floors only → Engine");
    expect(out).toContain("Order cycle: 3D → 5D");
    expect(out.some(l => l.startsWith("Re-copied from Bangalore"))).toBe(true);
    expect(hydOnlyChangelog(next, base)).toContain("Pati: Engine → Floors only");
  });
  it("missing floorsOnly reads as floors only (fail-safe)", () => {
    expect(hydOnlyChangelog({}, { floorsOnly: { HYDS01: true } })).toEqual([]);
  });
});

describe("isAnyHydDraftDirty (Logic Tweaker draft OR Plywood draft)", () => {
  const plywood = { plywoodNetworkConfig: { brands: {} }, networkConfigs: { HYDS01: { thick: { capacity: 10 } } } };
  const hydState = { hydParams: base, hydPlywood: plywood };
  it("clean when neither draft differs", () => {
    expect(isAnyHydDraftDirty({ hydDraft: null, hydPlywoodDraft: null, hydState })).toBe(false);
    expect(isAnyHydDraftDirty({ hydDraft: { base, value: { ...base } }, hydPlywoodDraft: { base: plywood, value: { ...plywood } }, hydState })).toBe(false);
  });
  it("dirty when only the Logic Tweaker draft differs", () => {
    expect(isAnyHydDraftDirty({ hydDraft: { base, value: { ...base, overallPeriod: 60 } }, hydPlywoodDraft: null, hydState })).toBe(true);
  });
  it("dirty when only the Plywood draft differs", () => {
    const value = { ...plywood, networkConfigs: { HYDS01: { thick: { capacity: 20 } } } };
    expect(isAnyHydDraftDirty({ hydDraft: null, hydPlywoodDraft: { base: plywood, value }, hydState })).toBe(true);
  });
  it("a plywood draft from an older hydPlywood (after a save) is not dirty", () => {
    const old = { ...plywood };
    expect(isAnyHydDraftDirty({ hydDraft: null, hydPlywoodDraft: { base: old, value: { ...old, x: 1 } }, hydState })).toBe(false);
  });
  it("no hydState → clean", () => {
    expect(isAnyHydDraftDirty({ hydDraft: null, hydPlywoodDraft: null, hydState: null })).toBe(false);
  });
});
