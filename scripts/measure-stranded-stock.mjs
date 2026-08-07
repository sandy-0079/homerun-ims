// How much stock sits at a DS with NO target against it?
//
//   npx vite-node scripts/measure-stranded-stock.mjs
//
// READ-ONLY. Writes nothing.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Until 2026-08-07 Stock Health's `allSkuRows` dropped any SKU whose engine
// min AND max were 0 at a location, regardless of stock physically sitting
// there. The DS teams build reverse TOs (send excess back to the DC) off that
// table, so a SKU zeroed overnight — demand out of the window, Dead Stock, a
// floor removed — became invisible with its units still on the shelf. This
// script measured that population and sized the fix: ₹64.0L across DS01–DS06.
//
// ── WHAT IT IS FOR NOW ─────────────────────────────────────────────────────
// The tab shows every active SKU at every location, so nothing is hidden any
// more. What this still answers, without opening the app:
//   * how much value is parked at each DS with no target against it,
//   * split by CAUSE, which matters because they are not equally recoverable:
//     a demand dip self-heals, a Zoho deactivation never does,
//   * Supplier-inventorised stock, which remains excluded from the tab BY
//     DESIGN and is therefore still invisible there.
// Also prints the tab's row universe and the KPI/coverage arithmetic, so the
// numbers on screen can be re-derived from the data rather than trusted.
//
// ⚠ Deliberately cites no line numbers — they drift silently. Grep for
// `inLocationUniverse` in StockHealthTab.jsx for the live universe rule.

import { runEngine } from "../src/engine/index.js";
import { DEFAULT_PARAMS, DS_LIST } from "../src/engine/constants.js";
import { loadParamConfigRows } from "../src/paramConfigRows.js";

const B = "https://rgyupnrogkbugsadwlye.supabase.co/rest/v1";
const K =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc";
const H = { apikey: K, Authorization: `Bearer ${K}` };

const load = async (table, id) => {
  const r = await fetch(`${B}/${table}?select=payload&id=eq.${id}`, { headers: H });
  if (!r.ok) throw new Error(`${table}/${id}: HTTP ${r.status}`);
  return (await r.json())[0]?.payload ?? null;
};

const [sbParams, team, invRow] = await Promise.all([
  load("params", "global"),
  load("team_data", "global"),
  load("team_data", "invoice_data"),
]);

const activeParams = sbParams ? { ...DEFAULT_PARAMS, ...sbParams } : DEFAULT_PARAMS;
const cfg = await loadParamConfigRows((id) => load("params", id), DS_LIST);
Object.assign(activeParams, cfg.extra);

const skuMaster = team?.skuMaster ?? {};
const priceData = team?.priceData ?? {};
const deadStock = new Set(team?.deadStock ?? []);
// Stock Health defaults to the ACCOUNTING view on DS tabs; both are measured.
const stockAcc = team?.stockDataAccounting ?? {};
const stockPhy = team?.stockData ?? {};

const res = runEngine(
  invRow?.invoiceData ?? [],
  skuMaster,
  team?.minReqQty ?? {},
  priceData,
  deadStock,
  team?.newSKUQty ?? {},
  activeParams,
);

// ECS = max(0, stock_on_hand) — Stock Health uses SoH, not AFS (switched 2026-06-30).
const soh = (store, sku, ds) => Math.max(0, store?.[sku]?.[ds]?.stock_on_hand ?? 0);

// ── What does the tab show TODAY vs the full ACTIVE universe? ────────────────
// Scope agreed 2026-08-07: active only (inactive / confirmation_pending ignored),
// Supplier still excluded. So the universe is active + non-supplier SKUs.
console.log(`\n${"#".repeat(78)}\nSCOPE: active, non-Supplier SKUs (accounting stock view)\n${"#".repeat(78)}`);

