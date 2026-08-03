import { describe, it, expect } from "vitest";
import { normaliseStatus } from "./skuStatus.js";

describe("normaliseStatus", () => {
  it("collapses the live four-way casing mess to one spelling per state", () => {
    // Measured live 2026-08-03: active 2090, inactive 27, Inactive 1, confirmation_pending 3.
    // A sheet formula ="Active" matched zero rows before this; ="active" missed one.
    expect(normaliseStatus("active")).toBe("Active");
    expect(normaliseStatus("inactive")).toBe("Inactive");
    expect(normaliseStatus("Inactive")).toBe("Inactive");
    expect(normaliseStatus("confirmation_pending")).toBe("Confirmation Pending");
  });

  it("maps every live spelling of inactive onto ONE value", () => {
    // The whole point: two downloads of the same fact must never disagree.
    expect(new Set(["inactive", "Inactive", "INACTIVE", " inactive "].map(normaliseStatus)).size).toBe(1);
  });

  it("treats a missing status as Active — the master-row-omits-the-field convention", () => {
    expect(normaliseStatus(undefined)).toBe("Active");
    expect(normaliseStatus(null)).toBe("Active");
    expect(normaliseStatus("")).toBe("Active");
    expect(normaliseStatus("   ")).toBe("Active");
  });

  it("renders an unseen Zoho value readably rather than raw", () => {
    expect(normaliseStatus("on_hold")).toBe("On Hold");
    expect(normaliseStatus("pending_approval")).toBe("Pending Approval");
  });

  it("is idempotent, so re-normalising an already-clean value is safe", () => {
    for (const s of ["Active", "Inactive", "Confirmation Pending"]) {
      expect(normaliseStatus(normaliseStatus(s))).toBe(normaliseStatus(s));
    }
  });
});
