// DC sizing (spec §6): repl P98 of rolling (L+1)-day TO drain + bulk P90 (additive)
// + cycle stock (mean drain × coverDays). Optional thick/thin capacity trim.

import { percentile } from '../../utils.js';

export function rollingSums(series, windowDates, span) {
  const vals = windowDates.map(d => series?.[d] || 0);
  const out = [];
  for (let i = 0; i + span <= vals.length; i++) {
    let s = 0;
    for (let j = i; j < i + span; j++) s += vals[j];
    out.push(s);
  }
  return out;
}

export function sizeDC(toDrain, bulkDaily, windowDates, cfg) {
  const L = (cfg.leadDays ?? 3) + 1;
  const replP = cfg.dcReplPercentile ?? 98;
  const bulkP = cfg.dcBulkPercentile ?? 90;
  const cover = cfg.dcCoverDays ?? 2;
  const share = cfg.bulkDcServedShare ?? 1.0;

  const skus = [...new Set([...Object.keys(toDrain), ...Object.keys(bulkDaily)])].sort();
  const dcPlan = {}, detail = {};
  for (const sku of skus) {
    const drainSums = rollingSums(toDrain[sku], windowDates, L).sort((a, b) => a - b);
    const repl = Math.ceil(percentile(drainSums, replP) || 0);

    const scaled = {};
    for (const [d, q] of Object.entries(bulkDaily[sku] || {})) scaled[d] = q * share;
    const bulkSums = rollingSums(scaled, windowDates, L).sort((a, b) => a - b);
    const bulk = Math.ceil(percentile(bulkSums, bulkP) || 0);

    const totalDrain = windowDates.reduce((a, d) => a + (toDrain[sku]?.[d] || 0), 0);
    const meanDrain = windowDates.length ? totalDrain / windowDates.length : 0;
    const cycle = Math.ceil(meanDrain * cover);

    const min = repl + bulk;
    dcPlan[sku] = { min, max: min + cycle };
    detail[sku] = { repl, bulk, cycle };
  }
  return { dcPlan, detail };
}

// ── DC v2 sizing (user-confirmed 2026-06-17): lean reorder cover + capped bulk buffer ──
// Min = s = P[dcServicePct] of L-day TO-drain — the lean reorder point (lead-time replenishment
//   demand at the service level); protects DS replenishment, never trimmed.
// Max = Min + max( one bulk order , lead-time TO-drain ):
//   one bulk order = P[dcBulkServicePct] of the SKU's bulk-order sizes — the bulk-service dial;
//     holds enough to serve a single typical bulk order off the shelf (clusters/bigger → supplier).
//   lead-time TO-drain = mean L-day drain — a reorder-batch FLOOR so non-bulky SKUs still get a
//     sane cycle (Min ≠ Max) rather than thrashing at the reorder point.
//   The buffer (Max − Min) is the trimmable depth; DS regular service is ~flat in it (the lever
//   for higher DS service is the DS plans, not DC depth).
export function sizeDCSS(toDrain, bulkOrderQty, windowDates, cfg) {
  const L = cfg.leadDays ?? 3;
  const q = cfg.dcServicePct ?? 98;
  const bq = cfg.dcBulkServicePct ?? 90;

  const skus = [...new Set([...Object.keys(toDrain || {}), ...Object.keys(bulkOrderQty || {})])].sort();
  const dcPlan = {}, detail = {};
  for (const sku of skus) {
    const leadW = rollingSums(toDrain?.[sku], windowDates, L).sort((a, b) => a - b);
    const s = Math.ceil(percentile(leadW, q) || 0);
    const leadBatch = Math.ceil(leadW.reduce((a, b) => a + b, 0) / Math.max(leadW.length, 1));
    const bo = [...(bulkOrderQty?.[sku] || [])].sort((a, b) => a - b);
    const bulkUnit = bo.length ? Math.ceil(percentile(bo, bq) || 0) : 0;
    const buffer = Math.max(bulkUnit, leadBatch);
    const nzd = windowDates.reduce((a, d) => a + ((toDrain?.[sku]?.[d] || 0) > 0 ? 1 : 0), 0);
    dcPlan[sku] = { min: s, max: s + buffer };
    detail[sku] = { s, bulkUnit, leadBatch, buffer, bulkOrders: bo.length, nzd };
  }
  return { dcPlan, detail };
}

