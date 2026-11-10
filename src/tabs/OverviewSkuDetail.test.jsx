// Overview + SKU Detail take a store list (spec §9): Bangalore's defaults render the
// 8 stores + DC exactly as before; Hyderabad passes ["HYDS01"] with no DC.
// Server render only (no jsdom in this repo), as in StockHealthTab.test.jsx.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../supabase.js", () => ({
  supabase: {}, loadFromSupabase: vi.fn(), saveToSupabase: vi.fn(), loadPayloadKey: vi.fn(),
  READ_ONLY: true, blockedWrites: () => [],
}));

import { OverviewTab, SKUDetailTab } from "../App.jsx";
import { HYD_DS_LIST } from "../city.js";

const noop = () => {};
const meta = { sku: "A", name: "Alpha", category: "Tiles", brand: "X", status: "Active", priceTag: "Medium" };
const blrResults = {
  A: { meta, stores: { DS01: { min: 1, max: 2, mvTag: "Fast" }, DS02: { min: 3, max: 4, mvTag: "Slow" } }, dc: { min: 5, max: 6, mvTag: "Moderate" } },
};
// A dc block with non-zero values, to prove includeDC:false really drops it.
const hydResults = {
  A: { meta, stores: { HYDS01: { min: 2, max: 4, mvTag: "Fast", logicTag: "Floor" } }, dc: { min: 50, max: 60 } },
};
const dates = ["2026-11-01", "2026-11-02"];
const range = { min: dates[0], max: dates[1], dates };
const blrInv = [{ date: dates[0], ds: "DS01", sku: "A", qty: 2 }];
const hydInv = [{ date: dates[1], ds: "HYDS01", sku: "A", qty: 3 }];
const priceData = { A: 1000 };

const ov = (props) => renderToStaticMarkup(
  <OverviewTab priceData={priceData} params={{}} invoiceDateRange={range}
    period="L90D" setPeriod={noop} dateFrom="" setDateFrom={noop} dateTo="" setDateTo={noop}
    store="All" setStore={noop} drill={null} setDrill={noop} onNavigateToSKU={noop} {...props} />);
const sd = (props) => renderToStaticMarkup(
  <SKUDetailTab skuMaster={{ A: meta }} params={{}} invoiceDateRange={range} priceData={priceData}
    skuId="A" setSkuId={noop} searchVal="A" setSearchVal={noop}
    period="L90D" setPeriod={noop} dateFrom="" setDateFrom={noop} dateTo="" setDateTo={noop}
    dsView="All" setDsView={noop} {...props} />);
const hydOv = (extra = {}) => ov({ invoiceData: hydInv, results: hydResults, dsList: HYD_DS_LIST, includeDC: false, ...extra });
const hydSd = (extra = {}) => sd({ invoiceData: hydInv, results: hydResults, dsList: HYD_DS_LIST, includeDC: false, openingList: [], ...extra });

describe("Overview — store list", () => {
  it("Bangalore default: All Locations (incl. DC), every DS and the DC option", () => {
    const html = ov({ invoiceData: blrInv, results: blrResults });
    expect(html).toContain("All Locations (incl. DC)");
    expect(html).toContain('<option value="DC">DC</option>');
    expect(html).toContain('<option value="DS08">DS08</option>');
    expect(html).toContain("₹12.0K"); // DS01+DS02+DC max = 12 × ₹1000 (Inv Value Max)
  });

  it("Hyderabad: HYDS01 only — no DC option, no 'incl. DC', DC excluded from value", () => {
    const html = hydOv();
    expect(html).not.toContain("incl. DC");
    expect(html).not.toContain('value="DC"');
    expect(html).not.toContain('value="DS01"');
    expect(html).toContain('<option value="HYDS01">HYDS01</option>');
    expect(html).toContain("₹4.0K");     // HYDS01 max 4 × ₹1000
    expect(html).not.toContain("₹64.0K"); // would include the dc block
  });

  it("Hyderabad brand drill: movement comes from the store, not a DC", () => {
    const html = hydOv({ drill: { type: "brand", value: "X", category: "Tiles" } });
    expect(html).toContain("Alpha");
    expect(html).toContain("Fast");
  });
});

describe("SKU Detail — store list", () => {
  it("Bangalore default: All + 8 stores in the picker and the DC card", () => {
    const html = sd({ invoiceData: blrInv, results: blrResults });
    expect(html).toContain(">DS08</button>");
    expect(html).toContain(">DC</div>");
  });

  it("Hyderabad: HYDS01 in the picker and a HYDS01 card in its colour, no DC card", () => {
    const html = hydSd();
    expect(html).toContain(">HYDS01</button>");
    expect(html).not.toContain(">DS01");
    expect(html).not.toContain(">DC</div>");
    expect(html).toContain("#1F5FA8");
  });

  it("Hyderabad single-store view renders", () => {
    const html = hydSd({ dsView: "HYDS01" });
    expect(html).toContain("HYDS01");
    expect(html).not.toContain(">DC</div>");
  });
});
