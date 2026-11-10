// Smoke render of the floor-upload preview (react-dom/server; no testing library
// in this repo). The preview sits behind a file pick, so it is rendered directly.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../supabase.js", () => ({ loadFromSupabase: vi.fn(), saveToSupabase: vi.fn(), supabase: {} }));

import { Preview } from "./HydUploadPanel.jsx";

const parsed = { ok: true, skuCount: 2, blankSkuRows: 0, unknownSkus: [], duplicateSkus: [], floors: { A: { HYDS01: { min: 1, max: 2 } } } };
const skuMaster = { A: { name: "Alpha" }, B: { name: "Beta" }, C: { name: "Gamma" } };
const dry = (outOfRangeSales) => ({ report: { inactiveFloored: [], overrides: [], outOfRangeSales, unknownFloorSkus: [] } });
const render = (d) => renderToStaticMarkup(<Preview parsed={parsed} dry={d} skuMaster={skuMaster} currentFloors={{}} />);

describe("HydUploadPanel preview", () => {
  it("lists Pati sales outside the range, collapsible, with its count", () => {
    const html = render(dry(["B", "C"]));
    expect(html).toContain("Pati sales outside the range");
    expect(html).toMatch(/Pati sales outside the range(<!-- -->)?<span[^>]*> · (<!-- -->)?2</);
  });

  it("renders when the dry run has no report", () => {
    expect(render(null)).toContain("Pati sales outside the range");
  });
});
