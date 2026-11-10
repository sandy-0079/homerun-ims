// Hyderabad's Logic Tweaker Apply. Writes ONLY params/hydGlobal (saveHydParams) —
// never applyAndRun / saveTeamData, which are Bangalore's.
import { saveHydParams, hydReadFailed } from "./hydStore.js";
import { NOT_SAVED_BEFORE } from "../tabs/hyd/hydStyles.js";

/** @returns {Promise<{kind:"info"|"error", text:string} | null>} null = the user cancelled */
export async function applyHydParams({ draft, hydState, setHydState, confirm }) {
  // Never after a failed read: what is on screen may be defaults over a row nobody read.
  if (hydReadFailed(hydState)) return { kind: "error", text: "Hyderabad data could not be read — reload before applying." };
  if (!hydState?.stored?.params && !confirm(NOT_SAVED_BEFORE)) return null;
  const ok = await saveHydParams(draft);
  if (!ok) return { kind: "error", text: "Save failed — Hyderabad settings were NOT changed." };
  setHydState(s => ({ ...s, hydParams: draft, stored: { ...s.stored, params: true } }));
  return { kind: "info", text: "Hyderabad settings applied (params/hydGlobal). Bangalore settings were not touched." };
}
