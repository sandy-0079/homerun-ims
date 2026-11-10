// Hyderabad's only contact with Supabase. It reads and writes exactly four new
// rows and never any Bangalore row, which is how Bangalore data stays safe.
//   team_data/hyd_inputs             { floors, uploadedAt }
//   params/hydGlobal                 hydParams
//   params/hydPlywoodNetworkConfig   plywoodNetworkConfig
//   params/hydNetworkConfigs         networkConfigs
import { supabase, saveToSupabase } from "../supabase.js";
import { buildHydParamsFromBangalore, mergeHydParams, buildHydPlywoodFromBangalore } from "./hydParams.js";

// Its own loader, NOT loadFromSupabase: that returns null on a PostgREST error,
// which would make a failed read look like "row missing" — and a save after that
// would overwrite a row nobody read. Here a failed read (error or throw) is kept
// distinct: { data: null, error: "<message>" }; a missing row is { data: null, error: null }.
async function loadHydRow(table, id) {
  try {
    const { data, error } = await supabase.from(table).select("payload").eq("id", id).maybeSingle();
    if (error) return { data: null, error: `${table}/${id}: ${error.message || error}` };
    return { data: data?.payload ?? null, error: null };
  } catch (e) {
    return { data: null, error: `${table}/${id}: ${e?.message || e}` };
  }
}

// True while any Hyderabad row failed to read: downloads and saves stay disabled
// until reload, because what is on screen may be defaults, not the stored values.
export function hydReadFailed(hydState) {
  return Object.values(hydState?.readFailed || {}).some(Boolean);
}

export async function loadHydState(blrParams, blrPlywoodRows) {
  const [inputsR, paramsR, plyR, ncR] = await Promise.all([
    loadHydRow("team_data", "hyd_inputs"),
    loadHydRow("params", "hydGlobal"),
    loadHydRow("params", "hydPlywoodNetworkConfig"),
    loadHydRow("params", "hydNetworkConfigs"),
  ]);
  const loadErrors = [inputsR, paramsR, plyR, ncR].map(r => r.error).filter(Boolean);
  const readFailed = { inputs: !!inputsR.error, params: !!paramsR.error, plywood: !!(plyR.error || ncR.error) };
  const [inputs, storedParams, storedPly, storedNc] = [inputsR.data, paramsR.data, plyR.data, ncR.data];
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
    readFailed,
  };
}

export function saveHydFloors(floors) {
  return saveToSupabase("team_data", "hyd_inputs", { floors, uploadedAt: new Date().toISOString() });
}

export function saveHydParams(hydParams) {
  return saveToSupabase("params", "hydGlobal", hydParams);
}

export async function saveHydPlywood({ plywoodNetworkConfig, networkConfigs }) {
  // Stop at the first failure: never write the second row on top of a failed first.
  if (!(await saveToSupabase("params", "hydPlywoodNetworkConfig", plywoodNetworkConfig))) return false;
  return !!(await saveToSupabase("params", "hydNetworkConfigs", networkConfigs));
}
