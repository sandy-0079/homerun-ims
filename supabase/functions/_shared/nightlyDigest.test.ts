import { describe, it, expect } from "vitest";
import { assessNight, renderDigest, istDateOf, appendHistory } from "./nightlyDigest.ts";

// The digest fires at 06:30 IST = 01:00 UTC.
const NOW = Date.parse("2026-08-04T01:00:00.000Z");

// Fixtures mirror the REAL payloads read from prod on 2026-08-04, trimmed to the
// fields the digest touches. Grounding them in a live shape is deliberate: a test
// built from an imagined shape proves the assessment logic and nothing about
// whether it can read the rows it will actually be handed.
const healthy = () => ({
  now: NOW,
  invoices: {
    ok: true,
    phase: "published",
    at: "2026-08-03T21:20:07.490Z",
    publishedAt: "2026-08-03T21:20:07.490Z",
    publishedPlan: ["2026-08-03", "2026-07-31"],
    merge: { safe: true, rowsAfter: 77642, datesAfter: 90, datesTrimmed: 4 },
    coverage: { unknownPct: 0 },
  },
  catalogue: {
    ok: true,
    at: "2026-08-03T16:25:21.017Z",
    lastOkNight: "2026-08-03",
    change: { safe: true, reason: "ok", after: 2140 },
    statusMix: { after: { active: 2109 } },
    prices: { merged: { total: 1868, retained: 301 } },
    invAtChanged: { count: 0, toSupplier: [] },
  },
  floors: {
    ok: true,
    at: "2026-08-03T23:05:04.802Z",
    lastOkNight: "2026-08-04",
    skuCount: 1125,
    withFloors: 1125,
    ineffective: { total: 5 },
    change: { reason: "ok" },
  },
  engine: { ok: true, mode: "live", reason: "ok", at: "2026-08-04T00:45:09.354Z", targets: 2038 },
  targets: {
    refreshedAt: "2026-08-04T00:45:07.486Z",
    inputs: { invoiceDataThrough: "2026-08-03", invoiceRows: 77642, skuMaster: 2140, newSKUQty: 1125 },
  },
});

const check = (v: any, key: string) => v.checks.find((c: any) => c.key === key);

// ₹7.9289Cr / ₹5.5581Cr — the real figures measured off prod on 2026-08-04.
const TODAY_VALUE = { min: 55_581_000, max: 79_289_000 };
const YESTERDAY = { date: "2026-08-03", min: 55_000_000, max: 78_289_000 };

