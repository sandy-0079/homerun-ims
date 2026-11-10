// The Hyderabad Logic Tweaker draft: unsaved edits to hydState.hydParams. Held by
// App.jsx as {base, value} so the city toggle and the Hyderabad tab bar can guard it.
// A draft is tied to the hydParams object it started from, so an Apply (which sets a
// new hydParams) discards it without an effect. Pure: no React, no Supabase.
import { isFloorsOnly } from "./hydParams.js";

export const HYD_DISCARD_PROMPT = "You have unsaved Hyderabad settings. Discard them?";

export function hydDraftValue(draft, base) {
  return draft && draft.base === base ? draft.value : base;
}

export function isHydDraftDirty(draft, base) {
  return JSON.stringify(hydDraftValue(draft, base)) !== JSON.stringify(base);
}

/** true = go ahead (and the draft was discarded if there was one); false = stay. */
export function guardHydDraft({ dirty, confirm, discard }) {
  if (!dirty) return true;
  if (!confirm(HYD_DISCARD_PROMPT)) return false;
  discard();
  return true;
}

const STORE = "HYDS01";
const mode = hp => (isFloorsOnly(hp, STORE) ? "Floors only" : "Engine");

/** Changes to the Hyderabad-only keys, for the shared Logic Tweaker's confirm list. */
export function hydOnlyChangelog(saved, draft) {
  const out = [];
  if (mode(saved) !== mode(draft)) out.push(`Pati: ${mode(saved)} → ${mode(draft)}`);
  const sc = saved?.orderCycleDays ?? 3, dc = draft?.orderCycleDays ?? 3;
  if (sc !== dc) out.push(`Order cycle: ${sc}D → ${dc}D`);
  if ((saved?.copiedFromBangaloreAt ?? null) !== (draft?.copiedFromBangaloreAt ?? null))
    out.push(`Re-copied from Bangalore (${draft?.copiedFromBangaloreAt ?? "—"})`);
  return out;
}
