// Static renders of the shared Logic Tweaker: Bangalore defaults vs Hyderabad props.
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LogicTweakerTab from "./LogicTweakerTab.jsx";
import { DEFAULT_PARAMS } from "../engine/index.js";
import { buildHydParamsFromBangalore } from "../hyd/hydParams.js";

const skuMaster = {
  A: { sku: "A", category: "Tiles", brand: "Kajaria" },
  P: { sku: "P", category: "Plywood, MDF & HDHMR", brand: "Greenply" },
};
const blr = {
  ...DEFAULT_PARAMS, overallPeriod: 45, recencyWindow: 15,
  categoryStrategies: { "Plywood, MDF & HDHMR": "network_design", Tiles: "percentile_cover" },
  pincodeConfig: { mode: "shippingCode", map: { 560001: "DS01" } }, openingDSList: [], newDSList: ["DS06"],
  brandLeadTimeDays: { _default: 3, "Asian Paints": 4 },
};
const noop = () => {};
const common = { skuMaster, saveParams: noop, setParams: noop, onApply: noop, setShowLogicConfirm: noop, setAdvancedOpen: noop,
  handlePincodeMap: noop, blrInvoice: [], missing: [], uploading: null, isAdmin: true, advancedOpen: true };
const render = (p) => renderToStaticMarkup(<LogicTweakerTab {...common} {...p} />);
const NETWORK = ["New Dark Store Logic", "Demand Attribution", "Store Status — Opening Shortly", "Dead Stock DC Multiplier", "SKU Floor DC Multipliers"];
// Sections render collapsed; walk the returned tree for every Section's title + children.
function sectionHtml(p) {
  const out = [];
  const walk = (el) => {
    if (!el || typeof el !== "object") return;
    if (Array.isArray(el)) return el.forEach(walk);
    if (typeof el.type === "function" && el.type.name === "Section") out.push(el.props.title + renderToStaticMarkup(<>{el.props.children}</>));
    walk(el.props?.children);
  };
  walk(LogicTweakerTab({ ...common, ...p }));
  return out.join("\n");
}

describe("LogicTweakerTab — Bangalore defaults", () => {
  it("renders every Bangalore section and the DC lead-time label", () => {
    const html = render({ params: blr, savedParams: blr, hasChanges: false, showLogicConfirm: false });
    for (const t of [...NETWORK, "Brand Lead Time (DC)", "Percentile Cover Params", "Fixed Unit Floor Params", "Category → Strategy Map"]) expect(html).toContain(t);
    expect(html).toContain("Up to date");
  });
  it("offers both plywood network strategies and the non-network picker", () => {
    const html = sectionHtml({ params: blr, savedParams: blr, hasChanges: false });
    expect(html).toContain('<option value="network_design_v2">');
    expect(html).toContain("Non-network brands");
  });
  it("Apply is enabled when there are changes", () => {
    const html = render({ params: { ...blr, overallPeriod: 60 }, savedParams: blr, hasChanges: true });
    expect(html).toMatch(/<button style="[^"]*"><span>▶<\/span> Apply \(1 changes\)/);
  });
});

describe("LogicTweakerTab — Hyderabad props", () => {
  const hyd = buildHydParamsFromBangalore(blr, "2026-11-10T00:00:00Z"); // HYD_HIDDEN_KEYS removed
  const hydProps = { params: hyd, savedParams: hyd, showNetworkSections: false, leadTimeLabel: "Brand Lead Time (vendor → Pati)",
    topSlot: <div>HYD-TOP-SLOT</div> };
  it("hides the network sections, keeps PCT / Fixed Unit Floor / vendor lead time / topSlot — with the DC keys absent", () => {
    for (const k of ["newDSList", "openingDSList", "pincodeConfig", "dcDeadMult", "skuFloorDCMultMin", "newDSFloorTopN"]) expect(hyd).not.toHaveProperty(k);
    const html = render({ ...hydProps, hasChanges: false });
    for (const t of NETWORK) expect(html).not.toContain(t);
    expect(html).not.toContain("Brand Lead Time (DC)");
    for (const t of ["Percentile Cover Params", "Fixed Unit Floor Params", "Brand Lead Time (vendor → Pati)", "HYD-TOP-SLOT", "Base Min Days", "Price Tag Boundaries"]) expect(html).toContain(t);
  });
  it("no plywood non-network picker and no retired v2 strategy", () => {
    const html = sectionHtml({ ...hydProps, hasChanges: false });
    expect(html).not.toContain("Non-network brands");
    expect(html).not.toContain("network_design_v2");
    expect(html).toMatch(/<option value="network_design"( selected="")?>Network Design</);
  });
  it("changelog omits the network keys and appends extraChangelog", () => {
    const next = { ...hyd, overallPeriod: 60, newDSList: ["DS01"], openingDSList: ["DS02"], pincodeConfig: { mode: "shippingCode" }, dcDeadMult: { min: 1, max: 1 }, skuFloorDCMultMin: 0.9, newDSFloorTopN: 50, plywoodNonNetworkStrategy: "manual" };
    const html = render({ ...hydProps, params: next, hasChanges: true, showLogicConfirm: true, extraChangelog: ["Pati: Floors only → Engine"] });
    expect(html).toContain("Overall period: 45D → 60D");
    expect(html).toContain("Pati: Floors only → Engine");
    expect(html).toContain("Apply (2 changes)");
    for (const t of ["New DS list", "Opening Shortly", "Demand attribution", "Dead stock DC", "SKU floor DC", "New DS floor", "Plywood non-network"]) expect(html).not.toContain(t);
  });
  it("applyDisabled disables Apply even with changes", () => {
    const html = render({ ...hydProps, params: { ...hyd, overallPeriod: 60 }, hasChanges: true, applyDisabled: true });
    expect(html).toMatch(/<button disabled="" style="[^"]*"><span>▶<\/span> Apply/);
  });
});
