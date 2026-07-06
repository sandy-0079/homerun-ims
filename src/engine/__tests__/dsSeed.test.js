import { describe, it, expect } from "vitest";
import { applyDSSeed } from "../dsSeed.js";
import { runEngine } from "../runEngine.js";
import { DEFAULT_PARAMS } from "../constants.js";

// ── Unit fixtures: hand-built res objects ────────────────────────────────────

function mkStore(min, max, dailyAvg = 0, extra = {}) {
  return {
    min, max, preFloorMin: min, preFloorMax: max,
    dailyAvg, abq: 0, mvTag: "Slow", spTag: "No Spike",
    logicTag: "Base Logic", strategyTag: "standard",
    strategyDetails: {}, postBlendSteps: [],
    ...extra,
  };
}

function mkSku({ ds02, ds04, ds06, dc, meta = {} } = {}) {
  return {
    meta: { sku: "SKU-A", category: "General Hardware", status: "Active", inventorisedAt: "DC", ...meta },
    stores: {
      DS01: mkStore(0, 0), DS02: ds02 ?? mkStore(0, 0), DS03: mkStore(0, 0),
      DS04: ds04 ?? mkStore(0, 0), DS05: mkStore(0, 0), DS06: ds06 ?? mkStore(0, 0),
    },
    dc: dc ?? {
      min: 8, max: 12, preFloorMin: 8, preFloorMax: 12, mvTag: "Slow", nonZeroDays: 2,
      dcDetails: { isDead: false, isFlooredSKU: false, sumDailyAvg: 2, leadTime: 3 },
    },
  };
}

const SEED_P = { dsSeed: { DS06: ["DS02", "DS04"] } };

describe("applyDSSeed — store seeding", () => {
  it("seeds target DS with ceil of source average, per field", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7), ds04: mkStore(2, 4) }) };
    applyDSSeed(res, SEED_P);
    const t = res["SKU-A"].stores.DS06;
    expect(t.min).toBe(3);  // ceil((3+2)/2) = 3
    expect(t.max).toBe(6);  // ceil((7+4)/2) = 6
    expect(t.logicTag).toBe("DS Seed");
  });

  it("keeps organic values when higher on both fields", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7), ds04: mkStore(2, 4), ds06: mkStore(5, 8, 0, { logicTag: "Base Logic" }) }) };
    applyDSSeed(res, SEED_P);
    const t = res["SKU-A"].stores.DS06;
    expect(t.min).toBe(5);
    expect(t.max).toBe(8);
    expect(t.logicTag).toBe("Base Logic");
  });

  it("mixes per-field: seed min wins, organic max wins", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(5, 5), ds04: mkStore(3, 7), ds06: mkStore(1, 8) }) };
    applyDSSeed(res, SEED_P);
    const t = res["SKU-A"].stores.DS06;
    expect(t.min).toBe(4);  // seed ceil(8/2)=4 > organic 1
    expect(t.max).toBe(8);  // organic 8 > seed ceil(12/2)=6
    expect(t.logicTag).toBe("DS Seed");
  });

  it("single-source SKU gets union-assortment ceil (1 at either source → 1 at target)", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(1, 1), ds04: mkStore(0, 0) }) };
    applyDSSeed(res, SEED_P);
    const t = res["SKU-A"].stores.DS06;
    expect(t.min).toBe(1);  // ceil(0.5)
    expect(t.max).toBe(1);
  });

  it("preserves preFloor audit values and records a postBlendSteps entry when seed wins", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7), ds04: mkStore(2, 4), ds06: mkStore(0, 0) }) };
    applyDSSeed(res, SEED_P);
    const t = res["SKU-A"].stores.DS06;
    expect(t.preFloorMin).toBe(0);
    expect(t.preFloorMax).toBe(0);
    expect(t.postBlendSteps.some(s => s.rule === "DS Seed")).toBe(true);
  });

  it("no dsSeed config → res untouched", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7), ds04: mkStore(2, 4) }) };
    const before = JSON.parse(JSON.stringify(res));
    applyDSSeed(res, { dsSeed: {} });
    applyDSSeed(res, {});
    expect(res).toEqual(before);
  });

  it("dead stock SKU stays zero everywhere and DC untouched", () => {
    const res = {
      "SKU-A": mkSku({
        ds02: mkStore(0, 0, 0, { logicTag: "Dead Stock" }),
        ds04: mkStore(0, 0, 0, { logicTag: "Dead Stock" }),
        dc: { min: 0, max: 0, dcDetails: { isDead: true, sumDailyAvg: 1, leadTime: 3 } },
      }),
    };
    applyDSSeed(res, SEED_P);
    expect(res["SKU-A"].stores.DS06.min).toBe(0);
    expect(res["SKU-A"].stores.DS06.max).toBe(0);
    expect(res["SKU-A"].dc.min).toBe(0);
    expect(res["SKU-A"].dc.max).toBe(0);
  });
});