describe("appendHistory", () => {
  it("appends today and keeps the list sorted oldest-first", () => {
    const h = appendHistory([YESTERDAY], { date: "2026-08-04", ...TODAY_VALUE }, 60);
    expect(h.map((e: any) => e.date)).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("REPLACES an entry for the same date instead of duplicating it", () => {
    // The digest may be invoked by hand on the same day. A duplicate would make
    // tomorrow's delta compare against a same-day entry and read zero.
    const h = appendHistory(
      [YESTERDAY, { date: "2026-08-04", min: 1, max: 2 }],
      { date: "2026-08-04", ...TODAY_VALUE }, 60,
    );
    expect(h).toHaveLength(2);
    expect(h.at(-1)).toEqual({ date: "2026-08-04", ...TODAY_VALUE });
  });

  it("trims to the newest N days", () => {
    const old = Array.from({ length: 10 }, (_, i) => ({ date: `2026-07-0${i}`, min: i, max: i }));
    const h = appendHistory(old, { date: "2026-08-04", ...TODAY_VALUE }, 3);
    expect(h).toHaveLength(3);
    expect(h.at(-1).date).toBe("2026-08-04");
    expect(h[0].date).toBe("2026-07-08");
  });

  it("copes with a missing or malformed history row", () => {
    expect(appendHistory(null, { date: "2026-08-04", ...TODAY_VALUE }, 60)).toHaveLength(1);
    expect(appendHistory([{ nonsense: true } as any], { date: "2026-08-04", ...TODAY_VALUE }, 60)).toHaveLength(1);
  });
});

describe("inventory value — the directional line", () => {
  const withValue = (extra: any = {}) => {
    const i: any = healthy();
    i.targets.invValue = TODAY_VALUE;
    return { ...i, ...extra };
  };

  it("surfaces today's value once the engine run stamps it", () => {
    expect(assessNight(withValue()).facts.invValue).toEqual(TODAY_VALUE);
  });

  it("computes the delta against the most recent PRIOR day", () => {
    const v = assessNight(withValue({ history: [YESTERDAY] }));
    expect(v.facts.invValueDelta).toMatchObject({ prevDate: "2026-08-03", absMax: 1_000_000 });
    expect(v.facts.invValueDelta.pctMax).toBeCloseTo(1.277, 2);
  });

  it("ignores a history entry for TODAY, so a re-run does not compare today to itself", () => {
    const v = assessNight(withValue({ history: [YESTERDAY, { date: "2026-08-04", ...TODAY_VALUE }] }));
    expect(v.facts.invValueDelta.prevDate).toBe("2026-08-03");
  });

  it("has no delta on the very first reading", () => {
    expect(assessNight(withValue({ history: [] })).facts.invValueDelta).toBeNull();
  });

  it("is informational only — it never changes the alert level", () => {
    const crashed = assessNight(withValue({ history: [{ date: "2026-08-03", min: 1, max: 900_000_000 }] }));
    expect(crashed.level).toBe("green");
  });

  it("degrades to null when the engine run has not stamped it yet", () => {
    // Deploy order must not matter: the digest may go live before run-engine does.
    const v = assessNight(healthy());
    expect(v.facts.invValue).toBeNull();
    expect(v.facts.invValueDelta).toBeNull();
  });
});

describe("targets added/removed — the free change signal already in engineRunStatus", () => {
  it("surfaces the counts", () => {
    const i: any = healthy();
    i.engine.change = { counts: { added: 3, removed: 1 } };
    const v = assessNight(i);
    expect(v.facts).toMatchObject({ targetsAdded: 3, targetsRemoved: 1 });
    expect(renderDigest(v).text).toContain("(3 added, 1 removed)");
  });

  it("omits the parenthetical rather than printing undefined when the row lacks counts", () => {
    const i: any = healthy();
    delete i.engine.change;
    const t = renderDigest(assessNight(i)).text;
    expect(t).not.toContain("undefined");
    expect(t).toMatch(/targets 2,038$/m);
  });
});

describe("renderDigest — the inventory value line", () => {
  const render = (history: any, invValue: any = TODAY_VALUE) => {
    const i: any = healthy();
    i.targets.invValue = invValue;
    return renderDigest(assessNight({ ...i, history })).text;
  };

  it("shows both numbers, the absolute move and the percentage", () => {
    const t = render([YESTERDAY]);
    expect(t).toContain("₹7.93Cr");
    expect(t).toContain("₹5.56Cr");
    expect(t).toMatch(/▲/);
    expect(t).toContain("₹10.0L");
    expect(t).toContain("1.3%");
    expect(t).toContain("2026-08-03");
  });

  it("shows a fall with a down arrow", () => {
    const t = render([{ date: "2026-08-03", min: 56_000_000, max: 81_289_000 }]);
    expect(t).toMatch(/▼/);
    expect(t).toContain("-₹20.0L");
  });

  it("uses crore for a move of a crore or more", () => {
    const t = render([{ date: "2026-08-03", min: 40_000_000, max: 60_000_000 }]);
    expect(t).toContain("₹1.93Cr");
  });

  it("says so plainly on the first reading rather than printing a fake zero", () => {
    expect(render([])).toMatch(/first reading/i);
  });

  it("does not print an inventory value line at all when it is not stamped", () => {
    // `null`, not `undefined` — the helper's default parameter would swallow the latter.
    const t = render([YESTERDAY], null);
    expect(t).not.toMatch(/Inv Value/);
  });
});

describe("istDateOf — IST, not UTC", () => {
  it("rolls the date at 00:00 IST, not 00:00 UTC", () => {
    // 2026-08-03T20:00Z is 01:30 IST on the 4th. A UTC read would say the 3rd.
    expect(istDateOf(Date.parse("2026-08-03T20:00:00Z"))).toBe("2026-08-04");
    expect(istDateOf(Date.parse("2026-08-03T18:00:00Z"))).toBe("2026-08-03");
  });
});

describe("assessNight — the healthy morning of 2026-08-04", () => {
  it("is green when every stage landed on time", () => {
    const v = assessNight(healthy());
    expect(v.level).toBe("green");
    expect(v.checks.every((c: any) => c.level === "green")).toBe(true);
  });

  it("reports today in IST", () => {
    expect(assessNight(healthy()).today).toBe("2026-08-04");
  });

  it("carries the composition facts the guards do not cover", () => {
    const f = assessNight(healthy()).facts;
    expect(f).toMatchObject({
      demandThrough: "2026-08-03",
      invoiceRows: 77642,
      unknownPct: 0,
      master: 2140,
      active: 2109,
      pricesRetained: 301,
      floors: 1125,
      floorsIneffective: 5,
      targets: 2038,
    });
  });
});

describe("invoice demand — red at 2 missed nights, because the D-4 recheck window closes at 4", () => {
  it("is green at the healthy lag of 1 (demand through yesterday)", () => {
    expect(check(assessNight(healthy()), "invoices").level).toBe("green");
  });

  it("is amber after one missed night (lag 2)", () => {
    const i = healthy();
    i.invoices.publishedPlan = ["2026-08-02", "2026-07-30"];
    const c = check(assessNight(i), "invoices");
    expect(c.level).toBe("amber");
    expect(c.missed).toBe(1);
  });

  it("is red after two missed nights (lag 3)", () => {
    const i = healthy();
    i.invoices.publishedPlan = ["2026-08-01", "2026-07-29"];
    const c = check(assessNight(i), "invoices");
    expect(c.level).toBe("red");
    expect(c.missed).toBe(2);
  });

  it("warns that data becomes unrecoverable once the recheck window has passed", () => {
    const i = healthy();
    i.invoices.publishedPlan = ["2026-07-30", "2026-07-27"]; // lag 5
    const c = check(assessNight(i), "invoices");
    expect(c.level).toBe("red");
    expect(c.detail).toMatch(/unrecoverable|backfill/i);
  });
});

describe("catalogue — healthy lag is 1, because it runs BEFORE midnight IST", () => {
  it("is green when lastOkNight is yesterday", () => {
    // 21:55-23:55 IST on the 3rd keys to '2026-08-03'. Treating today's date as the
    // expectation would report a perfectly healthy catalogue as late, every day.
    expect(check(assessNight(healthy()), "catalogue").level).toBe("green");
  });

  it("is amber one night behind, red two", () => {
    const a = healthy(); a.catalogue.lastOkNight = "2026-08-02";
    expect(check(assessNight(a), "catalogue").level).toBe("amber");
    const b = healthy(); b.catalogue.lastOkNight = "2026-08-01";
    expect(check(assessNight(b), "catalogue").level).toBe("red");
  });
});

describe("floors — healthy lag is 0, and there is no amber tier", () => {
  it("is green when lastOkNight is today", () => {
    // 04:35 IST runs AFTER midnight, so its night key is today's date.
    expect(check(assessNight(healthy()), "floors").level).toBe("green");
  });

  it("goes straight to red on the first missed night", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    const c = check(assessNight(i), "floors");
    expect(c.level).toBe("red");
    expect(c.missed).toBe(1);
  });

  it("says new floors are not live, since that is the actual consequence", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    expect(check(assessNight(i), "floors").detail).toMatch(/not live|not applied/i);
  });
});

