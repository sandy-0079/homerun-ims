// The Hyderabad floors card (Upload Data, city = Hyderabad). Static renders via
// react-dom/server; the preview/confirm sit behind a file pick, so they are rendered
// directly through their exported pieces.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../supabase.js", () => ({ loadFromSupabase: vi.fn(), saveToSupabase: vi.fn(), supabase: {} }));

import HydFloorsCard, { Preview, ReplaceConfirm } from "./HydFloorsCard.jsx";

const skuMaster = { A: { name: "Alpha", category: "Tiles" }, B: { name: "Beta" }, C: { name: "Gamma" }, D: { name: "Delta" } };
const hydState = { floors: { A: { HYDS01: { min: 1, max: 2 } }, B: { HYDS01: { min: 0, max: 0 } } }, floorsUploadedAt: "2026-11-09T10:00:00Z", stored: { params: true }, readFailed: {} };
const report = (over = {}) => ({ inactiveFloored: ["C"], overrides: [{ sku: "A", reason: "Purchase=OFF" }, { sku: "A", reason: "Supplier" }, { sku: "D", reason: "Dead Stock" }],
  outOfRangeSales: ["B", "D", "Q"], unknownFloorSkus: ["ZZ1", "ZZ2"], ...over });
const render = (hydRun, st = hydState) => renderToStaticMarkup(<HydFloorsCard skuMaster={skuMaster} hydState={st} setHydState={() => {}} hydRun={hydRun} />);

describe("HydFloorsCard", () => {
  it("names the city and shows SKUs in range + when uploaded, with one file input", () => {
    const html = render({ report: report() });
    expect(html).toContain("SKU Floors - HYDERABAD");
    expect(html).toContain("1 SKUs in range");
    expect(html).toContain("⬆ Upload CSV");
    expect((html.match(/type="file"/g) || []).length).toBe(1);
  });

  it("shows the four floor-sheet lists with their counts (overrides deduped)", () => {
    const html = render({ report: report() });
    expect(html).toContain("3 SKUs sold at Pati have no floor");
    expect(html).toContain("1 floor SKUs are inactive in Zoho");
    expect(html).toContain("2 floor SKUs override Bangalore flags"); // A once, D once
    expect(html).toContain("2 floor SKUs are not in the SKU master");
    expect(html).toContain("Purchase=OFF, Supplier"); // A's reasons together
    expect(html).toContain("⬇ Download as floor template");
  });

  it("no template button when nothing sold out of range; empty lists are not shown", () => {
    const html = render({ report: report({ outOfRangeSales: [], inactiveFloored: [], overrides: [], unknownFloorSkus: [] }) });
    expect(html).not.toContain("Download as floor template");
    expect(html).not.toContain("have no floor");
    expect(html).not.toContain("inactive in Zoho");
    expect(html).toContain("Nothing to fix in the floor sheet");
  });

  it("renders before the engine has run (no report)", () => {
    const html = render(null);
    expect(html).toContain("SKU Floors - HYDERABAD");
    expect(html).not.toContain("Download as floor template");
  });
});

describe("HydFloorsCard — preview and confirm (moved from HydUploadPanel)", () => {
  const parsed = { ok: true, skuCount: 2, blankSkuRows: 0, unknownSkus: [], duplicateSkus: [], floors: { A: { HYDS01: { min: 1, max: 2 } } } };
  const dry = (outOfRangeSales) => ({ report: { inactiveFloored: [], overrides: [], outOfRangeSales, unknownFloorSkus: [] } });
  const prev = (d) => renderToStaticMarkup(<Preview parsed={parsed} dry={d} skuMaster={skuMaster} currentFloors={{}} />);

  it("lists Pati sales outside the range, collapsible, with its count", () => {
    const html = prev(dry(["B", "C"]));
    expect(html).toContain("Pati sales outside the range");
    expect(html).toMatch(/Pati sales outside the range(<!-- -->)?<span[^>]*> · (<!-- -->)?2</);
  });

  it("renders when the dry run has no report", () => {
    expect(prev(null)).toContain("Pati sales outside the range");
  });

  it("confirm names the city, says Bangalore is not touched; Replace disabled on a failed read or while saving", () => {
    const html = (p) => renderToStaticMarkup(<ReplaceConfirm onReplace={() => {}} onCancel={() => {}} {...p} />);
    const ok = html({ saving: false, readFailed: false });
    expect(ok).toContain("HYDERABAD");
    expect(ok).toContain("Bangalore floors are not touched.");
    expect(ok).toMatch(/<button(?![^>]*disabled)[^>]*>Replace HYDERABAD floors/);
    expect(html({ saving: false, readFailed: true })).toMatch(/<button[^>]*disabled=""[^>]*>Replace HYDERABAD floors/);
    expect(html({ saving: true, readFailed: false })).toContain("Saving…");
  });
});