describe("applyDSSeed — DC re-derivation", () => {
  it("rate-based DC recomputed with synthetic DS06 rate = avg of source rates", () => {
    // sources: dailyAvg 1 and 3 → synth 2; organic DS06 rate 0
    // sumDailyAvg 2, leadTime 3 → new sum 4 → min ceil(4×4)=16, max 16+ceil(4×2)=24
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7, 1), ds04: mkStore(2, 4, 3) }) };
    applyDSSeed(res, SEED_P);
    expect(res["SKU-A"].dc.min).toBe(16);
    expect(res["SKU-A"].dc.max).toBe(24);
  });

  it("rate augmentation is reduced by DS06's organic rate (max semantics, self-sunsetting)", () => {
    // synth 2, organic DS06 rate already 1.5 → augment only 0.5 → sum 2.5 → min ceil(10)=10, max 10+5=15
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7, 1), ds04: mkStore(2, 4, 3), ds06: mkStore(2, 3, 1.5) }) };
    applyDSSeed(res, SEED_P);
    expect(res["SKU-A"].dc.min).toBe(10);
    expect(res["SKU-A"].dc.max).toBe(15);
  });

  it("never lowers DC below its pre-seed values", () => {
    const res = { "SKU-A": mkSku({
      ds02: mkStore(1, 2, 0.1), ds04: mkStore(0, 0, 0.1),
      dc: { min: 40, max: 60, dcDetails: { isDead: false, isFlooredSKU: false, sumDailyAvg: 0.2, leadTime: 3 } },
    }) };
    applyDSSeed(res, SEED_P);
    expect(res["SKU-A"].dc.min).toBe(40);
    expect(res["SKU-A"].dc.max).toBe(60);
  });

  it("floored-SKU DC recomputed from augmented DS sums", () => {
    // sums incl. pre-seed DS06(0): sumMin 10, sumMax 20; seed adds 3/6 → 13/26
    // multMin .2 → round(2.6)=3; multMax .3 → round(7.8)=8
    const res = { "SKU-A": mkSku({
      ds02: mkStore(4, 8), ds04: mkStore(2, 4),
      dc: { min: 2, max: 6, dcDetails: { isDead: false, isFlooredSKU: true, multMin: 0.2, multMax: 0.3, sumMin: 10, sumMax: 20, sumDailyAvg: 0, leadTime: 3 } },
    }) };
    applyDSSeed(res, SEED_P);
    expect(res["SKU-A"].dc.min).toBe(3);
    expect(res["SKU-A"].dc.max).toBe(8);
  });

  it("network-design DC augmented additively via brand dc multipliers", () => {
    // seed delta 4/– → min += ceil(4×0.8)=4, max += ceil(4×1.5)=6
    const res = { "SKU-A": mkSku({
      ds02: mkStore(5, 6), ds04: mkStore(3, 4),
      dc: { min: 10, max: 15, dcDetails: { strategy: "network_design", brand: "GreenPly", isDead: false, dcMultMin: 0.8, dcMultMax: 1.5 } },
    }) };
    applyDSSeed(res, SEED_P);
    expect(res["SKU-A"].dc.min).toBe(14);
    expect(res["SKU-A"].dc.max).toBe(21);
  });

  it("records the augmentation in dcDetails for audit", () => {
    const res = { "SKU-A": mkSku({ ds02: mkStore(3, 7, 1), ds04: mkStore(2, 4, 3) }) };
    applyDSSeed(res, SEED_P);
    const aug = res["SKU-A"].dc.dcDetails.dsSeedAug;
    expect(aug).toBeTruthy();
    expect(aug.targetDS).toBe("DS06");
  });
});