const universe = Object.entries(res).filter(([, r]) => {
  const m = r.meta || {};
  return (m.status || "Active").toLowerCase() === "active"
      && (m.inventorisedAt || "DS").toLowerCase() !== "supplier";
});
console.log(`\nactive non-Supplier SKUs in the engine result: ${universe.length}`);
console.log(`\n${"DS".padEnd(6)}${"shown today".padStart(12)}${"+0/0 w/ stock".padStart(14)}${"0/0 no stock".padStart(14)}${"no stk record".padStart(15)}${"= all active".padStart(13)}`);
for (const ds of DS_LIST) {
  let shown = 0, addWithStock = 0, zeroNoStock = 0, noRecord = 0;
  for (const [sku, r] of universe) {
    const mm = r.stores?.[ds];
    const live = stockAcc[sku]?.[ds];
    const units = soh(stockAcc, sku, ds);
    const zero = !mm || (!mm.min && !mm.max);
    if (!live) { noRecord++; continue; }          // line 341 — no stock record at all
    if (!zero) { shown++; continue; }             // has targets → visible today
    if (units > 0) addWithStock++;                // THE FIX: 0/0 but holding stock
    else zeroNoStock++;                           // 0/0 and empty → nothing to return
  }
  const all = shown + addWithStock + zeroNoStock + noRecord;
  console.log(`${ds.padEnd(6)}${String(shown).padStart(12)}${String(addWithStock).padStart(14)}${String(zeroNoStock).padStart(14)}${String(noRecord).padStart(15)}${String(all).padStart(13)}`);
}
console.log(`\n  "shown today" + "+0/0 w/ stock" = the table under the proposed change.`);
console.log(`  "0/0 no stock" + "no stk record" = would ONLY appear if we showed every active SKU.`);

// ── KPI card impact: today's row set vs the proposed one ────────────────────
// getHealthTag mirrored EXACTLY from StockHealthTab.jsx:63. Note the key names
// are inverted vs their labels: key "ec" renders as "Critical", key "critical"
// renders as "Low Stock".
const healthTag = (ecs, min, max, ros) => {
  if (ecs > max) return "excess";
  if (ecs === min && min === max) return "okay";
  if (ecs <= min) return (ros - ecs >= 1) ? "ec" : "critical";
  return "okay";
};
const LABEL = { ec: "Critical", critical: "Low Stock", okay: "Okay", excess: "Excess" };

const masterTotal = Object.values(skuMaster).filter(e =>
  (e.status || "Active").toLowerCase() === "active" &&
  (e.inventorisedAt || "DS").toLowerCase() !== "supplier").length;
console.log(`\nmasterTotal (nav denominator today) = ${masterTotal}`);

console.log(`\n${"#".repeat(78)}\nKPI CARD IMPACT — counts and % of the tab's denominator\n${"#".repeat(78)}`);
for (const ds of DS_LIST) {
  const now = { ec: 0, critical: 0, okay: 0, excess: 0 };
  const next = { ec: 0, critical: 0, okay: 0, excess: 0 };
  let withTargets = 0;
  for (const [sku, r] of universe) {
    const mm = r.stores?.[ds];
    const ecs = soh(stockAcc, sku, ds);
    const min = mm?.min || 0, max = mm?.max || 0;
    const ros = mm?.dailyAvg || 0;
    const zero = !min && !max;
    const tag = healthTag(ecs, min, max, ros);
    if (!zero) { now[tag]++; withTargets++; }        // today's table
    next[tag]++;                                      // proposed table (every active SKU)
  }
  const nowTot = Object.values(now).reduce((a, b) => a + b, 0);
  const nextTot = Object.values(next).reduce((a, b) => a + b, 0);
  console.log(`\n${ds}   today ${nowTot} rows  →  proposed ${nextTot} rows`);
  for (const k of ["ec", "critical", "okay", "excess"]) {
    const pn = ((now[k] / nowTot) * 100).toFixed(1), px = ((next[k] / nextTot) * 100).toFixed(1);
    console.log(`   ${LABEL[k].padEnd(10)} ${String(now[k]).padStart(5)} (${pn.padStart(5)}%)  →  ${String(next[k]).padStart(5)} (${px.padStart(5)}%)`);
  }
  console.log(`   nav coverage: today ${nowTot}/${masterTotal} = ${((nowTot / masterTotal) * 100).toFixed(0)}%` +
              `  ·  proposed (unfixed) ${nextTot}/${masterTotal} = ${((nextTot / masterTotal) * 100).toFixed(0)}%` +
              `  ·  re-based to "has target" ${withTargets}/${masterTotal} = ${((withTargets / masterTotal) * 100).toFixed(0)}%`);
}

const CAUSES = [
  ["deactivated", "Deactivated in Zoho — will NEVER be replenished again"],
  ["supplier", "Inventorised At = Supplier — never stocked in our network"],
  ["deadStock", "Ops marked it Dead Stock"],
  ["zeroTarget", "Targets fell to 0/0 (demand out of window, or floor removed)"],
];

