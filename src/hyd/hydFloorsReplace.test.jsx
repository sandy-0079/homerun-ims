import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../supabase.js", () => ({ saveToSupabase: vi.fn(async () => true), supabase: {}, loadFromSupabase: vi.fn() }));
import { saveToSupabase } from "../supabase.js";
import { prepareHydFloors, replaceHydFloors, inRangeCount } from "./hydFloorsReplace.js";
import { Refusal } from "../tabs/hyd/HydFloorsCard.jsx";

const floors = { A: { HYDS01: { min: 2, max: 5 } }, B: {} };
const stateWith = (over = {}) => ({ floors: {}, floorsUploadedAt: null, hydParams: { overallPeriod: 45 }, stored: { params: true }, readFailed: {}, ...over });
const handlers = () => ({ setHydState: vi.fn(), setSaving: vi.fn(), setStatus: vi.fn() });

beforeEach(() => { saveToSupabase.mockReset(); saveToSupabase.mockImplementation(async () => true); });

describe("replaceHydFloors — the confirmed Replace HYDERABAD floors", () => {
  it("saves the parsed floors to team_data/hyd_inputs only, then updates hydState", async () => {
    const h = handlers();
    const st = stateWith();
    expect(await replaceHydFloors({ floors, hydState: st, ...h })).toBe(true);
    expect(saveToSupabase.mock.calls.map(c => `${c[0]}/${c[1]}`)).toEqual(["team_data/hyd_inputs"]);
    expect(saveToSupabase.mock.calls[0][2].floors).toBe(floors);
    const next = h.setHydState.mock.calls[0][0](st);
    expect(next.floors).toBe(floors);
    expect(next.floorsUploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(next.hydParams).toBe(st.hydParams);
    expect(h.setStatus).toHaveBeenCalledWith({ kind: "info", text: "Hyderabad floors replaced: 1 SKUs in range." });
    expect(h.setSaving.mock.calls).toEqual([[true], [false]]);
  });

  it("a false save shows the error and leaves hydState alone", async () => {
    saveToSupabase.mockImplementation(async () => false);
    const h = handlers();
    expect(await replaceHydFloors({ floors, hydState: stateWith(), ...h })).toBe(false);
    expect(h.setHydState).not.toHaveBeenCalled();
    expect(h.setStatus).toHaveBeenCalledWith({ kind: "error", text: "Save failed — Hyderabad floors were NOT changed." });
    expect(h.setSaving.mock.calls).toEqual([[true], [false]]);
  });

  it("a THROWN save shows the error, leaves hydState alone and releases saving", async () => {
    saveToSupabase.mockRejectedValue(new Error("fetch failed"));
    const h = handlers();
    await expect(replaceHydFloors({ floors, hydState: stateWith(), ...h })).resolves.toBe(false);
    expect(h.setHydState).not.toHaveBeenCalled();
    expect(h.setStatus).toHaveBeenCalledWith({ kind: "error", text: "Save failed — Hyderabad floors were NOT changed." });
    expect(h.setSaving.mock.calls).toEqual([[true], [false]]);
  });

  it("after a failed Hyderabad read: writes nothing, changes nothing", async () => {
    const h = handlers();
    expect(await replaceHydFloors({ floors, hydState: stateWith({ readFailed: { inputs: true } }), ...h })).toBe(false);
    expect(saveToSupabase).not.toHaveBeenCalled();
    expect(h.setHydState).not.toHaveBeenCalled();
    expect(h.setSaving).not.toHaveBeenCalled();
  });
});

describe("prepareHydFloors — the file pick writes nothing", () => {
  const ctx = { invoiceData: [], skuMaster: { A: { name: "Alpha" }, B: { name: "Beta" } }, priceData: {}, deadStock: new Set(), hydState: stateWith() };

  it("a good file is parsed and dry-run, nothing written", () => {
    const { parsed, dry } = prepareHydFloors("SKU,Item Name,HYDS01 Min,HYDS01 Max\nA,x,2,5\nB,y,,", ctx);
    expect(parsed.ok).toBe(true);
    expect(parsed.floors.A.HYDS01).toEqual({ min: 2, max: 5 });
    expect(inRangeCount(parsed.floors)).toBe(1);
    expect(dry).not.toBeNull();
    expect(saveToSupabase).not.toHaveBeenCalled();
  });

  it("a refused file (Bangalore columns): no dry run, no write; the refusal shows reason + columns", () => {
    const { parsed, dry } = prepareHydFloors("SKU,DS01 Min,DC Max,HYDS01 Min,HYDS01 Max\nA,1,1,3,4", ctx);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("foreign_columns");
    expect(dry).toBeNull();
    expect(saveToSupabase).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(<Refusal parsed={parsed} />);
    expect(html).toContain("Refused — nothing was written.");
    expect(html).toContain("This file has Bangalore or DC columns.");
    expect(html).toContain("<b>DS01 Min, DC Max</b>");
  });

  it("a refused file (bad values) lists the offending cells", () => {
    const { parsed } = prepareHydFloors("SKU,HYDS01 Min,HYDS01 Max\nA,1.5,4", ctx);
    expect(parsed.reason).toBe("invalid_value");
    const html = renderToStaticMarkup(<Refusal parsed={parsed} />);
    expect(html).toContain("Some cells are not whole numbers.");
    expect(html).toContain("<code>A</code>");
    expect(saveToSupabase).not.toHaveBeenCalled();
  });
});
