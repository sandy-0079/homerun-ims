// SKU-floor sheet sync — DRY RUN. Reads the published Google Sheet and prod
// Supabase, runs the real parse + guard, writes NOTHING.
//
//   npx vite-node scripts/dryrun-sku-floors.mjs
//
// Imports the same `_shared/skuFloorSheet.ts` the edge function will use, on
// purpose: a dry run that re-implements the parse proves nothing about the thing
// that will actually write. Same reasoning as compare-csv-vs-live.mjs importing
// the real parseInvoiceCsv.

import { parseFloorSheet, assessFloorChange } from "../supabase/functions/_shared/skuFloorSheet.ts";
import { DS_LIST } from "../src/engine/constants.js";

const SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTT2_CBSySgwSk_DVQEziLMzrTxWxmuVDZ1npn6qb5jIeN2zBbNAQWPRZf-r3A7tb_mreZtAgNSJYFh/pub?gid=0&single=true&output=csv";

const SB = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";

const list = (a, n = 12) =>
  a.length <= n ? a.join(", ") : `${a.slice(0, n).join(", ")} … (+${a.length - n} more)`;

// ── 1. The sheet ─────────────────────────────────────────────────────────────
const res = await fetch(SHEET_CSV, { redirect: "follow" });
const csv = await res.text();
console.log("SHEET");
console.log(`  HTTP ${res.status} · ${res.headers.get("content-type")} · ${csv.length} bytes`);
if (!res.ok) { console.log("  ✗ fetch failed — nothing to assess"); process.exit(1); }

// ── 2. Live state ────────────────────────────────────────────────────────────
const r = await fetch(`${SB}/team_data?select=payload&id=eq.global`, { headers: { apikey: KEY } });
const payload = (await r.json())[0]?.payload ?? {};
const live = payload.newSKUQty ?? {};
const skuMaster = payload.skuMaster ?? {};
console.log(`  live newSKUQty: ${Object.keys(live).length} SKUs · skuMaster: ${Object.keys(skuMaster).length}`);

// ── 3. Parse ─────────────────────────────────────────────────────────────────
const p = parseFloorSheet(csv, DS_LIST);
console.log(`\nPARSE  (DS_LIST = ${DS_LIST.join(",")})`);
console.log(`  ok=${p.ok} reason=${p.reason} · ${p.skuCount} SKUs · ${p.blankSkuRows} blank-SKU rows skipped`);
if (p.unknownDs.length) console.log(`  ✗ unknown DS columns: ${p.unknownDs.join(", ")} — DS_LIST must gain them first`);
if (p.duplicateSkus.length) console.log(`  ✗ duplicate SKUs: ${list(p.duplicateSkus)}`);
if (p.invalid.length) {
  console.log(`  ✗ ${p.invalid.length} invalid values:`);
  for (const v of p.invalid.slice(0, 10)) console.log(`      ${v.sku} · ${v.column} = "${v.value}"`);
}
if (!p.ok) { console.log("\n❌ parse failed — a real run would REFUSE to write and leave floors untouched"); process.exit(1); }

const withFloors = Object.values(p.floors).filter((f) => Object.keys(f).length > 0).length;
const dsSet = {};
for (const f of Object.values(p.floors)) for (const ds of Object.keys(f)) dsSet[ds] = (dsSet[ds] ?? 0) + 1;
console.log(`  ${withFloors} SKUs carry at least one floor · ${p.skuCount - withFloors} are all-zero (floor absent)`);
console.log(`  floors per DS: ${Object.keys(dsSet).sort().map((d) => `${d}=${dsSet[d]}`).join(" ")}`);

// ── 4. Guard ─────────────────────────────────────────────────────────────────
const a = assessFloorChange({ parsed: p.floors, live });
console.log(`\nGUARD`);
console.log(`  safe=${a.safe} reason=${a.reason}`);
console.log(`  SKU keys      : ${a.liveCount} -> ${a.parsedCount}  (drop ${a.dropPct.toFixed(2)}%)`);
// ⚠ The dimension that catches a mass-zeroing, which leaves the key count flat.
console.log(`  carrying floor: ${a.liveWithFloors} -> ${a.parsedWithFloors}  (drop ${a.floorDropPct.toFixed(2)}%)`);
console.log(`  added ${a.added.length} · removed ${a.removed.length} · changed ${a.changed.length}`);
if (a.added.length) console.log(`    + ${list(a.added)}`);
if (a.removed.length) console.log(`    - ${list(a.removed)}`);
if (a.changed.length) console.log(`    ~ ${list(a.changed)}`);

// ── 5. Floors that can never take effect ─────────────────────────────────────
// The most valuable output and nothing to do with syncing: ops maintains these
// believing all are live. A floor on a SKU absent from skuMaster, or on one that
// is not Active, is zeroed by the engine's active-only pass.
const absent = [], inactive = [];
for (const [sku, f] of Object.entries(p.floors)) {
  if (Object.keys(f).length === 0) continue;
  const meta = skuMaster[sku];
  if (!meta) { absent.push(sku); continue; }
  if ((meta.status || "Active").toLowerCase() !== "active") inactive.push(sku);
}
console.log(`\nINEFFECTIVE FLOORS  ${absent.length + inactive.length} of ${withFloors}`);
if (absent.length) console.log(`  absent from skuMaster (${absent.length}): ${list(absent, 8)}`);
if (inactive.length) console.log(`  in master but not Active (${inactive.length}): ${list(inactive, 8)}`);

console.log(
  a.safe
    ? `\n✅ a real run WOULD write ${a.parsedCount} SKUs to newSKUQty`
    : `\n❌ a real run would REFUSE (${a.reason}) and leave floors untouched`,
);
