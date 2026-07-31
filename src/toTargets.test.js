import { describe, it, expect } from "vitest";
import { mergeCoreOverrides, buildToTargets, assessTargetsChange, buildInputsStamp } from "./toTargets.js";

const DS = ["DS01", "DS02", "DS03"];

// Minimal engine-result shape: what runEngine emits per SKU.
const res = (meta, stores) => ({ meta, stores });
const dc = (over = {}) => ({ name: "Widget", category: "Tiling", brand: "Acme", inventorisedAt: "DC", status: "active", ...over });

describe("buildToTargets — who gets into the TO tool's slice", () => {
  it("includes a DC-inventorised active SKU with its per-DS min/max", () => {
    const t = buildToTargets({ A: res(dc(), { DS01: { min: 2, max: 5 } }) }, DS);
    expect(t).toEqual({
      A: { name: "Widget", category: "Tiling", brand: "Acme", perDS: { DS01: { min: 2, max: 5 } } },
    });
  });

  it("excludes a SKU that is not active", () => {
    const t = buildToTargets({ A: res(dc({ status: "inactive" }), { DS01: { min: 2, max: 5 } }) }, DS);
    expect(t).toEqual({});
  });

  it("excludes confirmation_pending — the allowlist is exactly 'active'", () => {
    // Zoho's status vocabulary can grow; anything but `active` must be excluded.
    const t = buildToTargets({ A: res(dc({ status: "confirmation_pending" }), { DS01: { min: 1, max: 1 } }) }, DS);
    expect(t).toEqual({});
  });

  it("treats a MISSING status as active, the established (status || 'Active') convention", () => {
    const m = dc(); delete m.status;
    const t = buildToTargets({ A: res(m, { DS01: { min: 1, max: 2 } }) }, DS);
    expect(Object.keys(t)).toEqual(["A"]);
  });

  it("excludes DS-inventorised and Supplier SKUs", () => {
    const t = buildToTargets({
      A: res(dc({ inventorisedAt: "DS" }), { DS01: { min: 1, max: 2 } }),
      B: res(dc({ inventorisedAt: "Supplier" }), { DS01: { min: 1, max: 2 } }),
    }, DS);
    expect(t).toEqual({});
  });

  it("⚠ excludes a MISSING inventorisedAt — it must default to DS, never DC", () => {
    // The engine fabricates meta for SKUs absent from skuMaster. CLAUDE.md records
    // that toTargets escaping phantom SKUs was luck: had the default been "DC",
    // they would have reached the DC team's transfer orders. Pin the default.
    const m = dc(); delete m.inventorisedAt;
    const t = buildToTargets({ A: res(m, { DS01: { min: 1, max: 2 } }) }, DS);
    expect(t).toEqual({});
  });

  it("matches inventorisedAt and status case-insensitively", () => {
    const t = buildToTargets({ A: res(dc({ inventorisedAt: "dc", status: "Active" }), { DS01: { min: 1, max: 2 } }) }, DS);
    expect(Object.keys(t)).toEqual(["A"]);
  });

  it("emits only DSes present in stores, in DS_LIST order", () => {
    const t = buildToTargets({ A: res(dc(), { DS03: { min: 3, max: 4 }, DS01: { min: 1, max: 2 } }) }, DS);
    expect(Object.keys(t.A.perDS)).toEqual(["DS01", "DS03"]);
  });

  it("falls back to the SKU id when the name is missing", () => {
    const m = dc(); delete m.name;
    const t = buildToTargets({ ABC: res(m, { DS01: { min: 1, max: 1 } }) }, DS);
    expect(t.ABC.name).toBe("ABC");
    expect(t.ABC.category).toBe("Tiling");
  });

  it("survives a SKU with no meta and no stores without throwing", () => {
    const t = buildToTargets({ A: {} }, DS);
    expect(t).toEqual({});
  });
});

describe("mergeCoreOverrides — per-field max, never a downgrade", () => {
  it("raises min and max when the override is higher", () => {
    const merged = mergeCoreOverrides(
      { A: res(dc(), { DS01: { min: 1, max: 2 } }) },
      { A: { DS01: { min: 3, max: 7 } } },
    );
    expect(merged.A.stores.DS01).toMatchObject({ min: 3, max: 7 });
  });

  it("NEVER lowers a value — it is a floor, not an assignment", () => {
    const merged = mergeCoreOverrides(
      { A: res(dc(), { DS01: { min: 9, max: 20 } }) },
      { A: { DS01: { min: 3, max: 7 } } },
    );
    expect(merged.A.stores.DS01).toMatchObject({ min: 9, max: 20 });
  });

  it("raises each field independently", () => {
    const merged = mergeCoreOverrides(
      { A: res(dc(), { DS01: { min: 1, max: 20 } }) },
      { A: { DS01: { min: 5, max: 7 } } },
    );
    expect(merged.A.stores.DS01).toMatchObject({ min: 5, max: 20 });
  });

  it("ignores an override for a SKU the engine did not emit", () => {
    const merged = mergeCoreOverrides({ A: res(dc(), { DS01: { min: 1, max: 2 } }) }, { GHOST: { DS01: { min: 9, max: 9 } } });
    expect(Object.keys(merged)).toEqual(["A"]);
  });

  it("ignores an override for a DS the SKU is not stocked at", () => {
    const merged = mergeCoreOverrides({ A: res(dc(), { DS01: { min: 1, max: 2 } }) }, { A: { DS02: { min: 9, max: 9 } } });
    expect(merged.A.stores.DS02).toBeUndefined();
  });

  it("does not mutate the engine result it was given", () => {
    const raw = { A: res(dc(), { DS01: { min: 1, max: 2 } }) };
    mergeCoreOverrides(raw, { A: { DS01: { min: 8, max: 9 } } });
    expect(raw.A.stores.DS01).toEqual({ min: 1, max: 2 });
  });

  it("handles null/empty overrides as a no-op", () => {
    const raw = { A: res(dc(), { DS01: { min: 1, max: 2 } }) };
    expect(mergeCoreOverrides(raw, null).A.stores.DS01).toEqual({ min: 1, max: 2 });
    expect(mergeCoreOverrides(raw, {}).A.stores.DS01).toEqual({ min: 1, max: 2 });
  });

  it("preserves other store fields while raising min/max", () => {
    const merged = mergeCoreOverrides(
      { A: res(dc(), { DS01: { min: 1, max: 2, mvTag: "Fast", dailyAvg: 0.4 } }) },
      { A: { DS01: { min: 3, max: 3 } } },
    );
    expect(merged.A.stores.DS01).toEqual({ min: 3, max: 3, mvTag: "Fast", dailyAvg: 0.4 });
  });
});