// DC capacity trim: surrender order-up-to DEPTH (Max → Min) on the least TO-active SKUs first
// (ties: larger depth first). The reorder floor (Min = s) is NEVER trimmed — it backs TO-fill.
// Residual overflow (Σ Min still over cap) is reported, not hidden.
export function trimDCDepth(dcPlan, detail, dcCapacity, tclassOf) {
  if (!dcCapacity) return { dcPlan, detail, trimReport: null };
  const plan = {}, det = {};
  for (const sku of Object.keys(dcPlan)) { plan[sku] = { ...dcPlan[sku] }; det[sku] = { ...detail[sku] }; }

  const trimReport = { steps: [], stillOver: false, residual: {} };
  for (const tc of ['thick', 'thin']) {
    const cap = dcCapacity[tc];
    if (cap == null || cap <= 0) continue;
    const group = Object.keys(plan).filter(s => tclassOf(s) === tc);
    let used = group.reduce((a, s) => a + plan[s].max, 0);
    if (used <= cap) continue;

    for (const s of [...group].sort((a, b) =>
      (det[a].nzd - det[b].nzd) || ((plan[b].max - plan[b].min) - (plan[a].max - plan[a].min)))) {
      if (used <= cap) break;
      const take = Math.min(plan[s].max - plan[s].min, used - cap);
      if (take <= 0) continue;
      plan[s].max -= take;
      det[s].trimmedDepth = (det[s].trimmedDepth || 0) + take;
      used -= take;
    }
    if (used > cap) {
      trimReport.stillOver = true;
      trimReport.residual[tc] = used - cap;
    }
    trimReport.steps.push(`${tc}: trimmed to ${used}/${cap}`);
  }
  return { dcPlan: plan, detail: det, trimReport };
}

// Capacity trim (legacy v1 of DC trim): (1) drop cycle stock, (2) lower bulk percentile 90→85→80.
// Returns trimmed copies + report. Never touches the repl component.
export function trimDCToCapacity(dcPlan, detail, toDrain, bulkDaily, windowDates, cfg, dcCapacity, tclassOf) {
  if (!dcCapacity) return { dcPlan, detail, trimReport: null };
  const over = (p) => {
    const sums = { thick: 0, thin: 0 };
    for (const [sku, v] of Object.entries(p)) sums[tclassOf(sku)] += v.max;
    return {
      thick: sums.thick - (dcCapacity.thick ?? Infinity),
      thin: sums.thin - (dcCapacity.thin ?? Infinity),
      sums,
    };
  };
  let cur = { dcPlan, detail };
  let o = over(cur.dcPlan);
  const steps = [];
  if (o.thick <= 0 && o.thin <= 0) return { ...cur, trimReport: { steps, final: o.sums, stillOver: false } };

  // Step 1: drop cycle stock
  cur = sizeDC(toDrain, bulkDaily, windowDates, { ...cfg, dcCoverDays: 0 });
  steps.push('cycle stock removed');
  o = over(cur.dcPlan);
  // Step 2: lower bulk percentile
  for (const p of [85, 80]) {
    if (o.thick <= 0 && o.thin <= 0) break;
    cur = sizeDC(toDrain, bulkDaily, windowDates, { ...cfg, dcCoverDays: 0, dcBulkPercentile: p });
    steps.push(`bulk percentile → ${p}`);
    o = over(cur.dcPlan);
  }
  return { ...cur, trimReport: { steps, final: o.sums, stillOver: o.thick > 0 || o.thin > 0 } };
}
