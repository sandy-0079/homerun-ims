// The two Purchase/Move implementations must answer IDENTICALLY.
//
// ⚠ WHY THIS FILE EXISTS. `src/skuPolicy.js` (browser + engine) and
// `_shared/skuPolicy.ts` (edge functions) are two implementations of one fact,
// because Deno cannot import from `src/`. CLAUDE.md's most expensive recurring bug is
// exactly this shape:
//   • the invoice ⬇ Data button — a writer in App.jsx and its reader 3,000 lines away
//     in engine/utils.js, with an unasserted invariant between them: 74,381 rows -> 0
//   • the floor sheet, 2026-08-15 — `parseFloorSheet` and `handleNSQ` disagreeing on
//     duplicate rows, so the UNGUARDED path succeeded where the guarded one refused
//   • the TO deep link — the correct route known in homerun-to for a month while IMS
//     served a 404
// In every case the two sides agreed on the happy path and diverged on an ambiguous
// input. So this asserts agreement on the AMBIGUOUS values, not just the clean ones.

import { describe, it, expect } from "vitest";
import * as deno from "./skuPolicy.ts";
import * as web from "../../../src/skuPolicy.js";

// Everything either side could plausibly receive: both Zoho vocabularies, the
// checkbox artefacts, casing and whitespace variants, blanks and non-strings.
const VALUES: unknown[] = [
  // Move's vocabulary
  "Yes", "yes", "YES", " Yes ", "No", "no", "NO", "  no  ",
  // Purchase's vocabulary
  "ON", "on", " On ", "OFF", "off", " Off ",
  // absent / blank — the overwhelming normal state today
  "", "   ", undefined, null,
  // checkbox artefacts — must be Yes, never No
  "false", "FALSE", "true", "0", "1",
  // typos and a plausible future third option
  "n", "y", "nope", "hold", "HOLD", "maybe",
  // non-strings
  0, 1, false, true, {}, [],
];

const label = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

describe("skuPolicy — Deno and browser implementations agree", () => {
  it("agrees on isPolicyNo for every value", () => {
    for (const v of VALUES) {
      expect(deno.isPolicyNo(v), `isPolicyNo(${label(v)})`).toBe(web.isPolicyNo(v));
    }
  });

  it("agrees on isUnrecognisedPolicy for every value", () => {
    for (const v of VALUES) {
      expect(deno.isUnrecognisedPolicy(v), `isUnrecognisedPolicy(${label(v)})`)
        .toBe(web.isUnrecognisedPolicy(v));
    }
  });

  it("agrees on normalisePolicy for every value", () => {
    for (const v of VALUES) {
      expect(deno.normalisePolicy(v), `normalisePolicy(${label(v)})`).toBe(web.normalisePolicy(v));
    }
  });

  it("exports the same constants", () => {
    expect(deno.POLICY_YES).toBe(web.POLICY_YES);
    expect(deno.POLICY_NO).toBe(web.POLICY_NO);
  });
});

describe("skuPolicy — the Zoho api_names are the ones that exist", () => {
  it("pins cf_purchase_status and cf_move verbatim", () => {
    // ⚠ NOT GUESSABLE. The field is labelled "Purchase" but its api_name is
    // `cf_purchase_status` — copied from the field definition, not inferred from the
    // label. And because both fields carry a Zoho DEFAULT, a wrong api_name fails
    // INVISIBLY as that default rather than as a blank (the cf_to_type trap). This
    // test is the only thing standing between a typo and a silently inert feature.
    expect(deno.CF_PURCHASE).toBe("cf_purchase_status");
    expect(deno.CF_MOVE).toBe("cf_move");
  });

  it("does not use the label-derived name someone would guess", () => {
    expect(deno.CF_PURCHASE).not.toBe("cf_purchase");
  });
});
