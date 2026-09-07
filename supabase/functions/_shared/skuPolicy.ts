// Purchase / Move — the Deno-side mirror of `src/skuPolicy.js`.
//
// ⚠⚠ TWO IMPLEMENTATIONS OF ONE FACT, AND THAT IS UNAVOIDABLE HERE. Edge functions
// run on Deno and cannot import from `src/`, exactly like `dsOf` in invoiceMap.ts
// ("matching src/engine/utils.js exactly") and the DS_LIST literal in simWorker.js.
// What makes it safe is not discipline: `skuPolicy.agreement.test.ts` imports BOTH
// modules and asserts they answer identically across every value either could see,
// including the ambiguous ones. If you change one file, that test fails.
//
// It exists because this pair decides whether a SKU is purchased and distributed at
// all, and the 2026-08-15 floor-sheet incident was precisely two writers of one key
// disagreeing on an ambiguous input — with the UNGUARDED path succeeding where the
// guarded one refused.
//
// ⚠ THE TWO ZOHO FIELDS USE DIFFERENT VOCABULARIES. Verified from the live field
// definitions 2026-09-07:
//   Purchase — api_name `cf_purchase_status`, Dropdown **ON / OFF**,  default ON
//   Move     — api_name `cf_move`,            Dropdown **Yes / No**,  default Yes
// Both are Dropdown, not checkbox, which is what avoids the `"false"` catastrophe
// described in src/skuPolicy.js. Reading only "no" would make `Purchase = OFF`
// silently mean Yes: inert rather than destructive, but the Purchase half of the
// feature would simply not work and nothing would look wrong.
//
// ⚠ BOTH FIELDS HAVE A ZOHO DEFAULT, so a wrong api_name fails INVISIBLY as that
// default rather than as a blank — the `cf_to_type` trap verbatim. That is why the
// `policyFromZoho` counters exist and are not optional: if they read 0 while ops
// believes they have set values, the api_name is wrong.

export const POLICY_YES = "Yes";
export const POLICY_NO = "No";

/** Zoho api_names, from the field definitions. Not guessable — copied verbatim. */
export const CF_PURCHASE = "cf_purchase_status";
export const CF_MOVE = "cf_move";

const clean = (v: unknown) => String(v ?? "").trim().toLowerCase();

const NO_VALUES = new Set(["no", "off"]);
const YES_VALUES = new Set(["yes", "on"]);

/** True only for an explicit No/OFF. Blank, absent and "false" are all Yes. */
export function isPolicyNo(v: unknown): boolean {
  return NO_VALUES.has(clean(v));
}

/** Present but outside both vocabularies — a misconfigured field type or a typo.
 *  Treated as Yes and REPORTED, never hard-stopped: a hard stop on the catalogue
 *  costs a whole night of staleness (the 2026-08-28 active-share lesson). */
export function isUnrecognisedPolicy(v: unknown): boolean {
  const s = clean(v);
  return s !== "" && !YES_VALUES.has(s) && !NO_VALUES.has(s);
}

/** Canonicalise both vocabularies to Yes/No for storage. Downstream readers — the
 *  engine, the PO CSV — then never need to know which field they came from. */
export function normalisePolicy(v: unknown): string {
  return isPolicyNo(v) ? POLICY_NO : POLICY_YES;
}
