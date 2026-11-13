// Smoke render of Stock Health (no React testing library in this repo:
// react-dom/server proves the tab renders, which `npm run build` cannot — see
// src/tabs/CLAUDE.md). (a) Bangalore passes none of the optional props and must
// keep its DC tab and every DC-derived column; (b) Hyderabad passes the
// one-store, no-DC props.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../supabase.js", () => ({ supabase: {}, READ_ONLY: true }));

import StockHealthTab, { startOrdersSync } from "./StockHealthTab.jsx";
import { HYD_DS_LIST } from "../city.js";

const meta = (name, inventorisedAt) => ({ name, category: "Tiles", brand: "X", status: "Active", inventorisedAt });
const BLR_STORES = ["DS01", "DS02", "DS03", "DS04", "DS05", "DS06", "DS07", "DS08"];
const blrStores = (min, max) => Object.fromEntries(BLR_STORES.map(ds => [ds, { min, max, dailyAvg: 2, mvTag: "Fast" }]));

const blrResults = {
  A: { meta: meta("Alpha", "DC"), stores: blrStores(2, 4), dc: { min: 10, max: 20 } },
  B: { meta: meta("Beta", "DS"), stores: blrStores(1, 2), dc: { min: 0, max: 0 } },
};
const blrStock = { A: { DS01: { stock_on_hand: 9, available_for_sale: 9 }, DC: { stock_on_hand: 30 } }, B: { DS01: { stock_on_hand: 0 } } };

const hydResults = {
  P: { meta: meta("Pati Tile", "DC"), stores: { HYDS01: { min: 3, max: 7, dailyAvg: 1, logicTag: "Hyd Floor" } }, dc: { min: 0, max: 0 } },
  // Inventorised At=Supplier with a Hyderabad floor: Pati stocks it (spec §3.2).
  S: { meta: meta("Supplier Tile", "Supplier"), stores: { HYDS01: { min: 2, max: 5, dailyAvg: 0, logicTag: "Hyd Floor" } }, dc: { min: 0, max: 0 } },
};

const renderBlr = () => renderToStaticMarkup(
  <StockHealthTab results={blrResults} skuMaster={{}} stockData={blrStock} stockDataAccounting={{}}
    uploadedAtPerDS={{ DS01: "2026-11-01T00:00:00Z", DC: "2026-11-01T00:00:00Z" }} poData={{}} toData={{}} />,
);

const renderHyd = (uploadedAtPerDS = {}) => renderToStaticMarkup(
  <StockHealthTab results={hydResults} skuMaster={{}} stockData={blrStock} stockDataAccounting={{}}
    uploadedAtPerDS={uploadedAtPerDS} dsList={HYD_DS_LIST} includeDC={false}
    syncGroups={[["HYDS01"]]} syncOrders={false} defaultDS="HYDS01" filePrefix="Hyderabad_" />,
);

describe("StockHealthTab — Bangalore (no new props)", () => {
  it("keeps the DC tab, every store tab and the DC-derived elements", () => {
    const html = renderBlr();
    expect(html).toContain(">DC<");
    for (const ds of BLR_STORES) expect(html).toContain(`>${ds}<`);
    expect(html).toContain("DC Stock");
    expect(html).toContain("No TO");
    expect(html).toContain("All TO Status");
    expect(html).toContain("Download Reverse TO list");
    expect(html).not.toContain("HYDS01");
  });

  it("keeps Sync Now", () => {
    expect(renderBlr()).toContain("Sync Now");
  });

  it("Sync Now still kicks off sync-orders by default", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    await startOrdersSync({ functions: { invoke } }, true);
    expect(invoke).toHaveBeenCalledWith("sync-orders");
  });
});

