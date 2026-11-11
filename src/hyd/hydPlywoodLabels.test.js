import { describe, it, expect } from "vitest";
import {
  HYD_PLYWOOD_HIDDEN_PARAMS, HYD_PLYWOOD_PARAM_LABELS, isHiddenPlywoodParam,
  humaniseParamPath, hydPlywoodParamRows,
} from "./hydPlywoodLabels.js";
import { PLYWOOD_NETWORK_CONFIG_DEFAULT } from "../engine/constants.js";

const CAMEL = /[a-z][A-Z]/;

describe("hidden DC-only params", () => {
  it("hides dcCapacity and everything under it", () => {
    expect(HYD_PLYWOOD_HIDDEN_PARAMS).toContain("dcCapacity");
    expect(isHiddenPlywoodParam("dcCapacity")).toBe(true);
    expect(isHiddenPlywoodParam("dcCapacity.thick")).toBe(true);
    expect(isHiddenPlywoodParam("dcCapacity.thin")).toBe(true);
    expect(isHiddenPlywoodParam("dcCapacityX")).toBe(false);
    expect(isHiddenPlywoodParam("maxCap")).toBe(false);
  });
  it("brands is never a param row (edited as checkboxes)", () => {
    const paths = hydPlywoodParamRows(PLYWOOD_NETWORK_CONFIG_DEFAULT).map(r => r.path);
    expect(paths.some(p => p === "brands" || p.startsWith("brands."))).toBe(false);
  });
  it("hidden keys are not rendered but stay in the config", () => {
    const cfg = { ...PLYWOOD_NETWORK_CONFIG_DEFAULT };
    const paths = hydPlywoodParamRows(cfg).map(r => r.path);
    expect(paths).not.toContain("dcCapacity.thick");
    expect(paths).not.toContain("dcCapacity.thin");
    expect(cfg.dcCapacity).toEqual({ thick: 400, thin: 400 });
  });
});

describe("Bangalore labels", () => {
  it("every default global param is shown with Bangalore's label, in Bangalore's order", () => {
    const rows = hydPlywoodParamRows(PLYWOOD_NETWORK_CONFIG_DEFAULT);
    expect(rows.map(r => r.path)).toEqual(HYD_PLYWOOD_PARAM_LABELS.map(l => l.key));
    expect(rows[0]).toMatchObject({ path: "lookbackDays", label: "History Window", value: 90, kind: "number" });
    expect(rows.find(r => r.path === "maxCap").label).toBe("Max Sheets per Location");
    expect(rows.find(r => r.path === "thickBoundaryMm").hint).toMatch(/Thick/);
  });
  it("a param Bangalore does not label gets a readable fallback, after the labelled ones", () => {
    const rows = hydPlywoodParamRows({ maxCap: 20, zetaFactor: 1, nested: { someKnob: 2 } });
    expect(rows.map(r => r.path)).toEqual(["maxCap", "nested.someKnob", "zetaFactor"]);
    expect(rows[1].label).toBe("Nested — some knob");
    expect(rows[2].label).toBe("Zeta factor");
  });
  it("humanises camelCase", () => {
    expect(humaniseParamPath("bulkThresholdMultiplier")).toBe("Bulk threshold multiplier");
    expect(humaniseParamPath("thickBoundaryMm")).toBe("Thick boundary mm");
    expect(humaniseParamPath("a.minNZD")).toBe("A — min NZD");
  });
  it("no visible param label is camelCase or a raw path", () => {
    const cfg = { ...PLYWOOD_NETWORK_CONFIG_DEFAULT, someNewKey: 3, deep: { innerKnobValue: true } };
    for (const r of hydPlywoodParamRows(cfg)) {
      expect(r.label).not.toMatch(CAMEL);
      expect(r.label).not.toContain(".");
      expect(r.label).not.toBe(r.path);
    }
  });
  it("keeps the real key path for editing", () => {
    const rows = hydPlywoodParamRows({ deep: { "v1.2": 5 } });
    expect(rows[0].keys).toEqual(["deep", "v1.2"]);
  });
  it("null config → no rows", () => {
    expect(hydPlywoodParamRows(null)).toEqual([]);
  });
});