// ── Integration: through runEngine ───────────────────────────────────────────

function mkInvoice() {
  // 10 days of history; SKU-STD sells at DS02 and DS04; SKU-SUP at DS02 (supplier-inventorised)
  const rows = [];
  const days = Array.from({ length: 10 }, (_, i) => `2026-06-${String(10 + i).padStart(2, "0")}`);
  days.forEach((d, i) => {
    rows.push({ sku: "SKU-STD", ds: "DS02", date: d, qty: 4 });
    if (i % 2 === 0) rows.push({ sku: "SKU-STD", ds: "DS04", date: d, qty: 2 });
    rows.push({ sku: "SKU-SUP", ds: "DS02", date: d, qty: 3 });
  });
  return rows;
}

const SKU_M = {
  "SKU-STD": { sku: "SKU-STD", name: "Std item", category: "General Hardware", brand: "X", status: "Active", inventorisedAt: "DC" },
  "SKU-SUP": { sku: "SKU-SUP", name: "Supplier item", category: "General Hardware", brand: "X", status: "Active", inventorisedAt: "Supplier" },
};

function runWith(pOverrides = {}, mrq = {}) {
  const p = { ...DEFAULT_PARAMS, overallPeriod: 10, newDSList: ["DS06"], categoryStrategies: {}, ...pOverrides };
  return runEngine(mkInvoice(), SKU_M, mrq, {}, new Set(), {}, p);
}

describe("runEngine integration — DS06 seed", () => {
  it("DS06 gets per-field ceil-average of DS02/DS04 when seed is configured", () => {
    const res = runWith({ dsSeed: { DS06: ["DS02", "DS04"] } });
    const s = res["SKU-STD"].stores;
    expect(s.DS06.min).toBe(Math.ceil((s.DS02.min + s.DS04.min) / 2));
    expect(s.DS06.max).toBe(Math.ceil((s.DS02.max + s.DS04.max) / 2));
    expect(s.DS06.min).toBeGreaterThan(0);
  });

  it("without dsSeed config DS06 stays at zero (no floor, no sales)", () => {
    const res = runWith({ newDSList: [] });
    expect(res["SKU-STD"].stores.DS06.min).toBe(0);
    expect(res["SKU-STD"].stores.DS06.max).toBe(0);
  });

  it("Supplier-inventorised SKUs stay zeroed at DS06 (normalization runs after seed)", () => {
    const res = runWith({ dsSeed: { DS06: ["DS02", "DS04"] } });
    expect(res["SKU-SUP"].stores.DS06.min).toBe(0);
    expect(res["SKU-SUP"].stores.DS06.max).toBe(0);
    expect(res["SKU-SUP"].stores.DS06.logicTag).toBe("Supplier");
  });

  it("New DS Floor blends per-field: floor lifts Min, strategy Max survives when higher", () => {
    // floor between strategy min and max at DS04 → old code clobbered Max down to floor
    const res = runWith({ newDSList: ["DS04"], newDSFloorTopN: 250 }, { "SKU-STD": 9 });
    const st = res["SKU-STD"].stores.DS04;
    const step = st.postBlendSteps.find(x => x.rule === "New DS Floor");
    expect(step).toBeTruthy();                    // floor actually won on Min
    expect(step.beforeMax).toBeGreaterThan(9);    // fixture guarantees strategy Max > floor
    expect(st.min).toBe(9);
    expect(st.max).toBe(Math.ceil(step.beforeMax)); // per-field: Max keeps strategy value
  });

  it("seed and New DS Floor at DS06: whichever wins per field", () => {
    const res = runWith({ dsSeed: { DS06: ["DS02", "DS04"] }, newDSFloorTopN: 250 }, { "SKU-STD": 100 });
    const s = res["SKU-STD"].stores;
    expect(s.DS06.min).toBe(100); // floor >> seed
    expect(s.DS06.max).toBeGreaterThanOrEqual(100);
  });
});
