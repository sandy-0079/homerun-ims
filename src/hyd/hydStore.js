// Hyderabad's only contact with Supabase. It reads and writes exactly four new
// rows and never any Bangalore row, which is how Bangalore data stays safe.
//   team_data/hyd_inputs             { floors, uploadedAt }
//   params/hydGlobal                 hydParams
//   params/hydPlywoodNetworkConfig   plywoodNetworkConfig
//   params/hydNetworkConfigs         networkConfigs
import { loadFromSupabase, saveToSupabase } from "../supabase.js";
import { buildHydParamsFromBangalore, mergeHydParams, buildHydPlywoodFromBangalore } from "./hydParams.js";

// A read that throws is treated as a missing row so the app never white-pages;
// the message is surfaced to the caller through loadErrors.
async function safeLoad(table, id, errors) {
  try {
    return await loadFromSupabase(table, id);
  } catch (e) {
    errors.push(`${table}/${id}: ${e?.message || e}`);
    return null;
  }
}

export async function loadHydState(blrParams, blrPlywoodRows) {
  const loadErrors = [];
  const [inputs, storedParams, storedPly, storedNc] = await Promise.all([
    safeLoad("team_data", "hyd_inputs", loadErrors),
    safeLoad("params", "hydGlobal", loadErrors),
    safeLoad("params", "hydPlywoodNetworkConfig", loadErrors),
    safeLoad("params", "hydNetworkConfigs", loadErrors),
  ]);
  const hydParams = mergeHydParams(
    buildHydParamsFromBangalore(blrParams, new Date().toISOString()),
    storedParams,
  );
  const plywoodStored = !!(storedPly && storedNc);
  const hydPlywood = plywoodStored
    ? { plywoodNetworkConfig: storedPly, networkConfigs: storedNc }
    : buildHydPlywoodFromBangalore(blrPlywoodRows?.plywoodNetworkConfig, blrPlywoodRows?.networkConfigs);
  return {
    floors: inputs?.floors ?? {},
    floorsUploadedAt: inputs?.uploadedAt ?? null,
    hydParams,
    hydPlywood,
    stored: { params: !!storedParams, plywood: plywoodStored },
    loadErrors,
  };
}

export function saveHydFloors(floors) {
  return saveToSupabase("team_data", "hyd_inputs", { floors, uploadedAt: new Date().toISOString() });
}

export function saveHydParams(hydParams) {
  return saveToSupabase("params", "hydGlobal", hydParams);
}

export async function saveHydPlywood({ plywoodNetworkConfig, networkConfigs }) {
  const a = await saveToSupabase("params", "hydPlywoodNetworkConfig", plywoodNetworkConfig);
  const b = await saveToSupabase("params", "hydNetworkConfigs", networkConfigs);
  return a && b;
}
