// Smoke render of every Hyderabad tab (no React testing library in this repo:
// react-dom/server is enough to prove each tab renders without throwing — the
// class of bug `npm run build` cannot see, per src/tabs/CLAUDE.md).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../supabase.js", () => ({
  loadFromSupabase: vi.fn(), saveToSupabase: vi.fn(), supabase: {}, loadPayloadKey: vi.fn(),
  READ_ONLY: true, blockedWrites: () => [],
}));

// Wrap the real Tool Output tab so the props HydShell passes can be inspected.
let toolOutputProps = null;
vi.mock("../ToolOutputTab.jsx", async (importOriginal) => {
  const real = (await importOriginal()).default;
  return { default: (p) => { toolOutputProps = p; return real(p); } };
});

import HydShell from "./HydShell.jsx";
import { buildHydPoCsv } from "../../hyd/hydPoCsv.js";
// Bangalore's own screens, passed in as App.jsx does (spec §9).
import { OverviewTab, SKUDetailTab } from "../../App.jsx";
const SCREENS = { OverviewTabComponent: OverviewTab, SKUDetailTabComponent: SKUDetailTab };
import { runHydEngine } from "../../hyd/hydEngine.js";
import { buildHydParamsFromBangalore, buildHydPlywoodFromBangalore } from "../../hyd/hydParams.js";

const skuMaster = {
  A: { sku: "A", name: "Alpha", category: "Tiles", brand: "X", status: "Active", purchase: "Yes" },
  B: { sku: "B", name: "Beta", category: "Tiles", brand: "X", status: "Active", purchase: "No" },
  C: { sku: "C", name: "Gamma", category: "Plywood, MDF & HDHMR", brand: "Greenply", status: "Inactive" },
};
const invoiceData = [
  { date: "2026-11-01", ds: "HYDS01", sku: "A", qty: 3 },
  { date: "2026-11-02", ds: "HYDS01", sku: "B", qty: 1 },
  { date: "2026-11-03", ds: "DS01", sku: "A", qty: 9 },
];
const priceData = { A: 100, B: 50 };
const floors = { A: { HYDS01: { min: 2, max: 4 } }, B: { HYDS01: { min: 1, max: 1 } }, C: { HYDS01: { min: 1, max: 1 } }, Z: { HYDS01: { min: 1, max: 1 } } };
const hydPlywood = buildHydPlywoodFromBangalore(
  { lookbackDays: 90, brands: { Greenply: { nodes: { DS01: { covers: ["DS01"] } } } } },
  { DS07: { thick: { capacity: 300 }, thin: { capacity: 0 } } },
);

function stateFor(floorsOnly, storedOk = true) {
  const hydParams = { ...buildHydParamsFromBangalore({ overallPeriod: 45, brandLeadTimeDays: { _default: 3 }, categoryStrategies: { Tiles: "percentile_cover" }, fixedUnitFloor: { minNZD: 2 } }, "2026-11-10T00:00:00Z"), floorsOnly: { HYDS01: floorsOnly } };
  return { floors, floorsUploadedAt: null, hydParams, hydPlywood, stored: { params: storedOk, plywood: storedOk }, loadErrors: storedOk ? [] : ["params/hydGlobal: boom"] };
}

const render = (tab, hydState, extra = {}) => {
  const hydRun = "hydRun" in extra ? extra.hydRun : hydState ? runHydEngine({ invoiceData, skuMaster, priceData, deadStock: new Set(), floors: hydState.floors, hydParams: hydState.hydParams, hydPlywood: hydState.hydPlywood }) : null;
  return renderToStaticMarkup(
    <HydShell tab={tab} isAdmin invoiceData={invoiceData} skuMaster={skuMaster} priceData={priceData} deadStock={new Set()}
      stockData={{}} stockDataAccounting={{}} uploadedAtPerDS={{}} hydState={hydState} setHydState={() => {}} hydRun={hydRun}
      blrParams={{ overallPeriod: 45 }} {...SCREENS} {...extra} />,
  );
};

const TABS = ["overview", "skuDetail", "stockHealth", "output", "plywood", "upload", "logic"];

