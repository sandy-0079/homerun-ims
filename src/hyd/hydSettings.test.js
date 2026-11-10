import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HYD_STRATEGY_OPTIONS, strategyOptionsFor, HYD_EDITOR_EXCLUDED_KEYS,
  withFloorsOnly, resetHydParamsToBangalore, setCategoryStrategy,
} from "./hydSettings.js";
import { HYD_HIDDEN_KEYS, isFloorsOnly } from "./hydParams.js";

describe("strategy options", () => {
  it("every option value is one Bangalore's Logic Tweaker offers (drift guard on App.jsx)", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    for (const { value } of HYD_STRATEGY_OPTIONS) {
      expect(app).toContain(`<option value="${value}">`);
    }
  });
  it("network_design only for plywood; never the retired v2", () => {
    expect(strategyOptionsFor("Tiles").map(o => o.value)).toEqual(["standard", "percentile_cover", "fixed_unit_floor", "manual"]);
    expect(strategyOptionsFor("Plywood, MDF & HDHMR").map(o => o.value)).toContain("network_design");
    expect(HYD_STRATEGY_OPTIONS.map(o => o.value)).not.toContain("network_design_v2");
  });
  it("standard deletes the entry, as Bangalore does", () => {
    expect(setCategoryStrategy({ categoryStrategies: { A: "manual", B: "manual" } }, "A", "standard"))
      .toEqual({ categoryStrategies: { B: "manual" } });
    expect(setCategoryStrategy({}, "A", "percentile_cover")).toEqual({ categoryStrategies: { A: "percentile_cover" } });
  });
});

describe("HYD_EDITOR_EXCLUDED_KEYS", () => {
  it("covers hidden keys and the dedicated controls", () => {
    for (const k of [...HYD_HIDDEN_KEYS, "floorsOnly", "orderCycleDays", "brandLeadTimeDays", "categoryStrategies", "copiedFromBangaloreAt", "plywoodNonNetworkStrategy",
      "dcMult", "dcDeadMult", "skuFloorDCMultMin", "skuFloorDCMultMax", "newDSFloorTopN"]) {
      expect(HYD_EDITOR_EXCLUDED_KEYS).toContain(k);
    }
  });
});

describe("withFloorsOnly", () => {
  it("sets one store without touching others or mutating", () => {
    const hp = { floorsOnly: { HYDS01: true, HYDS02: true }, x: 1 };
    const out = withFloorsOnly(hp, "HYDS01", false);
    expect(out.floorsOnly).toEqual({ HYDS01: false, HYDS02: true });
    expect(isFloorsOnly(out, "HYDS01")).toBe(false);
    expect(hp.floorsOnly.HYDS01).toBe(true);
  });
});

describe("resetHydParamsToBangalore", () => {
  const blr = { overallPeriod: 30, brandLeadTimeDays: { _default: 5 }, newDSList: ["DS06"], categoryStrategies: { A: "manual" } };
  it("takes Bangalore's values, drops hidden keys, stamps the date", () => {
    const out = resetHydParamsToBangalore({ overallPeriod: 45, floorsOnly: { HYDS01: true }, orderCycleDays: 3 }, blr, "2026-11-10T00:00:00Z");
    expect(out.overallPeriod).toBe(30);
    expect(out.brandLeadTimeDays).toEqual({ _default: 5 });
    expect(out.newDSList).toBeUndefined();
    expect(out.copiedFromBangaloreAt).toBe("2026-11-10T00:00:00Z");
  });
  it("keeps the Hyderabad-only settings (the switch and the order cycle)", () => {
    const out = resetHydParamsToBangalore({ floorsOnly: { HYDS01: false }, orderCycleDays: 5 }, blr, "t");
    expect(out.floorsOnly).toEqual({ HYDS01: false });
    expect(out.orderCycleDays).toBe(5);
  });
  it("a Hyderabad key Bangalore lacks does not survive the reset", () => {
    const out = resetHydParamsToBangalore({ hydOnlyLegacy: 1, floorsOnly: { HYDS01: true } }, blr, "t");
    expect(out.hydOnlyLegacy).toBeUndefined();
  });
});
