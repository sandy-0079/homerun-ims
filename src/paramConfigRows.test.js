import { describe, it, expect } from "vitest";
import { loadParamConfigRows } from "./paramConfigRows.js";

const DS = ["DS01", "DS02"];
const loaderFor = (rows) => async (id) => rows[id] ?? null;

describe("loadParamConfigRows", () => {
  // The regression this exists for: pincodeConfig lives in its own params row,
  // and two of the three places that rebuilt activeParams re-attached the
  // plywood rows but forgot this one. setParams(activeParams) then wiped it and
  // runEngine(activeParams) silently reverted attribution to "location" on every
  // page load. One loader, one list, so a new config row cannot be half-wired.
  it("attaches pincodeConfig from the pincodeMap row", async () => {
    const { extra } = await loadParamConfigRows(loaderFor({ pincodeMap: { mode: "shippingCode", map: { "560077": "DS06" } } }), DS);
    expect(extra.pincodeConfig).toEqual({ mode: "shippingCode", map: { "560077": "DS06" } });
  });

  it("attaches every own-row config in one pass", async () => {
    const { extra } = await loadParamConfigRows(loaderFor({
      plywoodNetworkConfig: { lookbackDays: 45 },
      plywoodNetworkV2Config: { lookbackDays: 90 },
      pincodeMap: { mode: "location" },
      networkConfigs: { DS01: { thick: { capacity: 400 } } },
    }), DS);
    expect(Object.keys(extra).sort()).toEqual(
      ["dsCapacities", "pincodeConfig", "plywoodNetworkConfig", "plywoodNetworkV2Config"]);
  });

  it("omits keys whose row does not exist, so defaults survive", async () => {
    const { extra } = await loadParamConfigRows(loaderFor({}), DS);
    expect(extra).toEqual({});
  });

  it("derives dsCapacities from networkConfigs, defaulting missing capacities to 0", async () => {
    const { extra } = await loadParamConfigRows(
      loaderFor({ networkConfigs: { DS01: { thick: { capacity: 400 }, thin: { capacity: 250 } } } }), DS);
    expect(extra.dsCapacities).toEqual({
      DS01: { thick: 400, thin: 250 },
      DS02: { thick: 0, thin: 0 },
    });
  });

  it("returns networkConfigs separately, since it also drives its own state", async () => {
    const cfg = { DS01: { thick: { capacity: 400 } } };
    const { networkConfigs } = await loadParamConfigRows(loaderFor({ networkConfigs: cfg }), DS);
    expect(networkConfigs).toEqual(cfg);
  });

  it("yields an empty object for networkConfigs when the row is absent", async () => {
    expect((await loadParamConfigRows(loaderFor({}), DS)).networkConfigs).toEqual({});
  });
});
