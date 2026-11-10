// Hyderabad's own copy of Bangalore's engine settings and plywood config, so
// neither city can change the other's numbers. Pure builders, no I/O.

export const HYD_HIDDEN_KEYS = [
  "newDSList", "openingDSList", "pincodeConfig", "dsCapacities",
  "plywoodNetworkConfig", "plywoodNetworkV2Config", "activeDSCount",
  // DC parameters (spec §3.3): Hyderabad has no DC — its dc is discarded and
  // newDSList is [] — so these are inert there and hidden.
  "dcMult", "dcDeadMult", "skuFloorDCMultMin", "skuFloorDCMultMax", "newDSFloorTopN",
];

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function buildHydParamsFromBangalore(blrParams, nowIso) {
  const out = clone(blrParams || {});
  for (const k of HYD_HIDDEN_KEYS) delete out[k];
  return { ...out, floorsOnly: { HYDS01: true }, orderCycleDays: 3, copiedFromBangaloreAt: nowIso };
}

export function mergeHydParams(defaults, stored) {
  return {
    ...defaults,
    ...(stored || {}),
    floorsOnly: { ...(defaults?.floorsOnly || {}), ...(stored?.floorsOnly || {}) },
  };
}

// Missing or unreadable settings mean floors-only; only an explicit false turns it off.
export function isFloorsOnly(hydParams, ds) {
  return hydParams?.floorsOnly?.[ds] !== false;
}

export function buildHydPlywoodFromBangalore(blrPlywoodNetworkConfig, blrNetworkConfigs) {
  const src = blrPlywoodNetworkConfig || {};
  const { brands = {}, ...top } = src;
  const plywoodNetworkConfig = clone(top);
  plywoodNetworkConfig.brands = {};
  for (const [brand, cfg] of Object.entries(brands)) {
    plywoodNetworkConfig.brands[brand] = {
      nodes: { HYDS01: { covers: ["HYDS01"] } },
      dcMultMin: cfg.dcMultMin,
      dcMultMax: cfg.dcMultMax,
    };
  }
  const nc = blrNetworkConfigs || {};
  const hyd = clone(nc.DS07 ?? nc.DS08) || {};
  hyd.thick = { ...(hyd.thick || {}), capacity: 300 };
  hyd.thin = { ...(hyd.thin || {}), capacity: 150 };
  const networkConfigs = { HYDS01: hyd, global: clone(nc.global) };
  return { plywoodNetworkConfig, networkConfigs };
}