describe("HydShell renders every tab", () => {
  for (const floorsOnly of [true, false]) {
    for (const tab of TABS) {
      it(`${tab} (${floorsOnly ? "floors only" : "engine"})`, () => {
        expect(render(tab, stateFor(floorsOnly)).length).toBeGreaterThan(0);
      });
    }
  }

  it("shows the loading state before hydState arrives", () => {
    expect(render("overview", null)).toContain("Loading Hyderabad");
  });

  it("overview is Bangalore's Overview with HYDS01 only — no DC in the store picker", () => {
    const html = render("overview", stateFor(true));
    expect(html).toContain("Inv Value Max");
    expect(html).toContain('<option value="HYDS01">HYDS01</option>');
    expect(html).toContain('<option value="All" selected="">All Locations</option>');
    expect(html).not.toContain("incl. DC");
    expect(html).not.toContain('value="DC"');
    expect(html).not.toContain('value="DS01"');
  });

  it("sku detail is Bangalore's SKU Detail (its search box renders)", () => {
    expect(render("skuDetail", stateFor(true))).toContain("Search by SKU ID or name");
  });

  it("load errors and an engine error are surfaced, not thrown", () => {
    const html = render("overview", stateFor(true, false), { hydRun: { results: null, report: null, error: "kaboom" } });
    expect(html).toContain("params/hydGlobal: boom");
    expect(html).toContain("engine: kaboom");
  });

  it("null settings (load .catch path) say so instead of loading forever", () => {
    const st = { ...stateFor(true, false), hydParams: null, hydPlywood: null };
    for (const tab of ["logic", "plywood"]) {
      const html = render(tab, st, { hydRun: null });
      expect(html).toContain("Hyderabad settings could not be loaded");
      expect(html).not.toContain("Loading Hyderabad");
    }
  });

  it("plywood warns on a 0 capacity, and only then", () => {
    const st = stateFor(true);
    expect(render("plywood", st)).not.toContain("0 = no cap");
    const nc = { ...st.hydPlywood.networkConfigs, HYDS01: { ...st.hydPlywood.networkConfigs.HYDS01, thin: { capacity: 0 } } };
    expect(render("plywood", { ...st, hydPlywood: { ...st.hydPlywood, networkConfigs: nc } })).toContain("0 = no cap");
  });

  it("non-admin: plywood renders read-only, upload/logic refuse", () => {
    const st = stateFor(true);
    const html = (tab) => renderToStaticMarkup(
      <HydShell tab={tab} isAdmin={false} invoiceData={invoiceData} skuMaster={skuMaster} priceData={priceData} deadStock={new Set()}
        hydState={st} setHydState={() => {}} hydRun={null} blrParams={{}} {...SCREENS} />);
    expect(html("plywood")).not.toContain("Save (Hyderabad)");
    expect(html("upload")).toContain("admin-only");
    expect(html("logic")).toContain("admin-only");
  });

  it("stock health shows Pati's targets with no DC tab, before its stock sync exists", () => {
    const html = render("stockHealth", stateFor(true));
    expect(html).toContain(">HYDS01<");
    expect(html).not.toContain(">DC<");
    expect(html).toContain("Alpha");
    expect(html).toContain("Live stock for HYDS01 starts once the stock sync is enabled");
  });

  it("stock health shows the floor/range notice with counts when the report has entries", () => {
    const report = {
      inactiveFloored: ["C"],
      overrides: [{ sku: "A", reason: "Purchase=OFF" }, { sku: "A", reason: "Supplier" }, { sku: "B", reason: "Dead Stock" }],
      outOfRangeSales: ["B", "Z"],
      unknownFloorSkus: [],
    };
    const html = render("stockHealth", stateFor(true), { hydRun: { results: null, report } });
    expect(html).toContain("1 floor SKUs are inactive in Zoho");
    expect(html).toContain("2 floor SKUs override Bangalore flags"); // A deduped
    expect(html).toContain("2 SKUs sold at Pati but not in range");
    expect(html).toContain("Dismiss");
  });

  it("stock health shows no notice when all three lists are empty", () => {
    const report = { inactiveFloored: [], overrides: [], outOfRangeSales: [], unknownFloorSkus: ["Q"] };
    const html = render("stockHealth", stateFor(true), { hydRun: { results: null, report } });
    expect(html).not.toContain("Dismiss");
    expect(html).not.toContain("inactive in Zoho");
  });

  it("logic tweaker shows the copied-from date and both buttons", () => {
    const html = render("logic", stateFor(true));
    expect(html).toContain("Copied from Bangalore on");
    expect(html).toContain("Reset to Bangalore&#x27;s current values");
    expect(html).toContain("Apply (Hyderabad)");
  });

  it("tool output: Bangalore's card grid without DC / Inner Case Pack / Zero Sale; PO is Hyderabad's file", () => {
    const st = stateFor(true);
    const html = render("output", st);
    expect(html).toContain("Tool Output — DS Level");
    expect(html).toContain("SKU Master");
    expect(html).toContain("Purchase Prices");
    expect(html).toContain("⬇ PO — Hyderabad (HYDS01 Pati)");
    expect(html).toContain("9 columns · 3 SKUs");
    expect(html).toContain("Floors only");
    for (const absent of ["Tool Output — DC", "Inner Case Pack - Mid Mile", "Zero Sale SKUs", "PO Team Download"]) expect(html).not.toContain(absent);
    expect(toolOutputProps.dsList).toEqual(["HYDS01"]);
    expect(toolOutputProps.includeDC).toBe(false);
    expect(toolOutputProps.poCard.filename()).toMatch(/^PO_Hyderabad_\d{4}-\d{2}-\d{2}\.csv$/);
    const hydRun = runHydEngine({ invoiceData, skuMaster, priceData, deadStock: new Set(), floors: st.floors, hydParams: st.hydParams, hydPlywood: st.hydPlywood });
    expect(toolOutputProps.poCard.build()).toBe(buildHydPoCsv({ skuMaster, hydResults: hydRun.results, floors: st.floors, hydParams: st.hydParams }));
    expect(toolOutputProps.poCard.build().split("\n")[0]).toContain('"HYDS01 Min","HYDS01 Max","Purchase"');
  });

  it("stock health: no Sync Now for Pati while its stock has never synced", () => {
    const html = render("stockHealth", stateFor(true));
    expect(html).not.toContain("Sync Now");
    expect(html).toContain("Live stock for HYDS01 starts once the stock sync is enabled");
  });
});

