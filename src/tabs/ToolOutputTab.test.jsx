// Tool Output Download — Bangalore defaults vs the Hyderabad props (spec §9).
// Server render for the card set; the click paths are driven by walking the element
// tree the component returns, with the download mocked, so the file each card would
// write is asserted directly.
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../supabase.js", () => ({
  loadFromSupabase: vi.fn(async () => ({ packs: { A: 6 }, refreshedAt: "2026-11-09T10:00:00Z" })),
  saveToSupabase: vi.fn(), supabase: {}, loadPayloadKey: vi.fn(), READ_ONLY: true, blockedWrites: () => [],
}));
const downloads = [];
vi.mock("../downloadCsv.js", () => ({ downloadCsvFile: (filename, csv) => downloads.push({ filename, csv }) }));

import ToolOutputTab from "./ToolOutputTab.jsx";
import { DS_LIST } from "../engine/index.js";
import { summariseZeroSale } from "../zeroSaleCsv.js";

const skuMaster = {
  A: { sku: "A", name: "Alpha", category: "Tiles", brand: "X", status: "active", inventorisedAt: "DC" },
  B: { sku: "B", name: "Beta", category: "Tiles", brand: "X", status: "active", inventorisedAt: "DS" },
};
const stores = Object.fromEntries([...DS_LIST, "HYDS01"].map((d, i) => [d, { min: i, max: i + 2 }]));
const results = { A: { meta: { priceTag: "Low", t150Tag: "Top 150" }, stores, dc: { min: 5, max: 9 } },
                  B: { meta: { priceTag: "Low", t150Tag: "Top 150" }, stores, dc: { min: 1, max: 2 } } };
const invoiceData = [{ date: "2026-11-01", ds: "DS01", sku: "A", qty: 1 }];
const fresh = { state: "fresh", blocked: false, pageThrough: "2026-11-01", liveThrough: "2026-11-01" };
const blr = {
  results, skuMaster, params: { openingDSList: [], priceTiers: [3000, 1500, 400, 100] }, priceData: { A: 10 },
  coreOverrides: {}, provRaw: { catalogueAt: null }, outputDemandThrough: "2026-11-01", outputFreshness: fresh,
  zeroSaleLists: summariseZeroSale({ invoiceData, skuMaster }), packsAt: null, setPacksAt: () => {}, fmtStamp: () => null,
};
const poCard = { title: "PO — Hyderabad (HYDS01 Pati)", note: "Pati targets", columns: 9,
  build: () => "h1,h2\nx,y", filename: () => "PO_Hyderabad_2026-11-10.csv" };
const hyd = { ...blr, dsList: ["HYDS01"], includeDC: false, zeroSaleLists: null, poCard };

const html = (p) => renderToStaticMarkup(<ToolOutputTab {...p} />);
const cardProps = (p) => {
  const acc = [];
  const walk = (el) => {
    if (!el || typeof el !== "object") return;
    if (Array.isArray(el)) return el.forEach(walk);
    if (el.props?.title && el.props.cta) acc.push(el.props);
    walk(el.props?.children);
  };
  walk(ToolOutputTab(p));
  return Object.fromEntries(acc.map(c => [c.title, c]));
};
const disabledButton = (h, label) => new RegExp(`<button[^>]*disabled=""[^>]*>[^<]*${label}`).test(h);
beforeEach(() => { downloads.length = 0; });

describe("ToolOutputTab — Bangalore defaults", () => {
  it("has the PO, DS Level, DC, SKU Master, Zero Sale, Inner Case Pack and Purchase Prices cards", () => {
    const h = html(blr);
    for (const t of ["PO Team Download", "Tool Output — DS Level", "Tool Output — DC", "SKU Master",
      "Zero Sale SKUs", "Inner Case Pack - Mid Mile", "Purchase Prices"]) expect(h).toContain(t);
    expect(h).toContain("DC and DS01–DS06 side by side");
    expect(h).toContain("15 columns · 2 SKUs");
    expect(disabledButton(h, "⬇ PO Team Download")).toBe(false);
  });

  it("PO card writes Bangalore's frozen file (DC + every live DS, Purchase, Move)", async () => {
    await cardProps(blr)["PO Team Download"].onClick();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toMatch(/^PO_Targets_\d{4}-\d{2}-\d{2}_demand-thru-2026-11-01\.csv$/);
    const hdr = downloads[0].csv.split("\n")[0];
    expect(hdr).toContain('"DC Min","DC Max","DS01 Min"');
    expect(hdr).toContain('"DS08 Max","Purchase","Move"');
  });

  it("DS Level file has every DS_LIST store", () => {
    cardProps(blr)["Tool Output — DS Level"].onClick();
    expect(downloads[0].csv.split("\n")[0]).toBe(["Item Name", "SKU", "Category", ...DS_LIST.flatMap(d => [`${d} Min`, `${d} Max`])].join(","));
  });
});

describe("ToolOutputTab — Hyderabad props", () => {
  it("hides the DC, Inner Case Pack and Zero Sale cards; the PO card comes from poCard", () => {
    const h = html(hyd);
    expect(h).not.toContain("Tool Output — DC");
    expect(h).not.toContain("Inner Case Pack - Mid Mile");
    expect(h).not.toContain("Zero Sale SKUs");
    expect(h).not.toContain("PO Team Download");
    expect(h).not.toContain("DC and DS01–DS06");
    expect(h).toContain("⬇ PO — Hyderabad (HYDS01 Pati)");
    expect(h).toContain("Pati targets");
    expect(h).toContain("9 columns · 2 SKUs");
    expect(h).toContain("5 columns · 2 SKUs"); // DS Level: 3 + HYDS01 Min/Max
    expect(h).toContain("SKU Master");
    expect(h).toContain("Purchase Prices");
  });

  it("PO download writes poCard's file, not Bangalore's", async () => {
    await cardProps(hyd)["PO — Hyderabad (HYDS01 Pati)"].onClick();
    expect(downloads).toEqual([{ filename: "PO_Hyderabad_2026-11-10.csv", csv: "h1,h2\nx,y" }]);
  });

  it("an empty poCard build alerts and downloads nothing", async () => {
    const alert = vi.fn(); globalThis.alert = alert;
    await cardProps({ ...hyd, poCard: { ...poCard, build: () => null } })["PO — Hyderabad (HYDS01 Pati)"].onClick();
    expect(alert).toHaveBeenCalledWith("No SKU Master loaded — nothing to download.");
    expect(downloads).toHaveLength(0);
  });

  it("DS Level file has only the given stores", () => {
    cardProps(hyd)["Tool Output — DS Level"].onClick();
    const [hdr, row] = downloads[0].csv.split("\n");
    expect(hdr).toBe("Item Name,SKU,Category,HYDS01 Min,HYDS01 Max");
    expect(row).toBe(`"Alpha","A","Tiles",8,10`);
  });

  it("downloadsDisabled (a failed Hyderabad read) disables the PO and every other card", () => {
    const h = html({ ...hyd, downloadsDisabled: true });
    expect(disabledButton(h, "⬇ PO — Hyderabad")).toBe(true);
    expect(disabledButton(h, "⬇ Download DS Level")).toBe(true);
    expect(disabledButton(h, "⬇ Download SKU Master")).toBe(true);
    expect(disabledButton(h, "⬇ Download Purchase Prices")).toBe(true);
    expect(disabledButton(html(hyd), "⬇ PO — Hyderabad")).toBe(false);
  });
});