describe("engine — healthy lag is 0", () => {
  it("is green when toTargets was refreshed today IST", () => {
    expect(check(assessNight(healthy()), "engine").level).toBe("green");
  });

  it("is amber one night behind, red two", () => {
    const a = healthy(); a.targets.refreshedAt = "2026-08-03T00:45:07.486Z";
    expect(check(assessNight(a), "engine").level).toBe("amber");
    const b = healthy(); b.targets.refreshedAt = "2026-08-02T00:45:07.486Z";
    expect(check(assessNight(b), "engine").level).toBe("red");
  });
});

describe("'ran and refused' is a different red from 'never ran'", () => {
  it("calls it refused when the row was written recently but success is stale", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    i.floors.ok = false;
    i.floors.change = { reason: "floor_drop" };
    i.floors.at = "2026-08-03T23:05:04.802Z"; // it DID run last night
    const c = check(assessNight(i), "floors");
    expect(c.mode).toBe("refused");
    expect(c.detail).toMatch(/floor_drop/);
    // A guard refusing is the system protecting you — re-running is the wrong move.
    expect(c.remedy).not.toMatch(/re-?run/i);
  });

  it("calls it silent when the row itself has not been touched", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-02";
    i.floors.at = "2026-08-02T23:05:04.802Z";
    const c = check(assessNight(i), "floors");
    expect(c.mode).toBe("silent");
    expect(c.remedy).toMatch(/re-?run|cron/i);
  });

  it("does NOT call it a refusal when the row still reports ok", () => {
    // A cron that never fired leaves the PREVIOUS successful row in place — recent `at`,
    // ok:true, stale lastOkNight. Judging refusal on recency alone read that as
    // "refused: ok", which is nonsense and points at the wrong remedy.
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    i.floors.at = "2026-08-03T23:05:04.802Z"; // recent, but a SUCCESS record
    const c = check(assessNight(i), "floors");
    expect(c.mode).toBe("silent");
    expect(c.detail).not.toMatch(/refused/i);
  });

  it("says when the refused run was recorded, so 'refused' is never ambiguous", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-02";
    i.floors.ok = false;
    i.floors.change = { reason: "floor_drop" };
    i.floors.at = "2026-08-03T23:05:04.802Z"; // 04:35 IST on the 4th
    expect(check(assessNight(i), "floors").detail).toContain("2026-08-04 04:35 IST");
  });
});