for (const [label, store] of [["ACCOUNTING (Stock Health default)", stockAcc], ["PHYSICAL", stockPhy]]) {
  console.log(`\n${"=".repeat(78)}\n${label}\n${"=".repeat(78)}`);

  const grand = {};
  for (const ds of DS_LIST) {
    const buckets = Object.fromEntries(CAUSES.map(([c]) => [c, { skus: 0, units: 0, value: 0 }]));
    let visibleExcess = { skus: 0, units: 0, value: 0 };

    for (const [sku, r] of Object.entries(res)) {
      const meta = r.meta || {};
      const invAt = (meta.inventorisedAt || "DS").toLowerCase();
      const active = (meta.status || "Active").toLowerCase() === "active";
      const mm = r.stores?.[ds];
      const units = soh(store, sku, ds);
      if (units <= 0) continue; // nothing physically there → nothing to return

      const price = priceData[sku] ?? 0;
      const value = units * price;
      const zero = !mm || (!mm.min && !mm.max);

      // Cause precedence mirrors how the row is hidden: the FIRST matching
      // exclusion in allSkuRows is what actually drops it.
      let cause = null;
      if (invAt === "supplier") cause = "supplier";
      else if (!active) cause = "deactivated";
      else if (zero) cause = deadStock.has(sku) ? "deadStock" : "zeroTarget";

      if (cause) {
        buckets[cause].skus++; buckets[cause].units += units; buckets[cause].value += value;
      } else if (units > (mm.max || 0)) {
        visibleExcess.skus++; visibleExcess.units += units; visibleExcess.value += value;
      }
    }

    const hidTot = CAUSES.reduce((a, [c]) => ({
      skus: a.skus + buckets[c].skus, units: a.units + buckets[c].units, value: a.value + buckets[c].value,
    }), { skus: 0, units: 0, value: 0 });

    console.log(`\n${ds}  — hidden ${hidTot.skus} SKUs · ${hidTot.units.toLocaleString()} units · ₹${(hidTot.value / 1e5).toFixed(1)}L`);
    console.log(`      (already visible as Excess: ${visibleExcess.skus} SKUs · ₹${(visibleExcess.value / 1e5).toFixed(1)}L)`);
    for (const [c, desc] of CAUSES) {
      const b = buckets[c];
      if (!b.skus) continue;
      console.log(`      ${c.padEnd(12)} ${String(b.skus).padStart(4)} SKUs · ${String(b.units).padStart(6)} units · ₹${(b.value / 1e5).toFixed(1).padStart(6)}L   ${desc}`);
    }
    for (const [c] of CAUSES) {
      grand[c] = grand[c] || { skus: 0, units: 0, value: 0 };
      grand[c].skus += buckets[c].skus; grand[c].units += buckets[c].units; grand[c].value += buckets[c].value;
    }
  }

  console.log(`\n  ── NETWORK TOTAL (DS only, excludes DC) ──`);
  let tv = 0, tu = 0, ts = 0;
  for (const [c, desc] of CAUSES) {
    const g = grand[c];
    if (!g.skus) continue;
    console.log(`   ${c.padEnd(12)} ${String(g.skus).padStart(4)} SKU×DS · ${String(g.units).padStart(6)} units · ₹${(g.value / 1e5).toFixed(1).padStart(6)}L   ${desc}`);
    tv += g.value; tu += g.units; ts += g.skus;
  }
  console.log(`   ${"TOTAL".padEnd(12)} ${String(ts).padStart(4)} SKU×DS · ${String(tu).padStart(6)} units · ₹${(tv / 1e5).toFixed(1).padStart(6)}L`);
}

// ── DC tab universe (scope decision 2026-08-07: same rule applies there) ─────
{
  const dcUniverse = Object.entries(res).filter(([, r]) => {
    const m = r.meta || {};
    return (m.status || "Active").toLowerCase() === "active"
        && (m.inventorisedAt || "DS").toLowerCase() === "dc";
  });
  let shown = 0, addWithStock = 0, zeroEmpty = 0;
  for (const [sku, r] of dcUniverse) {
    const mm = r.dc;
    const units = soh(stockAcc, sku, "DC");
    const zero = !mm || (!mm.min && !mm.max);
    if (!zero) shown++;
    else if (units > 0) addWithStock++;
    else zeroEmpty++;
  }
  console.log(`\n${"#".repeat(78)}\nDC TAB — active + inventorisedAt=dc\n${"#".repeat(78)}`);
  console.log(`  universe ${dcUniverse.length} · shown today ${shown} · +0/0 with stock ${addWithStock} · 0/0 empty ${zeroEmpty}`);
}
