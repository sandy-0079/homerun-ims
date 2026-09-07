import { describe, it, expect } from "vitest";
import {
  isPolicyNo, isUnrecognisedPolicy, normalisePolicy, policyOf,
  POLICY_YES, POLICY_NO,
} from "./skuPolicy.js";

describe("isPolicyNo — No and OFF, nothing else", () => {
  it("treats blank, missing and null as Yes", () => {
    // ⚠ The load-bearing default. All ~2,573 existing items are blank and ~12 new
    // SKUs arrive blank daily; fail-closed would zero the whole network on night one.
    for (const v of ["", "   ", undefined, null]) expect(isPolicyNo(v)).toBe(false);
  });

  it("accepts No case-insensitively and with surrounding whitespace", () => {
    for (const v of ["No", "no", "NO", "  no  "]) expect(isPolicyNo(v)).toBe(true);
  });

  it("accepts OFF too — Purchase and Move use DIFFERENT vocabularies in Zoho", () => {
    // Measured from the live field definitions 2026-09-07: Purchase is ON/OFF,
    // Move is Yes/No. Reading only "no" would make `Purchase = OFF` silently mean
    // Yes — inert rather than destructive, but the feature would not work at all on
    // the Purchase side and nothing would look wrong.
    for (const v of ["OFF", "off", " Off "]) expect(isPolicyNo(v)).toBe(true);
    for (const v of ["ON", "on", " On "]) expect(isPolicyNo(v)).toBe(false);
  });

  it("⚠⚠ does NOT treat \"false\" as No — an unchecked Zoho checkbox reads \"false\"", () => {
    // customField() stringifies before its empty-check, so an unchecked checkbox comes
    // back as the STRING "false", not blank. If that counted as No, creating these as
    // checkboxes rather than dropdowns would take the entire network to 0/0 on the
    // first nightly sync. The two failure directions are wildly asymmetric:
    //   "false" => No  : network zeroed, catastrophic
    //   "false" => Yes : feature silently inert, and policyPopulated reads 0
    // NB "off" is deliberately absent from this list — it IS No (Purchase's
    // vocabulary). "false" is a checkbox artefact and must never be.
    for (const v of ["false", "FALSE", "0", "unchecked", "untrue"]) {
      expect(isPolicyNo(v)).toBe(false);
    }
  });

  it("does not accept abbreviations — a dropdown cannot produce them", () => {
    for (const v of ["n", "N", "nope", "no thanks"]) expect(isPolicyNo(v)).toBe(false);
  });
});

describe("isUnrecognisedPolicy — the misconfiguration detector", () => {
  it("flags a present value outside both vocabularies", () => {
    for (const v of ["false", "true", "0", "maybe", "hold"]) expect(isUnrecognisedPolicy(v)).toBe(true);
  });
  it("does not flag blank, or either vocabulary", () => {
    for (const v of ["", undefined, null, "Yes", "yes", "No", "no", "ON", "on", "OFF", "off"]) {
      expect(isUnrecognisedPolicy(v)).toBe(false);
    }
  });
});

describe("normalisePolicy", () => {
  it("renders both No spellings as No", () => {
    expect(normalisePolicy("no")).toBe(POLICY_NO);
    expect(normalisePolicy("No")).toBe(POLICY_NO);
    expect(normalisePolicy("OFF")).toBe(POLICY_NO);
  });

  it("canonicalises ON/OFF to Yes/No, so the PO CSV never shows two vocabularies", () => {
    // Same reasoning as normaliseStatus: four spellings of `status` were live at once
    // and a sheet formula =IF(E2="Active", …) matched zero rows.
    expect(normalisePolicy("ON")).toBe(POLICY_YES);
    expect(normalisePolicy("OFF")).toBe(POLICY_NO);
  });
  it("renders everything else as Yes, so a CSV round-trip is stable", () => {
    for (const v of ["", undefined, "Yes", "false", "junk"]) {
      expect(normalisePolicy(v)).toBe(POLICY_YES);
    }
    // Idempotent: parse -> write -> parse must not drift.
    expect(normalisePolicy(normalisePolicy("no"))).toBe(POLICY_NO);
    expect(normalisePolicy(normalisePolicy(""))).toBe(POLICY_YES);
  });
});

describe("policyOf — topology outranks policy", () => {
  it("reads both flags for a DC-inventorised SKU", () => {
    expect(policyOf({ inventorisedAt: "DC", purchase: "No", move: "No" }))
      .toMatchObject({ purchase: false, move: false, invAt: "dc", moveVacuous: false });
    expect(policyOf({ inventorisedAt: "DC", purchase: "Yes", move: "No" }))
      .toMatchObject({ purchase: true, move: false });
  });

  it("forces move=true for a DS-inventorised SKU — that arc does not exist", () => {
    // A DS-direct SKU has ONE arc, so it has one switch (Purchase) expressible two
    // ways. Move is vacuous, and vacuity is REPORTED rather than silently obeyed.
    const p = policyOf({ inventorisedAt: "DS", purchase: "Yes", move: "No" });
    expect(p.move).toBe(true);
    expect(p.moveVacuous).toBe(true);
    expect(p.purchase).toBe(true);
  });

  it("forces move=true for a Supplier SKU and still reports the vacuity", () => {
    const p = policyOf({ inventorisedAt: "Supplier", purchase: "No", move: "No" });
    expect(p.move).toBe(true);
    expect(p.moveVacuous).toBe(true);
    // `purchase` is still parsed; the engine ignores it for Supplier via invAt.
    expect(p.purchase).toBe(false);
  });

  it("does not flag vacuity when Move is Yes anywhere", () => {
    expect(policyOf({ inventorisedAt: "DS", move: "Yes" }).moveVacuous).toBe(false);
    expect(policyOf({ inventorisedAt: "Supplier" }).moveVacuous).toBe(false);
  });

  it("defaults a missing inventorisedAt to ds, so an unknown SKU is never DC-only", () => {
    // runEngine fabricates meta for a SKU absent from the master. It must never be
    // treated as DC-only: `invAt` would have to be "dc" and it cannot be.
    const p = policyOf(undefined);
    expect(p.invAt).toBe("ds");
    expect(p.purchase).toBe(true);
    expect(p.move).toBe(true);
  });

  it("is case- and whitespace-insensitive on inventorisedAt", () => {
    for (const v of ["dc", "DC", " Dc "]) {
      expect(policyOf({ inventorisedAt: v, move: "No" }).move).toBe(false);
    }
  });
});
