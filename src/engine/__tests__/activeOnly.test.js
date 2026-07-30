import { describe, it, expect } from "vitest";
import { runEngine } from "../runEngine.js";
import { DEFAULT_PARAMS } from "../constants.js";

// ── Only SKUs Active in the SKU Master get non-zero targets ──────────────────
//
// WHY (measured on live data, 2026-07-30): `status` gated Min/Max NOWHERE in the
// engine. Its only appearances were a Zero-Sale tag and two lines that FABRICATED a
// master entry for any SKU seen in invoice data:
//
//   const meta = skuM[skuId] || { ..., status: "Active", inventorisedAt: "DS" }
//
// So the engine emitted targets for 9 SKUs it had no business stocking — 4 present in
// the master but not active, and 5 absent from it entirely (all pre-July codes like
// FUT-DURA-24-18-8, orphaned when Zoho re-coded the catalogue ~2026-07-01). 6 carried
// real quantities, ₹2.4L of Max value, including Z8DJK at 10 units ≈ ₹1.6L.
//
// Every consumer was individually remembering to filter on status. `toTargets` did —
// but only by ALSO requiring inventorisedAt === "dc", and unknown SKUs were fabricated
// as "DS". Had that default been "DC", phantom SKUs would have been reaching the DC
// team's transfer orders. The engine should simply not emit them.

const DAYS = Array.from({ length: 10 }, (_, i) => `2026-06-${String(10 + i).padStart(2, "0")}`);

function mkInvoice() {
  const rows = [];
  for (const d of DAYS) {
    rows.push({ sku: "SKU-ACTIVE",   ds: "DS02", date: d, qty: 4 });
    rows.push({ sku: "SKU-INACTIVE", ds: "DS02", date: d, qty: 4 });
    rows.push({ sku: "SKU-PENDING",  ds: "DS02", date: d, qty: 4 });
    rows.push({ sku: "OLD-CODE-123", ds: "DS02", date: d, qty: 4 });   // absent from master
  }
  return rows;
}

const base = { category: "General Hardware", brand: "X", inventorisedAt: "DC" };
const SKU_M = {
  "SKU-ACTIVE":   { sku: "SKU-ACTIVE",   name: "Active",   status: "Active",   ...base },
  "SKU-INACTIVE": { sku: "SKU-INACTIVE", name: "Inactive",  status: "Inactive", ...base },
  "SKU-PENDING":  { sku: "SKU-PENDING",  name: "Pending",   status: "confirmation_pending", ...base },
};

const run = (over = {}) => runEngine(
  mkInvoice(), SKU_M, {}, {}, new Set(), {},
  { ...DEFAULT_PARAMS, overallPeriod: 10, categoryStrategies: {}, ...over },
);

const totals = (r) => {
  const ds = Object.values(r.stores).reduce((a, s) => a + (s.min || 0) + (s.max || 0), 0);
  return ds + (r.dc?.min || 0) + (r.dc?.max || 0);
};

describe("runEngine — active-only targets", () => {
  it("stocks a SKU that is Active in the master", () => {
    // Control. If this ever fails the fixture is wrong, not the rule.
    expect(totals(run()["SKU-ACTIVE"])).toBeGreaterThan(0);
  });

  it("zeroes a SKU that is Inactive in the master, despite real demand", () => {
    // 40 units over 10 days at DS02 and it still gets nothing — ops marked it
    // not-for-sale, so a target is unactionable. This is Z8DJK's case.
    const r = run()["SKU-INACTIVE"];
    expect(totals(r)).toBe(0);
  });

  it("zeroes any status that is not active, not just 'Inactive'", () => {
    // Zoho's vocabulary includes confirmation_pending — an allowlist of one value
    // ("active") is the only safe rule, since new statuses can appear at any time.
    expect(totals(run()["SKU-PENDING"])).toBe(0);
  });

  it("zeroes a SKU absent from the master entirely", () => {
    // The pre-July orphans. Absent is not evidence of active.
    expect(totals(run()["OLD-CODE-123"])).toBe(0);
  });

  it("KEEPS the entry rather than dropping it, so consumers and audit survive", () => {
    // Consumers iterate Object.keys(res); the Upload tab's "SKUs in Invoice not
    // Active in SKU Master" warning needs these visible. Dropping them would make a
    // real data problem silently disappear.
    const res = run();
    for (const k of ["SKU-INACTIVE", "SKU-PENDING", "OLD-CODE-123"]) {
      expect(res[k]).toBeDefined();
      expect(res[k].meta).toBeDefined();
    }
  });

  it("does not fabricate an Active status for an unknown SKU", () => {
    // The root cause. Saying "Active" is the lie every other symptom followed from.
    expect(String(run()["OLD-CODE-123"].meta.status).toLowerCase()).not.toBe("active");
  });

  it("records WHY it was zeroed, so a zero is diagnosable", () => {
    const r = run()["SKU-INACTIVE"];
    expect(r.dc?.dcDetails?.zeroedReason).toMatch(/not active/i);
  });

  it("leaves preFloor* intact for audit, matching the Dead Stock convention", () => {
    // Same character as Supplier/Dead Stock: zero the target, keep the working.
    const s = run()["SKU-INACTIVE"].stores.DS02;
    expect(s.min).toBe(0);
    expect(s.max).toBe(0);
    expect(s.preFloorMax).toBeGreaterThan(0);
  });

  it("does not disturb the active SKU's numbers", () => {
    // Regression guard: the new pass must be a no-op for everything active.
    const withRule = totals(run()["SKU-ACTIVE"]);
    expect(withRule).toBeGreaterThan(0);
    expect(run()["SKU-ACTIVE"].stores.DS02.min).toBeGreaterThan(0);
  });

  it("treats a missing status as active, matching every downstream filter", () => {
    // `(status || "Active")` is the established convention for a master row that
    // simply omits the field — distinct from a SKU absent from the master.
    const m = { ...SKU_M, "SKU-NOSTATUS": { sku: "SKU-NOSTATUS", name: "n", ...base } };
    const rows = [...mkInvoice(), ...DAYS.map((d) => ({ sku: "SKU-NOSTATUS", ds: "DS02", date: d, qty: 4 }))];
    const res = runEngine(rows, m, {}, {}, new Set(), {},
      { ...DEFAULT_PARAMS, overallPeriod: 10, categoryStrategies: {} });
    expect(totals(res["SKU-NOSTATUS"])).toBeGreaterThan(0);
  });
});
