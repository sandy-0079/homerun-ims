import { describe, it, expect, vi, beforeEach } from "vitest";

// `readRow(table, id)` stands in for one PostgREST round trip and returns what
// maybeSingle() resolves to: { data: {payload} | null, error }.
const readRow = vi.fn();
vi.mock("../supabase.js", () => ({
  loadFromSupabase: vi.fn(), // must never be used by hydStore: it hides errors as null
  saveToSupabase: vi.fn(),
  supabase: {
    from: (table) => ({ select: () => ({ eq: (_col, id) => ({ maybeSingle: () => readRow(table, id) }) }) }),
  },
}));

import { loadFromSupabase, saveToSupabase } from "../supabase.js";
import { loadHydState, saveHydFloors, saveHydParams, saveHydPlywood, hydReadFailed } from "./hydStore.js";

// Rows by id: a payload, null (row missing), or { error } (a failed read).
const rows = (byId) => readRow.mockImplementation(async (_t, id) => {
  const v = byId[id];
  if (v && v.__error) return { data: null, error: { message: v.__error } };
  return { data: v == null ? null : { payload: v }, error: null };
});
const ERR = (m) => ({ __error: m });
import { isFloorsOnly } from "./hydParams.js";

const blrParams = { overallPeriod: 45, newDSList: ["DS06"] };
const blrPly = {
  plywoodNetworkConfig: { brands: { Greenply: { nodes: { DS01: { covers: ["DS01"] } }, dcMultMin: 1, dcMultMax: 2 } } },
  networkConfigs: { DS07: { thick: { capacity: 1 }, thin: { capacity: 1 } }, global: { x: 1 } },
};
const ALLOWED = [
  ["team_data", "hyd_inputs"], ["params", "hydGlobal"],
  ["params", "hydPlywoodNetworkConfig"], ["params", "hydNetworkConfigs"],
];
const writtenPairs = () => saveToSupabase.mock.calls.map((c) => [c[0], c[1]]);

beforeEach(() => {
  vi.resetAllMocks();
  saveToSupabase.mockResolvedValue(true);
});

describe("saves", () => {
  it("saveHydFloors writes only team_data/hyd_inputs with floors + uploadedAt", async () => {
    await saveHydFloors({ A: 1 });
    expect(writtenPairs()).toEqual([["team_data", "hyd_inputs"]]);
    const p = saveToSupabase.mock.calls[0][2];
    expect(p.floors).toEqual({ A: 1 });
    expect(Number.isNaN(Date.parse(p.uploadedAt))).toBe(false);
  });
  it("saveHydParams writes only params/hydGlobal", async () => {
    await saveHydParams({ a: 1 });
    expect(writtenPairs()).toEqual([["params", "hydGlobal"]]);
  });
  it("saveHydPlywood writes only its two params rows", async () => {
    await saveHydPlywood({ plywoodNetworkConfig: { p: 1 }, networkConfigs: { n: 1 } });
    expect(writtenPairs()).toEqual([["params", "hydPlywoodNetworkConfig"], ["params", "hydNetworkConfigs"]]);
  });
  it("no save ever writes outside the four Hyderabad rows", async () => {
    await saveHydFloors({}); await saveHydParams({}); await saveHydPlywood({});
    for (const pair of writtenPairs()) expect(ALLOWED).toContainEqual(pair);
  });
  it("returns false if any plywood write fails", async () => {
    saveToSupabase.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await saveHydPlywood({})).toBe(false);
  });
  it("a failed first plywood write stops before the second", async () => {
    saveToSupabase.mockResolvedValueOnce(false);
    expect(await saveHydPlywood({ plywoodNetworkConfig: {}, networkConfigs: {} })).toBe(false);
    expect(writtenPairs()).toEqual([["params", "hydPlywoodNetworkConfig"]]);
  });
});

