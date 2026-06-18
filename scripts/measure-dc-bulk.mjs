#!/usr/bin/env node
// READ-ONLY diagnostic: DC per-SKU (s,S) service-vs-rack frontier on real data.
//   s (Min) = P[q] of L-day TO-drain windows  (reorder point)
//   S (Max) = P[q] of H-day TO-drain windows  (order-up-to depth)
// Sweeps (q, H); replays the test window @ α=0.7; reports TO qty-fill (headline), line-fill,
// incidental bulk fill, and the DC rack (thick/thin) each point needs. Caches to .cache/.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

const URL = 'https://rgyupnrogkbugsadwlye.supabase.co';
const KEY = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneXVwbnJvZ2tidWdzYWR3bHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzgzMzgsImV4cCI6MjA4ODM1NDMzOH0.sbZh8CbmW7hhpiUCg5OoS7hQzHaNqExkaAlACEqJ9sc';

async function fetchRow(table, id) {
  const path = `.cache/${table}-${id}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const r = await fetch(`${URL}/rest/v1/${table}?select=payload&id=eq.${id}`, { headers: { apikey: KEY } });
  const j = (await r.json())[0]?.payload ?? null;
  mkdirSync('.cache', { recursive: true });
  writeFileSync(path, JSON.stringify(j));
  return j;
}

const { computePlywoodNetworkV2Results, V2_DEFAULTS, buildUniverse, prepareDemand, replay, rollingSums } =
  await import('../src/engine/strategies/plywoodV2/index.js');
const { percentile } = await import('../src/engine/utils.js');
const { DS_LIST } = await import('../src/engine/constants.js');

const global_ = await fetchRow('team_data', 'global');
const invRow = await fetchRow('team_data', 'invoice_data');
const inv = invRow.invoiceData ?? invRow;
const skuM = global_.skuMaster;

const cfg = { ...V2_DEFAULTS };
const res = computePlywoodNetworkV2Results(inv, skuM, { plywoodNetworkV2Config: cfg });
const universe = buildUniverse(skuM, cfg);
const demand = prepareDemand(inv, universe, cfg);

const plan = {}, tclass = {};
for (const [sku, r] of Object.entries(res)) {
  plan[sku] = {};
  for (const ds of DS_LIST) plan[sku][ds] = { min: r.storeResults[ds].min, max: r.storeResults[ds].max };
  tclass[sku] = r.storeResults.DS01?.v2?.tclass || 'thin';
}
const footprint = (dc) => {
  const f = { thick: 0, thin: 0 };
  for (const sku of Object.keys(dc)) f[tclass[sku]] += dc[sku].max;
  return f;
};
const pct = (x) => (x * 100).toFixed(1) + '%';

// the infinite-DC drain the engine sizes against
const drain = replay(plan, null, demand, { ...cfg, infiniteDC: true }).toDrain;

// Proposed rule: Min = P[q] of L-day TO-drain; Max = Min + max(one bulk order, lead-time TO-drain).
const L = cfg.leadDays ?? 3;
const bulkBySku = {};
for (const o of demand.orders) {
  if (!o.isBulk) continue;
  const per = {};
  for (const l of o.lines) per[l.sku] = (per[l.sku] || 0) + l.qty;
  for (const [sku, q] of Object.entries(per)) (bulkBySku[sku] ??= []).push(q);
}
const sizeRule = (q, bulkPct) => {
  const dc = {};
  for (const sku of Object.keys(res)) {
    const leadW = rollingSums(drain[sku] || {}, demand.windowDates, L).sort((a, b) => a - b);
    const s = Math.ceil(percentile(leadW, q) || 0);
    const meanLead = Math.ceil(leadW.reduce((a, b) => a + b, 0) / Math.max(leadW.length, 1)); // lead-time batch
    const bo = (bulkBySku[sku] || []).slice().sort((a, b) => a - b);
    const oneOrder = bo.length ? Math.ceil(percentile(bo, bulkPct) || 0) : 0;
    dc[sku] = { min: s, max: s + Math.max(oneOrder, meanLead) };
  }
  return dc;
};

console.log('\n=== Proposed rule: Max = Min + max(one bulk order @P[bp], lead-time drain) — q=98 (α=0.7) ===');
console.log('  "one order" bp   DS regular svc   bulk@DC   rack(thick/thin/total)');
for (const bp of [50, 75, 90]) {
  const dc = sizeRule(98, bp);
  const sim = replay(plan, dc, demand, { ...cfg, bulkDcServedShare: 0.7 });
  const f = footprint(dc), b = sim.serviceLevels.bulk;
  console.log(`  P${String(bp).padEnd(14)} ${pct(sim.serviceLevels.regular.overall).padEnd(16)} ${pct(b.total ? 1 - b.oos / b.total : 1).padEnd(9)} ${f.thick}/${f.thin}/${f.thick + f.thin}`);
}
// engine-path check (default cfg, dcBulkServicePct=90) — the REAL computePlywoodNetworkV2Results plan
const ref = 'PLY-ARC-CLA-MR-18M-32';
const engFp = { thick: 0, thin: 0 };
for (const [sku, r] of Object.entries(res)) engFp[tclass[sku]] += r.dcResult.max;
console.log(`\nEngine path (default P${cfg.dcBulkServicePct}):  ${ref} → Min ${res[ref]?.dcResult.min} / Max ${res[ref]?.dcResult.max}  (was 35/139)`);
console.log(`Engine DC footprint ΣMax: thick ${engFp.thick} / thin ${engFp.thin} / total ${engFp.thick + engFp.thin}`);
console.log('');
