// What-if for open item #41: does merging split-shipment invoice lines change Min/Max?
//
//   npx vite-node scripts/snapshot-engine-inputs.mjs /tmp/snap.json      # read-only GETs
//   npx vite-node scripts/whatif-order-collapse.mjs /tmp/snap.json [2026-09-24]
//
// FULLY OFFLINE after the snapshot — no Supabase, no Zoho, no engine code changed.
//
// Background (docs/OPEN-WORK.md #41): from 2026-09-24 Zoho raises one invoice PER
// SHIPMENT, so one Shopify order can become several invoices. The engine counts one
// invoice LINE as one order (runEngine `oMap += 1`, collectOrderQtys, plywood
// orderLines), so a split only matters when the SAME SKU is split across shipments —
// 50 ordered, shipped 25 + 25, reads as two orders of 25. That shrinks ABQ and the
// Fixed Unit Floor P90, and moves Plywood's bulk threshold.
//
// The candidate fix merges lines by (shopifyOrder, sku, ds-after-attribution, date),
// summing qty. It is applied here to the INPUT, after attribution — applyAttribution is
// idempotent, so the engine's own pass inside runEngine is then a no-op.
//
// ⚠ SAME-DATE MERGE ONLY. A variant that also moved later shipments onto the order's
// first date was measured 2026-09-28 and rejected: it shifts demand between days and
// knocked Z8GYC off its New DS Floor (10 → 2/3 at DS07/DS08) for reasons unrelated to
// order size.
//
// ⚠ NEVER treat identical lines as duplicates. A genuine 50 → 25 + 25 split looks
// exactly like a duplicate invoice in the stored rows (which carry no invoice number).
// Real duplicates are Zoho's job to VOID, and the sync already excludes void.
//
// Two variants are reported, because they answer different questions:
//   POST    merge only rows dated >= cutover — the effect of the Zoho change itself
//   ALL     merge every row — also folds pre-cutover repeated lines (~0.4% of rows,
//           e.g. one invoice listing 77HVD as three 1-unit lines); what shipping the
//           fix would actually do

import { readFileSync } from "node:fs";
import { runEngine } from "../src/engine/index.js";
import { applyAttribution } from "../src/engine/attribution.js";
import { DS_LIST } from "../src/engine/constants.js";
import { computeInvValue } from "../src/invValue.js";

const [snapPath, cutover = "2026-09-24"] = process.argv.slice(2);
if (!snapPath) {
  console.error("usage: npx vite-node scripts/whatif-order-collapse.mjs <snapshot.json> [cutover YYYY-MM-DD]");
  process.exit(1);
}
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const i = snap.inputs;
const attributed = applyAttribution(i.invoiceData, i.params.pincodeConfig);

// ── 1. Data profile — how much splitting is there, and how much of the window is it? ──
const op = i.params.overallPeriod || 90;
const window = [...new Set(attributed.map(r => r.date))].sort().slice(-op);
const postDays = window.filter(d => d >= cutover).length;
const lineKey = r => `${r.shopifyOrder}|${r.sku}|${r.ds}|${r.date}`;
const excess = rows => {
  const m = new Map();
  for (const r of rows) m.set(lineKey(r), (m.get(lineKey(r)) || 0) + 1);
  let e = 0; for (const v of m.values()) e += v - 1;
  return { e, n: rows.length, pct: rows.length ? (100 * e) / rows.length : 0 };
};
const inWin = attributed.filter(r => r.date >= window[0]);
const pre = excess(inWin.filter(r => r.date < cutover));
const post = excess(inWin.filter(r => r.date >= cutover));
const blank = attributed.filter(r => !r.shopifyOrder).length;

// Orders whose every line appears exactly twice — the pattern that is EITHER a genuine
// even split OR an unvoided duplicate invoice. Listed for a human to check in Zoho.
const byOrder = {};
for (const r of attributed.filter(r => r.date >= cutover)) (byOrder[r.shopifyOrder] ??= []).push(r);
const doubled = Object.entries(byOrder).filter(([, rs]) => {
  if (rs.length < 2) return false;
  const c = new Map(); rs.forEach(r => { const k = lineKey(r) + "|" + r.qty; c.set(k, (c.get(k) || 0) + 1); });
  return [...c.values()].every(v => v === 2);
}).map(([o, rs]) => `${o}@${rs[0].date}(${rs.length / 2} lines)`);

