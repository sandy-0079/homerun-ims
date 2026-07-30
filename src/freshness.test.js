import { describe, it, expect } from "vitest";
import {
  formatAge, formatStamp, resolveSource, assessSyncedInput, assessModel,
  MISSED_A_NIGHT_MS, AGEING_MS,
} from "./freshness.js";

const NOW = Date.parse("2026-07-31T06:00:00Z");
const H = 3600_000;
const ago = (ms) => new Date(NOW - ms).toISOString();

describe("formatAge", () => {
  it("reads as age, not as a timestamp", () => {
    expect(formatAge(30_000)).toBe("just now");
    expect(formatAge(6 * 60_000)).toBe("6m ago");
    expect(formatAge(2 * H)).toBe("2h ago");
    expect(formatAge(3 * 24 * H)).toBe("3d ago");
  });

  it("renders an em dash rather than NaN when there is no age", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(-1)).toBe("—");
  });
});

describe("resolveSource — last writer wins, because both write the same key", () => {
  it("reports auto when the sync ran more recently", () => {
    const r = resolveSource({ manualAt: ago(10 * H), autoAt: ago(2 * H), now: NOW });
    expect(r.source).toBe("auto");
    expect(r.age).toBe("2h ago");
  });

  it("reports manual when the upload is the more recent write", () => {
    // The fallback path: a sync broke, an admin uploaded over it.
    const r = resolveSource({ manualAt: ago(1 * H), autoAt: ago(6 * H), now: NOW });
    expect(r.source).toBe("manual");
    expect(r.age).toBe("1h ago");
  });

  it("reports manual when only a manual upload exists", () => {
    // Invoice Data today: sync-invoices publishes to the SHADOW row, so nothing
    // auto has ever written the live value.
    expect(resolveSource({ manualAt: ago(H), autoAt: null, now: NOW }).source).toBe("manual");
  });

  it("reports auto when only a sync exists", () => {
    expect(resolveSource({ manualAt: null, autoAt: ago(H), now: NOW }).source).toBe("auto");
  });

  it("reports none, never a source, when neither has written", () => {
    const r = resolveSource({ manualAt: null, autoAt: null, now: NOW });
    expect(r.source).toBe("none");
    expect(r.age).toBe("—");
  });

  it("ignores a future timestamp rather than treating it as freshest", () => {
    // Clock skew must not let a bogus stamp win the comparison.
    const r = resolveSource({ manualAt: new Date(NOW + H).toISOString(), autoAt: ago(2 * H), now: NOW });
    expect(r.source).toBe("auto");
  });

  it("prefers manual on an exact tie, since the admin acted last deliberately", () => {
    const t = ago(H);
    expect(resolveSource({ manualAt: t, autoAt: t, now: NOW }).source).toBe("manual");
  });
});

describe("assessSyncedInput — cadence only applies to auto", () => {
  it("is ok shortly after a sync", () => {
    expect(assessSyncedInput({ source: "auto", ms: 2 * H }).level).toBe("ok");
  });

  it("is ageing once tonight's run is due", () => {
    expect(assessSyncedInput({ source: "auto", ms: AGEING_MS + H }).level).toBe("ageing");
  });

  it("is stale once the sync has missed a night", () => {
    // The 2026-07-30 case: the cron fired, 429'd, wrote nothing, and the catalogue
    // sat 24h old with no indication anywhere in the UI.
    const r = assessSyncedInput({ source: "auto", ms: MISSED_A_NIGHT_MS + H });
    expect(r.level).toBe("stale");
    expect(r.note).toMatch(/missed a night/);
  });

  it("does NOT call a manual value stale, however old — there is no cadence", () => {
    expect(assessSyncedInput({ source: "manual", ms: 40 * 24 * H }).level).toBe("ok");
  });

  it("is unknown, never ok, when nothing has loaded", () => {
    expect(assessSyncedInput({ source: "none", ms: null }).level).toBe("unknown");
  });
});