describe("loadHydState", () => {
  it("all rows missing: floors-only defaults, HYDS01 plywood node, nothing stored", async () => {
    rows({});
    const s = await loadHydState(blrParams, blrPly);
    expect(isFloorsOnly(s.hydParams, "HYDS01")).toBe(true);
    expect(Object.keys(s.hydPlywood.plywoodNetworkConfig.brands.Greenply.nodes)).toEqual(["HYDS01"]);
    expect(s.floors).toEqual({});
    expect(s.stored).toEqual({ params: false, plywood: false });
    expect(s.loadErrors).toEqual([]);
    expect(s.readFailed).toEqual({ inputs: false, params: false, plywood: false });
    expect(hydReadFailed(s)).toBe(false);
    expect(saveToSupabase).not.toHaveBeenCalled();
    expect(loadFromSupabase).not.toHaveBeenCalled();
  });
  it("stored hydGlobal floorsOnly false turns floors-only off", async () => {
    rows({ hydGlobal: { floorsOnly: { HYDS01: false }, copiedFromBangaloreAt: "2026-01-01" } });
    const s = await loadHydState(blrParams, blrPly);
    expect(isFloorsOnly(s.hydParams, "HYDS01")).toBe(false);
    expect(s.hydParams.copiedFromBangaloreAt).toBe("2026-01-01");
    expect(s.stored.params).toBe(true);
  });
  it("uses stored plywood only when both rows exist", async () => {
    const pc = { brands: { Z: {} } }, nc = { HYDS01: { k: 1 } };
    rows({ hydPlywoodNetworkConfig: pc, hydNetworkConfigs: nc });
    const s = await loadHydState(blrParams, blrPly);
    expect(s.hydPlywood).toEqual({ plywoodNetworkConfig: pc, networkConfigs: nc });
    expect(s.stored.plywood).toBe(true);
    rows({ hydNetworkConfigs: nc });
    const s2 = await loadHydState(blrParams, blrPly);
    expect(s2.stored.plywood).toBe(false);
    expect(Object.keys(s2.hydPlywood.plywoodNetworkConfig.brands)).toEqual(["Greenply"]);
  });
  it("reads floors and uploadedAt", async () => {
    rows({ hyd_inputs: { floors: { S: 2 }, uploadedAt: "T" } });
    const s = await loadHydState(blrParams, blrPly);
    expect(s.floors).toEqual({ S: 2 });
    expect(s.floorsUploadedAt).toBe("T");
  });
  it("a thrown read becomes defaults plus loadErrors, never a throw", async () => {
    readRow.mockRejectedValue(new Error("boom"));
    const s = await loadHydState(blrParams, blrPly);
    expect(isFloorsOnly(s.hydParams, "HYDS01")).toBe(true);
    expect(s.floors).toEqual({});
    expect(s.loadErrors.length).toBe(4);
    expect(s.readFailed).toEqual({ inputs: true, params: true, plywood: true });
    expect(hydReadFailed(s)).toBe(true);
  });
  it("a PostgREST error is a failed read, not a missing row", async () => {
    rows({ hydGlobal: ERR("statement timeout"), hyd_inputs: { floors: { S: 2 }, uploadedAt: "T" } });
    const s = await loadHydState(blrParams, blrPly);
    expect(s.loadErrors).toEqual(["params/hydGlobal: statement timeout"]);
    expect(s.readFailed).toEqual({ inputs: false, params: true, plywood: false });
    expect(s.stored.params).toBe(false);
    expect(hydReadFailed(s)).toBe(true);
    expect(s.floors).toEqual({ S: 2 }); // the rows that did read are still used
  });
  it("either plywood row failing marks plywood failed", async () => {
    rows({ hydPlywoodNetworkConfig: { brands: {} }, hydNetworkConfigs: ERR("x") });
    const s = await loadHydState(blrParams, blrPly);
    expect(s.readFailed).toEqual({ inputs: false, params: false, plywood: true });
    expect(s.stored.plywood).toBe(false);
  });
  it("a failed floors read marks inputs failed", async () => {
    rows({ hyd_inputs: ERR("x") });
    const s = await loadHydState(blrParams, blrPly);
    expect(s.readFailed.inputs).toBe(true);
  });
  it("hydReadFailed tolerates states without the flag", () => {
    expect(hydReadFailed(null)).toBe(false);
    expect(hydReadFailed({})).toBe(false);
  });
});
