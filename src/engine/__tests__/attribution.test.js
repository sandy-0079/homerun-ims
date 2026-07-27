import { describe, it, expect } from "vitest";
import { applyAttribution } from "../attribution.js";
import { runEngine } from "../runEngine.js";
import { DEFAULT_PARAMS } from "../constants.js";

const row = (o) => ({ date: "2026-07-01", sku: "A", ds: "DS02", qty: 3, pin: "560077", ...o });

describe("applyAttribution", () => {
  it("remaps ds from the pincode when mode is shippingCode", () => {
    const out = applyAttribution([row()], { mode: "shippingCode", map: { "560077": "DS06" } });
    expect(out[0].ds).toBe("DS06");
  });

  // ── The off-path must be a true no-op. These are the Stage 2 safety net. ──

  it("returns the input array itself when no config is supplied", () => {
    const inv = [row()];
    expect(applyAttribution(inv, undefined)).toBe(inv);
  });

  it("returns the input array itself in location mode, even with a map present", () => {
    const inv = [row()];
    expect(applyAttribution(inv, { mode: "location", map: { "560077": "DS06" } })).toBe(inv);
  });

  it("keeps the fulfilling ds when the pincode is not in the map", () => {
    const out = applyAttribution([row({ pin: "999999" })], { mode: "shippingCode", map: { "560077": "DS06" } });
    expect(out[0].ds).toBe("DS02");
  });

  it("keeps the fulfilling ds for rows stored before pincodes were captured", () => {
    // Rows already in team_data/invoice_data have no `pin` field at all.
    const out = applyAttribution([{ date: "2026-07-01", sku: "A", ds: "DS02", qty: 3 }],
      { mode: "shippingCode", map: { "560077": "DS06" } });
    expect(out[0].ds).toBe("DS02");
  });

  it("does not mutate the rows it remaps", () => {
    const inv = [row()];
    applyAttribution(inv, { mode: "shippingCode", map: { "560077": "DS06" } });
    expect(inv[0].ds).toBe("DS02");
  });
});

describe("runEngine attribution wiring", () => {
  // A small but real-shaped dataset: two SKUs sold across two stores, where
  // 560077 is physically served by DS02 but belongs to DS06's catchment.
  const skuMaster = {
    A: { sku: "A", name: "A", category: "Cement", brand: "ACC", status: "Active", inventorisedAt: "DC" },
    B: { sku: "B", name: "B", category: "Cement", brand: "ACC", status: "Active", inventorisedAt: "DC" },
  };
  const dates = Array.from({ length: 20 }, (_, i) =>
    new Date(Date.UTC(2026, 5, 12 + i)).toISOString().slice(0, 10));
  const inv = dates.flatMap((date) => [
    { date, sku: "A", ds: "DS02", qty: 4, shopifyOrder: `o${date}1`, pin: "560077" },
    { date, sku: "A", ds: "DS02", qty: 2, shopifyOrder: `o${date}2`, pin: "560016" },
    { date, sku: "B", ds: "DS01", qty: 5, shopifyOrder: `o${date}3`, pin: "560035" },
  ]);
  const params = { ...DEFAULT_PARAMS, overallPeriod: 20, recencyWindow: 5 };
  const run = (p) => runEngine(inv, skuMaster, {}, {}, new Set(), {}, p);

  it("produces identical output with no pincodeConfig and with location mode", () => {
    const noCfg = run(params);
    const location = run({ ...params, pincodeConfig: { mode: "location", map: { "560077": "DS06" } } });
    expect(location).toEqual(noCfg);
  });

  it("moves demand to the mapped DS when shippingCode mode is on", () => {
    const before = run(params);
    const after = run({ ...params, pincodeConfig: { mode: "shippingCode", map: { "560077": "DS06" } } });
    expect(before.A.stores.DS06.min).toBe(0);
    expect(after.A.stores.DS06.min).toBeGreaterThan(0);
    expect(after.A.stores.DS02.min).toBeLessThan(before.A.stores.DS02.min);
  });

  it("leaves SKUs with no remapped pincodes untouched", () => {
    const before = run(params);
    const after = run({ ...params, pincodeConfig: { mode: "shippingCode", map: { "560077": "DS06" } } });
    expect(after.B).toEqual(before.B);
  });
});
