import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../supabase.js", () => ({ saveToSupabase: vi.fn(async () => true), supabase: {}, loadFromSupabase: vi.fn() }));
import { saveToSupabase } from "../supabase.js";
import { applyHydParams } from "./hydApply.js";
import { NOT_SAVED_BEFORE } from "../tabs/hyd/hydStyles.js";

const draft = { overallPeriod: 60, floorsOnly: { HYDS01: false }, orderCycleDays: 3 };
const stateWith = (over = {}) => ({ hydParams: { overallPeriod: 45 }, stored: { params: true, plywood: true }, readFailed: {}, floors: {}, ...over });

beforeEach(() => { saveToSupabase.mockClear(); saveToSupabase.mockImplementation(async () => true); });

describe("applyHydParams — Hyderabad Apply writes only params/hydGlobal", () => {
  it("saves the draft to params/hydGlobal and nothing else, then updates hydState", async () => {
    const setHydState = vi.fn(), confirm = vi.fn(() => true);
    const st = stateWith();
    const res = await applyHydParams({ draft, hydState: st, setHydState, confirm });
    expect(saveToSupabase).toHaveBeenCalledTimes(1);
    expect(saveToSupabase.mock.calls.map(c => `${c[0]}/${c[1]}`)).toEqual(["params/hydGlobal"]);
    expect(saveToSupabase.mock.calls[0][2]).toBe(draft);
    expect(confirm).not.toHaveBeenCalled(); // stored before: no NOT_SAVED_BEFORE prompt
    const next = setHydState.mock.calls[0][0](st);
    expect(next.hydParams).toBe(draft);
    expect(next.stored).toEqual({ params: true, plywood: true });
    expect(next.floors).toBe(st.floors);
    expect(res.kind).toBe("info");
  });
  it("first save asks with the NOT_SAVED_BEFORE text; Cancel writes nothing", async () => {
    const setHydState = vi.fn(), confirm = vi.fn(() => false);
    const res = await applyHydParams({ draft, hydState: stateWith({ stored: { params: false } }), setHydState, confirm });
    expect(confirm).toHaveBeenCalledWith(NOT_SAVED_BEFORE);
    expect(saveToSupabase).not.toHaveBeenCalled();
    expect(setHydState).not.toHaveBeenCalled();
    expect(res).toBe(null);
  });
  it("first save confirmed writes params/hydGlobal and marks it stored", async () => {
    const setHydState = vi.fn();
    await applyHydParams({ draft, hydState: stateWith({ stored: { params: false } }), setHydState, confirm: () => true });
    expect(saveToSupabase.mock.calls.map(c => `${c[0]}/${c[1]}`)).toEqual(["params/hydGlobal"]);
    expect(setHydState.mock.calls[0][0](stateWith({ stored: { params: false } })).stored.params).toBe(true);
  });
  it("after a failed Hyderabad read: refuses, writes nothing", async () => {
    const setHydState = vi.fn();
    const res = await applyHydParams({ draft, hydState: stateWith({ readFailed: { params: true } }), setHydState, confirm: () => true });
    expect(saveToSupabase).not.toHaveBeenCalled();
    expect(setHydState).not.toHaveBeenCalled();
    expect(res.kind).toBe("error");
  });
  it("a failed write leaves hydState alone and says so", async () => {
    saveToSupabase.mockImplementation(async () => false);
    const setHydState = vi.fn();
    const res = await applyHydParams({ draft, hydState: stateWith(), setHydState, confirm: () => true });
    expect(setHydState).not.toHaveBeenCalled();
    expect(res).toEqual({ kind: "error", text: "Save failed — Hyderabad settings were NOT changed." });
  });
});