// The 2026-08-15 incident: `sync-sku-floors` refused two nights with
// `reason: "duplicate_sku"` and the email said "refused: reason not stated",
// because this module read `floors.change.reason` and a PARSE failure has no
// `change` object at all. The word that pointed straight at the ops sheet sat in
// the status row for two mornings.
describe("refusal reason — a parse failure names itself", () => {
  it("falls back to the top-level reason when there is no change guard object", () => {
    const i = healthy();
    i.floors = { ok: false, at: "2026-08-03T23:55:02.765Z", lastOkNight: "2026-08-02", reason: "invalid_value" } as any;
    const c = check(assessNight(i), "floors");
    expect(c.mode).toBe("refused");
    expect(c.detail).toContain("invalid_value");
    expect(c.detail).not.toContain("reason not stated");
  });

  it("still prefers change.reason, which is the more specific of the two", () => {
    // sync-catalogue stamps a generic top-level `change_guard_failed` and puts the
    // real verdict in `change.reason`. Preferring the top level would lose it.
    const i = healthy();
    i.catalogue = {
      ok: false, at: "2026-08-03T16:25:21.017Z", lastOkNight: "2026-08-01",
      reason: "change_guard_failed", change: { reason: "active_share_shift" },
    } as any;
    const c = check(assessNight(i), "catalogue");
    expect(c.detail).toContain("active_share_shift");
  });

  it("still says 'reason not stated' when the row genuinely carries neither", () => {
    const i = healthy();
    i.floors = { ok: false, at: "2026-08-03T23:55:02.765Z", lastOkNight: "2026-08-02" } as any;
    expect(check(assessNight(i), "floors").detail).toContain("reason not stated");
  });
});

