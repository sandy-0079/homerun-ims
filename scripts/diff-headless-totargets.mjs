// Stage 6 acceptance test: does a HEADLESS engine run reproduce the `toTargets`
// that a browser "Apply & Re-run Model" wrote?
//
//   npx vite-node scripts/diff-headless-totargets.mjs
//
// READ-ONLY. Writes nothing to Supabase, deploys nothing. Also times each phase,
// because a Vercel function has a wall-clock limit and we would rather measure
// that than design around a guess.
//
// ⚠ WHAT THIS NOW MEASURES: it uses the SHARED `src/toTargets.js` builder, while
// the live `params/toTargets` row was written by App.jsx's INLINE copy inside
// `applyAndRun`. So a clean diff is a DRIFT CHECK between the two implementations,
// not a tautology — and it stays useful until App.jsx is switched over to the
// shared builder (deliberately deferred: that is a frontend deploy, and it should
// ride along with the toTargets cutover rather than being a separate risk).
//
// The first run of this harness used its own independent re-implementation and
// measured 0 of 2,030 SKUs differing. That is what earned the extraction — same
// order as the SKU-floor parser, where mirroring `handleFloors` by hand and
// measuring `changed: 0` came before sharing any code.
//
// The five inputs and two post-steps a headless run must get right:
//   1. params/global merged over DEFAULT_PARAMS (SHALLOW — the nested-key trap)
//   2. the own-row configs re-attached via loadParamConfigRows  <-- the trap that
//      silently reverted attribution when 2 of 3 call sites missed pincodeConfig
//   3. team_data/global: skuMaster, minReqQty, priceData, deadStock (Set!), newSKUQty
//   4. team_data/invoice_data: invoiceData
//   5. overrides/global: coreOverrides
//   6. runEngine
//   7. coreOverrides merged per-field max, THEN the DC+active slice

import { runEngine } from "../src/engine/index.js";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";
import { mergeCoreOverrides, buildToTargets } from "../src/toTargets.js";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };

