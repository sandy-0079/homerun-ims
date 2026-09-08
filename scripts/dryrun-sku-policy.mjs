// Prove what Purchase / Move actually DO, without writing anything anywhere.
//
//   npx vite-node scripts/dryrun-sku-policy.mjs <snapshot.json> [SKU ...]
//
// FULLY OFFLINE — replays a frozen snapshot from snapshot-engine-inputs.mjs. Flags
// are injected into an in-memory copy of skuMaster; Supabase is never touched, so
// this is safe to run against a prod snapshot as often as you like.
//
// ⚠ WHY THIS EXISTS SEPARATELY FROM THE INERTNESS DIFF. "0 of 18,046 cells differ"
// proves the code cannot disturb production. It says NOTHING about whether the
// feature works — a policy pass that never fires would pass that test perfectly.
// CLAUDE.md records the same trap from the ceiling rollout: the cap was verified on
// two SKUs that both had demand, and the zero-demand case was never constructed.
// So this asserts the OUTCOME of every combination, and exits 1 on any surprise.
//
// The matrix it proves, per representative SKU class:
//   inventorisedAt   Purchase  Move   expected
//   DC               Yes       Yes    unchanged from baseline
//   DC               Yes       No     all six DS 0/0 · DC from its category strategy
//                                     on TOTAL demand · dcDetails.dcOnly = true
//   DC               No        Yes    DC 0/0 · DS unchanged (TOs keep pulling)
//   DC               No        No     everything 0/0
//   DS               Yes       *      unchanged (Move has no arc to govern)
//   DS               No        *      all 0/0 (its PO and its shelf are one number)
//   Supplier         *         *      unchanged — already 0/0, flags ignored

import { readFileSync } from "node:fs";
import { runEngine } from "../src/engine/index.js";
import { DS_LIST } from "../src/engine/constants.js";

const snapPath = process.argv[2];
if (!snapPath) {
  console.error("usage: npx vite-node scripts/dryrun-sku-policy.mjs <snapshot.json> [SKU ...]");
  process.exit(1);
}
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const I = snap.inputs;
const LOCS = [...DS_LIST, "DC"];

const run = (master) => runEngine(
  I.invoiceData, master, I.minReqQty, I.priceData,
  new Set(I.deadStock), I.newSKUQty, I.params, I.skuCeiling,
);

const cellsOf = (r) => {
  const o = {};
  for (const ds of DS_LIST) o[ds] = r?.stores?.[ds] ? [r.stores[ds].min, r.stores[ds].max] : null;
  o.DC = r?.dc ? [r.dc.min, r.dc.max] : null;
  return o;
};
const fmt = (c) => LOCS.map((l) => `${l} ${c[l] ? c[l].join("/") : "—"}`).join("  ");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allZero = (c, locs) => locs.every((l) => !c[l] || (c[l][0] === 0 && c[l][1] === 0));

console.log("BASELINE");
const base = run(I.skuMaster);
console.log(`  ${Object.keys(base).length} SKUs · snapshot ${snap.capturedAt}`);

// ── Pick representative SKUs, one per class ────────────────────────────────
const invAt = (s) => String(I.skuMaster[s]?.inventorisedAt ?? "").toLowerCase();
const isActive = (s) => String(I.skuMaster[s]?.status ?? "Active").trim().toLowerCase() === "active";
const dsSum = (s) => DS_LIST.reduce((a, ds) => a + (base[s]?.stores?.[ds]?.max ?? 0), 0);

const pick = (pred) => Object.keys(base).find((s) => I.skuMaster[s] && pred(s));

// ⚠⚠ THE CLASSES ARE PICKED FROM LIVE DATA, SO COVERAGE SHRINKS AS PROD MOVES — and
// until 2026-09-08 it shrank SILENTLY: an unmatched class was `.filter(Boolean)`'d
// away and the run still printed "ALL ASSERTIONS PASSED". Measured that day: 4 of 5.
// The one lost was "DC unfloored" — the floors sheet grew 1,877 -> 2,201, leaving
// exactly one unfloored DC-active SKU (MAXT8, created that day, no demand). That is
// the class that matters most to keep an eye on: floored and unfloored SKUs take
// DIFFERENT DC branches (`sum(DS Min) x mult` vs `sumDailyAvg x (leadTime+1)`), and
// the unfloored one is precisely what open item #8 says understocks erratic demand.
//
// Unbuilt classes are now NAMED and carried into the success line, so you cannot read
// a pass without seeing what it did not cover. Deliberately NOT a non-zero exit: a
// missing class is a fact about prod data, not a defect, and failing every run would
// train the reader to ignore this script — the Sunday-row-count mistake.
const CLASSES = [
  ["DC · unfloored (rate-based DC branch)",
   (s) => invAt(s) === "dc" && isActive(s) && dsSum(s) > 0 && !I.newSKUQty[s]
          && base[s].dc?.dcDetails?.isFlooredSKU === false],
  ["DC · floored (sum-of-DS-mins DC branch)",
   (s) => invAt(s) === "dc" && isActive(s) && dsSum(s) > 0 && !!I.newSKUQty[s]],
  ["DC · network design (plywood bypass)",
   (s) => invAt(s) === "dc" && isActive(s) && dsSum(s) > 0
          && base[s].stores?.[DS_LIST[0]]?.strategyTag === "network_design"],
  ["DS-inventorised (Move has no arc to govern)", (s) => invAt(s) === "ds" && isActive(s)],
  ["Supplier (both flags ignored)", (s) => invAt(s) === "supplier"],
];
const explicit = process.argv.slice(3);
const resolved = explicit.length
  ? explicit.map((s) => ["(named on the command line)", s])
  : CLASSES.map(([label, pred]) => [label, pick(pred)]);
