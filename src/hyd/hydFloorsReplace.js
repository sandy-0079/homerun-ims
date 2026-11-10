// The Hyderabad floors card's upload flow, as pure helpers (as hydApply.js is for the
// Logic Tweaker) so the confirm / refusal path is testable without a DOM:
//   prepareHydFloors  — parse the picked file + dry engine run on the NEW floors. Writes nothing.
//   replaceHydFloors  — the confirmed "Replace HYDERABAD floors": saveHydFloors
//                       (team_data/hyd_inputs only), and hydState changes ONLY after a true save.
import { parseHydFloorsCsv } from "./hydFloors.js";
import { runHydEngine } from "./hydEngine.js";
import { saveHydFloors, hydReadFailed } from "./hydStore.js";
import { HYD_DS_LIST } from "../city.js";

/** SKUs with a Min or Max > 0 at HYDS01. */
export const inRangeCount = floors => Object.values(floors || {}).filter(f => (f?.HYDS01?.min || 0) > 0 || (f?.HYDS01?.max || 0) > 0).length;

/** @returns {{parsed, dry}} — dry is null for a refused file (nothing is run, nothing written). */
export function prepareHydFloors(text, { invoiceData, skuMaster, priceData, deadStock, hydState }) {
  const parsed = parseHydFloorsCsv(text, { dsList: HYD_DS_LIST, knownSkus: new Set(Object.keys(skuMaster || {})) });
  let dry = null;
  if (parsed.ok) {
    try {
      dry = runHydEngine({ invoiceData, skuMaster, priceData, deadStock, floors: parsed.floors, hydParams: hydState.hydParams, hydPlywood: hydState.hydPlywood });
    } catch (err) {
      dry = { error: err?.message || String(err) };
    }
  }
  return { parsed, dry };
}

/** @returns {Promise<boolean>} true only when the floors were saved and hydState updated. */
export async function replaceHydFloors({ floors, hydState, setHydState, setSaving, setStatus }) {
  // A failed Hyderabad read: never replace floors over a row nobody read.
  if (hydReadFailed(hydState)) return false;
  setSaving(true);
  let ok = false;
  try { ok = await saveHydFloors(floors); } catch { ok = false; } finally { setSaving(false); }
  if (!ok) { setStatus({ kind: "error", text: "Save failed — Hyderabad floors were NOT changed." }); return false; }
  setHydState(s => ({ ...s, floors, floorsUploadedAt: new Date().toISOString() }));
  setStatus({ kind: "info", text: `Hyderabad floors replaced: ${inRangeCount(floors).toLocaleString()} SKUs in range.` });
  return true;
}
