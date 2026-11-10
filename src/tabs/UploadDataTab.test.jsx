// Upload Data (moved out of App.jsx). Bangalore: the default render keeps every card
// and its upload controls. Hyderabad (mode="hyd"): the same cards, shared and inert —
// no file inputs, no clear buttons, no Apply & Re-run, and no path to a Bangalore
// handler (they all reach saveTeamData / applyAndRun).
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UploadDataTab from "./UploadDataTab.jsx";
import { summariseInputs } from "../inputSummary.js";

const skuMaster = { A: { sku: "A", name: "Alpha", category: "Tiles", status: "Active" }, B: { sku: "B", name: "Beta", category: "Tiles", status: "Active" } };
const invoiceData = [{ date: "2026-11-01", ds: "DS01", sku: "A", qty: 2, shopifyOrder: "HR/1" }];
const priceData = { A: 10 };
const minReqQty = { A: 2 }, newSKUQty = { A: { DS01: { min: 1, max: 2 } } }, skuCeiling = { A: { DS01: 3 } };
const deadStock = new Set(["B"]);
const inputSummaries = summariseInputs({ invoiceData, skuMaster, priceData, minReqQty, newSKUQty, deadStock, skuCeiling });
const inputProvenance = Object.fromEntries(Object.keys(inputSummaries).map(k => [k, { source: "auto", age: "1h ago", level: "ok", note: "n", at: null }]));

// Every Bangalore handler as a spy: each one writes a Bangalore row.
const BLR_HANDLERS = ["onApply", "clearData", "handleCeiling", "handleDead", "handleInvoice", "handleMRQ", "handleNSQ", "handlePrice", "handleSKU", "setShowRunConfirm"];
function props(extra = {}) {
  const spies = Object.fromEntries(BLR_HANDLERS.map(h => [h, vi.fn()]));
  return {
    spies,
    p: {
      ...spies, changeLog: ["Invoice uploaded"], deadStock, infoCard: null, setInfoCard: vi.fn(), inputProvenance, inputSummaries,
      invoiceData, invoiceDateRange: { min: "2026-11-01", max: "2026-11-01" }, minReqQty, missing: ["Z"], modelDirty: true,
      modelRunSuccess: true, modelSnapshot: null, modelState: { level: "ok", lastRun: "today", note: "n" }, newSKUQty,
      params: { overallPeriod: 45 }, priceData, provRaw: {}, results: { A: {} }, showRunConfirm: true, skuCeiling, skuMaster,
      uniqueSold: 1, uploadedFiles: {}, uploading: null, zeroSale: 1, ...extra,
    },
  };
}
const CARD_TITLES = ["Invoice Data", "SKU Master", "Purchase Prices", "SKU Floors - DS Level", "Newly Launched Dark Store Floor Qty", "Dead Stock List", "SKU Ceilings - DS Level"];
const fileInputs = (html) => (html.match(/type="file"/g) || []).length;

function walk(el, fn) {
  if (!el || typeof el !== "object") return;
  if (Array.isArray(el)) { el.forEach(c => walk(c, fn)); return; }
  fn(el); walk(el.props?.children, fn);
}

describe("UploadDataTab — Bangalore (default mode) is unchanged", () => {
  it("renders every card with its upload input, Apply & Re-run, the run-confirm modal and the summary strip", () => {
    const html = renderToStaticMarkup(<UploadDataTab {...props().p} />);
    for (const t of CARD_TITLES) expect(html).toContain(t);
    expect(fileInputs(html)).toBe(7);
    expect(html).toContain("Apply &amp; Re-run Model");
    expect(html).toContain("Re-run Model?");
    expect(html).toContain("Model ran successfully");
    expect(html).toContain("🗑 Clear");
    expect(html).toContain("Missing SKUs");
    expect(html).not.toContain("Shared — managed in Bangalore");
  });
  it("its run-confirm still calls applyAndRun (onApply) — the Bangalore path is wired", () => {
    const { p, spies } = props();
    walk(UploadDataTab(p), el => { if (el.type === "button" && /Run Model/.test(JSON.stringify(el.props.children))) el.props.onClick(); });
    expect(spies.onApply).toHaveBeenCalledWith(p.params);
  });
});

describe("UploadDataTab — Hyderabad (mode=\"hyd\")", () => {
  it("shared cards render in the same card layout with the shared note and NO file inputs or clear buttons", () => {
    const html = renderToStaticMarkup(<UploadDataTab {...props({ mode: "hyd" }).p} />);
    for (const t of CARD_TITLES) expect(html).toContain(t);
    expect(html.split("Shared — managed in Bangalore").length - 1).toBe(7);
    expect(fileInputs(html)).toBe(0);
    expect(html).not.toContain("🗑 Clear");
    expect(html).not.toContain("⬆ Upload CSV");
  });
  it("hides Bangalore's Apply & Re-run Model, its confirm modal, the success banner and the model diagnostics", () => {
    const html = renderToStaticMarkup(<UploadDataTab {...props({ mode: "hyd" }).p} />);
    for (const absent of ["Apply &amp; Re-run Model", "Model up to date", "Re-run Model?", "Model ran successfully", "Last run:", "Missing SKUs", "not Active in SKU Master"]) {
      expect(html).not.toContain(absent);
    }
  });
  it("cannot invoke any Bangalore handler: every clickable/changeable element fired, no spy called", () => {
    const { p, spies } = props({ mode: "hyd" });
    let fired = 0;
    walk(UploadDataTab(p), el => {
      for (const h of ["onClick", "onChange", "onMouseEnter", "onMouseLeave"]) {
        if (typeof el.props?.[h] === "function") { el.props[h]({ target: { files: [new Blob(["x"])], value: "" } }); fired++; }
      }
    });
    expect(fired).toBeGreaterThan(0); // the ⓘ hovers are still live
    for (const h of BLR_HANDLERS) expect(spies[h], h).not.toHaveBeenCalled();
  });
  it("extraCards render first, before the shared buckets", () => {
    const html = renderToStaticMarkup(<UploadDataTab {...props({ mode: "hyd", extraCards: <div id="hyd-floors">HYD FLOORS</div> }).p} />);
    expect(html.indexOf("HYD FLOORS")).toBeGreaterThan(-1);
    expect(html.indexOf("HYD FLOORS")).toBeLessThan(html.indexOf("Invoice Data"));
  });
  it("renders with only what Hyderabad passes (no Bangalore data props)", () => {
    const html = renderToStaticMarkup(<UploadDataTab mode="hyd" inputSummaries={inputSummaries} inputProvenance={inputProvenance}
      infoCard={null} setInfoCard={() => {}} uploadedFiles={{}} uploading={null} />);
    expect(html).toContain("Shared — managed in Bangalore");
  });
});
