// Config that lives in its own `params` row rather than in `params/global`.
//
// WHY OWN ROWS: `params/global` is replaced wholesale on every Apply and loaded
// with a shallow merge (`{...DEFAULT_PARAMS, ...sbParams}`), so a new *nested*
// key there is silently dropped — the `fixedUnitFloor.minNZD` trap.
//
// WHY ONE HELPER: three separate places used to rebuild `activeParams` and
// re-attach these rows by hand. Two of them re-attached the plywood rows but
// missed `pincodeConfig`; since both then call `setParams(activeParams)` and
// `runEngine(activeParams)`, demand attribution silently reverted to "location"
// on every page load. Adding a row must be a one-line change here, not a
// three-site edit that can be done two-thirds of the way.
//
// Loads run in parallel — four sequential round-trips on app start was just waste.

export async function loadParamConfigRows(load, dsList) {
  const [plywood, plywoodV2, pincode, networkConfigs] = await Promise.all([
    load("plywoodNetworkConfig"),
    load("plywoodNetworkV2Config"),
    load("pincodeMap"),
    load("networkConfigs"),
  ]);

  const extra = {};
  if (plywood) extra.plywoodNetworkConfig = plywood;
  if (plywoodV2) extra.plywoodNetworkV2Config = plywoodV2;
  if (pincode) extra.pincodeConfig = pincode;
  if (networkConfigs) {
    extra.dsCapacities = Object.fromEntries(dsList.map((ds) => [ds, {
      thick: networkConfigs[ds]?.thick?.capacity || 0,
      thin: networkConfigs[ds]?.thin?.capacity || 0,
    }]));
  }

  // networkConfigs is returned separately as well: it drives its own React state
  // (the Plywood matrix editor), not just the derived dsCapacities.
  return { extra, networkConfigs: networkConfigs || {} };
}