const unbuilt = resolved.filter(([, s]) => !s).map(([label]) => label);
const chosen = resolved.filter(([, s]) => s).map(([, s]) => s);

const label = (s) => {
  const m = I.skuMaster[s];
  const tag = base[s]?.stores?.[DS_LIST[0]]?.strategyTag ?? "?";
  return `${s}  [${m?.inventorisedAt ?? "?"} · ${m?.status ?? "?"} · ${tag}${I.newSKUQty[s] ? " · floored" : ""}]`;
};

console.log("\nSKUs under test");
for (const s of chosen) console.log(`  ${label(s)}\n      baseline  ${fmt(cellsOf(base[s]))}`);

// ── Run the four combinations ──────────────────────────────────────────────
// ⚠ THE REAL ZOHO VOCABULARIES, not a tidied pair. Verified from the live field
// definitions 2026-09-07: `cf_purchase_status` offers **ON / OFF** (default ON) while
// `cf_move` offers **Yes / No** (default Yes). Testing with "Yes"/"No" on both would
// pass while `Purchase = OFF` silently meant Yes in production.
const COMBOS = [
  { purchase: "ON",  move: "Yes" },
  { purchase: "ON",  move: "No"  },
  { purchase: "OFF", move: "Yes" },
  { purchase: "OFF", move: "No"  },
];
const isNo = (v) => ["no", "off"].includes(String(v).toLowerCase());

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

for (const combo of COMBOS) {
  const master = { ...I.skuMaster };
  for (const s of chosen) master[s] = { ...master[s], purchase: combo.purchase, move: combo.move };
  const out = run(master);
  console.log(`\nPurchase=${combo.purchase}  Move=${combo.move}`);

  for (const s of chosen) {
    const b = cellsOf(base[s]), a = cellsOf(out[s]);
    const at = invAt(s);
    const dcOnly = out[s]?.dc?.dcDetails?.dcOnly === true;
    console.log(`  ${s.padEnd(24)} ${fmt(a)}${same(a, b) ? "   (unchanged)" : ""}${dcOnly ? "   [dcOnly]" : ""}`);

    const tag = `${s} ${at} P=${combo.purchase} M=${combo.move}`;
    if (at === "supplier") {
      check(same(a, b) && allZero(a, LOCS), `${tag}: Supplier must stay 0/0 and ignore both flags`);
    } else if (at === "ds") {
      if (!isNo(combo.purchase)) check(same(a, b), `${tag}: DS-inv with Purchase=Yes must be unchanged (Move is vacuous)`);
      else check(allZero(a, LOCS), `${tag}: DS-inv with Purchase=No must be 0/0 everywhere`);
    } else { // dc
      if (!isNo(combo.purchase) && !isNo(combo.move)) {
        check(same(a, b), `${tag}: must be unchanged`);
      } else if (!isNo(combo.purchase) && isNo(combo.move)) {
        check(allZero(a, DS_LIST), `${tag}: all six DS must be 0/0`);
        check(dcOnly, `${tag}: dcDetails.dcOnly must be true (took the DC-only branch)`);
        check(a.DC[1] > 0, `${tag}: DC Max must be > 0 — a SKU with demand must still be stocked at the DC`);
      } else if (isNo(combo.purchase) && !isNo(combo.move)) {
        check(a.DC[0] === 0 && a.DC[1] === 0, `${tag}: DC must be 0/0`);
        check(same({ ...a, DC: null }, { ...b, DC: null }), `${tag}: DS columns must be unchanged — TOs keep pulling`);
      } else {
        check(allZero(a, LOCS), `${tag}: must be 0/0 everywhere`);
      }
    }
  }
}

console.log("");
if (unbuilt.length) {
  console.log(`⚠ ${unbuilt.length} of ${CLASSES.length} class(es) had NO matching SKU in this snapshot and were NOT TESTED:`);
  for (const label of unbuilt) console.log(`    ${label}`);
  console.log(`  Not a failure — prod simply holds no such SKU today. But the assertions below`);
  console.log(`  cover less than they used to, so read the pass with that in mind.`);
  console.log("");
}
const caveat = unbuilt.length ? ` — ⚠ ${unbuilt.length} class(es) NOT TESTED, see above` : "";
if (failures.length === 0) {
  console.log(`✓ ALL ASSERTIONS PASSED — ${COMBOS.length} combinations x ${chosen.length} of ${CLASSES.length} SKU classes${caveat}.`);
} else {
  console.log(`✕ ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.log(`    ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
