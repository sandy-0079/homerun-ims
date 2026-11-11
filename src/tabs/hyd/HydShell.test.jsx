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

// Same for the Logic Tweaker: the props HydShell passes (onApply, the draft) are inspected.
let logicProps = null;
vi.mock("../LogicTweakerTab.jsx", async (importOriginal) => {
  const real = (await importOriginal()).default;
  return { default: (p) => { logicProps = p; return real(p); } };
});

// And Upload Data: HydShell must pass mode="hyd" and none of Bangalore's handlers.
let uploadProps = null;
vi.mock("../UploadDataTab.jsx", async (importOriginal) => {
  const real = (await importOriginal()).default;
  return { default: (p) => { uploadProps = p; return real(p); } };
});

import HydShell from "./HydShell.jsx";
import { saveToSupabase } from "../../supabase.js";
import { buildHydPoCsv } from "../../hyd/hydPoCsv.js";
// Bangalore's own screens, passed in as App.jsx does (spec §9).
import { OverviewTab, SKUDetailTab } from "../../App.jsx";
const SCREENS = { OverviewTabComponent: OverviewTab, SKUDetailTabComponent: SKUDetailTab };
import { runHydEngine } from "../../hyd/hydEngine.js";
import { summariseInputs } from "../../inputSummary.js";
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

  it("overview counts WINDOW days (network dates), not Pati's sale days", () => {
    // Pati sold on 11-01 and 11-02; the network window is 11-01..11-03 (DS01 sold on 11-03).
    const html = render("overview", stateFor(true));
    expect(html).toMatch(/>3D<\/span>/);
    expect(html).toContain("(3D)");
    expect(html).not.toMatch(/>2D<\/span>/);
  });

  it("Bangalore's Overview without the prop still counts the dates present in its rows", () => {
    const html = renderToStaticMarkup(<OverviewTab invoiceData={invoiceData.filter(r => r.ds === "HYDS01")} results={null} priceData={priceData}
      params={{}} invoiceDateRange={{ min: "2026-11-01", max: "2026-11-03", dates: ["2026-11-01", "2026-11-02", "2026-11-03"] }}
      period="L90D" setPeriod={() => {}} dateFrom="" setDateFrom={() => {}} dateTo="" setDateTo={() => {}}
      store="All" setStore={() => {}} drill={null} setDrill={() => {}} onNavigateToSKU={() => {}} />);
    expect(html).toMatch(/>2D<\/span>/);
    expect(html).toContain("(2D)");
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

  it("plywood params: Bangalore's labels, no DC-only or raw camelCase keys", () => {
    const st = stateFor(true);
    const ply = { ...st.hydPlywood, plywoodNetworkConfig: { ...st.hydPlywood.plywoodNetworkConfig, dcCapacity: { thick: 400, thin: 400 }, maxCap: 20, bulkThresholdMultiplier: 2 } };
    const html = render("plywood", { ...st, hydPlywood: ply });
    expect(html).toContain("Global Settings");
    expect(html).toContain("History Window");
    expect(html).toContain("Max Sheets per Location");
    expect(html).toContain("Bulk Multiplier (N×ABQ)");
    for (const raw of ["dcCapacity", "lookbackDays", "maxCap", "bulkThresholdMultiplier"]) expect(html).not.toContain(raw);
  });

  it("plywood lists Pati's plywood SKUs with capacity used, or the empty state", () => {
    const st = stateFor(true);
    const html = render("plywood", st);
    expect(html).toContain("Pati plywood SKUs");
    expect(html).toContain("Gamma"); // plywood, has a Hyderabad floor (inactive → 0/0)
    expect(html).toContain("Inactive in Zoho");
    expect(html).toContain("Vertical Storage — Thick");
    expect(html).toContain("Tub Storage — Thin");
    expect(html).not.toContain("No plywood SKUs in Pati");
    const { C, ...noPly } = floors;
    expect(render("plywood", { ...st, floors: noPly })).toContain("No plywood SKUs in Pati&#x27;s range yet");
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

  it("stock health paints HYDS01 in Hyderabad's blue (as Overview / SKU Detail), not DS01's gold", () => {
    const html = render("stockHealth", stateFor(true));
    const tabBtn = html.match(/<button[^>]*>HYDS01</)[0];
    expect(tabBtn).toContain("#1F5FA8");
    expect(tabBtn).not.toContain("#B8860B");
  });

  it("stock health is Bangalore's screen with no floor-sheet notice (the lists moved to Upload Data)", () => {
    const report = {
      inactiveFloored: ["C"],
      overrides: [{ sku: "A", reason: "Purchase=OFF" }],
      outOfRangeSales: ["B", "Z"],
      unknownFloorSkus: ["Q"],
    };
    const html = render("stockHealth", stateFor(true), { hydRun: { results: null, report } });
    for (const absent of ["Dismiss", "inactive in Zoho", "override Bangalore flags", "sold at Pati", "Pati floor sheet"]) expect(html).not.toContain(absent);
  });

  it("upload is Bangalore's Upload Data: the Hyderabad floors card first and active, every other card shared", () => {
    const report = {
      inactiveFloored: ["C"],
      overrides: [{ sku: "A", reason: "Purchase=OFF" }, { sku: "A", reason: "Supplier" }, { sku: "B", reason: "Dead Stock" }],
      outOfRangeSales: ["B", "Z"],
      unknownFloorSkus: ["Q"],
    };
    const html = render("upload", stateFor(true), { hydRun: { results: null, report } });
    expect(html).toContain("Data Inputs");
    expect(html.indexOf("SKU Floors - HYDERABAD")).toBeGreaterThan(-1);
    expect(html.indexOf("SKU Floors - HYDERABAD")).toBeLessThan(html.indexOf("Invoice Data"));
    expect(html.split("Shared — managed in Bangalore").length - 1).toBe(7);
    expect((html.match(/type="file"/g) || []).length).toBe(1); // the Hyderabad floors card only
    expect(html).not.toContain("Apply &amp; Re-run Model");
    expect(html).not.toContain("🗑 Clear");
    expect(html).toContain("1 SKUs sold at Pati have no floor"); // B; Z is not in the SKU master
    expect(html).toContain("⬇ Download as floor template");
    expect(html).toContain("1 floor SKUs are inactive in Zoho");
    expect(html).toContain("2 floor SKUs override Bangalore flags"); // A deduped
    expect(html).toContain("1 floor SKUs are not in the SKU master");
    expect(uploadProps.mode).toBe("hyd");
    for (const h of ["onApply", "clearData", "handleInvoice", "handleSKU", "handlePrice", "handleNSQ", "handleMRQ", "handleDead", "handleCeiling", "setShowRunConfirm"]) {
      expect(uploadProps[h], h).toBeUndefined(); // no Bangalore handler is even passed
    }
  });

  it("upload: the shared cards show App's counts when App passes them", () => {
    const inputSummaries = summariseInputs({ invoiceData, skuMaster, priceData, minReqQty: {}, newSKUQty: {}, deadStock: new Set(), skuCeiling: {} });
    render("upload", stateFor(true), { inputSummaries });
    expect(uploadProps.inputSummaries).toBe(inputSummaries);
  });

  it("logic tweaker is Bangalore's, with the Hyderabad top section and no network sections", () => {
    const html = render("logic", stateFor(true));
    expect(html).toContain("Logic Tweaker");
    expect(html).toContain("Hyderabad — HYDS01 Pati");
    expect(html).toContain("Copied from Bangalore on");
    expect(html).toContain("Reset to Bangalore&#x27;s current values");
    expect(html).toContain("Pati: Floors only ⇄ Engine");
    expect(html).toContain("Order cycle");
    expect(html).toContain("Percentile Cover Params");
    expect(html).toContain("Fixed Unit Floor Params");
    expect(html).toContain("Brand Lead Time (vendor → Pati)");
    expect(html).not.toContain("Brand Lead Time (DC)");
    expect(html).toContain("Up to date"); // no draft
    expect(logicProps.showNetworkSections).toBe(false);
    expect(logicProps.savedParams).toBe(logicProps.params);
  });

  it("logic tweaker edits the draft from App (hydDraft); hydParams is only the saved side", () => {
    const st = stateFor(true);
    const value = { ...st.hydParams, overallPeriod: 60, floorsOnly: { HYDS01: false } };
    let set = null;
    const html = render("logic", st, { hydDraft: { base: st.hydParams, value }, setHydDraft: (d) => { set = d; } });
    expect(logicProps.params).toBe(value);
    expect(logicProps.savedParams).toBe(st.hydParams);
    expect(logicProps.hasChanges).toBe(true);
    expect(logicProps.extraChangelog).toEqual(["Pati: Floors only → Engine"]);
    expect(html).toContain("Apply (2 changes)");
    expect(html).toContain("Unsaved Hyderabad changes");
    logicProps.saveParams({ ...value, overallPeriod: 30 });
    expect(set).toEqual({ base: st.hydParams, value: { ...value, overallPeriod: 30 } });
  });

  it("logic Apply writes only params/hydGlobal (never applyAndRun / saveTeamData)", async () => {
    saveToSupabase.mockReset();
    saveToSupabase.mockResolvedValue(true);
    const st = stateFor(true);
    const value = { ...st.hydParams, orderCycleDays: 5 };
    const setHydState = vi.fn();
    render("logic", st, { hydDraft: { base: st.hydParams, value }, setHydState });
    await logicProps.onApply(logicProps.params);
    expect(saveToSupabase.mock.calls.map(c => `${c[0]}/${c[1]}`)).toEqual(["params/hydGlobal"]);
    expect(saveToSupabase.mock.calls[0][2]).toBe(value);
    expect(setHydState.mock.calls[0][0](st).hydParams).toBe(value);
  });

  it("first save: Apply is enabled with no edits when params/hydGlobal was never stored (spec §3.3)", () => {
    const st = { ...stateFor(true), stored: { params: false, plywood: true } };
    const html = render("logic", st);
    expect(logicProps.hasChanges).toBe(true);
    expect(logicProps.extraChangelog).toEqual(["First save — creates Hyderabad's own copy (params/hydGlobal)"]);
    expect(html).toContain("Apply (1 changes)");
    expect(html.match(/<button([^>]*)><span>▶<\/span> Apply/)[1]).not.toContain('disabled=""');
  });

  it("first save only when params/hydGlobal is known NOT stored (stored.params === false)", () => {
    const st = { ...stateFor(true) };
    delete st.stored;
    render("logic", st);
    expect(logicProps.hasChanges).toBe(false);
    expect(logicProps.extraChangelog).toEqual([]);
  });

  it("\"(not saved yet)\" label uses the same predicate (stored.params === false)", () => {
    expect(render("logic", { ...stateFor(true), stored: { params: false, plywood: true } })).toContain("not saved yet");
    const unknown = { ...stateFor(true) };
    delete unknown.stored;
    expect(render("logic", unknown)).not.toContain("not saved yet");
    expect(render("logic", stateFor(true))).not.toContain("not saved yet");
  });

  it("plywood edits live in App's draft (hydPlywoodDraft) so leaving can be guarded", () => {
    const st = stateFor(true);
    const value = { ...st.hydPlywood, networkConfigs: { ...st.hydPlywood.networkConfigs, HYDS01: { thick: { capacity: 77 }, thin: { capacity: 5 } } } };
    const html = render("plywood", st, { hydPlywoodDraft: { base: st.hydPlywood, value }, setHydPlywoodDraft: () => {} });
    expect(html).toContain("Unsaved Hyderabad plywood changes");
    expect(html).toContain('value="77"');
    // A draft from an older hydPlywood (after a save) is ignored.
    expect(render("plywood", st, { hydPlywoodDraft: { base: { ...st.hydPlywood }, value }, setHydPlywoodDraft: () => {} })).not.toContain("Unsaved Hyderabad plywood changes");
  });

  it("once stored, no edits means Up to date (no first-save line)", () => {
    render("logic", stateFor(true));
    expect(logicProps.hasChanges).toBe(false);
    expect(logicProps.extraChangelog).toEqual([]);
  });

  it("a THROWN Hyderabad save does not escape onApply (applying is released; error status, not a crash)", async () => {
    saveToSupabase.mockReset();
    saveToSupabase.mockRejectedValue(new Error("fetch failed"));
    const st = stateFor(true);
    const setHydState = vi.fn();
    render("logic", st, { hydDraft: { base: st.hydParams, value: { ...st.hydParams, orderCycleDays: 5 } }, setHydState });
    await expect(logicProps.onApply(logicProps.params)).resolves.toBeUndefined();
    expect(setHydState).not.toHaveBeenCalled();
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
    expect(toolOutputProps.filePrefix).toBe("Hyderabad_");
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
  // The shared Logic Tweaker's Apply: <button …><span>▶</span> Apply (n changes)
  const applyButton = (html) => html.match(/<button([^>]*)><span>▶<\/span> Apply/);
  const dirty = (st) => ({ hydDraft: { base: st.hydParams, value: { ...st.hydParams, overallPeriod: 60 } } });
  // stored:false so Plywood Save is enabled on a healthy read (a first save is allowed
  // unchanged), and a dirty Logic draft so Apply is — the read failure is then the only
  // thing disabling them.
  const healthy = () => ({ ...stateFor(true), stored: { params: false, plywood: false } });
  const failed = () => ({ ...healthy(), readFailed: { inputs: false, params: true, plywood: false }, loadErrors: ["params/hydGlobal: timeout"] });

  it("healthy read: no banner, PO / Apply / Save enabled", () => {
    expect(render("output", healthy())).not.toContain("could not be read");
    expect(disabledButton(render("output", healthy()), "PO — Hyderabad")).toBe(false);
    const h = healthy();
    expect(applyButton(render("logic", h, dirty(h)))[1]).not.toContain('disabled=""');
    expect(disabledButton(render("plywood", healthy()), "Save \\(Hyderabad\\)")).toBe(false);
  });

  it("shows the red banner on every tab", () => {
    for (const tab of TABS) {
      expect(render(tab, failed())).toContain("Hyderabad data could not be read — downloads and saves are disabled until reload");
    }
  });

  it("disables the PO download, Logic Tweaker Apply and Plywood Save", () => {
    expect(disabledButton(render("output", failed()), "PO — Hyderabad")).toBe(true);
    const f = failed();
    expect(applyButton(render("logic", f, dirty(f)))[1]).toContain('disabled=""');
    expect(disabledButton(render("plywood", failed()), "Save \\(Hyderabad\\)")).toBe(true);
  });
});

describe("HydShell — invariant: a failed read disables EVERY Hyderabad download and save", () => {
  // Every control that downloads a file or writes a row: a <button> whose text is a
  // download (⬇ / Download), a save, an Apply or a Replace.
  const CONTROL = /⬇|Download|Save|Apply|Replace/;
  const controls = (html) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    .map(m => ({ attrs: m[1], text: m[2].replace(/<[^>]+>/g, "").trim() }))
    .filter(c => CONTROL.test(c.text));
  const failed = () => ({ ...stateFor(true), stored: { params: false, plywood: false },
    readFailed: { inputs: true, params: false, plywood: false }, loadErrors: ["team_data/hyd_inputs: timeout"] });
  // A report with an active SKU sold out of range, so the floor-template download renders.
  const runWithReport = (st) => {
    const run = runHydEngine({ invoiceData, skuMaster, priceData, deadStock: new Set(), floors: st.floors, hydParams: st.hydParams, hydPlywood: st.hydPlywood });
    return { ...run, report: { ...run.report, outOfRangeSales: ["A"] } };
  };

  it("every tab, every control", () => {
    const st = failed();
    const seen = [];
    for (const tab of TABS) {
      const html = render(tab, st, { hydRun: runWithReport(st), hydDraft: { base: st.hydParams, value: { ...st.hydParams, overallPeriod: 60 } } });
      for (const c of controls(html)) {
        seen.push(`${tab}: ${c.text}`);
        expect(c.attrs, `${tab}: ${c.text}`).toContain('disabled=""');
      }
    }
    // The invariant is only as good as its coverage: each known control must have been seen.
    for (const label of ["output: ⬇ PO — Hyderabad", "output: ⬇ Download DS Level", "output: ⬇ Download SKU Master",
      "output: ⬇ Download Purchase Prices", "upload: ⬇ Download as floor template", "upload: ⬇ Template (current floors)",
      "logic: ▶ Apply", "plywood: Save (Hyderabad)", "stockHealth: ⬇ Download All SKUs"]) {
      expect(seen.some(s => s.startsWith(label)), `${label} not rendered — invariant has a gap`).toBe(true);
    }
  });
});
