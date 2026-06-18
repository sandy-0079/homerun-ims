// OOS Simulation — backtest the PUBLISHED v2 plan against an uploaded out-of-window invoice.
// Pure + deterministic: composes the existing demand prep + replay simulator, then aggregates
// order-level OOS per DS (regular) and bulk fulfilment from the DC. No UI, no I/O.
//
//   publishedPlan = computePlywoodNetworkV2Results(originalInvoice, skuMaster,
//                     { plywoodNetworkV2Config: savedCfg })
//   params        = the published config (savedCfg) — already V2_DEFAULTS-merged by the caller.
import { buildUniverse, prepareDemand } from './demand.js';
import { replay } from './replay.js';
import { DS_LIST } from '../../constants.js';

export function simulateOOS(uploadedInvoice, publishedPlan, skuMaster, params) {
  const c = params || {};
  const universe = buildUniverse(skuMaster, c);
  const universeSkus = new Set(Object.keys(universe));

  // Unplanned bucket: SKUs in the upload that aren't in the published plan's universe (new-to-master
  // or out-of-scope). prepareDemand drops them from the sim; we count their orders separately so they
  // don't pollute the OOS rate.
  const uploadedSkus = new Set();
  const unplannedOrderIds = new Set();
  const orderId = (r) => r.shopifyOrder || `_noid|${r.ds}|${r.date}|${r.sku}`;
  for (const r of uploadedInvoice) {
    if (!r.sku || !(r.qty > 0)) continue;
    uploadedSkus.add(r.sku);
    if (!universeSkus.has(r.sku)) unplannedOrderIds.add(orderId(r));
  }
  const unplannedSkus = [...uploadedSkus].filter((s) => !universeSkus.has(s)).sort();

  // Window the demand to the uploaded data's own calendar span. prepareDemand derives its cutoff as
  // (lastDate − lookbackDays), so lookbackDays ≈ the span (+ a 2-day buffer so the cutoff lands on or
  // before the first date — keeps every uploaded order, plus a brief warm-up to reach stocked steady
  // state). A huge lookback would instead compute a garbage pre-historic cutoff.
  const dts = [...new Set(uploadedInvoice.map((r) => r.date).filter(Boolean))].sort();
  const first = dts[0] || null, last = dts[dts.length - 1] || null;
  const calSpan = (first && last) ? Math.round((Date.parse(last) - Date.parse(first)) / 86400000) : 0;
  const demand = prepareDemand(uploadedInvoice, universe, { ...c, lookbackDays: Math.max(1, calSpan + 2) });

  // Build the replay plan from the published plan (storeResults → DS, dcResult → DC).
  const plan = {}, dcPlan = {};
  for (const sku of universeSkus) {
    const pr = publishedPlan?.[sku];
    if (!pr) continue;
    plan[sku] = {};
    for (const ds of DS_LIST) {
      const m = pr.storeResults?.[ds] || { min: 0, max: 0 };
      plan[sku][ds] = { min: m.min, max: m.max };
    }
    dcPlan[sku] = { min: pr.dcResult?.min || 0, max: pr.dcResult?.max || 0 };
  }

  const lookback = demand.windowDates.length || 1;

  // DS regular OOS — DC is INFINITE: each DS starts at Max, depletes on orders, and a TO refills it
  // to Max the next day (the DC always honours it). Isolates DS-shelf performance — the same basis as
  // the 75/15 evaluation. (Bulk is meaningless in this pass: an infinite DC fills every bulk order.)
  const simDS = replay(plan, null, demand, { ...c, lookbackDays: lookback, infiniteDC: true, captureLines: true });

  // Bulk fulfilment — the FINITE published DC stock serves bulk; ALL bulk routes to the DC (the
  // framework premise: any order with a line ≥ threshold goes to the DC), so α is forced to 1.
  const simDC = replay(plan, dcPlan, demand, { ...c, lookbackDays: lookback, infiniteDC: false, bulkDcServedShare: 1, captureLines: true });

  const refOf = (id) => (id && !String(id).startsWith('_noid|')) ? id : '—';
  // Table rows for one location: every line of orders that missed ≥1 item here (red short + green
  // served), sorted by shortfall desc. SOH on every line comes from the captureLines pass.
  const buildLineTable = (sim, type, ds) => {
    const byOrder = {};
    for (const e of sim.lineEvents) {
      if (e.type !== type) continue;
      if (ds && e.ds !== ds) continue;
      (byOrder[e.orderId] ??= []).push(e);
    }
    const rows = [];
    for (const [oid, lines] of Object.entries(byOrder)) {
      if (!lines.some((l) => l.short > 0)) continue;   // only orders that missed something here
      for (const l of lines) {
        const mm = (type === 'bulk' ? dcPlan[l.sku] : plan[l.sku]?.[l.ds]) || {};
        rows.push({
          date: l.date, ref: refOf(oid), sku: l.sku, itemName: skuMaster?.[l.sku]?.name || '',
          qty: l.qty, soh: l.onHand, short: l.short, served: l.served, min: mm.min ?? 0, max: mm.max ?? 0,
        });
      }
    }
    return rows.sort((a, b) => b.short - a.short || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  const reg = simDS.serviceLevels.regular;
  const blk = simDC.serviceLevels.bulk;
  const perDS = {};
  for (const ds of DS_LIST) {
    const cc = reg.perDS[ds] || { service: 1, total: 0, oos: 0 };
    perDS[ds] = { oosPct: 1 - cc.service, oos: cc.oos, total: cc.total, rows: buildLineTable(simDS, 'regular', ds) };
  }

  return {
    window: { from: first, to: last, days: calSpan + 1 },
    orderCounts: { total: reg.total + blk.total, regular: reg.total, bulk: blk.total },
    network: { dsOosPct: 1 - reg.overall, dsOos: reg.oos, bulkServedPct: blk.overall },
    perDS,
    dc: { servedPct: blk.overall, served: blk.total - blk.oos, total: blk.total, rows: buildLineTable(simDC, 'bulk', null) },
    unplanned: { orders: unplannedOrderIds.size, skus: unplannedSkus },
  };
}
