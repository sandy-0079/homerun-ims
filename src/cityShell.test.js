import { describe, it, expect } from "vitest";
import {
  CITY_THEME, cityHeaderLabel, cityHeaderStyle, hydTabsFor, tabForCity, otherCity, cityUrl,
  safeHydRun,
} from "./cityShell.js";

describe("city shell", () => {
  it("theme values are the agreed constants", () => {
    expect(CITY_THEME.blr).toEqual({ headerBg: "#FFF8DC", underline: "#F5C400", label: "#7A5C00", title: "IMS · Bangalore" });
    expect(CITY_THEME.hyd).toEqual({ headerBg: "#E6F0FA", underline: "#1F5FA8", label: "#1F5FA8", title: "IMS · Hyderabad" });
  });

  it("header label", () => {
    expect(cityHeaderLabel("blr")).toBe("· BANGALORE ▾");
    expect(cityHeaderLabel("hyd")).toBe("· HYDERABAD ▾");
  });

  it("header style replaces only background and bottom border", () => {
    const base = { background: "#FFFFFF", borderBottom: "2px solid #F5C400", height: 44, padding: "0 16px", display: "flex" };
    const s = cityHeaderStyle(base, "hyd");
    expect(s).toEqual({ ...base, background: "#E6F0FA", borderBottom: "3px solid #1F5FA8" });
    expect(cityHeaderStyle(base, "blr")).toEqual({ ...base, background: "#FFF8DC", borderBottom: "3px solid #F5C400" });
    expect(base.background).toBe("#FFFFFF"); // not mutated
  });

  it("Hyderabad tabs: public set, plus upload + logic for admins; Bangalore labels", () => {
    expect(hydTabsFor(false)).toEqual([
      ["overview", "Overview"], ["skuDetail", "SKU Detail"], ["stockHealth", "Stock Health"],
      ["output", "Tool Output Download"], ["plywood", "Plywood"],
    ]);
    expect(hydTabsFor(true)).toEqual([...hydTabsFor(false), ["upload", "Upload Data"], ["logic", "Logic Tweaker"]]);
    expect(hydTabsFor(true).map(([t]) => t)).not.toContain("baskets");
    expect(hydTabsFor(true).map(([t]) => t)).not.toContain("overrides");
  });

  it("tabForCity keeps an offered tab, else overview", () => {
    expect(tabForCity("plywood", hydTabsFor(false))).toBe("plywood");
    expect(tabForCity("baskets", hydTabsFor(true))).toBe("overview");
    expect(tabForCity("overrides", hydTabsFor(true))).toBe("overview");
    expect(tabForCity("logic", hydTabsFor(false))).toBe("overview");
  });

  it("otherCity toggles", () => {
    expect(otherCity("blr")).toBe("hyd");
    expect(otherCity("hyd")).toBe("blr");
  });

  it("cityUrl sets ?city= and keeps path, other params and hash", () => {
    expect(cityUrl("https://x.app/", "hyd")).toBe("/?city=hyd");
    expect(cityUrl("https://x.app/p?a=1&city=hyd#h", "blr")).toBe("/p?a=1&city=blr#h");
  });

  it("safeHydRun returns the run, or an error instead of throwing", () => {
    expect(safeHydRun(() => ({ results: { A: 1 }, report: {} }))).toEqual({ results: { A: 1 }, report: {} });
    const r = safeHydRun(() => { throw new Error("boom"); });
    expect(r.results).toBeNull();
    expect(r.error).toBe("boom");
  });
});