describe("StockHealthTab — Hyderabad (one store, no DC)", () => {
  it("shows HYDS01 only, and no DC tab or DC-derived element", () => {
    const html = renderHyd();
    expect(html).toContain(">HYDS01<");
    expect(html).not.toContain(">DC<");
    expect(html).not.toContain(">DS01<");
    expect(html).not.toContain("DC Stock");
    expect(html).not.toContain("No TO");
    expect(html).not.toContain("All TO Status");
    expect(html).not.toContain("Reverse TO");
    expect(html).not.toContain("DS Req Covered");
  });

  it("renders targets before the stock sync exists, with a note instead of the waiting screen", () => {
    const html = renderHyd();
    expect(html).toContain("Pati Tile");
    expect(html).toContain("Live stock for HYDS01 starts once the stock sync is enabled");
    expect(html).not.toContain("Waiting for first sync");
  });

  it("keeps a floored Supplier SKU, which Pati stocks", () => {
    expect(renderHyd()).toContain("Supplier Tile");
  });

  it("drops the note once HYDS01 has synced", () => {
    expect(renderHyd({ HYDS01: "2026-11-10T00:00:00Z" })).not.toContain("Live stock for HYDS01");
  });

  it("hides Sync Now while HYDS01 has never synced, and shows it once it has", () => {
    expect(renderHyd()).not.toContain("Sync Now");
    expect(renderHyd({ HYDS01: "2026-11-10T00:00:00Z" })).toContain("Sync Now");
  });

  it("syncOrders=false never invokes sync-orders (a Bangalore row)", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    await startOrdersSync({ functions: { invoke } }, false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("StockHealthTab — downloadsDisabled (Hyderabad: a failed read)", () => {
  const dlButtons = (html) => html.match(/<button[^>]*>[^<]*⬇ Download[^<]*/g) || [];
  it("default (Bangalore): both downloads enabled, no tooltip", () => {
    const btns = dlButtons(renderBlr());
    expect(btns).toHaveLength(2); // Download All SKUs + Reverse TO list
    for (const b of btns) { expect(b).not.toContain("disabled"); expect(b).not.toContain("title="); }
  });
  it("downloadsDisabled disables every download, with the reload tooltip", () => {
    const html = renderToStaticMarkup(
      <StockHealthTab results={blrResults} skuMaster={{}} stockData={blrStock} stockDataAccounting={{}}
        uploadedAtPerDS={{ DS01: "2026-11-01T00:00:00Z", DC: "2026-11-01T00:00:00Z" }} poData={{}} toData={{}} downloadsDisabled />);
    const btns = dlButtons(html);
    expect(btns).toHaveLength(2);
    for (const b of btns) {
      expect(b).toContain('disabled=""');
      expect(b).toContain('title="Hyderabad data could not be read — reload"');
    }
  });
});

describe("StockHealthTab — Floor / Ceiling columns and filter", () => {
  const renderBounds = (extra = {}) => renderToStaticMarkup(
    <StockHealthTab results={blrResults} skuMaster={{}} stockData={blrStock} stockDataAccounting={{}}
      uploadedAtPerDS={{ DS01: "2026-11-01T00:00:00Z", DC: "2026-11-01T00:00:00Z" }} poData={{}} toData={{}} {...extra} />,
  );
  const cells = (html) => [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1]);

  it("adds the two headers and the filter in both cities", () => {
    for (const html of [renderBlr(), renderHyd()]) {
      expect(html).toContain(">Floor<");
      expect(html).toContain(">Ceiling<");
      expect(html).toContain("All Floor/Ceiling");
      expect(html).toContain("No Floor &amp; No Ceiling");
    }
  });

  it("puts Floor right after AFS and Ceiling right after Max", () => {
    const heads = [...renderBlr().matchAll(/<th[^>]*>(?:<span[^>]*>)?([^<]+)/g)].map(m => m[1]);
    const i = heads.indexOf("AFS");
    expect(heads.slice(i, i + 5)).toEqual(["AFS", "Floor", "Min", "Max", "Ceiling"]);
  });

  it("shows the floor as min/max and a 0 ceiling as 0, at the selected store", () => {
    const html = renderBounds({
      floors:   { A: { DS01: { min: 3, max: 5 } } },
      ceilings: { A: { DS01: 0 }, B: { DS02: 9 } },   // B's cap is at DS02, not DS01
    });
    expect(cells(html)).toContain("3/5");
    expect(html).toContain('title="Ceiling 0"');          // a 0 cap is a cap
    expect(html).not.toContain('title="Ceiling 9"');      // DS02's cap stays off DS01
    expect(html).toContain('title="No ceiling at this location"');
  });

  it("shows a dash when a row has neither (Bangalore without the new props)", () => {
    expect(cells(renderBlr()).filter(t => t === "—").length).toBeGreaterThan(0);
  });

  it("Hyderabad shows its own floor", () => {
    const html = renderToStaticMarkup(
      <StockHealthTab results={hydResults} skuMaster={{}} stockData={blrStock} stockDataAccounting={{}}
        uploadedAtPerDS={{}} dsList={HYD_DS_LIST} includeDC={false} floors={{ P: { HYDS01: { min: 3, max: 7 } } }}
        syncGroups={[["HYDS01"]]} syncOrders={false} defaultDS="HYDS01" filePrefix="Hyderabad_" />,
    );
    expect(cells(html)).toContain("3/7");
  });
});