describe("HydShell — a failed Hyderabad read disables downloads and saves", () => {
  const disabledButton = (html, label) => new RegExp(`<button[^>]*disabled=""[^>]*>[^<]*${label}`).test(html);
  // stored:false so Apply/Save are enabled on a healthy read (a first save is
  // allowed unchanged) — the read failure is then the only thing disabling them.
  const healthy = () => ({ ...stateFor(true), stored: { params: false, plywood: false } });
  const failed = () => ({ ...healthy(), readFailed: { inputs: false, params: true, plywood: false }, loadErrors: ["params/hydGlobal: timeout"] });

  it("healthy read: no banner, PO / Apply / Save enabled", () => {
    expect(render("output", healthy())).not.toContain("could not be read");
    expect(disabledButton(render("output", healthy()), "PO — Hyderabad")).toBe(false);
    expect(disabledButton(render("logic", healthy()), "Apply \\(Hyderabad\\)")).toBe(false);
    expect(disabledButton(render("plywood", healthy()), "Save \\(Hyderabad\\)")).toBe(false);
  });

  it("shows the red banner on every tab", () => {
    for (const tab of TABS) {
      expect(render(tab, failed())).toContain("Hyderabad data could not be read — downloads and saves are disabled until reload");
    }
  });

  it("disables the PO download, Logic Tweaker Apply and Plywood Save", () => {
    expect(disabledButton(render("output", failed()), "PO — Hyderabad")).toBe(true);
    expect(disabledButton(render("logic", failed()), "Apply \\(Hyderabad\\)")).toBe(true);
    expect(disabledButton(render("plywood", failed()), "Save \\(Hyderabad\\)")).toBe(true);
  });
});