// Duplicate rows stopped being a failure on 2026-08-15 (the sync now follows the
// ops append rule, last row wins). They are still sheet rot that GROWS — one
// duplicated SKU became 95 in a single day — and the sync has no write access to
// the sheet, so this email is the only thing that will ever tell ops to clean up.
describe("duplicate sheet rows — reported, never alerting", () => {
  const withDupes = () => {
    const i = healthy();
    (i.floors as any).duplicates = { rows: 96, skus: ["S8UHR", "289QJ", "3FKU2"] };
    return i;
  };

  it("carries the superseded ROW count, which is not the SKU count", () => {
    const v = assessNight(withDupes());
    expect(v.facts.floorDuplicateRows).toBe(96);
  });

  it("prints the count on the floors line", () => {
    const { text } = renderDigest(assessNight(withDupes()));
    expect(text).toMatch(/96 duplicate row/);
  });

  it("names the SKUs, because ops has to find them in the sheet by hand", () => {
    const { text } = renderDigest(assessNight(withDupes()));
    expect(text).toContain("S8UHR");
  });

  it("NEVER moves the alert level — the append rule makes them harmless to the engine", () => {
    // Same reasoning as the inventory-value line: nobody has measured how often ops
    // legitimately appends, so a threshold here would be guessed. A red that fires
    // on schedule discredits the reds beside it.
    const v = assessNight(withDupes());
    expect(v.level).toBe("green");
    expect(check(v, "floors").level).toBe("green");
  });

  it("says nothing at all when there are none", () => {
    const { text } = renderDigest(assessNight(healthy()));
    expect(text).not.toMatch(/duplicate row/);
  });

  it("truncates the SKU list and says how many more there are", () => {
    // 95 duplicated SKUs joined into one line is a wall of codes in Gmail. Found by
    // rendering the real email, not by any assertion — the house lesson.
    const i = healthy();
    (i.floors as any).duplicates = {
      rows: 96,
      skus: Array.from({ length: 60 }, (_, n) => `SKU${n}`),
      skuTotal: 95,
    };
    const { text } = renderDigest(assessNight(i));
    expect(text).toContain("SKU0");
    expect(text).not.toContain("SKU59");
    expect(text).toMatch(/\+83 more/);
  });

  it("falls back to the list length when skuTotal is absent", () => {
    // A status row written by the previous deploy has no `skuTotal`. It must still
    // render rather than print "+NaN more".
    const i = healthy();
    (i.floors as any).duplicates = { rows: 2, skus: ["AAA", "BBB"] };
    const { text } = renderDigest(assessNight(i));
    expect(text).toContain("AAA, BBB");
    expect(text).not.toMatch(/NaN|more/);
  });

  it("stays out of an amber subject raised by something else", () => {
    // A green flag rides alongside a real amber one. If it leaked into the subject
    // it would read as a second fault — and `sheetDuplicates` has no FLAG_LABEL, so
    // the raw key would have been printed to the reader.
    const i = withDupes();
    i.invoices.coverage = { unknownPct: 0.7 };
    const { subject } = renderDigest(assessNight(i));
    expect(subject).toMatch(/unknown-SKU rate rising/);
    expect(subject).not.toMatch(/sheetDuplicates|duplicate/i);
  });
});

describe("composition flags — what the guards let through", () => {
  it("raises amber and names every SKU that became Supplier", () => {
    const i = healthy();
    i.catalogue.invAtChanged = { count: 2, toSupplier: ["ABC12", "XYZ99"] };
    const v = assessNight(i);
    expect(v.level).toBe("amber");
    const flag = v.flags.find((f: any) => f.key === "toSupplier");
    expect(flag.level).toBe("amber");
    expect(flag.detail).toContain("ABC12");
    expect(flag.detail).toContain("XYZ99");
  });

  it("stays green when nothing moved to Supplier", () => {
    expect(assessNight(healthy()).flags.some((f: any) => f.key === "toSupplier")).toBe(false);
  });

  it("raises amber when the unknown-SKU rate climbs toward the 1% guard", () => {
    const i = healthy();
    i.invoices.coverage = { unknownPct: 0.62 };
    const v = assessNight(i);
    expect(v.level).toBe("amber");
    expect(v.flags.find((f: any) => f.key === "unknownSku").detail).toMatch(/0\.62/);
  });

  it("flags targets computed from older demand than what is published", () => {
    const i = healthy();
    i.targets.inputs.invoiceDataThrough = "2026-08-02";
    const v = assessNight(i);
    expect(v.flags.find((f: any) => f.key === "targetsBehind")).toBeTruthy();
    expect(v.level).toBe("amber");
  });
});

