// Diff two engine dumps produced from the SAME input snapshot.
//
//   npx vite-node scripts/diff-engine-dumps.mjs <before.dump.json> <after.dump.json>
//
// FULLY OFFLINE. Exits 1 when anything differs, so it can gate a build step.
//
// ⚠ IT REFUSES TO COMPARE DUMPS FROM DIFFERENT SNAPSHOTS. That is the whole point:
// prod inputs move nightly (sliding invoice window, retention trim, catalogue sync,
// floors sheet re-read), so two dumps taken from live data at different times differ
// for reasons that have nothing to do with the code — and those differences look
// exactly like a regression. Same input bytes, or no verdict.
//
// ⚠ MIN/MAX CHANGES AND TAG-ONLY CHANGES ARE COUNTED SEPARATELY, deliberately.
// A cell whose numbers match while its logicTag / strategyTag / branch changed means
// the same answer arrived by a different code path — which is how the four-writers
// ceiling bug and the Dead Stock inline-branch bug both presented. The Dead Stock
// inertness proof was stated in exactly these terms: "2,375 SKUs → exactly 12
// min/max changes, 0 DC changes, 0 logic-tag-only changes."

import { readFileSync } from "node:fs";
import { DS_LIST } from "../src/engine/constants.js";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: npx vite-node scripts/diff-engine-dumps.mjs <before.dump.json> <after.dump.json>");
  process.exit(1);
}

const A = JSON.parse(readFileSync(aPath, "utf8"));
const B = JSON.parse(readFileSync(bPath, "utf8"));

const fa = JSON.stringify(A.meta.fingerprint), fb = JSON.stringify(B.meta.fingerprint);
if (A.meta.snapshotAt !== B.meta.snapshotAt || fa !== fb) {
  console.error("✕ REFUSING TO DIFF — these dumps came from different input snapshots.");
  console.error(`  before: ${A.meta.snapshotAt} (git ${A.meta.snapshotGitHead})`);
  console.error(`  after : ${B.meta.snapshotAt} (git ${B.meta.snapshotGitHead})`);
  console.error("  Re-dump both from ONE snapshot file. A verdict from different inputs is worthless.");
  process.exit(2);
}

const LOCS = [...DS_LIST, "DC"];
const keys = [...new Set([...Object.keys(A.cells), ...Object.keys(B.cells)])].sort();

const valueDiffs = [];   // min/max moved
const tagDiffs = [];     // numbers identical, path/tag moved
const shapeDiffs = [];   // cell present in one dump and not the other
const skusTouched = new Set();
const byLoc = Object.fromEntries(LOCS.map((l) => [l, { value: 0, tag: 0 }]));

for (const k of keys) {
  const a = A.cells[k], b = B.cells[k];
  const [sku, loc] = k.split("||");
  if ((a == null) !== (b == null)) {
    shapeDiffs.push(`${sku} ${loc}: ${a == null ? "absent" : "present"} → ${b == null ? "absent" : "present"}`);
    skusTouched.add(sku);
    continue;
  }
  if (a == null) continue;

  if (a.min !== b.min || a.max !== b.max) {
    valueDiffs.push(`${sku} ${loc}: ${a.min}/${a.max} → ${b.min}/${b.max}` +
      (loc === "DC" ? `  [basis ${a.basis} → ${b.basis}]` : `  [${a.logicTag || "—"} → ${b.logicTag || "—"}]`));
    skusTouched.add(sku);
    byLoc[loc].value++;
    continue;
  }
  const aTag = loc === "DC" ? `${a.reason}|${a.basis}` : `${a.logicTag}|${a.strategyTag}|${a.steps}`;
  const bTag = loc === "DC" ? `${b.reason}|${b.basis}` : `${b.logicTag}|${b.strategyTag}|${b.steps}`;
  if (aTag !== bTag) {
    tagDiffs.push(`${sku} ${loc}: numbers unchanged (${a.min}/${a.max}) · ${aTag} → ${bTag}`);
    skusTouched.add(sku);
    byLoc[loc].tag++;
  }
}

const show = (label, arr, n = 30) => {
  console.log(`  ${label}: ${arr.length}`);
  for (const d of arr.slice(0, n)) console.log(`      ${d}`);
  if (arr.length > n) console.log(`      … (+${arr.length - n} more)`);
};

const cr = (n) => `₹${(n / 1e7).toFixed(4)}Cr`;
const dMin = B.meta.invValue.min - A.meta.invValue.min;
const dMax = B.meta.invValue.max - A.meta.invValue.max;

console.log(`DIFF  ${aPath}  →  ${bPath}`);
console.log(`  snapshot ${A.meta.snapshotAt} · ${A.meta.fingerprint.invoiceRows.toLocaleString()} invoice rows · skuMaster ${A.meta.fingerprint.skuMaster}`);
console.log(`  engine git ${A.meta.dumpGitHead} → ${B.meta.dumpGitHead}`);
console.log(`  SKUs ${A.meta.skus} → ${B.meta.skus} · cells ${A.meta.cells} → ${B.meta.cells}`);
console.log("");
show("min/max changes", valueDiffs);
show("tag/branch-only changes", tagDiffs);
show("cell shape changes", shapeDiffs);
console.log("");
console.log(`  per-location  ${LOCS.map((l) => `${l} ${byLoc[l].value}v/${byLoc[l].tag}t`).join(" · ")}`);
console.log(`  SKUs touched  ${skusTouched.size} of ${B.meta.skus}`);
console.log(`  Inv Value     Min ${cr(A.meta.invValue.min)} → ${cr(B.meta.invValue.min)} (${dMin >= 0 ? "+" : ""}${cr(dMin)})`);
console.log(`                Max ${cr(A.meta.invValue.max)} → ${cr(B.meta.invValue.max)} (${dMax >= 0 ? "+" : ""}${cr(dMax)})`);

const total = valueDiffs.length + tagDiffs.length + shapeDiffs.length;
console.log("");
if (total === 0) console.log("✓ IDENTICAL — 0 of " + B.meta.cells + " cells differ. Provably inert.");
else console.log(`✕ ${total} differences across ${skusTouched.size} SKUs.`);
process.exit(total === 0 ? 0 : 1);