describe("assessTargetsChange — a replace-entirely writer needs a floor", () => {
  const targets = (n) => Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`SKU${i}`, { name: `n${i}`, category: "", brand: "", perDS: { DS01: { min: 1, max: 2 } } }]),
  );

  it("passes an unchanged run", () => {
    const r = assessTargetsChange({ built: targets(2030), live: targets(2030) });
    expect(r.safe).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("passes ordinary churn — a handful of SKUs going inactive", () => {
    const r = assessTargetsChange({ built: targets(2020), live: targets(2030) });
    expect(r.safe).toBe(true);
    expect(r.dropPct).toBeCloseTo(0.49, 1);
  });

  it("BLOCKS an empty result — the signature of inputs that failed to load", () => {
    // If invoiceData came back empty, runEngine yields almost nothing and a
    // replace-entirely write would empty the TO tool. Nothing legitimately takes
    // toTargets to zero.
    const r = assessTargetsChange({ built: {}, live: targets(2030) });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("targets_collapse");
  });

  it("BLOCKS a large fall even when non-empty", () => {
    const r = assessTargetsChange({ built: targets(1000), live: targets(2030) });
    expect(r.safe).toBe(false);
    expect(r.reason).toBe("targets_collapse");
  });

  it("treats an absent live row as the first run rather than a 100% collapse", () => {
    const r = assessTargetsChange({ built: targets(2030), live: {} });
    expect(r.safe).toBe(true);
    expect(r.reason).toBe("first_run");
  });

  it("reports added and removed SKUs so a real change is reviewable", () => {
    const r = assessTargetsChange({
      live: { KEEP: {}, GONE: {} },
      built: { KEEP: {}, FRESH: {} },
      maxDropPct: 100,
    });
    expect(r.added).toEqual(["FRESH"]);
    expect(r.removed).toEqual(["GONE"]);
  });
});

describe("buildInputsStamp — freshness derived from the DATA, not from a run clock", () => {
  const args = (over = {}) => ({
    invoiceData: [{ date: "2026-07-28", qty: 1 }, { date: "2026-07-30", qty: 2 }, { date: "2026-07-29", qty: 1 }],
    skuMaster: { A: {}, B: {} },
    priceData: { A: 10 },
    newSKUQty: { A: {}, B: {}, C: {} },
    minReqQty: { A: {} },
    deadStock: ["X", "Y"],
    coreOverrides: {},
    params: { pincodeConfig: { mode: "shippingCode" } },
    ...over,
  });

  it("reports invoiceDataThrough as the MAX date, not the last row", () => {
    // The rows are not sorted; taking the last one would report 07-29.
    expect(buildInputsStamp(args()).invoiceDataThrough).toBe("2026-07-30");
  });

  it("reports null when there is no invoice data at all", () => {
    expect(buildInputsStamp(args({ invoiceData: [] })).invoiceDataThrough).toBeNull();
  });

  it("counts every input", () => {
    const s = buildInputsStamp(args());
    expect(s).toMatchObject({
      invoiceRows: 3, skuMaster: 2, priceData: 1, newSKUQty: 3, minReqQty: 1, deadStock: 2, coreOverrides: 0,
    });
  });

  it("⚠ accepts deadStock as a Set — the browser holds one in React state", () => {
    // App.jsx keeps deadStock as a Set; api/run-engine.js reads it as an array.
    // One stamp builder serves both, so it must not assume .length.
    expect(buildInputsStamp(args({ deadStock: new Set(["X", "Y", "Z"]) })).deadStock).toBe(3);
  });

  it("carries the attribution mode, and null when unset", () => {
    expect(buildInputsStamp(args()).attributionMode).toBe("shippingCode");
    expect(buildInputsStamp(args({ params: {} })).attributionMode).toBeNull();
  });

  it("passes lastSyncs through, defaulting to null for the browser writer", () => {
    expect(buildInputsStamp(args()).lastSyncs).toBeNull();
    const ls = { invoices: "x", catalogue: "y", floors: "z" };
    expect(buildInputsStamp(args({ lastSyncs: ls })).lastSyncs).toEqual(ls);
  });

  it("produces the SAME KEY SET whichever writer calls it", () => {
    // The whole point: a browser Apply and the nightly run must leave the row in
    // one shape, or the TO tool's freshness display blanks after every Apply.
    const browser = buildInputsStamp(args({ deadStock: new Set(["X"]) }));
    const headless = buildInputsStamp(args({ lastSyncs: { invoices: "a", catalogue: "b", floors: "c" } }));
    expect(Object.keys(browser).sort()).toEqual(Object.keys(headless).sort());
  });
});
