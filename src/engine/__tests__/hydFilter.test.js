import { describe, it, expect } from "vitest";
import { runEngine } from "../runEngine.js";
import { DEFAULT_PARAMS } from "../constants.js";

// Spec §4.2: the Bangalore engine must be unaffected by any ds:"HYDS01" row.
// The HYDS01 rows carry a pincode mapped to DS08, so without the filter they
// would reach Bangalore through attribution (DS08) and the DC-only total.
describe("runEngine ignores Hyderabad rows", () => {
  const dates = Array.from({ length: 10 }, (_, i) =>
    new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
  const params = {
    ...DEFAULT_PARAMS,
    overallPeriod: 10,
    recencyWindow: 3,
    categoryStrategies: { Cement: "percentile_cover" },
    pincodeConfig: { mode: "shippingCode", map: { "560009": "DS08" } },
  };
  const hydRows = (sku) => Array.from({ length: 20 }, (_, i) => ({
    date: dates[i % dates.length], sku, ds: "HYDS01", qty: 7,
    shopifyOrder: `h${i}`, pin: "560009",
  }));
  const run = (inv, skuMaster) => runEngine(inv, skuMaster, {}, {}, new Set(), {}, params, {});

  it("a PCT SKU's output is byte-identical with and without HYDS01 rows", () => {
    const skuMaster = {
      A: { sku: "A", name: "A", category: "Cement", brand: "ACC", status: "Active", inventorisedAt: "DS" },
    };
    const base = dates.map((date, i) => ({
      date, sku: "A", ds: "DS01", qty: 3, shopifyOrder: `o${i}`, pin: "560035",
    }));
    const a = run(base, skuMaster);
    const b = run([...base, ...hydRows("A")], skuMaster);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("a DC-only SKU's DC result is unchanged by HYDS01 rows", () => {
    const skuMaster = {
      D: { sku: "D", name: "D", category: "Cement", brand: "ACC", status: "Active",
        inventorisedAt: "DC", move: "No" },
    };
    const base = dates.map((date, i) => ({
      date, sku: "D", ds: "DC01", qty: 2, shopifyOrder: `d${i}`, pin: "560035",
    }));
    const a = run(base, skuMaster);
    const b = run([...base, ...hydRows("D")], skuMaster);
    expect(b.D.dc).toEqual(a.D.dc);
  });
});