const load = async (table, id) => {
  const r = await fetch(`${B}/${table}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
  const rows = await r.json();
  return rows[0]?.payload ?? null;
};

const ms = (t) => `${Date.now() - t}ms`;
const list = (a, n = 10) => (a.length <= n ? a.join(", ") : `${a.slice(0, n).join(", ")} … (+${a.length - n})`);

// ── 1. Load everything the browser loads ────────────────────────────────────
const tLoad = Date.now();
const [sbParams, team, invRow, liveTo, sbOverrides] = await Promise.all([
  load("params", "global"),
  load("team_data", "global"),
  load("team_data", "invoice_data"),
  load("params", "toTargets"),
  load("overrides", "global"),
]);

// SHALLOW merge, exactly as App.jsx does — a nested key absent from prod falls
// back to the DEFAULT_PARAMS value, which is why fixedUnitFloor.minNZD is read
// with an inline `?? 2` in the engine rather than trusted here.
const activeParams = sbParams ? { ...DEFAULT_PARAMS, ...sbParams } : DEFAULT_PARAMS;
const cfg = await loadParamConfigRows((id) => load("params", id), DS_LIST);
Object.assign(activeParams, cfg.extra);

const invoiceData = invRow?.invoiceData ?? [];
const skuMaster = team?.skuMaster ?? {};
const coreOverrides = sbOverrides ?? {};
const loadMs = Date.now() - tLoad;

console.log("LOAD");
console.log(`  ${loadMs}ms · invoiceData ${invoiceData.length.toLocaleString()} rows · skuMaster ${Object.keys(skuMaster).length}`);
console.log(`  minReqQty ${Object.keys(team?.minReqQty ?? {}).length} · newSKUQty ${Object.keys(team?.newSKUQty ?? {}).length} · priceData ${Object.keys(team?.priceData ?? {}).length} · deadStock ${(team?.deadStock ?? []).length}`);
console.log(`  coreOverrides ${Object.keys(coreOverrides).length} SKUs`);
console.log(`  own-row configs attached: ${Object.keys(cfg.extra).join(", ") || "(none)"}`);
console.log(`  attribution mode: ${activeParams.pincodeConfig?.mode ?? "(absent — would silently be 'location')"}`);

// ── 2. Run the engine ────────────────────────────────────────────────────────
const tEngine = Date.now();
const raw = runEngine(
  invoiceData,
  skuMaster,
  team?.minReqQty ?? {},
  team?.priceData ?? {},
  new Set(team?.deadStock ?? []),
  team?.newSKUQty ?? {},
  activeParams,
);
const engineMs = Date.now() - tEngine;
console.log(`\nENGINE\n  ${engineMs}ms · ${Object.keys(raw).length} SKUs in result`);

// ── 3. Merge coreOverrides, per-field max (applyAndRun does this; the PAGE-LOAD
//       path does NOT — see the note printed below) ─────────────────────────────
const merged = mergeCoreOverrides(raw, coreOverrides);
// How many cells the overrides actually MOVE — the page-load gap below is only
// real for these, so quantify it rather than describing it as a risk.
let ovrMoved = 0;
for (const [sku, dsList] of Object.entries(coreOverrides)) {
  for (const [ds, ov] of Object.entries(dsList || {})) {
    const a = raw[sku]?.stores?.[ds];
    if (a && (Math.max(a.min, ov.min) !== a.min || Math.max(a.max, ov.max) !== a.max)) ovrMoved++;
  }
}

// ── 4. Build the toTargets slice via the SHARED builder ─────────────────────
const built = buildToTargets(merged, DS_LIST);

// ── 5. Diff against what the browser actually wrote ──────────────────────────
const liveTargets = liveTo?.targets ?? {};
const bK = Object.keys(built), lK = Object.keys(liveTargets);
const addedSkus = bK.filter((s) => !(s in liveTargets)).sort();
const missingSkus = lK.filter((s) => !(s in built)).sort();

const canon = (e) => JSON.stringify({
  name: e.name, category: e.category, brand: e.brand,
  perDS: Object.keys(e.perDS ?? {}).sort().map((d) => [d, e.perDS[d].min, e.perDS[d].max]),
});
const changed = [], cellDiffs = [];
for (const s of bK) {
  if (!(s in liveTargets)) continue;
  if (canon(built[s]) === canon(liveTargets[s])) continue;
  changed.push(s);
  for (const ds of DS_LIST) {
    const a = built[s].perDS?.[ds], b = liveTargets[s].perDS?.[ds];
    const av = a ? `${a.min}/${a.max}` : "—", bv = b ? `${b.min}/${b.max}` : "—";
    if (av !== bv) cellDiffs.push(`${s} ${ds}: headless ${av} vs browser ${bv}`);
  }
}

console.log(`\nDIFF vs params/toTargets  (browser Apply at ${liveTo?.refreshedAt})`);
console.log(`  headless ${bK.length} SKUs · browser ${lK.length} SKUs`);
console.log(`  only in headless : ${addedSkus.length}${addedSkus.length ? " → " + list(addedSkus) : ""}`);
console.log(`  only in browser  : ${missingSkus.length}${missingSkus.length ? " → " + list(missingSkus) : ""}`);
console.log(`  differing        : ${changed.length}${changed.length ? " → " + list(changed) : ""}`);
for (const d of cellDiffs.slice(0, 25)) console.log(`      ${d}`);
if (cellDiffs.length > 25) console.log(`      … (+${cellDiffs.length - 25} more cells)`);

// ── 6. The IMS page-load gap, worth knowing regardless of Stage 6 ───────────
// applyAndRun merges coreOverrides before building toTargets; the page-load path
// calls setResults(raw) WITHOUT that merge. So IMS-on-load and toTargets already
// disagree for any SKU an override actually moves.
console.log(`\nPAGE-LOAD GAP`);
console.log(`  coreOverrides move ${ovrMoved} SKU×DS cells. applyAndRun merges them before`);
console.log(`  building toTargets; the page-load path (App.jsx setResults(raw)) does not.`);

const clean = !addedSkus.length && !missingSkus.length && !changed.length;
console.log(`\nTIMING  load ${loadMs}ms + engine ${engineMs}ms = ${loadMs + engineMs}ms total`);
console.log(clean
  ? "\n✅ HEADLESS RUN REPRODUCES THE BROWSER APPLY EXACTLY — 0 SKUs differ"
  : `\n❌ ${addedSkus.length + missingSkus.length + changed.length} SKUs differ — do NOT build on this until root-caused`);
process.exit(clean ? 0 : 1);
