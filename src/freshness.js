// Where each input's current value came from, and whether the model has caught up.
//
// WHY: on 2026-07-30 the nightly `sync-catalogue` had silently failed and the
// catalogue sat 24h stale. Nothing in the UI said so — finding it took a Management
// API dig through `function_logs`. Anyone opening IMS should be able to see it.
//
// ⚠ PROVENANCE IS DERIVED, NOT STORED. Auto timestamps already live in
// `params/catalogueSyncStatus.at` and `params/invoiceSyncStatus`; the browser records
// ONLY its own manual uploads, in `params/uploadProvenance`. The card then compares
// the two and reports whichever is later.
//
// That is deliberate. A single shared `provenance` object written by both the edge
// functions and the browser would recreate the write-write conflict fixed this same
// day in teamDataBundle.js — and would give one fact two homes, which is the opposite
// of a single source of truth. Every key here has exactly one writer.
//
// ⚠ A COUNT NEVER DEPENDS ON PROVENANCE. Counts come from inputSummary.js and are
// computed from the stored data, so they are right however it arrived. Source and
// time are a label beside the number, never an input to it.

export const MISSED_A_NIGHT_MS = 30 * 3600_000;   // nightly cadence + margin
export const AGEING_MS = 18 * 3600_000;

/** Compact relative age. Age is the decision-relevant number; the absolute
 *  timestamp belongs in the tooltip. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const parse = (v) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
};
// A future timestamp is clock skew. Never report freshness off a value we can't trust.
const usable = (t, now) => (t !== null && t <= now ? t : null);

/**
 * Which write produced the value on screen: the later of the two, since both write
 * the same key and last writer wins.
 * @returns {{source:"auto"|"manual"|"none", at:string|null, age:string, ms:number|null}}
 */
export function resolveSource({ manualAt, autoAt, now }) {
  const m = usable(parse(manualAt), now);
  const a = usable(parse(autoAt), now);
  if (m === null && a === null) return { source: "none", at: null, age: "—", ms: null };
  const useManual = a === null || (m !== null && m >= a);
  const t = useManual ? m : a;
  return {
    source: useManual ? "manual" : "auto",
    at: new Date(t).toISOString(),
    age: formatAge(now - t),
    ms: now - t,
  };
}

/**
 * Is an auto-synced input overdue? Only meaningful for inputs on a nightly
 * schedule — an input last set by hand has no cadence to be late against.
 */
export function assessSyncedInput({ source, ms }) {
  if (source === "none") return { level: "unknown", note: "Never loaded" };
  if (source === "manual") return { level: "ok", note: "Set by a manual upload" };
  if (ms >= MISSED_A_NIGHT_MS) return { level: "stale", note: "Auto-sync has missed a night" };
  if (ms >= AGEING_MS) return { level: "ageing", note: "Auto-sync is due tonight" };
  return { level: "ok", note: "Auto-synced from Zoho" };
}

/** `YYYY-MM-DD HH:mm` in the viewer's local time. ISO-ish to match how dates read
 *  everywhere else in the app (the date-range strip shows 2026-04-30 → 2026-07-28),
 *  and 24-hour so there is no am/pm to misread on a glance. */
export function formatStamp(at) {
  const t = Date.parse(String(at ?? ""));
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Has the model caught up with its inputs?
 *
 * ⚠ RELATIVE, NOT ABSOLUTE. `params/toTargets` is written only when a human clicks
 * Apply & Re-run Model (App.jsx is the sole writer until Stage 6), so there is no
 * schedule for it to be late against and absolute age says little. What matters is
 * whether ANY input changed after the last Apply — that is exactly the 2026-07-30
 * defect: a SKU deleted from Zoho vanished from IMS immediately (the engine
 * recomputes client-side each load) while the TO tool kept offering a target for it,
 * because nothing had rewritten toTargets.
 *
 * @param inputAts array of ISO timestamps, one per input's current value
 */
export function assessModel({ targetsAt, inputAts = [], now }) {
  const t = usable(parse(targetsAt), now);
  if (t === null) {
    return { level: "unknown", note: "Model has never been run", age: "—", lastRun: null, behind: [] };
  }

  const behind = inputAts
    .map(({ label, at }) => ({ label, ms: usable(parse(at), now) }))
    .filter((x) => x.ms !== null && x.ms > t)
    .map((x) => x.label);

  // `lastRun` is the absolute stamp shown on the pill; `age` stays available for the
  // tooltip and any caller that wants the relative reading.
  const common = { age: formatAge(now - t), lastRun: formatStamp(targetsAt) };
  return behind.length
    ? {
        ...common, level: "stale", behind,
        note: `Ran ${formatAge(now - t)}, but ${behind.join(", ")} changed since — click Apply & Re-run Model`,
      }
    : { ...common, level: "ok", behind: [], note: `Ran ${formatAge(now - t)}; newer than every input` };
}