describe("assessModel — RELATIVE to its inputs", () => {
  it("is stale when ANY input changed after the last Apply", () => {
    // THE CASE THIS EXISTS FOR. Targets published an hour ago are still wrong if the
    // catalogue moved half an hour ago: the TO tool would keep offering a target for
    // a SKU deleted from Zoho.
    const r = assessModel({
      targetsAt: ago(H),
      inputAts: [{ label: "SKU Master", at: ago(30 * 60_000) }, { label: "Invoice Data", at: ago(5 * H) }],
      now: NOW,
    });
    expect(r.level).toBe("stale");
    expect(r.behind).toEqual(["SKU Master"]);
    expect(r.note).toMatch(/Apply & Re-run Model/);
  });

  it("names every input it is behind, not just the first", () => {
    const r = assessModel({
      targetsAt: ago(5 * H),
      inputAts: [{ label: "SKU Master", at: ago(H) }, { label: "SKU Floors", at: ago(2 * H) }],
      now: NOW,
    });
    expect(r.behind).toEqual(["SKU Master", "SKU Floors"]);
  });

  it("is ok when newer than every input, however old in absolute terms", () => {
    // Absolute age is NOT the signal — there is no schedule to be late against.
    const r = assessModel({
      targetsAt: ago(9 * H),
      inputAts: [{ label: "SKU Master", at: ago(10 * H) }],
      now: NOW,
    });
    expect(r.level).toBe("ok");
    expect(r.behind).toEqual([]);
  });

  it("ignores inputs that have never been written", () => {
    const r = assessModel({ targetsAt: ago(H), inputAts: [{ label: "Dead Stock", at: null }], now: NOW });
    expect(r.level).toBe("ok");
  });

  it("is unknown when the model has never been published", () => {
    expect(assessModel({ targetsAt: null, inputAts: [], now: NOW }).level).toBe("unknown");
  });

  it("is ok at an exact tie, and stale one millisecond behind", () => {
    const t = ago(5 * H);
    expect(assessModel({ targetsAt: t, inputAts: [{ label: "X", at: t }], now: NOW }).level).toBe("ok");
    const later = new Date(Date.parse(t) + 1).toISOString();
    expect(assessModel({ targetsAt: t, inputAts: [{ label: "X", at: later }], now: NOW }).level).toBe("stale");
  });
});

describe("formatStamp", () => {
  it("renders an ISO-ish local stamp, 24-hour so there is no am/pm to misread", () => {
    const s = formatStamp("2026-07-30T09:34:00Z");
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("returns null rather than 'Invalid Date' for a missing or junk value", () => {
    // The whole reason `new Date(x).toISOString()` took prod down on 2026-07-29.
    for (const v of [null, undefined, "", "not a date"]) expect(formatStamp(v)).toBeNull();
  });
});

describe("assessModel — lastRun for the pill", () => {
  it("carries an absolute stamp alongside the relative age", () => {
    const at = ago(2 * H);
    const r = assessModel({ targetsAt: at, inputAts: [], now: NOW });
    expect(r.lastRun).toBe(formatStamp(at));
    expect(r.age).toBe("2h ago");
  });

  it("has no stamp, and says never, when the model has not run", () => {
    const r = assessModel({ targetsAt: null, inputAts: [], now: NOW });
    expect(r.lastRun).toBeNull();
    expect(r.level).toBe("unknown");
  });

  it("still reports staleness even though the pill text is now just a timestamp", () => {
    // The pill lost the words "behind X" — the colour and tooltip carry it instead, so
    // this must keep working or a stale model becomes invisible.
    const r = assessModel({
      targetsAt: ago(2 * H),
      inputAts: [{ label: "SKU Master", at: ago(H) }],
      now: NOW,
    });
    expect(r.level).toBe("stale");
    expect(r.behind).toEqual(["SKU Master"]);
    expect(r.note).toMatch(/Apply & Re-run Model/);
    expect(r.lastRun).not.toBeNull();
  });
});
