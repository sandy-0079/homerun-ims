#!/usr/bin/env node
// Offline validation: real Supabase data → v2 plan + simulated service + keep score.
// READ-ONLY against Supabase. Writes only to .cache/ and validation-out/.
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

const { computePlywoodNetworkV2Results, V2_DEFAULTS, buildUniverse, prepareDemand, replay, computeKeepScores } =
  await import('../src/engine/strategies/plywoodV2/index.js');
const { DS_LIST } = await import('../src/engine/constants.js');

const global_ = await fetchRow('team_data', 'global');
const invRow = await fetchRow('team_data', 'invoice_data');
const inv = invRow.invoiceData ?? invRow;
const skuM = global_.skuMaster, priceData = global_.priceData;

const cfg = { ...V2_DEFAULTS };           // tweak here between iterations
const params = { plywoodNetworkV2Config: cfg };

const res = computePlywoodNetworkV2Results(inv, skuM, params);
const universe = buildUniverse(skuM, cfg);
const demand = prepareDemand(inv, universe, cfg);

// Re-derive plan/dcPlan from results for the replay
const plan = {}, dcPlan = {};
for (const [sku, r] of Object.entries(res)) {
  plan[sku] = {};
  for (const ds of DS_LIST) plan[sku][ds] = { min: r.storeResults[ds].min, max: r.storeResults[ds].max };
  dcPlan[sku] = { ...r.dcResult };
}
const sim = replay(plan, dcPlan, demand, cfg);

// Keep score inputs
const windowQty = {}, networkNZD = {}, regularNZD = {};
for (const sku of Object.keys(universe)) {
  windowQty[sku] = 0; networkNZD[sku] = 0; regularNZD[sku] = 0;
}
{
  const allDates = {}, regDates = {};
  for (const o of demand.orders) {
    for (const l of o.lines) {
      windowQty[l.sku] += l.qty;
      (allDates[l.sku] ??= new Set()).add(o.date);
    }
  }
  for (const sku of Object.keys(universe)) {
    networkNZD[sku] = allDates[sku]?.size || 0;
    const rd = new Set();
    for (const ds of DS_LIST) for (const d of Object.keys(demand.regularDaily[sku]?.[ds] || {})) rd.add(d);
    regularNZD[sku] = rd.size;
  }
}
const scores = computeKeepScores({ plan, dcPlan, priceData, windowQty, networkNZD, regularNZD }, cfg.keepScore);

// ── CSVs ──
mkdirSync('validation-out', { recursive: true });
const csv = (rows) => rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

const planRows = [['SKU', 'Name', 'Brand', 'Class', 'Floor', ...DS_LIST.flatMap(ds => [`${ds} Min`, `${ds} Max`]), 'DC Min', 'DC Max', 'DC Repl', 'DC Bulk', 'DC Cycle']];
for (const [sku, r] of Object.entries(res)) {
  planRows.push([sku, skuM[sku].name, r.brand, r.storeResults.DS01.v2.tclass, r.v2.floor,
    ...DS_LIST.flatMap(ds => [r.storeResults[ds].min, r.storeResults[ds].max]),
    r.dcResult.min, r.dcResult.max, r.v2.dcDetail?.repl ?? '', r.v2.dcDetail?.bulk ?? '', r.v2.dcDetail?.cycle ?? '']);
}
writeFileSync('validation-out/plan.csv', csv(planRows));

const anySku = Object.keys(res)[0];
const capRows = [['DS', 'Class', 'Capacity', 'Floor Used', 'Used', 'Util %', 'Over']];
for (const ds of DS_LIST) for (const tc of ['thick', 'thin']) {
  const n = res[anySku].v2.nodeReport[ds][tc];
  capRows.push([ds, tc, n.capacity, n.floorUsed, n.used, n.capacity ? Math.round(n.used / n.capacity * 100) : '', n.overCapacity ? 'FLOORS OVER CAP' : '']);
}
writeFileSync('validation-out/capacity.csv', csv(capRows));

const svc = sim.serviceLevels;
const svcRows = [['Scope', 'Total Orders', 'OOS', 'Service %']];
svcRows.push(['Regular (network)', svc.regular.total, svc.regular.oos, (svc.regular.overall * 100).toFixed(2)]);
for (const [ds, c] of Object.entries(svc.regular.perDS)) svcRows.push([`Regular ${ds}`, c.total, c.oos, (c.service * 100).toFixed(2)]);
svcRows.push(['Bulk (DC)', svc.bulk.total, svc.bulk.oos, (svc.bulk.overall * 100).toFixed(2)]);
writeFileSync('validation-out/service.csv', csv(svcRows));

writeFileSync('validation-out/oos-events.csv', csv([
  ['Type', 'Order', 'Date', 'DS', 'SKU', 'Short'],
  ...sim.oosEvents.map(e => [e.type, e.orderId, e.date, e.ds, e.sku, e.short]),
]));

writeFileSync('validation-out/keepscore.csv', csv([
  ['SKU', 'Name', 'PP', 'Avg Position', 'Holding Val', 'Rent Ratio', 'Service Ratio', 'Keep Score', 'Flag'],
  ...scores.map(s => [s.sku, skuM[s.sku]?.name, s.pp, s.avgPosition.toFixed(1), Math.round(s.holdingValue),
    s.rentRatio.toFixed(2), s.serviceRatio.toFixed(2), s.keepScore.toFixed(2), s.flag]),
]));

// DC totals by class
const dcTotals = { thick: 0, thin: 0 };
for (const [sku, r] of Object.entries(res)) dcTotals[r.storeResults.DS01.v2.tclass] += r.dcResult.max;

console.log(`Universe: ${Object.keys(universe).length} SKUs | window ${demand.cutoff} → ${demand.windowDates[demand.windowDates.length - 1]} (${demand.windowDates.length}d)`);
console.log(`Regular service: ${(svc.regular.overall * 100).toFixed(2)}% (${svc.regular.oos}/${svc.regular.total} OOS)`);
for (const [ds, c] of Object.entries(svc.regular.perDS)) console.log(`  ${ds}: ${(c.service * 100).toFixed(2)}% (${c.oos}/${c.total})`);
console.log(`Bulk service:    ${(svc.bulk.overall * 100).toFixed(2)}% (${svc.bulk.oos}/${svc.bulk.total} OOS)`);
console.log(`TO lines: ${sim.opsLoad.toLines} (${(sim.opsLoad.toLines / demand.windowDates.length).toFixed(1)}/day), PO lines: ${sim.opsLoad.poLines}`);
console.log(`DC ΣMax: thick ${dcTotals.thick}/${cfg.dcCapacity.thick}, thin ${dcTotals.thin}/${cfg.dcCapacity.thin}${res[anySku].v2.dcTrimReport?.steps?.length ? ' | DC TRIM: ' + res[anySku].v2.dcTrimReport.steps.join(', ') : ''}`);
console.log(`Keep flags: ${['Keep', 'Watch', 'Cut'].map(f => `${f}=${scores.filter(s => s.flag === f).length}`).join(' ')}`);
console.log('CSVs written to validation-out/');
