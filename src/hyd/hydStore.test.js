import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../supabase.js", () => ({
  loadFromSupabase: vi.fn(),
  saveToSupabase: vi.fn(),
}));

import { loadFromSupabase, saveToSupabase } from "../supabase.js";
import { loadHydState, saveHydFloors, saveHydParams, saveHydPlywood } from "./hydStore.js";
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
});

describe("loadHydState", () => {
  it("all rows missing: floors-only defaults, HYDS01 plywood node, nothing stored", async () => {
    loadFromSupabase.mockResolvedValue(null);
    const s = await loadHydState(blrParams, blrPly);
    expect(isFloorsOnly(s.hydParams, "HYDS01")).toBe(true);
    expect(Object.keys(s.hydPlywood.plywoodNetworkConfig.brands.Greenply.nodes)).toEqual(["HYDS01"]);
    expect(s.floors).toEqual({});
    expect(s.stored).toEqual({ params: false, plywood: false });
    expect(s.loadErrors).toEqual([]);
    expect(saveToSupabase).not.toHaveBeenCalled();
  });
  it("stored hydGlobal floorsOnly false turns floors-only off", async () => {
    loadFromSupabase.mockImplementation(async (t, id) =>
      id === "hydGlobal" ? { floorsOnly: { HYDS01: false }, copiedFromBangaloreAt: "2026-01-01" } : null);
    const s = await loadHydState(blrParams, blrPly);
    expect(isFloorsOnly(s.hydParams, "HYDS01")).toBe(false);
    expect(s.hydParams.copiedFromBangaloreAt).toBe("2026-01-01");
    expect(s.stored.params).toBe(true);
  });
  it("uses stored plywood only when both rows exist", async () => {
    const pc = { brands: { Z: {} } }, nc = { HYDS01: { k: 1 } };
    loadFromSupabase.mockImplementation(async (t, id) =>
      id === "hydPlywoodNetworkConfig" ? pc : id === "hydNetworkConfigs" ? nc : null);
    const s = await loadHydState(blrParams, blrPly);
    expect(s.hydPlywood).toEqual({ plywoodNetworkConfig: pc, networkConfigs: nc });
    expect(s.stored.plywood).toBe(true);
    loadFromSupabase.mockImplementation(async (t, id) => (id === "hydNetworkConfigs" ? nc : null));
    const s2 = await loadHydState(blrParams, blrPly);
    expect(s2.stored.plywood).toBe(false);
    expect(Object.keys(s2.hydPlywood.plywoodNetworkConfig.brands)).toEqual(["Greenply"]);
  });
  it("reads floors and uploadedAt", async () => {
    loadFromSupabase.mockImplementation(async (t, id) =>
      id === "hyd_inputs" ? { floors: { S: 2 }, uploadedAt: "T" } : null);
    const s = await loadHydState(blrParams, blrPly);
    expect(s.floors).toEqual({ S: 2 });
    expect(s.floorsUploadedAt).toBe("T");
  });
  it("a thrown read becomes defaults plus loadErrors, never a throw", async () => {
    loadFromSupabase.mockRejectedValue(new Error("boom"));
    const s = await loadHydState(blrParams, blrPly);
    expect(isFloorsOnly(s.hydParams, "HYDS01")).toBe(true);
    expect(s.floors).toEqual({});
    expect(s.loadErrors.length).toBe(4);
  });
});
