// Dead Stock leak — READ-ONLY AUDIT. Writes NOTHING, to Supabase or disk.
//
//   npx vite-node scripts/audit-deadstock-leak.mjs
//
// WHY: `runEngine` applies the Dead Stock cap INLINE in each branch that builds
// `stores[dsId]`, and there are four such branches. Three carry the cap; the
// NO-DATA-with-a-manual-floor branch (`runEngine.js:271`) does not. So a Dead
// Stock SKU that has a `newSKUQty` floor at a store NOT in `newDSList` and no
// sales at that store in the window keeps the floor as its Min/Max.
//
// Same class as the SKU Ceiling four-writers bug of 2026-08-15. This script does
// not re-implement the rule — it runs the REAL engine and asks which Dead Stock
// SKU x DS cells came back non-zero, which is the only question that matters.

import { runEngine } from "../src/engine/index.js";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };
const load = async (t, id) => {
  const r = await fetch(`${B}/${t}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${t}/${id}: HTTP ${r.status}`);
  return (await r.json())[0]?.payload ?? null;
};
const lakh = (n) => `Rs${(n / 1e5).toFixed(2)}L`;

const REPORTED = ["4BK45", "EDUNK", "RYNJT", "RU5YU", "WUZUF", "Y8SCD"];

const [sbParams, team, invRow] = await Promise.all([
  load("params", "global"), load("team_data", "global"), load("team_data", "invoice_data"),
]);
const activeParams = { ...DEFAULT_PARAMS, ...sbParams };
Object.assign(activeParams, (await loadParamConfigRows((id) => load("params", id), DS_LIST)).extra);

const invoiceData = invRow?.invoiceData ?? [];
const skuMaster  = team?.skuMaster ?? {};
const priceData  = team?.priceData ?? {};
const newSKUQty  = team?.newSKUQty ?? {};
const deadArr    = team?.deadStock ?? [];
const deadSet    = new Set(deadArr);
const newDSList  = activeParams.newDSList || [];

console.log("LOAD (read-only)");
console.log(`  invoiceData ${invoiceData.length.toLocaleString()} rows · skuMaster ${Object.keys(skuMaster).length} · newSKUQty ${Object.keys(newSKUQty).length}`);
console.log(`  deadStock ${deadArr.length} SKUs · skuCeiling ${Object.keys(team?.skuCeiling ?? {}).length} SKUs`);
console.log(`  newDSList (LIVE, derived — not from a doc): [${newDSList.join(", ")}]`);
console.log(`  => stores NOT in newDSList (the exposed ones): [${DS_LIST.filter(d => !newDSList.includes(d)).join(", ")}]`);

// ── One run of the REAL engine, exactly as prod computes it ─────────────────
const res = runEngine(invoiceData, skuMaster, team?.minReqQty ?? {}, priceData,
  deadSet, newSKUQty, activeParams, team?.skuCeiling ?? {});

// ── Every Dead Stock cell that came back non-zero ───────────────────────────
const leaks = [];
let dcLeaks = 0;
for (const sku of deadArr) {
  const r = res[sku];
  if (!r) continue;
  if ((r.dc?.min ?? 0) > 0 || (r.dc?.max ?? 0) > 0) dcLeaks++;
  for (const ds of DS_LIST) {
    const s = r.stores?.[ds];
    if (!s || (s.min === 0 && s.max === 0)) continue;
    const fl = newSKUQty[sku]?.[ds];
    leaks.push({
      sku, ds, min: s.min, max: s.max,
      logicTag: s.logicTag,
      // The branch tell: the main HAS-DATA loop always sets `postBlendSteps` ([])
      // and `nonZeroDays`; the NO-DATA branches never create either key.
      branch: s.postBlendSteps === undefined
        ? (newDSList.includes(ds) ? "NO-DATA / newDS (:257)" : "NO-DATA / floor (:271)")
        : "HAS-DATA (:290)",
      floor: fl === undefined ? "-" : (typeof fl === "number" ? String(fl) : `${fl.min ?? 0}/${fl.max ?? 0}`),
      value: (Number(priceData[sku]) || 0) * s.max,
      status: (skuMaster[sku]?.status ?? "?"),
      invAt: (skuMaster[sku]?.inventorisedAt ?? "?"),
    });
  }
}

console.log(`\nRESULT  ${leaks.length} Dead Stock SKU x DS cells came back NON-ZERO, across ${new Set(leaks.map(l => l.sku)).size} SKUs`);
console.log(`        DC cells non-zero on a Dead Stock SKU: ${dcLeaks}  (expect 0 — the DC check sits on the finished map)`);

const byBranch = {}, byDs = {};
for (const l of leaks) { byBranch[l.branch] = (byBranch[l.branch] || 0) + 1; byDs[l.ds] = (byDs[l.ds] || 0) + 1; }
console.log("\n  by code path:");
for (const [b, n] of Object.entries(byBranch).sort((a, c) => c[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${b}`);
console.log("  by store:");
for (const ds of DS_LIST) console.log(`    ${String(byDs[ds] || 0).padStart(4)}  ${ds}${newDSList.includes(ds) ? "  (in newDSList)" : ""}`);

const totalValue = leaks.reduce((a, l) => a + l.value, 0);
console.log(`\n  value at risk (sum of price x leaked Max): ${lakh(totalValue)}`);

console.log(`\nTHE SIX SKUs YOU REPORTED`);
for (const sku of REPORTED) {
  const inDead = deadSet.has(sku);
  const m = skuMaster[sku];
  console.log(`\n  ${sku}  deadStock=${inDead}  status=${m?.status ?? "ABSENT FROM MASTER"}  invAt=${m?.inventorisedAt ?? "-"}  price=${priceData[sku] ?? "-"}`);
  console.log(`        floors: ${JSON.stringify(newSKUQty[sku] ?? null)}`);
  const r = res[sku];
  if (!r) { console.log("        (no engine result)"); continue; }
  for (const ds of DS_LIST) {
    const s = r.stores?.[ds] ?? {};
    const branch = s.postBlendSteps === undefined
      ? (newDSList.includes(ds) ? "NO-DATA/newDS" : "NO-DATA/floor")
      : "HAS-DATA";
    const flag = (s.min || s.max) ? "  <-- LEAK" : "";
    console.log(`        ${ds}  ${String(s.min ?? 0)}/${String(s.max ?? 0)}  tag="${s.logicTag}"  nzd=${s.nonZeroDays ?? "-"}  path=${branch}${flag}`);
  }
  console.log(`        DC  ${r.dc?.min ?? 0}/${r.dc?.max ?? 0}  isDead=${r.dc?.dcDetails?.isDead}`);
}

console.log(`\nFULL LEAK LIST (${leaks.length})`);
leaks.sort((a, b) => b.value - a.value);
for (const l of leaks) {
  console.log(`  ${l.sku.padEnd(10)} ${l.ds}  ${String(l.min)}/${String(l.max)}`.padEnd(34) +
    ` floor=${l.floor.padEnd(7)} tag="${l.logicTag}" ${l.branch}  ${lakh(l.value)}  [${l.status}/${l.invAt}]`);
}
console.log("\n(read-only — nothing was written)");
