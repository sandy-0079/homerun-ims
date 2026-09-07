// Purchase / Move — the two commercial-policy flags on a SKU, read from Zoho.
//
// They answer two questions `status` and `inventorisedAt` could not:
//   Purchase = No  →  raise no PO. Zero the INBOUND target (the DC for a
//                     DC-inventorised SKU, the DS for a DS-inventorised one).
//   Move     = No  →  send no TO. Zero all six DS, so the DC is the only place the
//                     SKU is stocked — which is what makes "buy at the DC and sell
//                     only from the DC" expressible at all.
//
// The 2x2 is complete and has NO invalid states, which is why there is no third
// "Sell" flag: Y/Y normal · Y/N DC-only · N/Y winding down, still distributing ·
// N/N withdrawn. A `Sell` flag would have added three incoherent combinations
// (`Sell=No, Purchase=Yes` = buy stock for something you don't sell) needing a
// master-switch derivation and a validation guard, and it had no actuator anyway —
// IMS does not control Shopify listing.
//
// ⚠ TOPOLOGY OUTRANKS POLICY, so these flags are not read everywhere:
//   • inventorisedAt = Supplier — BOTH flags ignored. Never enters our network.
//   • inventorisedAt = DS       — `Move` ignored. It governs the DC->DS arc, and
//                                 that arc does not exist for a DS-direct SKU. Such
//                                 a SKU has ONE arc, so it has one switch
//                                 (`Purchase`) expressible two ways.
//   That vacuity is reported, not silently obeyed: a SKU with `Move=No` and
//   `Purchase=Yes` whose inventorisedAt is not DC means someone intended DC-only and
//   will instead get six dark stores stocked. Anomalous by construction, so it is a
//   RED digest line on first occurrence.
//
// ⚠⚠ BLANK MEANS YES, AND THAT IS THE OPPOSITE OF THE `status` RULE — deliberately.
// `status` follows "a missing status is NOT active; absent data is not evidence."
// Here absence is the overwhelming normal state: all ~2,573 existing items are blank,
// and ~12 new SKUs arrive blank every day. Fail-closed would zero the entire network
// on the first nightly sync and silently un-stock every new SKU thereafter. So this
// fails OPEN, and the safety net is a populated-count detector rather than a default.
//
// ⚠⚠ TWO VOCABULARIES ARE LIVE IN ZOHO, ON PURPOSE-BUILT SIBLING FIELDS.
// Measured from the field definitions 2026-09-07:
//   Purchase — api_name `cf_purchase_status`, options **ON / OFF**, default ON
//   Move     — api_name `cf_move`,            options **Yes / No**, default Yes
// So this accepts `no` AND `off` as No, and `yes`/`on` as a recognised Yes. Reading
// only "no" would have made `Purchase = OFF` silently mean Yes — inert rather than
// destructive (the fail-open default working), but the feature would simply not work
// on the Purchase side, and nothing would look wrong.
//
// Accepting both is deliberately preferred over demanding Zoho be reconfigured: it
// removes a dependency on a UI setting staying put, and there is no typo risk to
// coerce away because a dropdown can only emit its own options. A THIRD option added
// later still surfaces through `isUnrecognisedPolicy` rather than being obeyed.
//
// ⚠ Output is normalised to Yes/No for BOTH fields, so the PO CSV shows "Yes"/"No"
// even where Zoho shows ON/OFF. Same reasoning as `normaliseStatus`: four spellings of
// `status` were live at once and a sheet formula `=IF(E2="Active", …)` matched zero
// rows. One canonical rendering downstream, whatever the source vocabulary.
//
// ⚠⚠ `"false"` IS **NOT** No — THIS IS THE MOST IMPORTANT LINE IN THE FILE.
// `customField()` stringifies before its empty-check, so an UNCHECKED Zoho checkbox
// comes back as the string `"false"`, not blank. If that counted as No, creating
// these fields as checkboxes rather than dropdowns would read No for every item and
// take the whole network to 0/0 on night one. Only "no"/"off" count.
// The two failure directions are wildly asymmetric:
//   • "false" => No      : entire network zeroed, catastrophic
//   • "false" => Yes     : the feature silently does nothing, and `policyPopulated`
//                          in catalogueSyncStatus reads 0, which is the tell
// Hence: single-select dropdowns in Zoho, never a checkbox — which is what was
// actually created (verified from the field definitions). If someone adds a checkbox
// field later, `isUnrecognisedPolicy` surfaces it instead of the data doing so.

export const POLICY_YES = "Yes";
export const POLICY_NO = "No";

const clean = (v) => String(v ?? "").trim().toLowerCase();

/** The two spellings of No that Zoho's dropdowns can emit: Move says "No",
 *  Purchase says "OFF". Kept as a set so a third is a one-line change. */
const NO_VALUES = new Set(["no", "off"]);
const YES_VALUES = new Set(["yes", "on"]);

/** True only for an explicit No/OFF. Anything else — blank, absent, "false" — is Yes. */
export function isPolicyNo(v) {
  return NO_VALUES.has(clean(v));
}

/**
 * A value that is present but neither "yes" nor "no" — a misconfigured field type
 * (a checkbox's "false"/"true") or a typo. Treated as Yes and REPORTED, never
 * hard-stopped: a hard stop on the catalogue costs a whole night of staleness, which
 * is the lesson from the 2026-08-28 active-share block.
 */
export function isUnrecognisedPolicy(v) {
  const s = clean(v);
  return s !== "" && !YES_VALUES.has(s) && !NO_VALUES.has(s);
}

/** Render for storage / display. Canonicalises BOTH vocabularies: "no" and "off"
 *  become "No", everything else "Yes". */
export function normalisePolicy(v) {
  return isPolicyNo(v) ? POLICY_NO : POLICY_YES;
}

/**
 * Resolve both flags for one SKU-master entry into booleans, already accounting for
 * topology: `move` is forced true where the DC->DS arc does not exist, so callers
 * never have to remember that rule.
 *
 * @param meta `skuMaster[sku]` (or the engine's fabricated meta)
 * @returns {{purchase:boolean, move:boolean, invAt:string, moveVacuous:boolean}}
 */
export function policyOf(meta) {
  const invAt = clean(meta?.inventorisedAt) || "ds";
  const rawMoveNo = isPolicyNo(meta?.move);
  // Move only governs the DC->DS arc. No arc => nothing to switch off.
  const moveApplies = invAt === "dc";
  return {
    purchase: !isPolicyNo(meta?.purchase),
    move: moveApplies ? !rawMoveNo : true,
    invAt,
    // Someone set Move=No where it cannot act. Surfaced, not obeyed.
    moveVacuous: rawMoveNo && !moveApplies,
  };
}