describe("unknown resolves to RED here — the opposite of the download gate", () => {
  it("goes red on a missing status row rather than assuming it is fine", () => {
    // assessOutputFreshness resolves uncertainty to `unknown` and downloads freely,
    // because blocking a download stops purchasing. Here the action is sending an
    // email, so a spurious red costs thirty seconds and silence costs a night.
    const i = healthy();
    i.catalogue = null;
    const c = check(assessNight(i), "catalogue");
    expect(c.level).toBe("red");
    expect(c.mode).toBe("unreadable");
  });

  it("goes red on a malformed date rather than crashing", () => {
    const i = healthy();
    i.invoices.publishedPlan = ["03/08/2026"]; // the DD/MM/YYYY that took prod down
    const c = check(assessNight(i), "invoices");
    expect(c.level).toBe("red");
    expect(c.mode).toBe("unreadable");
  });

  it("survives every row being absent", () => {
    const v = assessNight({ now: NOW, invoices: null, catalogue: null, floors: null, engine: null, targets: null });
    expect(v.level).toBe("red");
    expect(v.checks).toHaveLength(4);
  });
});

describe("overall level", () => {
  it("takes the worst of every check and flag", () => {
    const i = healthy();
    i.catalogue.lastOkNight = "2026-08-02";        // amber
    i.floors.lastOkNight = "2026-08-03";           // red
    expect(assessNight(i).level).toBe("red");
  });
});

describe("renderDigest", () => {
  it("leads a green subject with the demand date, the fact that matters most", () => {
    const { subject } = renderDigest(assessNight(healthy()));
    // Bracketed prefix FIRST so one mail rule can match every digest regardless of
    // state; the emoji second so the state is scannable without reading.
    expect(subject.startsWith("[IMS] ✅ ")).toBe(true);
    expect(subject).toContain("2026-08-03");
  });

  it("names the failing stage in a red subject, so the inbox line is enough", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    const { subject } = renderDigest(assessNight(i));
    expect(subject.startsWith("[IMS] 🔴 ")).toBe(true);
    expect(subject).toMatch(/floor/i);
  });

  it("puts every composition fact in the body", () => {
    const { text } = renderDigest(assessNight(healthy()));
    for (const s of ["2026-08-03", "77,642", "2,140", "2,109", "1,125", "2,038", "5"]) {
      expect(text).toContain(s);
    }
  });

  it("includes a remedy line for anything not green", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    const { text } = renderDigest(assessNight(i));
    expect(text).toMatch(/what to do/i);
  });

  it("stays honest when every stage ran and only a flag is amber", () => {
    // Saying "some stage(s) need attention" when all four are green sends the reader
    // hunting for a broken stage that does not exist.
    const i = healthy();
    i.catalogue.invAtChanged = { count: 1, toSupplier: ["ABC12"] };
    const { subject, text } = renderDigest(assessNight(i));
    expect(subject).not.toMatch(/check inputs/);
    expect(subject).toMatch(/Supplier/i);
    expect(text).toMatch(/all four .*ran/i);
    // No stage has a remedy, so the heading must not appear empty.
    expect(text).not.toMatch(/what to do/i);
  });

  it("does not write '1 stage(s)'", () => {
    const i = healthy();
    i.floors.lastOkNight = "2026-08-03";
    const { text } = renderDigest(assessNight(i));
    expect(text).toContain("1 stage ");
    expect(text).not.toContain("stage(s)");
  });
});
