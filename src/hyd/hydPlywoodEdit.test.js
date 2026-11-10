import { describe, it, expect } from "vitest";
import { isBrandOnAt, setBrandOnAt, setCapacity, capacityOf } from "./hydPlywoodEdit.js";

const cfg = { lookbackDays: 90, brands: {
  Greenply: { nodes: { HYDS01: { covers: ["HYDS01"] } }, dcMultMin: 1 },
  Century: { nodes: {}, dcMultMin: 2 },
} };

describe("brand on/off at a store", () => {
  it("reads presence of the store's node", () => {
    expect(isBrandOnAt(cfg, "Greenply", "HYDS01")).toBe(true);
    expect(isBrandOnAt(cfg, "Century", "HYDS01")).toBe(false);
  });
  it("off removes the store from nodes; nothing else changes; no mutation", () => {
    const out = setBrandOnAt(cfg, "Greenply", "HYDS01", false);
    expect(out.brands.Greenply).toEqual({ nodes: {}, dcMultMin: 1 });
    expect(out.lookbackDays).toBe(90);
    expect(out.brands.Century).toBe(cfg.brands.Century);
    expect(cfg.brands.Greenply.nodes.HYDS01).toBeDefined();
  });
  it("on adds a node covering itself", () => {
    const out = setBrandOnAt(cfg, "Century", "HYDS01", true);
    expect(out.brands.Century.nodes).toEqual({ HYDS01: { covers: ["HYDS01"] } });
  });
});

describe("capacity", () => {
  const nc = { HYDS01: { thick: { capacity: 300, coverDays: 3 }, thin: { capacity: 150 } }, global: {} };
  it("sets thick/thin capacity keeping the rest of the node", () => {
    const out = setCapacity(nc, "HYDS01", "thick", 0);
    expect(out.HYDS01.thick).toEqual({ capacity: 0, coverDays: 3 });
    expect(out.HYDS01.thin).toBe(nc.HYDS01.thin);
    expect(nc.HYDS01.thick.capacity).toBe(300);
  });
  it("reads capacity, 0 when absent", () => {
    expect(capacityOf(nc, "HYDS01", "thin")).toBe(150);
    expect(capacityOf({}, "HYDS01", "thin")).toBe(0);
  });
});