console.log(`SNAPSHOT ${snap.capturedAt} · ${i.invoiceData.length.toLocaleString()} rows · cutover ${cutover}`);
console.log(`  engine window  ${window[0]} → ${window.at(-1)} (${window.length}d) · post-cutover days ${postDays}/${window.length} = ${((100 * postDays) / window.length).toFixed(0)}% full`);
console.log(`  repeated lines pre ${pre.e}/${pre.n} (${pre.pct.toFixed(2)}%) · post ${post.e}/${post.n} (${post.pct.toFixed(2)}%)`);
console.log(`  blank shopifyOrder rows ${blank}${blank ? "  ⚠ merge would fuse unrelated orders — investigate first" : ""}`);
console.log(`  fully-doubled orders since cutover: ${doubled.length}${doubled.length ? " — " + doubled.slice(0, 8).join(" ") + (doubled.length > 8 ? " …" : "") : ""}`);

// ── 2. Engine runs ─────────────────────────────────────────────────────────────────
const merge = (rows, pred) => {
  const m = new Map(), out = [];
  for (const r of rows) {
    if (!pred(r)) { out.push(r); continue; }
    const k = lineKey(r), e = m.get(k);
    if (e) e.qty += r.qty; else { const c = { ...r }; m.set(k, c); out.push(c); }
  }
  return out;
};
const run = inv => runEngine(inv, i.skuMaster, i.minReqQty, i.priceData, new Set(i.deadStock),
  i.newSKUQty, i.params, i.skuCeiling);

const base = run(attributed);
const baseVal = computeInvValue(base, i.priceData, DS_LIST);
const cr = v => `₹${(v / 1e7).toFixed(4)}Cr`, lakh = v => `${v >= 0 ? "+" : "−"}₹${(Math.abs(v) / 1e5).toFixed(2)}L`;
// ⚠ ₹ is Min × purchase price, so an UNPRICED SKU shows ₹0.00L however far it moves —
// the unit change is the signal there (PZVXV DS04 Max 88 → 116 on 2026-09-28).

const locs = [...DS_LIST, "DC"];
const cell = (res, sku, loc) => (loc === "DC" ? res[sku]?.dc : res[sku]?.stores?.[loc]);

for (const [label, pred] of [["POST", r => r.date >= cutover], ["ALL", () => true]]) {
  const inv = merge(attributed, pred);
  const res = run(inv);
  const val = computeInvValue(res, i.priceData, DS_LIST);
  const moves = [];
  for (const sku of Object.keys(base)) for (const loc of locs) {
    const a = cell(base, sku, loc), b = cell(res, sku, loc);
    if (!a || !b || (a.min === b.min && a.max === b.max)) continue;
    const price = Number(i.priceData[sku]) || 0;
    moves.push({ sku, loc, a, b, dMinVal: (b.min - a.min) * price, tag: loc === "DC" ? "(DC)" : `${a.logicTag}→${b.logicTag}`, dMax: Math.abs(b.max - a.max) + Math.abs(b.min - a.min) });
  }
  const cat = {};
  for (const m of moves) {
    const c = i.skuMaster[m.sku]?.category || "(no category)";
    cat[c] = (cat[c] || 0) + m.dMinVal;
  }
  const up = moves.filter(m => m.b.min > m.a.min).length, down = moves.filter(m => m.b.min < m.a.min).length;
  console.log(`\n── ${label}: ${attributed.length - inv.length} lines merged → ${moves.length} cells changed · ${new Set(moves.map(m => m.sku)).size} SKUs · Min up ${up} / down ${down}`);
  console.log(`  Inv Value Min ${cr(baseVal.min)} → ${cr(val.min)} (${lakh(val.min - baseVal.min)}, ${((100 * (val.min - baseVal.min)) / baseVal.min).toFixed(3)}%) · Max ${lakh(val.max - baseVal.max)}`);
  console.log(`  by category (Min ₹): ${Object.entries(cat).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 6).map(([c, v]) => `${c} ${lakh(v)}`).join(" · ") || "—"}`);
  for (const m of moves.sort((x, y) => Math.abs(y.dMinVal) - Math.abs(x.dMinVal) || y.dMax - x.dMax).slice(0, 15)) {
    console.log(`    ${m.sku.padEnd(7)} ${m.loc.padEnd(4)} ${m.a.min}/${m.a.max} → ${m.b.min}/${m.b.max}  ${lakh(m.dMinVal).padStart(9)}  ${m.tag}`);
  }
}
