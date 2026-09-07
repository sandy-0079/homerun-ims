// Replay the engine against a frozen input snapshot and dump every cell.
//
//   npx vite-node scripts/dump-engine-output.mjs <snapshot.json> [out.json]
//
// FULLY OFFLINE — reads the snapshot from disk, touches no network and no Supabase.
// Pair with snapshot-engine-inputs.mjs (capture once) and diff-engine-dumps.mjs
// (compare two dumps). The three together are the inertness proof: freeze the
// inputs, dump on the old engine, `git stash` back to the new one, dump again, diff.
//
// ⚠ ALL EIGHT runEngine ARGUMENTS ARE PASSED EXPLICITLY. The 8th (`ceilings`)
// defaults to `{}` — a silent no-op — and CLAUDE.md records that a call site which
// forgets it publishes UNCAPPED targets with nothing looking wrong. Never rely on
// the default here.
//
// ⚠ deadStock is stored as an ARRAY and consumed as a Set. The snapshot keeps the
// array (so the file is plain JSON); re-wrap on every replay or every Dead Stock SKU
// silently stops being dead.
//
// What a cell records, and why each field is here rather than just min/max:
//   logicTag / strategyTag  — a min/max that matches while the TAG changed means the
//                             same number arrived by a different code path, which is
//                             the signature of the four-writers class of bug.
//   postBlendSteps presence — CLAUDE.md's fastest diagnostic in this engine: a store
//                             built by the main loop has `[]`, the NO-DATA branches
//                             never create the key at all, so `undefined` means a
//                             DIFFERENT branch produced this cell.
//   dcBasis                 — which DC branch fired (dead / floored / rate), so a DC
//                             difference points at the branch rather than the number.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { runEngine } from "../src/engine/index.js";
import { DS_LIST } from "../src/engine/constants.js";
import { computeInvValue } from "../src/invValue.js";

const snapPath = process.argv[2];
if (!snapPath) {
  console.error("usage: npx vite-node scripts/dump-engine-output.mjs <snapshot.json> [out.json]");
  process.exit(1);
}
const out = process.argv[3] || snapPath.replace(/\.json$/, "") + ".dump.json";

const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const i = snap.inputs;

const t0 = Date.now();
const res = runEngine(
  i.invoiceData,
  i.skuMaster,
  i.minReqQty,
  i.priceData,
  new Set(i.deadStock),
  i.newSKUQty,
  i.params,
  i.skuCeiling,
);
const engineMs = Date.now() - t0;

const dcBasisOf = (d) => {
  if (!d) return "";
  if (d.isDead) return "dead";
  if (d.dcOnly) return "dcOnly";          // set by the DC-only branch once it exists
  if (d.isFlooredSKU) return "floored";
  if (d.network) return "network";
  return "rate";
};

const cells = {};
for (const [sku, r] of Object.entries(res)) {
  for (const ds of DS_LIST) {
    const s = r.stores?.[ds];
    if (!s) { cells[`${sku}||${ds}`] = null; continue; }
    cells[`${sku}||${ds}`] = {
      min: s.min, max: s.max,
      logicTag: s.logicTag ?? "",
      strategyTag: s.strategyTag ?? "",
      // presence, not contents — see the header note on branch detection
      steps: Array.isArray(s.postBlendSteps) ? "[]" : "undefined",
    };
  }
  const dc = r.dc;
  cells[`${sku}||DC`] = dc
    ? { min: dc.min, max: dc.max, reason: dc.dcDetails?.zeroedReason ?? "", basis: dcBasisOf(dc.dcDetails) }
    : null;
}

const invValue = computeInvValue(res, i.priceData, DS_LIST);

const dump = {
  meta: {
    snapshotAt: snap.capturedAt,
    snapshotGitHead: snap.gitHead,
    dumpGitHead: (() => {
      try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
      catch { return "unknown"; }
    })(),
    dumpedAt: new Date().toISOString(),
    engineMs,
    skus: Object.keys(res).length,
    cells: Object.keys(cells).length,
    invValue,
    fingerprint: snap.fingerprint,
  },
  cells,
};

writeFileSync(out, JSON.stringify(dump));

console.log(`DUMP written to ${out}`);
console.log(`  engine ${engineMs}ms · ${dump.meta.skus} SKUs · ${dump.meta.cells} cells`);
console.log(`  snapshot ${snap.capturedAt} (git ${snap.gitHead}) · dumped on git ${dump.meta.dumpGitHead}`);
console.log(`  Inv Value  Min ₹${(invValue.min / 1e7).toFixed(4)}Cr · Max ₹${(invValue.max / 1e7).toFixed(4)}Cr`);
