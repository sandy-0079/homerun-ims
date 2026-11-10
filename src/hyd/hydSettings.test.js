import { describe, it, expect } from "vitest";
import { withFloorsOnly, resetHydParamsToBangalore } from "./hydSettings.js";
import { isFloorsOnly } from "./hydParams.js";

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
